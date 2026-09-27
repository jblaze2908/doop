import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime.ts'
import { StreamHealer } from '../shared/stream.ts'

declare global {
  interface Window {
    reads: number
  }
}

const rows = Array.from(
  { length: 60 },
  (_, i) =>
    `<section class="row r${i}" data-i="${i}"><h2 id="h${i}">Row ${i}</h2><p>body <b>${i}</b> text</p></section>`,
).join('')
const DOC = `<!doctype html><html><head><style>.row{padding:4px}</style></head><body><main class="page">${rows}<footer><p>end</p></footer></main></body></html>`

/* Real Chrome with the runtime as the top document, as in frameTheme.test.ts. */
describe.skipIf(!findBrowserPath())('frame runtime streaming', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setContent(FRAME_BOOTSTRAP)
    /* count attribute reads on the live document: the morph's per-element cost */
    await page.evaluate(() => {
      window.reads = 0
      const get = Element.prototype.getAttribute
      Element.prototype.getAttribute = function (this: Element, name: string) {
        if (this.ownerDocument === document) window.reads++
        return get.call(this, name)
      }
    })
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  const post = (msg: Record<string, unknown>) =>
    page.evaluate((m) => {
      window.postMessage(m, '*')
      return new Promise((r) => setTimeout(r, 20))
    }, msg)
  /* the live body against a fresh parse of the same html */
  const matchesParse = (html: string) =>
    page.evaluate(
      (h) => document.body.innerHTML === new DOMParser().parseFromString(h, 'text/html').body.innerHTML,
      html,
    )
  const reads = () => page.evaluate(() => window.reads)

  it('stays identical to a full parse after every chunk, touching only the open spine', async () => {
    const healer = new StreamHealer()
    let spineReads = 0
    for (let i = 0; i < DOC.length; i += 97) {
      const html = healer.push(DOC.slice(i, i + 97))
      const before = await reads()
      await post({ type: 'draft:html', html, append: true })
      spineReads = (await reads()) - before
      expect(await matchesParse(html)).toBe(true)
    }
    const before = await reads()
    await post({ type: 'draft:html', html: DOC, append: false })
    const fullReads = (await reads()) - before
    expect(await matchesParse(DOC)).toBe(true)
    /* the last mid-stream render vs a full resync of the same document */
    expect(spineReads * 5).toBeLessThan(fullReads)
  })

  it('falls back to a full morph when the html is not an extension of the last render', async () => {
    const other = '<!doctype html><html><head></head><body><main><h1>Different</h1></main></body></html>'
    await post({ type: 'draft:html', html: other, append: true })
    expect(await matchesParse(other)).toBe(true)
  })

  it('drops the shortcut after another writer changed the DOM', async () => {
    const a = '<!doctype html><html><head></head><body><p id="x">one</p><p>two</p></body></html>'
    await post({ type: 'draft:html', html: a, append: false })
    await post({ type: 'draft:style', reqId: 1, selector: '#x', styles: { color: 'rgb(1, 2, 3)' } })
    /* renders wait out the style edit's save debounce (250 ms) */
    await new Promise((r) => setTimeout(r, 400))
    const b = a.replace('</body>', '<p>three</p></body>')
    await post({ type: 'draft:html', html: b, append: true })
    expect(await matchesParse(b)).toBe(true)
  })
})
