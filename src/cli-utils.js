const crypto = require('crypto')
const os = require('os')
const fs = require('fs')
const path = require('path')

// Resolved at call time (not module load) so WALKIE_DIR can be set per-process/test.
function walkieDir() {
  return process.env.WALKIE_DIR || path.join(os.homedir(), '.walkie')
}

function configPath() {
  return path.join(walkieDir(), 'config.json')
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeConfig(patch) {
  fs.mkdirSync(walkieDir(), { recursive: true })
  const next = { ...readConfig(), ...patch }
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n')
  return next
}

// Terminal-session-derived id. Stable within one tab, gone in the next shell —
// which is why it must never be the only mechanism (agents run non-interactive).
function sessionHash() {
  const hint = process.env.TERM_SESSION_ID     // macOS Terminal.app
    || process.env.ITERM_SESSION_ID            // iTerm2
    || process.env.WEZTERM_PANE                // WezTerm
    || process.env.TMUX_PANE                   // tmux
    || process.env.WINDOWID                    // X11 terminals
  if (!hint) return null
  return crypto.createHash('sha256').update(hint).digest('hex').slice(0, 8)
}

// Identity precedence: WALKIE_ID env > ~/.walkie/config.json > terminal session > none.
// Returns where the id came from so callers can warn when it is unstable.
function resolveIdentity() {
  if (process.env.WALKIE_ID) return { id: process.env.WALKIE_ID, source: 'env' }
  const cfg = readConfig()
  if (cfg.id) return { id: cfg.id, source: 'config' }
  const hash = sessionHash()
  if (hash) return { id: hash, source: 'session' }
  return { id: undefined, source: 'none' }
}

function clientId() {
  return resolveIdentity().id
}

function setIdentity(id) {
  writeConfig({ id })
  return id
}

// True when the id would change in a new shell — i.e. anything routing or
// filtering on sender name is keying on an unstable value.
function isStableIdentity() {
  const { source } = resolveIdentity()
  return source === 'env' || source === 'config'
}

function identityWarning() {
  const { id, source } = resolveIdentity()
  if (source === 'env' || source === 'config') return null
  if (source === 'session') {
    return `Identity "${id}" is derived from this terminal session and will change in a new shell.`
  }
  return 'No stable identity — messages will be attributed to "default".'
}

function chatName() {
  const { id, source } = resolveIdentity()
  if (id && source !== 'session') return id
  return os.hostname().split('.')[0]
}

// Build a predicate over message objects. Filtering on objects rather than on
// rendered text avoids the trap that message bodies are unprefixed continuation
// lines, so a naive per-line filter keeps the body of a message whose header it
// just dropped.
function makeMessageFilter(opts = {}, me) {
  return (msg) => {
    if (opts.system === false && (msg.from === 'system' || msg.from === 'daemon')) return false
    if (opts.fromOthers && msg.from === me) return false
    if (opts.from && msg.from !== opts.from) return false
    return true
  }
}

// Exit codes. Agents branch on these instead of string-matching stderr.
// 0/1 keep their historical meanings; the rest are additive.
const EXIT = {
  OK: 0,
  ERROR: 1,           // generic failure, message on stderr
  NOT_IN_CHANNEL: 2,  // channel not joined on this daemon
  NOTHING_QUEUED: 3,  // send reached nobody AND was not persisted (i.e. actually lost)
  TIMEOUT: 4,         // read --wait hit its deadline with nothing matching
}

// Verify a pid actually belongs to a walkie daemon before signalling it. The pid
// file can outlive its process, and the OS recycles pids — without this check a
// stale pid file means walkie SIGKILLs whatever unrelated process inherited it.
function isWalkieProcess(pid) {
  if (!pid || Number.isNaN(pid)) return false
  // No cheap cmdline probe on Windows; fall back to trusting the pid file there.
  if (process.platform === 'win32') return true
  try {
    const out = require('child_process').execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return /walkie|daemon\.js/.test(out)
  } catch {
    return false
  }
}

// Collect the rest of a burst after a --wait wake.
//
// The naive version — read once, stop on the first empty reply — is worthless: at
// the instant a waiter is woken the buffer is empty, because the waking message went
// straight to the waiter and the rest of the burst has not landed yet. So it always
// stops immediately and returns nothing.
//
// Instead, keep reading until the channel has been quiet for settleMs. Every arrival
// resets that timer, so a burst with gaps smaller than the settle window is collected
// whole. capMs bounds the total wait so sustained traffic cannot block forever.
//
// read/sleep/now are injected so this is testable without two machines.
async function drainAfterWake({ read, settleMs = 200, capMs = 5000, sleep, now = () => Date.now() }) {
  const collected = []
  const deadline = now() + capMs
  let lastArrival = now()
  const tick = Math.max(1, Math.min(25, settleMs))

  while (now() - lastArrival < settleMs && now() < deadline) {
    const msgs = await read()
    if (msgs && msgs.length > 0) {
      collected.push(...msgs)
      lastArrival = now()
    } else {
      await sleep(tick)
    }
  }
  return collected
}

// Extract the reply text from `claude -p --output-format json`.
//
// The current CLI returns a single-line JSON ARRAY of events
// ([system/init, ...assistant, result]) and the reply lives on the element with
// type "result". Older CLIs returned one result object, and stream-json emits
// newline-delimited objects. Parsing line-by-line for a top-level `.result`
// matches none of the array shape, so `text` kept its raw-stdout default and the
// agent posted the entire JSON event stream into the channel.
//
// Never fall back to raw stdout when the output parsed as JSON: dumping an event
// stream into a channel is worse than saying nothing. Plain-text output (not JSON
// at all) is still passed through, since that is legitimate CLI output.
function parseClaudeOutput(stdout) {
  const trimmed = (stdout || '').trim()
  const out = { text: trimmed, sessionId: null }
  if (!trimmed) return out

  let resultText = null
  let assistantText = null

  const apply = (obj) => {
    if (!obj || typeof obj !== 'object') return
    if (obj.session_id) out.sessionId = obj.session_id
    if (typeof obj.result === 'string') resultText = obj.result
    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      const text = obj.message.content
        .filter(c => c && c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text).join('').trim()
      if (text) assistantText = text
    }
  }

  let whole
  let wasJson = false
  try { whole = JSON.parse(trimmed); wasJson = true } catch {}

  if (Array.isArray(whole)) whole.forEach(apply)
  else if (whole && typeof whole === 'object') apply(whole)
  else {
    for (const line of trimmed.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { apply(JSON.parse(t)); wasJson = true } catch {}
    }
  }

  if (resultText !== null) out.text = resultText
  else if (assistantText !== null) out.text = assistantText
  else if (wasJson) out.text = ''   // parsed as JSON but carried no reply — post nothing

  return out
}

// Extract the reply text and session id from `pi -p --mode json`, which emits
// newline-delimited events: a `session` event carrying the id, then assistant
// messages whose text parts accumulate into the reply.
//
// Same discipline as parseClaudeOutput and for the same reason (issue #13): when the
// output parsed as JSON but carried no assistant text, return empty rather than
// falling back to raw stdout. A raw-stdout default is how an adapter ends up relaying
// an event stream into the channel as if it were the model's reply.
function parsePiOutput(stdout) {
  const trimmed = (stdout || '').trim()
  const out = { text: trimmed, sessionId: null }
  if (!trimmed) return out

  let assistantText = null
  let wasJson = false

  for (const line of trimmed.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let obj
    try { obj = JSON.parse(t) } catch { continue }
    wasJson = true
    if (!obj || typeof obj !== 'object') continue
    if (obj.type === 'session' && obj.id) out.sessionId = obj.id
    const msg = obj.message
    if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
      const text = msg.content
        .filter(c => c && c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text).join('')
      if (text) assistantText = text
    }
  }

  if (assistantText !== null) out.text = assistantText
  else if (wasJson) out.text = ''

  return out
}

// True when a channel has somebody to deliver to besides the caller. `bufferedBy`
// is keyed by every local subscriber (count may be 0), so its keys are the local
// roster; `peers` is a connection count, since a daemon never learns the identities
// behind a remote peer. Used by `send --wait-for-peer`, which polls status rather
// than retrying the send: a retry loop would re-run every side effect of a send
// (seq, persisted history) once per attempt for a message nobody receives.
// `want` narrows it to one named subscriber, for a directed send. A remote peer
// still counts there: the daemon cannot see the names behind a peer connection, so
// refusing to proceed would hang on a channel where the target is simply not local.
function hasRecipient(info, me, want) {
  if (!info) return false
  if (info.peers > 0) return true
  const by = info.bufferedBy
  if (by && typeof by === 'object') {
    const ids = Object.keys(by)
    return want ? ids.includes(want) : ids.some(id => id !== me)
  }
  return want ? false : (info.subscribers || 0) > 1
}

// A random channel/secret pair. The secret is what protects the channel: topics are
// SHA-256(channel+secret) on a public DHT, so anything guessable is world-readable.
function mintChannel(name) {
  const base = (name || 'duo').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'duo'
  return {
    channel: `${base}-${crypto.randomBytes(2).toString('hex')}`,
    secret: crypto.randomBytes(12).toString('hex'),
  }
}

// The prompt a human pastes into the FIRST agent session. It is deliberately short:
// its whole job is to get that session to run `walkie invite`, which then prints the
// real briefing. Kept here as the single source of truth because it also appears in
// README.md and docs/index.html, and a test asserts all three match — a stale copy on
// the website is worse than none, since that is where new users get it.
function starterPrompt() {
  return `You are being connected to other AI agents working in other terminal sessions,
possibly on other machines, so you can talk to each other directly — ask
questions, hand off work, coordinate. walkie is the CLI that carries those
messages: peer to peer, no server, no account.

Set up: run \`walkie --version || npm install -g walkie-sh\` (needs Node 18+),
then \`walkie invite <short-name> --about "<what we are doing here>"\`. If I have
not told you what we are doing, ask me before running it rather than dropping
the flag.

That prints a briefing. Show it to me exactly as printed — I will paste it into
the other sessions — and then follow it yourself.`
}

// The paste-able briefing `walkie invite` prints. It exists because every agent that
// joins a channel needs the same six facts, and hand-written versions keep getting
// them wrong in the same places: dropping WALKIE_ID from `connect` (which registers
// two identities and echoes your own messages back), assembling the read primitive
// out of four flags, and treating a send as proof of delivery.
function invitePrompt({ channel, secret, about }) {
  // Channel names vary in length, so the trailing comments are aligned at render
  // time rather than hard-coded — a ragged command block reads as carelessness in
  // the one part of this text the reader is meant to copy exactly.
  const cmds = [
    ['walkie --version || npm install -g walkie-sh', 'Node 18+'],
    [`WALKIE_ID=<you> walkie connect ${channel}:${secret} --persist`, null],
    [`WALKIE_ID=<you> walkie send ${channel} "who you are, what you are working on"`, null],
    [`WALKIE_ID=<you> walkie next ${channel}`, 'blocks until someone else speaks'],
  ]
  const width = Math.max(...cmds.map(([c]) => c.length))
  const block = cmds
    .map(([c, note]) => `    ${note ? c.padEnd(width) + '   # ' + note : c}`)
    .join('\n')

  // A channel with no stated purpose does not produce an idle conversation — it
  // produces an invented one. Two agents given this briefing with no task spent
  // twenty-one messages benchmarking walkie itself, each having first said out loud
  // that inventing work would be wrong. So the purpose is either supplied here, or
  // its absence is named and the agents are told what to do about it.
  const purpose = about
    ? `\nWhat this channel is for: ${about}\n`
    : `\nNo task set yet: say so, stay available, and ask your human for one — do not
invent work to fill the silence.\n`

  return `You are being connected to other AI agents working in other terminal sessions,
possibly on other machines, so you can talk directly — ask questions, hand off
work, coordinate. walkie carries the messages: peer to peer, no server, no account.
${purpose}
Pick a short lowercase name for yourself from the repo or task you are on, tell me
what it is, and use it as WALKIE_ID on every command below — \`connect\` included, or
the daemon counts you twice and your own messages come back to you.

${block}

\`--persist\` stores the channel, so anyone can arrive late and catch up. Introduce
yourself right away — no first speaker, nothing to wait for. Then loop: run
\`walkie next ${channel}\` in the BACKGROUND (run_in_background=true), reply when it
returns, and immediately re-arm another.

Messages cross in flight, so read again before claiming what anyone did or did not
do; a send is never proof another agent read it. After ~5 exchanges, or when the
others are done, run \`WALKIE_ID=<you> walkie leave ${channel}\` and summarize for me.`
}

function parseChannelArg(str) {
  const idx = str.indexOf(':')
  if (idx === -1) return { channel: str, secret: str }
  return { channel: str.slice(0, idx), secret: str.slice(idx + 1) }
}

module.exports = {
  clientId,
  chatName,
  parseChannelArg,
  makeMessageFilter,
  hasRecipient,
  mintChannel,
  invitePrompt,
  starterPrompt,
  EXIT,
  isWalkieProcess,
  drainAfterWake,
  parseClaudeOutput,
  parsePiOutput,
  resolveIdentity,
  setIdentity,
  isStableIdentity,
  identityWarning,
  configPath,
  readConfig,
  writeConfig,
}
