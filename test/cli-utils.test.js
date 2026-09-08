const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const fs = require('fs')
const path = require('path')

// Save/restore env between tests
const ENV_KEYS = ['WALKIE_ID', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'WEZTERM_PANE', 'TMUX_PANE', 'WINDOWID']
let savedEnv
let savedDir
let tmpDir

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  // Point WALKIE_DIR at a scratch dir so the developer's real ~/.walkie/config.json
  // can never influence identity resolution during tests.
  savedDir = process.env.WALKIE_DIR
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-cfg-'))
  process.env.WALKIE_DIR = tmpDir
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    else delete process.env[k]
  }
  if (savedDir !== undefined) process.env.WALKIE_DIR = savedDir
  else delete process.env.WALKIE_DIR
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

// Fresh require each time so env changes take effect
function load() {
  delete require.cache[require.resolve('../src/cli-utils')]
  return require('../src/cli-utils')
}

describe('parseChannelArg', () => {
  it('plain channel name defaults secret to channel', () => {
    const { parseChannelArg } = load()
    assert.deepEqual(parseChannelArg('ops'), { channel: 'ops', secret: 'ops' })
  })

  it('splits on first colon', () => {
    const { parseChannelArg } = load()
    assert.deepEqual(parseChannelArg('ops:mysecret'), { channel: 'ops', secret: 'mysecret' })
  })

  it('preserves colons in secret', () => {
    const { parseChannelArg } = load()
    assert.deepEqual(parseChannelArg('ops:my:complex:secret'), { channel: 'ops', secret: 'my:complex:secret' })
  })

  it('handles empty secret', () => {
    const { parseChannelArg } = load()
    assert.deepEqual(parseChannelArg('ops:'), { channel: 'ops', secret: '' })
  })
})

describe('clientId', () => {
  it('returns WALKIE_ID if set', () => {
    process.env.WALKIE_ID = 'alice'
    const { clientId } = load()
    assert.equal(clientId(), 'alice')
  })

  it('derives 8-char hex from TERM_SESSION_ID', () => {
    process.env.TERM_SESSION_ID = 'some-session-123'
    const { clientId } = load()
    const id = clientId()
    assert.equal(id.length, 8)
    assert.match(id, /^[0-9a-f]{8}$/)
  })

  it('returns undefined when no env vars set', () => {
    const { clientId } = load()
    assert.equal(clientId(), undefined)
  })
})

describe('chatName', () => {
  it('returns WALKIE_ID if set', () => {
    process.env.WALKIE_ID = 'bob'
    const { chatName } = load()
    assert.equal(chatName(), 'bob')
  })

  it('falls back to hostname prefix', () => {
    const { chatName } = load()
    const expected = os.hostname().split('.')[0]
    assert.equal(chatName(), expected)
  })
})

describe('persistent identity', () => {
  it('setIdentity round-trips through config.json', () => {
    const { setIdentity, clientId, configPath } = load()
    setIdentity('migration')
    assert.equal(clientId(), 'migration')
    assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).id, 'migration')
  })

  it('WALKIE_ID takes precedence over config', () => {
    const { setIdentity, resolveIdentity } = load()
    setIdentity('from-config')
    process.env.WALKIE_ID = 'from-env'
    assert.deepEqual(resolveIdentity(), { id: 'from-env', source: 'env' })
  })

  it('config takes precedence over a terminal session hash', () => {
    const { setIdentity, resolveIdentity } = load()
    setIdentity('from-config')
    process.env.TERM_SESSION_ID = 'some-session-123'
    assert.deepEqual(resolveIdentity(), { id: 'from-config', source: 'config' })
  })

  it('falls back to the session hash when nothing is stored', () => {
    process.env.TERM_SESSION_ID = 'some-session-123'
    const { resolveIdentity } = load()
    const { id, source } = resolveIdentity()
    assert.equal(source, 'session')
    assert.match(id, /^[0-9a-f]{8}$/)
  })

  it('reports no identity when there is nothing to go on', () => {
    const { resolveIdentity } = load()
    assert.deepEqual(resolveIdentity(), { id: undefined, source: 'none' })
  })

  it('survives a corrupt config file', () => {
    const { configPath } = load()
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), 'not json at all')
    const { resolveIdentity } = load()
    assert.equal(resolveIdentity().source, 'none')
  })
})

describe('identity stability', () => {
  it('env and config are stable', () => {
    const { setIdentity, isStableIdentity, identityWarning } = load()
    setIdentity('agent-a')
    assert.equal(isStableIdentity(), true)
    assert.equal(identityWarning(), null)
  })

  it('a session hash is flagged unstable', () => {
    process.env.TMUX_PANE = '%3'
    const { isStableIdentity, identityWarning } = load()
    assert.equal(isStableIdentity(), false)
    assert.match(identityWarning(), /change in a new shell/)
  })

  it('no identity is flagged unstable and names the default', () => {
    const { isStableIdentity, identityWarning } = load()
    assert.equal(isStableIdentity(), false)
    assert.match(identityWarning(), /default/)
  })
})

describe('chatName with stored identity', () => {
  it('prefers a stored id over the hostname', () => {
    const { setIdentity, chatName } = load()
    setIdentity('stored-name')
    assert.equal(chatName(), 'stored-name')
  })

  it('ignores an unstable session hash and uses the hostname', () => {
    process.env.TERM_SESSION_ID = 'some-session-123'
    const { chatName } = load()
    assert.equal(chatName(), os.hostname().split('.')[0])
  })
})

describe('makeMessageFilter', () => {
  const sys = { from: 'system', data: 'bob joined' }
  const daemon = { from: 'daemon', data: 'note' }
  const mine = { from: 'alice', data: 'mine' }
  const theirs = { from: 'bob', data: 'theirs' }
  const all = [sys, daemon, mine, theirs]

  function apply(opts) {
    const { makeMessageFilter } = load()
    return all.filter(makeMessageFilter(opts, 'alice')).map(m => m.from)
  }

  it('passes everything by default', () => {
    assert.deepEqual(apply({}), ['system', 'daemon', 'alice', 'bob'])
  })

  it('--no-system drops system and daemon traffic', () => {
    assert.deepEqual(apply({ system: false }), ['alice', 'bob'])
  })

  it('--from-others drops your own messages', () => {
    assert.deepEqual(apply({ fromOthers: true }), ['system', 'daemon', 'bob'])
  })

  it('--from selects a single sender', () => {
    assert.deepEqual(apply({ from: 'bob' }), ['bob'])
  })

  it('filters compose', () => {
    assert.deepEqual(apply({ system: false, fromOthers: true }), ['bob'])
  })

  it('an absent identity still filters against "default"', () => {
    const { makeMessageFilter } = load()
    const msgs = [{ from: 'default', data: 'x' }, { from: 'bob', data: 'y' }]
    const kept = msgs.filter(makeMessageFilter({ fromOthers: true }, 'default'))
    assert.deepEqual(kept.map(m => m.from), ['bob'])
  })

  it('keeps system messages when only --from-others is set', () => {
    // --from-others and --no-system are independent; one must not imply the other.
    assert.ok(apply({ fromOthers: true }).includes('system'))
  })
})

describe('EXIT codes', () => {
  it('keeps 0 and 1 at their historical meanings', () => {
    const { EXIT } = load()
    assert.equal(EXIT.OK, 0)
    assert.equal(EXIT.ERROR, 1)
  })

  it('gives each agent-branchable outcome a distinct code', () => {
    const { EXIT } = load()
    const codes = Object.values(EXIT)
    assert.equal(new Set(codes).size, codes.length, 'exit codes must be unique')
    assert.equal(EXIT.NOT_IN_CHANNEL, 2)
    assert.equal(EXIT.NOTHING_QUEUED, 3)
    assert.equal(EXIT.TIMEOUT, 4)
  })
})

describe('drainAfterWake', () => {
  // Virtual clock: every sleep advances time, so these run instantly and
  // deterministically — no two machines and no wall-clock races needed.
  function harness(script, { settleMs = 200, capMs = 5000 } = {}) {
    let t = 0
    const now = () => t
    const sleep = async (ms) => { t += ms }
    let call = 0
    const read = async () => {
      const batch = script[call++]
      return batch || []
    }
    return { now, sleep, read, settleMs, capMs, calls: () => call }
  }

  it('does NOT stop on the first empty read', async () => {
    // The regression this exists for: at the moment a waiter is woken the buffer is
    // empty, because the waking message went straight to the waiter. Stopping there
    // returns nothing and strands the rest of the burst.
    const { drainAfterWake } = load()
    const h = harness([[], [], [{ data: 'b' }], [{ data: 'c' }]])
    const got = await drainAfterWake(h)
    assert.deepEqual(got.map(m => m.data), ['b', 'c'])
  })

  it('keeps collecting while messages keep arriving', async () => {
    const { drainAfterWake } = load()
    const script = []
    for (let i = 0; i < 10; i++) script.push([], [{ data: `m${i}` }])
    const got = await drainAfterWake(harness(script))
    assert.equal(got.length, 10)
  })

  it('returns once the channel has been quiet for settleMs', async () => {
    const { drainAfterWake } = load()
    // 25ms tick, 200ms settle -> gives up after 8 consecutive empty reads.
    const h = harness([[{ data: 'x' }]], { settleMs: 200 })
    const got = await drainAfterWake(h)
    assert.deepEqual(got.map(m => m.data), ['x'])
    assert.ok(h.calls() <= 12, 'must stop polling once quiet, not spin')
  })

  it('returns nothing when the channel is silent throughout', async () => {
    const { drainAfterWake } = load()
    assert.deepEqual(await drainAfterWake(harness([])), [])
  })

  it('honours capMs under sustained traffic', async () => {
    const { drainAfterWake } = load()
    // Never goes quiet: without a cap this would never return.
    const forever = { read: async () => [{ data: 'flood' }], settleMs: 200, capMs: 1000 }
    let t = 0
    forever.now = () => t
    forever.sleep = async (ms) => { t += ms }
    // Each read returns immediately without sleeping, so advance the clock per read.
    forever.read = async () => { t += 10; return [{ data: 'flood' }] }
    const got = await drainAfterWake(forever)
    assert.ok(got.length > 0)
    assert.ok(t <= 1100, `must stop at the cap, stopped at ${t}ms`)
  })

  it('a longer settle window tolerates wider gaps', async () => {
    const { drainAfterWake } = load()
    // Nine empty 25ms ticks = 225ms of quiet between messages.
    const gap = [[], [], [], [], [], [], [], [], []]
    const script = [...gap, [{ data: 'late' }]]
    assert.deepEqual((await drainAfterWake(harness(script, { settleMs: 200 }))).length, 0,
      'a gap wider than settleMs ends the drain — this is a heuristic, not a guarantee')
    assert.deepEqual((await drainAfterWake(harness(script, { settleMs: 400 }))).map(m => m.data), ['late'])
  })
})

describe('parseClaudeOutput', () => {
  it('extracts the reply from the current array-of-events shape', () => {
    const { parseClaudeOutput } = load()
    const stdout = JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['Bash'] },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }] } },
      { type: 'result', subtype: 'success', result: 'PONG', session_id: 'sess-1' },
    ])
    const r = parseClaudeOutput(stdout)
    assert.equal(r.text, 'PONG')
    assert.equal(r.sessionId, 'sess-1')
  })

  it('never posts a raw JSON event stream into the channel', () => {
    // The actual bug: the array shape fell through to the raw-stdout default and
    // the agent relayed the whole event stream as its reply.
    const { parseClaudeOutput } = load()
    const stdout = JSON.stringify([{ type: 'system', subtype: 'init', session_id: 'x' }])
    const r = parseClaudeOutput(stdout)
    assert.ok(!r.text.includes('"type"'), 'must not leak JSON into the reply')
    assert.equal(r.text, '')
  })

  it('supports the legacy single result object', () => {
    const { parseClaudeOutput } = load()
    const r = parseClaudeOutput(JSON.stringify({ result: 'legacy reply', session_id: 'sess-2' }))
    assert.equal(r.text, 'legacy reply')
    assert.equal(r.sessionId, 'sess-2')
  })

  it('supports newline-delimited stream-json', () => {
    const { parseClaudeOutput } = load()
    const stdout = [
      JSON.stringify({ type: 'system', session_id: 'sess-3' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
      JSON.stringify({ type: 'result', result: 'stream reply' }),
    ].join('\n')
    const r = parseClaudeOutput(stdout)
    assert.equal(r.text, 'stream reply')
    assert.equal(r.sessionId, 'sess-3')
  })

  it('falls back to assistant text when no result event is present', () => {
    const { parseClaudeOutput } = load()
    const stdout = JSON.stringify([
      { type: 'system', session_id: 'sess-4' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'only assistant' }] } },
    ])
    assert.equal(parseClaudeOutput(stdout).text, 'only assistant')
  })

  it('passes plain non-JSON output through unchanged', () => {
    const { parseClaudeOutput } = load()
    assert.equal(parseClaudeOutput('just plain text').text, 'just plain text')
  })

  it('handles empty output', () => {
    const { parseClaudeOutput } = load()
    assert.equal(parseClaudeOutput('').text, '')
    assert.equal(parseClaudeOutput(undefined).text, '')
  })

  it('takes the last result when several appear', () => {
    const { parseClaudeOutput } = load()
    const stdout = JSON.stringify([
      { type: 'result', result: 'first' },
      { type: 'result', result: 'final' },
    ])
    assert.equal(parseClaudeOutput(stdout).text, 'final')
  })
})

describe('parsePiOutput', () => {
  it('extracts session id and the assistant reply from NDJSON events', () => {
    const { parsePiOutput } = load()
    const stdout = [
      JSON.stringify({ type: 'session', id: 'pi-sess-1' }),
      JSON.stringify({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PI ADAPTER WORKS' }] } }),
    ].join('\n')
    const r = parsePiOutput(stdout)
    assert.equal(r.text, 'PI ADAPTER WORKS')
    assert.equal(r.sessionId, 'pi-sess-1')
  })

  it('joins multiple text parts of one message', () => {
    const { parsePiOutput } = load()
    const stdout = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    })
    assert.equal(parsePiOutput(stdout).text, 'ab')
  })

  it('ignores non-assistant messages', () => {
    const { parsePiOutput } = load()
    const stdout = [
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'the reply' }] } }),
    ].join('\n')
    assert.equal(parsePiOutput(stdout).text, 'the reply')
  })

  it('never leaks a raw event stream into the channel', () => {
    // Same failure the claude adapter shipped with (#13): a raw-stdout default
    // relays the event stream as if it were the model's reply.
    const { parsePiOutput } = load()
    const stdout = JSON.stringify({ type: 'session', id: 'pi-sess-2' })
    const r = parsePiOutput(stdout)
    assert.equal(r.text, '')
    assert.equal(r.sessionId, 'pi-sess-2')
    assert.ok(!r.text.includes('"type"'))
  })

  it('passes plain non-JSON output through', () => {
    const { parsePiOutput } = load()
    assert.equal(parsePiOutput('plain reply').text, 'plain reply')
  })

  it('handles empty output', () => {
    const { parsePiOutput } = load()
    assert.equal(parsePiOutput('').text, '')
    assert.equal(parsePiOutput(undefined).text, '')
  })

  it('tolerates interleaved non-JSON lines', () => {
    const { parsePiOutput } = load()
    const stdout = [
      'warning: something on stdout',
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'still works' }] } }),
    ].join('\n')
    assert.equal(parsePiOutput(stdout).text, 'still works')
  })
})

describe('hasRecipient', () => {
  it('a remote peer counts even though its identities are unknown', () => {
    const { hasRecipient } = load()
    assert.equal(hasRecipient({ peers: 1, bufferedBy: { me: 0 } }, 'me'), true)
  })

  it('you alone on the channel is not a recipient', () => {
    const { hasRecipient } = load()
    assert.equal(hasRecipient({ peers: 0, bufferedBy: { me: 0 } }, 'me'), false)
    assert.equal(hasRecipient({ peers: 0, bufferedBy: { me: 7 } }, 'me'), false)
  })

  it('another local subscriber counts, even with an empty buffer', () => {
    const { hasRecipient } = load()
    assert.equal(hasRecipient({ peers: 0, bufferedBy: { me: 0, you: 0 } }, 'me'), true)
  })

  it('--to waits for that specific name, not for anybody', () => {
    const { hasRecipient } = load()
    const info = { peers: 0, bufferedBy: { me: 0, you: 0 } }
    assert.equal(hasRecipient(info, 'me', 'bob'), false)
    assert.equal(hasRecipient(info, 'me', 'you'), true)
  })

  it('--to accepts a peer, since a daemon cannot see names behind a peer link', () => {
    const { hasRecipient } = load()
    assert.equal(hasRecipient({ peers: 2, bufferedBy: { me: 0 } }, 'me', 'bob'), true)
  })

  it('falls back to the subscriber count when bufferedBy is absent', () => {
    const { hasRecipient } = load()
    assert.equal(hasRecipient({ peers: 0, subscribers: 2 }, 'me'), true)
    assert.equal(hasRecipient({ peers: 0, subscribers: 1 }, 'me'), false)
    assert.equal(hasRecipient(undefined, 'me'), false)
  })
})

describe('mintChannel', () => {
  it('secret is 24 hex chars of randomness, not derived from the name', () => {
    const { mintChannel } = load()
    const a = mintChannel('ops')
    const b = mintChannel('ops')
    assert.match(a.secret, /^[0-9a-f]{24}$/)
    assert.notEqual(a.secret, b.secret)
    assert.notEqual(a.channel, b.channel)
  })

  it('keeps the given name as a prefix and suffixes it to avoid collisions', () => {
    const { mintChannel } = load()
    assert.match(mintChannel('ops').channel, /^ops-[0-9a-f]{4}$/)
  })

  it('defaults the prefix and strips characters that would break channel:secret', () => {
    const { mintChannel } = load()
    assert.match(mintChannel().channel, /^duo-[0-9a-f]{4}$/)
    assert.match(mintChannel(':::').channel, /^---[0-9a-f-]*$/)
    assert.equal(mintChannel('a:b c').channel.includes(':'), false)
  })
})

describe('invitePrompt', () => {
  it('bakes the real channel and secret into every command it shows', () => {
    const { invitePrompt } = load()
    const text = invitePrompt({ channel: 'ops-1234', secret: 'deadbeef' })
    assert.match(text, /walkie connect ops-1234:deadbeef/)
    assert.match(text, /walkie next ops-1234/)
    assert.match(text, /walkie leave ops-1234/)
    assert.equal(text.includes('<channel>'), false)
  })

  it('says what this is before it says what to run', () => {
    const { invitePrompt } = load()
    const text = invitePrompt({ channel: 'c', secret: 's' })
    // An agent receiving this may never have heard of walkie. The opening lines have
    // to establish the situation before any command appears, or the first thing it
    // sees is an install instruction for a tool it has no reason to want.
    const firstCommand = text.indexOf('walkie connect')
    const framing = text.indexOf('other AI agents')
    assert.ok(framing !== -1 && framing < firstCommand, 'must explain the point up front')
    assert.match(text.slice(0, firstCommand), /peer to peer|no server/)
  })

  it('carries the three facts agents get wrong on their own', () => {
    const { invitePrompt } = load()
    const text = invitePrompt({ channel: 'c', secret: 's' })
    // Match the fact, not the sentence that carries it — earlier versions of this test
    // pinned exact phrasing and then exact line breaks, and failed twice on rewrites
    // that kept every fact intact. Prose is hard-wrapped, so flatten before matching.
    const flat = text.replace(/\s+/g, ' ')
    // WALKIE_ID on connect too, or you register twice and hear yourself.
    assert.match(text, /WALKIE_ID=<you> walkie connect/)
    // Every connect carries --persist, which is what makes arrival order irrelevant.
    assert.match(text, /walkie connect c:s --persist/)
    assert.match(flat, /catch up|catches up|stores the channel/)
    // A send is not a delivery receipt.
    assert.match(flat, /never proof another agent read it|never that another agent read it/)
  })

  it('never wraps a command across a line break', () => {
    const { invitePrompt } = load()
    // A long channel name must not push part of a command onto the next line — an
    // agent copying `walkie leave` without its channel runs a broken command.
    const text = invitePrompt({ channel: 'a-very-long-channel-name-for-testing', secret: 'x'.repeat(24) })
    for (const line of text.split('\n')) {
      if (!/walkie (connect|send|next|leave)/.test(line)) continue
      assert.ok(/walkie (connect|send|next|leave) \S/.test(line), `command split across lines: ${line}`)
    }
  })

  it('tells the agent to keep listening rather than stop at a message count', () => {
    const { invitePrompt } = load()
    const flat = invitePrompt({ channel: 'c', secret: 's' }).replace(/\s+/g, ' ')
    // Two live sessions parked, said "listener armed, going quiet", and stopped —
    // because the briefing told them to wrap up after ~5 exchanges. A standing
    // channel must not carry a stop condition that fires on volume.
    assert.doesNotMatch(flat, /after ~?\d+ exchanges/i)
    assert.match(flat, /as long as this session is alive/)
    assert.match(flat, /work is genuinely finished/)
  })

  it('is self-sufficient for an agent that has never seen walkie', () => {
    const { invitePrompt } = load()
    const text = invitePrompt({ channel: 'c', secret: 's' })
    const firstCommand = text.indexOf('walkie connect')
    // How to get the tool, and what it does, both before the first thing to run.
    assert.match(text, /npm install -g walkie-sh/)
    assert.ok(text.indexOf('npm install -g walkie-sh') < firstCommand, 'install comes first')
    assert.ok(text.indexOf('daemon') < firstCommand, 'the mechanism is explained up front')
  })
})
