import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime.ts'
import { prepareFrameHtml, type ComponentRuntimeDef } from '../shared/components.ts'

declare global {
  interface Window {
    edited: string[]
  }
}

const THEME = ':root{--ink:rgb(0, 0, 255)} .t{color:var(--ink)}'
const stat = (over: Partial<ComponentRuntimeDef> = {}): ComponentRuntimeDef => ({
  name: 'ds-stat',
  html: '<b class="t">{{label}}</b><i><slot></slot></i>',
  css: ':host{display:block} :host([tone="loss"]) i{color:rgb(255, 0, 0)}',
  props: [{ name: 'label', default: 'Label' }, { name: 'tone' }],
  version: 1,
  ...over,
})
const DOC = '<!doctype html><html><head></head><body><ds-stat label="Net worth">₹18</ds-stat></body></html>'

/* What an instance rendered: its shadow text and computed colours. */
function readInstance(page: Page, selector = 'ds-stat') {
  return page.evaluate((s) => {
    const host = document.querySelector(s)!
    const root = host.shadowRoot
    const b = root?.querySelector('b')
    const i = root?.querySelector('i')
    return {
      text: root?.textContent ?? null,
      label: b?.textContent ?? null,
      labelColor: b ? getComputedStyle(b).color : null,
      slotColor: i ? getComputedStyle(i).color : null,
      slotted: (root?.querySelector('slot') as HTMLSlotElement | null)?.assignedNodes().map((n) => n.textContent) ?? [],
    }
  }, selector)
}

describe.skipIf(!findBrowserPath())('component runtime', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setContent(FRAME_BOOTSTRAP)
    await page.evaluate(() => {
      window.edited = []
      window.addEventListener('message', (ev) => {
        if (ev.data?.type === 'doop:edited') window.edited.push(ev.data.html)
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

  it('renders slots and props with the theme inside the shadow root', async () => {
    await post({ type: 'doop:theme', css: THEME })
    await post({ type: 'doop:components', defs: [stat()] })
    await post({ type: 'doop:html', html: DOC })
    expect(await readInstance(page)).toEqual({
      text: 'Net worth',
      label: 'Net worth',
      labelColor: 'rgb(0, 0, 255)',
      slotColor: 'rgb(0, 0, 0)',
      slotted: ['₹18'],
    })
  })

  it('re-renders on attribute changes from a morph and on a new definition', async () => {
    await post({
      type: 'doop:html',
      html: DOC.replace('label="Net worth"', 'label="Liabilities" tone="loss"'),
    })
    expect(await readInstance(page)).toMatchObject({ label: 'Liabilities', slotColor: 'rgb(255, 0, 0)' })
    await post({
      type: 'doop:components',
      defs: [stat({ version: 2, html: '<b class="t">[{{label}}]</b><i><slot></slot></i>' })],
    })
    expect((await readInstance(page)).label).toBe('[Liabilities]')
  })

  it('keeps frame HTML linked: serialize() sees only the light DOM', async () => {
    await post({ type: 'doop:edit', on: true })
    await post({ type: 'doop:edit', on: false })
    const html = await page.evaluate(() => window.edited[window.edited.length - 1] ?? '')
    expect(html).toContain('<ds-stat label="Liabilities" tone="loss">₹18</ds-stat>')
    expect(html).not.toContain('<b class="t">')
  })

  it('shows a visible fallback for a deleted component and for runaway nesting', async () => {
    await post({ type: 'doop:components', defs: [stat({ version: 3, deletedAt: 1 })] })
    expect((await readInstance(page)).text).toBe('Missing component: <ds-stat> ')
    await post({
      type: 'doop:components',
      defs: [stat({ version: 4 }), { name: 'ds-loop', html: '<ds-loop></ds-loop>', css: '', props: [], version: 1 }],
    })
    await post({ type: 'doop:html', html: DOC.replace('</body>', '<ds-loop></ds-loop></body>') })
    const deepest = await page.evaluate(() => {
      let el: Element | null | undefined = document.querySelector('ds-loop')
      let text = ''
      for (let n = 0; el && n < 20; n++) {
        text = el.shadowRoot?.textContent ?? ''
        el = el.shadowRoot?.querySelector('ds-loop')
      }
      return text
    })
    expect(deepest).toBe('Component nested too deep: <ds-loop> ')
  })

  it('renders identically on the server path', async () => {
    const server = await browser.newPage()
    try {
      await server.setContent(prepareFrameHtml(DOC, THEME, [stat()]))
      expect(await readInstance(server)).toEqual({
        text: 'Net worth',
        label: 'Net worth',
        labelColor: 'rgb(0, 0, 255)',
        slotColor: 'rgb(0, 0, 0)',
        slotted: ['₹18'],
      })
    } finally {
      await server.close()
    }
  })
})
