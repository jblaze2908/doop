import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime.ts'
import { themeClassNames, tokenRef, tokensOf } from '../src/lib/designTokens.ts'
import type { CanvasTheme } from '../shared/theme.ts'

declare global {
  interface Window {
    replies: Record<string, unknown>[]
    edited: string[]
  }
}

describe('design token helpers', () => {
  it('recognises a bare token reference, with or without a fallback', () => {
    expect(tokenRef('var(--color-ink)')).toBe('--color-ink')
    expect(tokenRef(' var( --space-4 , 16px) ')).toBe('--space-4')
    expect(tokenRef('calc(var(--a) * 2)')).toBeNull()
    expect(tokenRef('#fff')).toBeNull()
    expect(tokenRef(undefined)).toBeNull()
  })

  it('filters tokens by type and lists theme classes, ignoring strings, urls and comments', () => {
    const theme = {
      tokens: [
        { name: '--ink', type: 'color', value: '#111' },
        { name: '--gap', type: 'size', value: '8px' },
      ],
    } as CanvasTheme
    expect(tokensOf(theme, ['color']).map((t) => t.name)).toEqual(['--ink'])
    expect(
      themeClassNames(
        '/* .nope */ .btn, .btn--primary:hover{background:url(a.png)} .card .title{margin:.5em} @media (min-width:1.5em){.wide{content:".x"}}',
      ),
    ).toEqual(['btn', 'btn--primary', 'card', 'title', 'wide'])
  })
})

/* The runtime as the top document, as in frameTheme.test.ts: replies to
   `parent` come back to this window. */
describe.skipIf(!findBrowserPath())('element panel runtime messages', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setContent(FRAME_BOOTSTRAP)
    await page.evaluate(() => {
      window.replies = []
      window.edited = []
      window.addEventListener('message', (ev) => {
        if (typeof ev.data?.type !== 'string') return
        if (ev.data.type === 'draft:edited') window.edited.push(ev.data.html)
        else if (ev.data.type.endsWith('-result')) window.replies.push(ev.data)
      })
    })
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  const post = (msg: Record<string, unknown>, wait = 30) =>
    page.evaluate(
      (m, w) => {
        window.postMessage(m, '*')
        return new Promise((r) => setTimeout(r, w))
      },
      msg,
      wait,
    )
  const lastReply = () => page.evaluate(() => window.replies[window.replies.length - 1] as Record<string, unknown>)

  it('reports spacing, alignment, attributes and component membership', async () => {
    await post({
      type: 'draft:components',
      defs: [
        {
          name: 'ds-chip',
          html: '<b>{{label}}</b>',
          css: ':host{display:inline-block}',
          props: [{ name: 'label' }],
          version: 1,
        },
      ],
    })
    await post({
      type: 'draft:html',
      html: '<html><body><div id="row" style="display:flex;align-items:center;margin:4px 8px" data-kind="x"><ds-chip label="All"></ds-chip></div></body></html>',
    })
    await post({ type: 'draft:inspect', reqId: 1, selector: '#row' })
    expect((await lastReply()).info).toMatchObject({
      margin: [4, 8, 4, 8],
      alignItems: 'center',
      attributes: { 'data-kind': 'x' },
      component: null,
    })
    await post({ type: 'draft:inspect', reqId: 2, selector: '#row > ds-chip' })
    expect((await lastReply()).info).toMatchObject({ component: 'ds-chip', attributes: { label: 'All' } })
  })

  it('edits component props as attributes and re-renders the instance', async () => {
    await post({ type: 'draft:attrs', reqId: 3, selector: '#row > ds-chip', attrs: { label: 'Food', onclick: 'x()' } })
    expect((await lastReply()).ok).toBe(true)
    const rendered = await page.evaluate(() => ({
      label: document.querySelector('ds-chip')!.shadowRoot!.textContent,
      onclick: document.querySelector('ds-chip')!.hasAttribute('onclick'),
    }))
    expect(rendered).toEqual({ label: 'Food', onclick: false })
  })

  it('replaces the class list, dropping invalid names', async () => {
    await post({ type: 'draft:classes', reqId: 4, selector: '#row', classes: ['card', 'card', 'bad"name', ' row '] })
    expect(await page.evaluate(() => document.querySelector('#row')!.getAttribute('class'))).toBe('card row')
  })

  it('holds incoming renders while an edit is waiting to save, then saves it', async () => {
    await post({ type: 'draft:style', reqId: 5, selector: '#row', styles: { color: 'rgb(255, 0, 0)' } }, 0)
    /* a remote render lands inside the save window — it must not wipe the edit */
    await post({ type: 'draft:html', html: '<html><body><div id="row">remote</div></body></html>' }, 0)
    expect(await page.evaluate(() => document.querySelector('#row')!.getAttribute('style'))).toContain('rgb(255, 0, 0)')
    await new Promise((r) => setTimeout(r, 400))
    const saved = await page.evaluate(() => window.edited[window.edited.length - 1] ?? '')
    expect(saved).toContain('color: rgb(255, 0, 0)')
    expect(saved).toContain('class="card row"')
    expect(saved).toContain('<ds-chip label="Food"></ds-chip>')
  })
})
