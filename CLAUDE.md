# CLAUDE.md

## Project

walkie — P2P communication CLI for AI agents. npm package: `walkie-sh`.

## Architecture

- `bin/walkie.js` — CLI entry point (commander). Version is here AND in `package.json` (keep in sync)
- `src/api.js` — **Programmatic API** (`require('walkie-sh')`). Exports `listen()` and `send()`. Uses daemon IPC under the hood.
- `src/daemon.js` — background daemon managing Hyperswarm P2P + local subscriber routing
- `src/client.js` — IPC client, handles daemon auto-start and stale socket cleanup
- `src/crypto.js` — topic derivation (SHA-256 of channel+secret)
- `src/cli-utils.js` — identity resolution (`WALKIE_ID` > `~/.walkie/config.json` > terminal session), channel arg parsing, message filters
- `src/slack.js` — Slack <-> walkie bridge over Socket Mode (`walkie slack`)
- `src/web.js` — HTTP + WebSocket server bridging browser clients to daemon
- `src/web-ui.js` — exports HTML string for web chat UI (minimal, terminal-style)

## Programmatic API

`package.json` `"main"` points to `src/api.js`. Node apps can `require('walkie-sh')`:

```js
const walkie = require('walkie-sh')

// Listen on a channel (EventEmitter — emits 'message' and 'error')
const ch = await walkie.listen('mychannel:secret', { id: 'mybot' })
ch.on('message', async (msg) => {
  // msg: { from: string, data: string, ts: number, id: string }
  await ch.send('response')
})
await ch.close()

// One-shot send (auto-joins if secret provided)
await walkie.send('mychannel:secret', 'hello', { id: 'sender' })
```

- `listen()` joins the channel, starts streaming via `streamMessages()`, filters own messages, returns a `WalkieChannel` (EventEmitter + `send()` + `close()`)
- `send()` auto-joins and fires a single message — good for scripts/CI
- Both auto-start the daemon if not running

## Testing

`npm test` — 120 automated tests using `node:test` (zero extra deps). Covers crypto, store, CLI utils, daemon IPC, web server, and programmatic API.

`npm run test:p2p` — manual P2P integration test (two daemons, Hyperswarm discovery, ~30s).

Manual same-machine test with two identities:
```bash
walkie stop
WALKIE_ID=alice walkie connect test:secret
WALKIE_ID=bob walkie connect test:secret
WALKIE_ID=alice walkie send test "hello"
WALKIE_ID=bob walkie read test
```

## Publishing

Publishing runs in CI via **npm trusted publishing (OIDC)** — no NPM_TOKEN, no 2FA
code, nothing secret in the repo. `.github/workflows/publish.yml` fires on a `v*` tag,
checks the tag matches `package.json`, runs the suite, then publishes.

```bash
# bump version in package.json AND bin/walkie.js, commit, then:
git tag v1.6.5 && git push origin v1.6.5
```

A published version sits in npm's automated review as **Validating** for a few
minutes and is genuinely 404 until it clears — that is not a failed publish. The
local npm cache also serves a stale packument right after, so `npm i pkg@newversion`
can claim "no matching version" while `npm pack` succeeds; use `--prefer-online`.

Requires a Trusted Publisher configured once at npmjs.com -> walkie-sh -> Settings:
user `vikasprogrammer`, repo `walkie`, workflow `publish.yml`, action `npm publish`.

Local `npm publish` still works but needs a 2FA code (`npm publish --otp=NNNNNN`) and
the `vikasprogrammer` account — not the machine's default login. Prefer the tag.

Background: npm is deprecating 2FA-bypass granular access tokens — they lost the
2FA skip for sensitive operations in August 2026 and lose direct publish around
January 2027. Trusted publishing is the replacement, so do not add a publish token.

## Git

Remote uses SSH alias: `git@github-vikasprogrammer:vikasprogrammer/walkie.git`

## Skill

- Skill source: `skills/walkie/`
- The test copy at `/Users/vikas/Playground/random/walkie-test/.agents/skills/walkie` is a
  **symlink** to `skills/walkie/` — editing the source is enough, there is nothing to sync

## Website

`docs/index.html` — single-page static site at walkie.sh

Deploy:
```bash
instapods deploy walkie --local docs --preset static
```

## Key decisions

- `walkie pair` was removed in v1.7.0: it was two `walkie agent` invocations plus a
  kickoff task, i.e. a second orchestration path to keep working for no capability the
  first did not already have. Precedent for removing a command in a minor is v1.3.0
  (`--as`). Its 1.6.0 changelog entry stays — a changelog records what shipped
- `--await-reply` implies `--wait-for-peer` and the timeout is one overall deadline
  across both halves. Awaiting a reply on an empty channel could only ever fail: the
  send exits 3 before any waiting happens
- `chat`/`agent`/`slack` default the secret to the channel name, so `walkie chat standup`
  is joinable by anyone who guesses "standup" on the public DHT. Kept for casual use but
  it now warns — the failure is invisible from inside the channel
- `walkie watch` defaults to JSONL and inverts with `--pretty`, the opposite of
  read/log/next. The default cannot change without breaking scripts, so `--json` is
  accepted as a no-op alias; the flag now means the same thing on every command
- Reaping a subscriber keeps its `lastReadTs` in a bounded `ch.readMarks` map. Without
  it a reaped identity re-registers at 0 and a persistent channel replays its whole
  history as new — a returning agent re-processes and re-replies to the entire
  conversation. The mark is one timestamp, far cheaper than the subscriber it replaces
- The invite briefing must not carry a stop condition that fires on message count.
  "After ~5 exchanges, leave" made two live sessions park and go silent while still
  believing they were listening; a standing channel ends when the work does
- A send on a `--persist` channel is stored *before* delivery is attempted, so
  "reached nobody" is not "lost". It reports `Stored` and exits 0; exit 3 is reserved
  for a message that is genuinely gone. The daemon's send reply carries `persisted` so
  the CLI can tell those apart. This is also why the invite briefing uses `--persist`
  and no longer needs `--wait-for-peer`: with the store in play, arrival order stops
  mattering and there is no window for the first greeting to fall into
- `walkie invite` does **not** join the channel it mints (`--join` opts in). An inviter
  who joins is a subscriber that never reads: it satisfies another agent's
  `send --wait-for-peer`, which then delivers the opening message into a buffer nobody
  drains — the exact failure that flag exists to prevent. Caught only by running the
  real paste-this-into-two-sessions flow end to end; every unit test passed
- `walkie invite` mints a channel + random 12-byte secret and prints a
  paste-able briefing (`cli-utils.invitePrompt`) for other agents. It exists because
  every hand-written version of that briefing got the same three things wrong:
  dropping `WALKIE_ID` from `connect` (two identities, own messages echo back),
  rebuilding the read primitive out of four flags, and treating a send as delivery.
  The briefing lives in cli-utils so it is unit-testable, not inline in bin
- `walkie next <ch>` == `read --wait --from-others --no-system --drain`. That
  incantation is the agent loop primitive; making agents assemble it from four flags
  is where they get it wrong (plain `--wait` burns its wake on your own join notice).
  `read` and `next` share one `runRead` implementation
- `send --wait-for-peer [s]` polls `status` until `hasRecipient` is true, then sends
  once. It must not retry the send: a send with no recipients is still a send — it
  burns a seq and appends to persisted history — so a retry loop would write the same
  message into `walkie log` once per attempt for a message nobody received. On
  timeout it falls through and sends anyway, so the "Queued nowhere" exit 3 is
  unchanged; a wait that silently swallowed the message would be worse than no flag
- A daemon cannot name remote participants: `peers` is a connection count and
  `subscribers` is local-only. `hasRecipient(info, me, want)` therefore treats any
  peer as satisfying a `--to` wait — refusing would hang whenever the target is
  simply not on this machine. Real presence needs protocol-level gossip
- No `--as` flag (removed in v1.3.0)
- Identity resolves `WALKIE_ID` env > `~/.walkie/config.json` > terminal-session hash > none.
  Env-only was not viable: `~/.bashrc` returns early for non-interactive shells, so agents
  silently fell back to an unstable per-session hash. `walkie connect` bootstraps the
  hostname; `walkie whoami [--set]` inspects and sets it
- Auto-derived subscriber IDs from terminal session env vars (v1.2.0)
- `--wait` blocks indefinitely, `--timeout` is optional. With filters, `--wait` keeps
  waiting through filtered-out traffic and `--timeout` is the overall deadline
- `send` reports "Queued at ..." not "delivered" — reaching a peer daemon is not evidence
  that any agent consumed the message. The IPC reply keeps `delivered` for the API/web client
  and adds `peerDaemons` / `localSubscribers`
- Exit codes are meaningful, not just 0/1: `2` not in channel, `3` send reached nobody,
  `4` `read --wait` timed out. Defined once in `src/cli-utils.js` as `EXIT`
- A `--wait` wake carries one message. `read --drain` polls until the channel is quiet
  for `--settle` ms (default 200). The first implementation read once and stopped on
  the first empty reply, which never worked: at the instant of a wake the buffer is
  empty by construction, so it always returned nothing in exactly the case it existed
  for. The algorithm lives in `cli-utils.drainAfterWake` with injected read/sleep/now
  so it is unit-testable on one machine — see `test/cli-utils.test.js`
- `send --await-reply` is served by a daemon-side waiter (`awaitReply` IPC action +
  a bounded `recentReplies` cache per channel), matched at delivery time before
  subscriber buffers. The first implementation polled with `--peek` and failed
  whenever any other reader consumed the reply first — including the background
  `read --wait` the docs recommend — reporting "no reply" while the answer sat in
  another process's output. An ack that silently times out is worse than no ack
- `--drain` is a heuristic and must never be documented or described as a completeness
  guarantee. A flag that implies "you have everything" is worse than no flag, because
  an agent that knows it might be behind will re-read and one holding the flag will not
- `status` reports `bufferedBy` per subscriber — aggregate `buffered` cannot answer
  "do *I* have unread?" when several identities share one daemon
- Known quirk: a joiner receives its own `X joined` system notice, because the subscriber
  is registered before the announcement and `_send` only excludes the literal `system`
  sender. Filter with `--no-system`
- Messages carry a per-channel `seq`, monotonic in the order **this daemon** saw them.
  Deliberately local: independent daemons cannot agree a shared sequence without
  consensus, so a conditional send like `--if-seen N` is not implementable here.
  `send --warn-if-unread` and `--await-reply` are the locally decidable equivalents
- Subscribers are reaped when idle past `WALKIE_SUBSCRIBER_TTL_MS` (1h default) **and**
  holding nothing — never when a message or waiter would be lost
- Tests derive a random secret per run (`test/helpers.js` `SECRET`). Topics are
  SHA-256(channel+secret) on the public DHT, so fixed secrets let stray daemons join
  test channels and skew assertions
- Every agent-CLI adapter parses through a `parse*Output` helper in cli-utils
  (`parseClaudeOutput`, `parsePiOutput`), and none may default `text` to raw stdout.
  That default is what made the agent relay a JSON event stream as its reply (#13); a
  payload that parsed as JSON but carried no message must yield empty text instead
- `claude -p --output-format json` has TWO shapes in the wild: current CLIs return a
  single-line JSON **array** of events (reply on the `type: "result"` element), older
  ones a single result object. `cli-utils.parseClaudeOutput` handles both plus
  newline-delimited stream-json, and posts **nothing** when the payload parses as JSON
  but carries no reply — dumping an event stream into a channel is worse than silence.
  It lives in cli-utils, not inline in bin, so it is unit-testable; it was refactored
  twice while broken because nothing could reach it (issue #13, diagnosed in PR #14)
- Do NOT merge the semgrep-driven "harden child_process" change to `execForMessage`
  (PR #18). Replacing `execSync(cmd)` with `execFileSync('/bin/sh', ['-c', '$WALKIE_CMD'])`
  breaks `watch --exec`: quotes stop being interpreted and `$WALKIE_MSG` no longer
  expands, which is the flag's entire purpose. The command comes from the user's own
  CLI flag, so there is no untrusted input to sanitize. Its second half (using execFile
  for the `--open` URL) is directionally right but breaks Windows, where `start` is a
  shell builtin and not an executable
- walkie carries messages, not authority. Relayed human approval is not approval;
  see the closing section of `skills/walkie/references/commands.md`
- The daemon logs uncaught exceptions/rejections to `~/.walkie/daemon.log` and the client
  spawns it with stderr pointed at that file. Do not go back to `stdio: 'ignore'`: a daemon
  that crashed after `start()` previously left only a clean "Daemon started" line, which is
  why issue #11 could not be diagnosed by anyone
- Windows IPC pipe name is derived from `WALKIE_DIR` (it used to be a fixed global name, so
  every instance on the machine shared one pipe)
- `walkie web` binds **127.0.0.1** by default (`--host` to widen, which warns). `GET /state`
  is unauthenticated and returns channel secrets plus message history, so a wider bind
  hands the network the keys to every channel the UI has touched. Do not change this
  default; if `/state` ever needs to be reachable, authenticate it first
- `walkie web` uses read-wait loops per channel (no daemon changes needed for real-time)
- Web client identity: `web-{random8hex}`, renameable via header click
- Web session state (channels, secrets, name) persisted in **localStorage**
  (`walkie:web:state:v1`); the server `/state` endpoint is a legacy fallback used only when
  the localStorage write fails, plus a `beforeunload` sendBeacon flush so the 500ms save
  debounce cannot lose messages on close
- `ws` npm package added as 3rd dependency
- Programmatic API (`src/api.js`) wraps `client.js` functions — no new deps, uses existing daemon IPC
- `package.json` `"main": "./src/api.js"` makes `require('walkie-sh')` return the API (not the CLI)
