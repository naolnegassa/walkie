const Hyperswarm = require('hyperswarm')
const net = require('net')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { deriveTopic, agentId } = require('./crypto')
const store = require('./store')
const { isWalkieProcess } = require('./cli-utils')

const IS_WINDOWS = process.platform === 'win32'
const WALKIE_DIR = process.env.WALKIE_DIR || path.join(os.homedir(), '.walkie')
// On POSIX the socket lives inside WALKIE_DIR, so instances isolate naturally.
// A fixed Windows pipe name ignored WALKIE_DIR entirely, so every instance on the
// machine — including isolated test runs — fought over one pipe. Derive it instead.
const IPC_PATH = IS_WINDOWS
  ? '\\\\.\\pipe\\walkie-' + require('crypto').createHash('sha256').update(WALKIE_DIR).digest('hex').slice(0, 12)
  : path.join(WALKIE_DIR, 'daemon.sock')
const PID_FILE = path.join(WALKIE_DIR, 'daemon.pid')
const LOG_FILE = path.join(WALKIE_DIR, 'daemon.log')
// How long a subscriber may sit idle and empty before being dropped.
const SUBSCRIBER_TTL = parseInt(process.env.WALKIE_SUBSCRIBER_TTL_MS, 10) || 60 * 60 * 1000
// Sweep at most once a minute, but more often when the TTL is shorter than that
// (tests drive a very short TTL and need the sweep to actually run).
const RECENT_REPLY_CACHE = 200
const REAP_INTERVAL = Math.max(100, Math.min(60 * 1000, SUBSCRIBER_TTL))

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch {}
}

// A daemon that died after start() left nothing behind: the spawn discarded stderr
// and nothing handled uncaught errors, so "it starts then vanishes" was unreportable.
// See issue #11.
process.on('uncaughtException', (err) => {
  log(`FATAL uncaughtException: ${err && err.stack || err}`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log(`FATAL unhandledRejection: ${reason && reason.stack || reason}`)
  process.exit(1)
})

const TTL_MS = (parseInt(process.env.WALKIE_TTL, 10) || 86400) * 1000
const COMPACT_INTERVAL = 15 * 60 * 1000

class WalkieDaemon {
  constructor() {
    this.id = agentId()
    this.swarm = new Hyperswarm()
    this.channels = new Map()  // name -> { topicHex, discovery, persist, knownMsgIds, peers: Set, subscribers: Map<clientId, { messages: [], waiters: [], lastReadTs }> }
    this.peers = new Map()     // remoteKey hex -> { conn, channels: Set }
    this.msgSeq = 0
    this._compactTimer = null
  }

  async start() {
    fs.mkdirSync(WALKIE_DIR, { recursive: true })

    // Kill any old daemon before taking over
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
      // Confirm the pid is a walkie daemon before signalling — pid files outlive
      // their process and the OS recycles pids.
      if (oldPid !== process.pid && this._isRunning(oldPid) && isWalkieProcess(oldPid)) {
        log(`Killing old daemon pid=${oldPid}`)
        try { process.kill(oldPid, 'SIGTERM') } catch {}
        // Give it a moment to shut down
        await new Promise(r => setTimeout(r, 500))
        if (this._isRunning(oldPid)) {
          try { process.kill(oldPid, 'SIGKILL') } catch {}
          await new Promise(r => setTimeout(r, 200))
        }
      }
    } catch {}

    fs.writeFileSync(PID_FILE, process.pid.toString())

    // Clean stale socket
    try { fs.unlinkSync(IPC_PATH) } catch {}

    // IPC server for CLI commands
    const server = net.createServer(sock => this._onIPC(sock))
    await new Promise(resolve => server.listen(IPC_PATH, resolve))
    log(`Daemon listening on ${IPC_PATH}`)

    // P2P connections
    this.swarm.on('connection', (conn, info) => this._onPeer(conn, info))
    // An unhandled 'error' on an EventEmitter throws and kills the daemon. The swarm
    // can error for reasons that are not fatal to IPC (UDP bind refused, DHT
    // unreachable), so log and keep serving local clients.
    this.swarm.on('error', (err) => log(`swarm error: ${err && err.message || err}`))

    // TTL compaction on startup + periodic
    store.compactAll(TTL_MS)
    this._compactTimer = setInterval(() => store.compactAll(TTL_MS), COMPACT_INTERVAL)
    this._reapTimer = setInterval(() => this._reapSubscribers(), REAP_INTERVAL)
    if (this._reapTimer.unref) this._reapTimer.unref()

    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())

    log(`Daemon started id=${this.id} pid=${process.pid}`)
  }

  // ── IPC (CLI <-> Daemon) ──────────────────────────────────────────

  _onIPC(socket) {
    let buf = ''
    socket.on('data', data => {
      buf += data.toString()
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.trim()) {
          try {
            this._exec(JSON.parse(line), socket)
          } catch (e) {
            socket.write(JSON.stringify({ ok: false, error: e.message }) + '\n')
          }
        }
      }
    })
    socket.on('error', () => {})
  }

  async _exec(cmd, socket) {
    const reply = d => socket.write(JSON.stringify(d) + '\n')

    try {
      switch (cmd.action) {
        case 'join': {
          const id = cmd.clientId || 'default'
          await this._joinChannel(cmd.channel, cmd.secret, cmd.persist)
          const ch = this.channels.get(cmd.channel)
          const isNew = !ch.subscribers.has(id)
          if (isNew) {
            // Announce BEFORE registering, so the joiner does not receive its own
            // join notice. _send excludes only the literal 'system' sender, so a
            // subscriber already in the map is inside its own broadcast set.
            if (ch.subscribers.size > 0 || ch.peers.size > 0) {
              this._send(cmd.channel, `${id} joined`, 'system')
            }
            ch.subscribers.set(id, { messages: [], waiters: [], lastReadTs: 0, lastSeen: Date.now() })
          } else {
            ch.subscribers.get(id).lastSeen = Date.now()
          }
          reply({ ok: true, channel: cmd.channel })
          break
        }
        case 'send': {
          const id = cmd.clientId || 'default'
          const ch = this.channels.get(cmd.channel)
          if (ch && ch.subscribers.has(id)) ch.subscribers.get(id).lastSeen = Date.now()
          const { total, local, peers, recipients, msgId } = this._send(cmd.channel, cmd.message, id, cmd.replyTo, cmd.to)
          const mine = ch && ch.subscribers.has(id) ? ch.subscribers.get(id).messages.length : 0
          reply({ ok: true, delivered: total, localSubscribers: local, peerDaemons: peers, recipients, unread: mine, msgId, persisted: !!(ch && ch.persist) })
          break
        }
        case 'awaitReply': {
          const ch = this.channels.get(cmd.channel)
          if (!ch) { reply({ ok: false, error: `Not in channel: ${cmd.channel}` }); return }
          if (!cmd.replyTo) { reply({ ok: false, error: 'replyTo required' }); return }

          // The reply may already have arrived while the caller was registering.
          const already = ch.recentReplies && ch.recentReplies.get(cmd.replyTo)
          if (already) { reply({ ok: true, reply: already }); return }

          let timer
          const waiter = {
            replyTo: cmd.replyTo,
            fn: (entry) => {
              if (timer) clearTimeout(timer)
              reply({ ok: true, reply: entry })
            },
          }
          if (cmd.timeout) {
            timer = setTimeout(() => {
              ch.replyWaiters = ch.replyWaiters.filter(w => w !== waiter)
              reply({ ok: true, reply: null, timedOut: true })
            }, cmd.timeout * 1000)
          }
          ch.replyWaiters.push(waiter)
          socket.once('close', () => {
            if (timer) clearTimeout(timer)
            ch.replyWaiters = ch.replyWaiters.filter(w => w !== waiter)
          })
          break
        }
        case 'read': {
          const id = cmd.clientId || 'default'
          const ch = this.channels.get(cmd.channel)
          if (!ch) { reply({ ok: false, error: `Not in channel: ${cmd.channel}` }); return }

          // Auto-register subscriber on read if not yet joined
          if (!ch.subscribers.has(id)) {
            ch.subscribers.set(id, { messages: [], waiters: [], lastReadTs: 0, lastSeen: Date.now() })
          }
          const sub = ch.subscribers.get(id)
          sub.lastSeen = Date.now()

          // Merge persisted messages for persistent channels
          if (ch.persist) {
            const stored = store.read(cmd.channel, sub.lastReadTs)
            if (stored.length > 0) {
              // Merge with in-memory, dedup by id
              const inMemIds = new Set(sub.messages.map(m => m.id).filter(Boolean))
              for (const msg of stored) {
                if (!msg.id || !inMemIds.has(msg.id)) sub.messages.push(msg)
              }
              sub.messages.sort((a, b) => a.ts - b.ts)
            }
          }

          // Peek is non-destructive: look without consuming, so a second reader on
          // the same identity does not lose messages to the first.
          if (cmd.peek) {
            reply({ ok: true, messages: sub.messages.slice(), unread: sub.messages.length, peeked: true })
            return
          }

          // If messages available or no wait requested, return immediately
          if (sub.messages.length > 0 || !cmd.wait) {
            const msgs = sub.messages.splice(0)
            if (msgs.length > 0) {
              sub.lastReadTs = msgs[msgs.length - 1].ts
            }
            reply({ ok: true, messages: msgs, unread: sub.messages.length })
            return
          }

          // Wait mode: hold connection until a message arrives
          let timer
          if (cmd.timeout) {
            timer = setTimeout(() => {
              sub.waiters = sub.waiters.filter(w => w !== waiter)
              reply({ ok: true, messages: [] })
            }, cmd.timeout * 1000)
          }

          const waiter = (msgs) => {
            if (timer) clearTimeout(timer)
            if (socket.writable) {
              // A waiter is woken with a single message. Anything that landed in the
              // buffer between the wake and this reply goes out in the same batch, so
              // the caller is not left with messages only a second read would reveal.
              const all = msgs.concat(sub.messages.splice(0))
              if (all.length > 0) sub.lastReadTs = all[all.length - 1].ts
              reply({ ok: true, messages: all })
            } else {
              // Socket gone (client interrupted) — put messages back
              sub.messages.unshift(...msgs)
            }
          }
          sub.waiters.push(waiter)

          // Clean up waiter if socket closes before message arrives
          socket.once('close', () => {
            if (timer) clearTimeout(timer)
            sub.waiters = sub.waiters.filter(w => w !== waiter)
          })
          break
        }
        case 'leave': {
          const id = cmd.clientId || 'default'
          const ch = this.channels.get(cmd.channel)
          if (ch) {
            // Announce leave to local subscribers and remote peers before removing
            if (ch.subscribers.size > 1 || ch.peers.size > 0) {
              this._send(cmd.channel, `${id} left`, 'system')
            }
            ch.subscribers.delete(id)
            // Only fully leave the channel if no subscribers remain
            if (ch.subscribers.size === 0) {
              await this._leaveChannel(cmd.channel)
            }
          }
          reply({ ok: true })
          break
        }
        case 'status': {
          const channels = {}
          for (const [name, ch] of this.channels) {
            // Aggregate buffered cannot answer "do *I* have unread?" on a daemon with
            // more than one identity, so report the per-subscriber breakdown too.
            let buffered = 0
            const bufferedBy = {}
            for (const [sid, sub] of ch.subscribers) {
              buffered += sub.messages.length
              bufferedBy[sid] = sub.messages.length
            }
            const info = { peers: ch.peers.size, subscribers: ch.subscribers.size, buffered, bufferedBy }
            if (ch.persist) {
              info.persist = true
              info.stored = store.read(name, 0).length
            }
            channels[name] = info
          }
          reply({ ok: true, channels, daemonId: this.id })
          break
        }
        case 'members': {
          const ch = this.channels.get(cmd.channel)
          if (!ch) { reply({ ok: false, error: 'not joined' }); break }
          const now = Date.now()
          const alive = []
          for (const [id, sub] of ch.subscribers) {
            if (sub.waiters.length > 0 || (now - (sub.lastSeen || 0)) < 60000) {
              alive.push(id)
            }
          }
          reply({ ok: true, members: alive, peers: ch.peers.size })
          break
        }
        case 'ping': {
          const pkg = require('../package.json')
          reply({ ok: true, version: pkg.version })
          break
        }
        case 'stop': {
          reply({ ok: true })
          await this.shutdown()
          break
        }
        default:
          reply({ ok: false, error: `Unknown action: ${cmd.action}` })
      }
    } catch (e) {
      reply({ ok: false, error: e.message })
    }
  }

  // Fire anyone blocked on a reply to this message. Runs at delivery time, before
  // and independently of subscriber buffers, so a concurrent reader draining the
  // channel cannot make an ack invisible to the agent that asked for it.
  _notifyReplyWaiters(ch, entry) {
    if (!entry || !entry.replyTo) return

    if (ch.recentReplies) {
      ch.recentReplies.set(entry.replyTo, entry)
      while (ch.recentReplies.size > RECENT_REPLY_CACHE) {
        ch.recentReplies.delete(ch.recentReplies.keys().next().value)
      }
    }

    if (!ch.replyWaiters || ch.replyWaiters.length === 0) return
    const matched = ch.replyWaiters.filter(w => w.replyTo === entry.replyTo)
    if (matched.length === 0) return
    ch.replyWaiters = ch.replyWaiters.filter(w => w.replyTo !== entry.replyTo)
    for (const w of matched) {
      try { w.fn(entry) } catch {}
    }
  }

  // Drop subscribers that have gone quiet. Deliberately conservative: a subscriber
  // is only reaped when it holds nothing (no buffered messages, no parked waiter),
  // so reaping can never lose a message. Without this, every identity that ever
  // touched a channel stays in the subscriber list for the daemon's lifetime.
  _reapSubscribers() {
    const now = Date.now()
    for (const [name, ch] of this.channels) {
      for (const [id, sub] of ch.subscribers) {
        if (sub.waiters.length > 0) continue
        if (sub.messages.length > 0) continue
        if (now - (sub.lastSeen || 0) < SUBSCRIBER_TTL) continue
        ch.subscribers.delete(id)
        log(`Reaped idle subscriber "${id}" from channel "${name}"`)
      }
    }
  }

  _isRunning(pid) {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  // ── Channel management ────────────────────────────────────────────

  async _joinChannel(name, secret, persist) {
    let carriedSubscribers = null
    if (this.channels.has(name)) {
      const ch = this.channels.get(name)
      // If rejoining with a different secret, leave the old channel and rejoin
      // with the new topic. This prevents stale DHT topics when secrets change.
      const newTopic = deriveTopic(name, secret)
      const newTopicHex = newTopic.toString('hex')
      if (ch.topicHex !== newTopicHex) {
        log(`Channel "${name}" secret changed, rejoining with new topic`)
        // Other local clients are on this channel. Rejoining swaps the swarm topic;
        // it must not silently drop their subscriptions and buffered messages.
        carriedSubscribers = ch.subscribers
        await this._leaveChannel(name)
        // Fall through to join with new secret
      } else {
        // Same topic — upgrade to persistent if requested (never downgrade)
        if (persist) {
          if (!ch.persist) {
            ch.persist = true
            ch.knownMsgIds = store.loadIds(name)
            log(`Channel "${name}" upgraded to persistent`)
          }
        }
        return
      }
    }

    const topic = deriveTopic(name, secret)
    const topicHex = topic.toString('hex')
    log(`Joining channel "${name}" topic=${topicHex.slice(0, 16)}...${persist ? ' [persist]' : ''}`)
    const discovery = this.swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
    log(`Channel "${name}" flushed, discoverable`)

    this.channels.set(name, {
      topicHex,
      secret,
      discovery,
      persist: !!persist,
      knownMsgIds: persist ? store.loadIds(name) : null,
      peers: new Set(),
      subscribers: carriedSubscribers || new Map(),
      // Monotonic position of messages as THIS daemon saw them, covering both local
      // sends and remote receipts. It is a local ordering, not a global one: two
      // daemons have no way to agree on a shared sequence without consensus, so
      // never treat this as a channel-wide total order.
      seq: 0,
      // Callers blocked on a reply to a specific message id. Held at channel level,
      // not per subscriber, because a reply belongs to whoever asked the question —
      // it must not depend on which reader happens to consume it first.
      replyWaiters: [],
      // Replies seen recently, keyed by the id they answer. A caller registers its
      // interest only after its send returns, so a fast reply can arrive first; this
      // lets awaitReply resolve one that already landed.
      recentReplies: new Map()
    })

    // Re-announce topics to already-connected peers (fixes race condition
    // where peer connects before channel is registered)
    this._reannounce()
  }

  _reannounce() {
    const topics = Array.from(this.channels.values()).map(ch => ch.topicHex)
    const hello = JSON.stringify({ t: 'hello', topics, id: this.id }) + '\n'
    for (const [remoteKey, peer] of this.peers) {
      if (peer.conn?.writable) {
        log(`Re-announcing ${topics.length} topic(s) to ${remoteKey.slice(0, 12)}`)
        peer.conn.write(hello)
      }
      // Also match this peer against our newly added channels
      // (handles case where we received their hello before our channel was ready)
      if (peer.knownTopics) {
        for (const [name, ch] of this.channels) {
          if (peer.knownTopics.has(ch.topicHex) && !ch.peers.has(remoteKey)) {
            ch.peers.add(remoteKey)
            peer.channels.add(name)
            log(`Late-matched channel "${name}" with peer ${remoteKey.slice(0, 12)}`)
            if (ch.persist) {
              this._sendSyncReq(peer.conn, name, ch)
            }
          }
        }
      }
    }
  }

  async _leaveChannel(name) {
    const ch = this.channels.get(name)
    if (!ch) return
    await ch.discovery.destroy()
    this.channels.delete(name)
  }

  // ── P2P peer handling ─────────────────────────────────────────────

  _onPeer(conn, info) {
    const remoteKey = conn.remotePublicKey.toString('hex')
    log(`Peer connected: ${remoteKey.slice(0, 12)}...`)

    const peer = { conn, channels: new Set(), buf: '' }
    this.peers.set(remoteKey, peer)

    // Send handshake: our active topic list
    const topics = Array.from(this.channels.values()).map(ch => ch.topicHex)
    log(`Sending hello with ${topics.length} topic(s)`)
    conn.write(JSON.stringify({ t: 'hello', topics, id: this.id }) + '\n')

    conn.on('data', data => {
      peer.buf += data.toString()
      let idx
      while ((idx = peer.buf.indexOf('\n')) !== -1) {
        const line = peer.buf.slice(0, idx)
        peer.buf = peer.buf.slice(idx + 1)
        if (line.trim()) {
          try { this._onPeerMsg(remoteKey, JSON.parse(line)) } catch {}
        }
      }
    })

    conn.on('close', () => {
      for (const [, ch] of this.channels) ch.peers.delete(remoteKey)
      this.peers.delete(remoteKey)
    })

    conn.on('error', () => conn.destroy())
  }

  _onPeerMsg(remoteKey, msg) {
    const peer = this.peers.get(remoteKey)
    if (!peer) return

    if (msg.t === 'hello') {
      const theirTopics = new Set(msg.topics || [])
      peer.knownTopics = theirTopics  // Store for late-matching
      log(`Got hello from ${remoteKey.slice(0, 12)} with ${theirTopics.size} topic(s)`)
      for (const [name, ch] of this.channels) {
        if (theirTopics.has(ch.topicHex) && !ch.peers.has(remoteKey)) {
          ch.peers.add(remoteKey)
          peer.channels.add(name)
          log(`Matched channel "${name}" with peer ${remoteKey.slice(0, 12)}`)
          // Send sync request for persistent channels
          if (ch.persist) {
            this._sendSyncReq(peer.conn, name, ch)
          }
        }
      }
      return
    }

    if (msg.t === 'msg') {
      for (const [name, ch] of this.channels) {
        if (ch.topicHex === msg.topic) {
          const msgId = msg.msgId || `${msg.id}-${msg.ts}`
          const entry = { from: msg.from || msg.id || remoteKey.slice(0, 8), data: msg.data, ts: msg.ts, id: msgId, seq: ++ch.seq, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}), ...(msg.to ? { to: msg.to } : {}) }
          // Dedup for persistent channels
          if (ch.persist) {
            if (ch.knownMsgIds.has(msgId)) break
            ch.knownMsgIds.add(msgId)
            store.append(name, entry)
          }
          this._notifyReplyWaiters(ch, entry)
          this._deliverLocal(ch, entry, null, null, entry.to)
          break
        }
      }
      return
    }

    if (msg.t === 'sync_req') {
      for (const [name, ch] of this.channels) {
        if (ch.topicHex === msg.topic && ch.persist) {
          const cutoff = Date.now() - TTL_MS
          const since = Math.max(msg.since || 0, cutoff)
          const messages = store.read(name, since)
          if (peer.conn?.writable) {
            peer.conn.write(JSON.stringify({
              t: 'sync_resp',
              topic: ch.topicHex,
              messages
            }) + '\n')
            log(`Sent sync_resp to ${remoteKey.slice(0, 12)}: ${messages.length} msg(s)`)
          }
          break
        }
      }
      return
    }

    if (msg.t === 'sync_resp') {
      for (const [name, ch] of this.channels) {
        if (ch.topicHex === msg.topic && ch.persist) {
          let added = 0
          for (const entry of (msg.messages || [])) {
            const msgId = entry.id || `${entry.from}-${entry.ts}`
            if (ch.knownMsgIds.has(msgId)) continue
            ch.knownMsgIds.add(msgId)
            entry.id = msgId
            store.append(name, entry)
            this._notifyReplyWaiters(ch, entry)
            this._deliverLocal(ch, entry, null)
            added++
          }
          log(`Sync from ${remoteKey.slice(0, 12)}: ${added} new msg(s) for "${name}"`)
          break
        }
      }
      return
    }
  }

  _sendSyncReq(conn, channelName, ch) {
    let since = 0
    const msgs = store.read(channelName, 0)
    if (msgs.length > 0) since = msgs[msgs.length - 1].ts
    if (conn?.writable) {
      conn.write(JSON.stringify({ t: 'sync_req', topic: ch.topicHex, since }) + '\n')
    }
  }

  // ── Send ──────────────────────────────────────────────────────────

  _send(channelName, message, senderClientId, replyTo, to) {
    const ch = this.channels.get(channelName)
    if (!ch) throw new Error(`Not in channel: ${channelName}`)

    const ts = Date.now()
    const msgId = `${this.id}-${++this.msgSeq}`
    const payload = JSON.stringify({
      t: 'msg',
      topic: ch.topicHex,
      data: message,
      id: this.id,
      from: senderClientId || this.id,
      msgId,
      ts,
      ...(replyTo ? { replyTo } : {}),
      ...(to ? { to } : {})
    }) + '\n'

    let peerCount = 0
    for (const remoteKey of ch.peers) {
      const peer = this.peers.get(remoteKey)
      if (peer?.conn?.writable) {
        peer.conn.write(payload)
        peerCount++
      }
    }

    // Deliver to local subscribers (excluding sender)
    const entry = { from: senderClientId || this.id, data: message, ts, id: msgId, seq: ++ch.seq, ...(replyTo ? { replyTo } : {}), ...(to ? { to } : {}) }

    // Persist if channel has persistence enabled
    if (ch.persist) {
      ch.knownMsgIds.add(msgId)
      store.append(channelName, entry)
    }

    // Report peer daemons and local subscribers separately: reaching a peer daemon
    // is not the same as any agent having consumed the message.
    this._notifyReplyWaiters(ch, entry)

    const recipients = []
    const localCount = this._deliverLocal(ch, entry, senderClientId, recipients, to)
    return { total: peerCount + localCount, local: localCount, peers: peerCount, recipients, msgId }
  }

  _deliverLocal(ch, entry, excludeId, recipients, only) {
    let count = 0
    for (const [id, sub] of ch.subscribers) {
      if (id === excludeId) continue
      // Directed message: only the addressed subscriber sees it locally.
      if (only && id !== only) continue
      if (recipients) recipients.push(id)
      if (sub.waiters.length > 0) {
        sub.waiters.shift()([entry])
      } else {
        sub.messages.push(entry)
      }
      count++
    }
    return count
  }

  // ── Shutdown ──────────────────────────────────────────────────────

  async shutdown() {
    if (this._compactTimer) clearInterval(this._compactTimer)
    if (this._reapTimer) clearInterval(this._reapTimer)
    try { fs.unlinkSync(IPC_PATH) } catch {}
    try { fs.unlinkSync(PID_FILE) } catch {}
    await this.swarm.destroy()
    process.exit(0)
  }
}

const daemon = new WalkieDaemon()
daemon.start().catch(e => {
  console.error('Failed to start daemon:', e.message)
  process.exit(1)
})
