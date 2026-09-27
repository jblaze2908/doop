import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { healPartialHtml, StreamHealer } from '../shared/stream'

/* deterministic PRNG so a failure reproduces */
function rng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
}

const SAMPLES = [
  '<main><h1>Tijori</h1><p>ledger</p></main>',
  '<style>p{color:red}</style><p>a</p><SCRIPT>var x = "</p>"</SCRIPT><p>b</p>',
  '<div><Style media="x">.a{}</STYLE><script src="a.js"></script><script>if (a < b) run()</script></div>',
  '<p>unterminated <b>bold <script>let s = 1<2; <style>x</style>',
  '<p a="1 > 0">gt inside attr</p><!-- <script> in a comment --><p>c</p>',
  readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
]

describe('StreamHealer', () => {
  it('heals every prefix exactly like healPartialHtml, for any chunking', () => {
    const rand = rng(42)
    for (const html of SAMPLES) {
      for (let run = 0; run < 40; run++) {
        const healer = new StreamHealer()
        let raw = ''
        for (let i = 0; i < html.length;) {
          const n = 1 + Math.floor(rand() * (run % 2 ? 3 : 40))
          const chunk = html.slice(i, i + n)
          i += n
          raw += chunk
          expect(healer.push(chunk)).toBe(healPartialHtml(raw))
        }
        expect(healer.length).toBe(html.length)
      }
    }
  })

  it('resumes from text it did not see arrive', () => {
    const healer = new StreamHealer('<p>a</p><scr')
    expect(healer.push('ipt>x')).toBe(healPartialHtml('<p>a</p><script>x'))
  })
})
