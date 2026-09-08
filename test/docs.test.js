const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const { starterPrompt } = require('../src/cli-utils')

// The starter prompt is published in three places. A copy that drifts is worse than
// no copy: the website is where someone meets walkie for the first time, and a prompt
// that references a flag or command the CLI no longer has fails on their first try.
describe('published starter prompt', () => {
  it('README carries it verbatim', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    assert.ok(readme.includes(starterPrompt()), 'README.md is out of date with cli-utils.starterPrompt()')
  })

  it('the website carries it verbatim', () => {
    const html = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8')
    const m = html.match(/<pre id="starter-prompt"[^>]*>([\s\S]*?)<\/pre>/)
    assert.ok(m, 'docs/index.html has no #starter-prompt block')
    // The page stores it HTML-escaped; the copy button hands over textContent, which
    // is the unescaped form — so that is what has to match.
    const unescaped = m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
    assert.equal(unescaped, starterPrompt())
  })

  it('the copy button targets a block that exists', () => {
    const html = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8')
    for (const [, id] of html.matchAll(/class="copy-btn"[^>]*data-target="([^"]+)"/g)) {
      assert.ok(html.includes(`id="${id}"`), `copy button targets missing #${id}`)
    }
  })

  it('every command the starter tells an agent to run actually exists', () => {
    const bin = fs.readFileSync(path.join(root, 'bin/walkie.js'), 'utf8')
    // `walkie invite --about` is the pair the last live test got wrong; if either the
    // command or the flag is renamed, the published prompt must fail here first.
    assert.match(starterPrompt(), /walkie invite <short-name> --about/)
    assert.ok(bin.includes(".command('invite [target]')"), 'invite command missing')
    assert.ok(bin.includes("--about <text>"), 'invite --about flag missing')
  })
})
