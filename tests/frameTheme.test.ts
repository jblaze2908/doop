import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime.ts'

declare global {
  interface Window {
    edited: string[]
  }
}

/* The runtime loaded as the top document: `parent` is the window itself, so
 * the test drives it with window.postMessage and reads its replies the same way.
 * Real Chrome, because the point is the cascade order a DOM emulator fakes. */
describe.skipIf(!findBrowserPath())('frame runtime theme', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setContent(FRAME_BOOTSTRAP)
    await page.evaluate(() => {
      window.edited = []
      window.addEventListener('message', (ev) => {
        if (ev.data?.type === 'draft:edited') window.edited.push(ev.data.html)
      })
    })
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  const post = (msg: Record<string, unknown>) =>
    page.evaluate((m) => {
      window.postMessage(m, '*')
      return new Promise((r) => setTimeout(r, 30))
    }, msg)
  const colorOf = (selector: string) =>
    page.evaluate((s) => getComputedStyle(document.querySelector(s)!).color, selector)

  it('themes a frame, lets the frame win the cascade, and survives re-renders', async () => {
    await post({ type: 'draft:theme', css: ':root{--ink:rgb(0, 0, 255)} p{color:var(--ink)} h1{color:rgb(0, 128, 0)}' })
    await post({
      type: 'draft:html',
      html: '<!doctype html><html><head><style>h1{color:rgb(255, 0, 0)}</style></head><body><h1>T</h1><p>b</p></body></html>',
    })
    expect(await colorOf('p')).toBe('rgb(0, 0, 255)')
    expect(await colorOf('h1')).toBe('rgb(255, 0, 0)')

    await post({ type: 'draft:html', html: '<!doctype html><html><head></head><body><p>again</p></body></html>' })
    expect(await colorOf('p')).toBe('rgb(0, 0, 255)')
    expect(await page.evaluate(() => document.head.firstElementChild?.hasAttribute('data-draft-theme'))).toBe(true)

    await post({ type: 'draft:theme', css: ':root{--ink:rgb(1, 2, 3)} p{color:var(--ink)}' })
    expect(await colorOf('p')).toBe('rgb(1, 2, 3)')
    expect(await page.evaluate(() => document.querySelectorAll('style[data-draft-theme]').length)).toBe(1)
  })

  it("puts utilities after the frame's own styles, so a utility beats the frame's reset", async () => {
    await post({
      type: 'draft:theme',
      css: ':root{--ink:rgb(1, 2, 3)} p{color:var(--ink)}',
      utilities: '.u{color:rgb(9, 9, 9)}',
    })
    await post({
      type: 'draft:html',
      html: '<!doctype html><html><head><style>*{color:rgb(255, 0, 0)}</style></head><body><p class="u">again</p></body></html>',
    })
    expect(await colorOf('p')).toBe('rgb(9, 9, 9)')
    expect(await page.evaluate(() => document.head.lastElementChild?.hasAttribute('data-draft-utilities'))).toBe(true)
    await post({ type: 'draft:html', html: '<!doctype html><html><head></head><body><p>again</p></body></html>' })
  })

  it('never serializes the theme into the frame html', async () => {
    await post({ type: 'draft:edit', on: true })
    await post({ type: 'draft:edit', on: false })
    const html = await page.evaluate(() => window.edited[window.edited.length - 1] ?? '')
    expect(html).toContain('<p>again</p>')
    expect(html).not.toContain('data-draft-theme')
    expect(html).not.toContain('data-draft-utilities')
  })

  it('respects a frame that opts out, and a cleared theme', async () => {
    await post({ type: 'draft:html', html: '<html data-draft-theme="off"><body><p>own</p></body></html>' })
    expect(await colorOf('p')).toBe('rgb(0, 0, 0)')
    await post({ type: 'draft:html', html: '<html><body><p>on</p></body></html>' })
    expect(await colorOf('p')).toBe('rgb(1, 2, 3)')
    await post({ type: 'draft:theme', css: '' })
    expect(await colorOf('p')).toBe('rgb(0, 0, 0)')
  })
})
