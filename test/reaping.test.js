const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { createTempDir, ipc, startDaemon, stopDaemon, cleanupDir, SECRET } = require('./helpers')

// A dedicated daemon with a very short subscriber TTL, so reaping is observable in a
// test rather than an hour away.
let tmpDir, sockPath, savedTtl

before(async () => {
  savedTtl = process.env.WALKIE_SUBSCRIBER_TTL_MS
  process.env.WALKIE_SUBSCRIBER_TTL_MS = '400'
  tmpDir = createTempDir()
  const d = await startDaemon(tmpDir)
  sockPath = d.sockPath
})

after(async () => {
  await stopDaemon(sockPath)
  cleanupDir(tmpDir)
  if (savedTtl === undefined) delete process.env.WALKIE_SUBSCRIBER_TTL_MS
  else process.env.WALKIE_SUBSCRIBER_TTL_MS = savedTtl
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

describe('subscriber reaping', () => {
  it('does not replay history to an identity that was reaped and came back', async () => {
    const ch = 'reap-replay'
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'reader', persist: true })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'writer', persist: true })
    await ipc(sockPath, { action: 'send', channel: ch, message: 'one', clientId: 'writer' })

    const first = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'reader' })
    assert.ok(first.messages.some(m => m.data === 'one'), 'reader should get the first message')

    // Idle past the TTL with nothing buffered and no waiter: the reaper takes it.
    await sleep(1200)
    await ipc(sockPath, { action: 'send', channel: ch, message: 'two', clientId: 'writer' })

    const second = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'reader' })
    const texts = second.messages.map(m => m.data)
    // The whole point: a reaped identity re-registers at lastReadTs 0, and on a
    // persistent channel that used to replay the entire conversation as if it were
    // new — so a returning agent would re-process and re-reply to everything.
    assert.deepEqual(texts.filter(t => t === 'one'), [], 'must not replay already-read messages')
    assert.ok(texts.includes('two'), 'must still deliver what actually arrived')
  })

  it('never reaps a subscriber that is holding a message', async () => {
    const ch = 'reap-holding'
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'idle' })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'sender' })
    await ipc(sockPath, { action: 'send', channel: ch, message: 'held', clientId: 'sender' })

    await sleep(1200)
    const r = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'idle' })
    // Filter the join notice: a joiner's own "X joined" is expected traffic here.
    const real = r.messages.filter(m => m.from !== 'system').map(m => m.data)
    assert.deepEqual(real, ['held'], 'a buffered message must survive the TTL')
  })
})
