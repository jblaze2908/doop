import fs from 'node:fs'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { Frame, FrameAudit } from '../shared/types.ts'
import { auditPage } from './designAudit.ts'
import { designOfCanvas } from './designSystems.ts'
import { guardPublicPageRequests } from './publicUrl.ts'
import { renderableHtml } from './theme.ts'
import { utilitiesFor } from './utilities.ts'

/**
 * Render a frame's HTML in headless Chrome so agents can *see* their work.
 * Uses the system browser via puppeteer-core — no bundled download.
 */

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p)

/** The first usable local browser executable, or null when there is none. */
export function findBrowserPath(): string | null {
  for (const p of CHROME_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

function findBrowser(): string {
  const path = findBrowserPath()
  if (!path) throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a browser executable.')
  return path
}

let browserPromise: Promise<Browser> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
/* pages being opened or open; the browser only closes at zero */
let inUse = 0

/* An idle Chromium held ~380 MB RSS on the server for good (measured 2026-10-02), while renders come in bursts.
   It now exits this long after the last page closes; the next render pays one browser launch. */
export const BROWSER_IDLE_MS = Number(process.env.DRAFT_BROWSER_IDLE_MS || 90_000)

/* Armed when the last page closes: one timer, never a poll. */
function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void closeIfIdle(), BROWSER_IDLE_MS)
  idleTimer.unref()
}

async function closeIfIdle(): Promise<void> {
  idleTimer = null
  const pending = browserPromise
  if (!pending) return
  const browser = await pending.catch(() => null)
  if (!browser || browserPromise !== pending) return
  if (inUse > 0) return
  browserPromise = null
  await browser.close().catch(() => {})
}

export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise
    if (b.connected) return b
    browserPromise = null
  }
  const launching = puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: [
      '--no-first-run',
      '--disable-extensions',
      '--disable-quic',
      '--disable-webrtc-multiple-routes',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--hide-scrollbars',
      /* no GPU process and none of Chrome's background services: a headless renderer needs neither */
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OnDeviceModelBackgroundDownload,MediaRouter,Translate',
      /* containers: no user namespaces for the sandbox, tiny /dev/shm */
      ...(process.env.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  })
  browserPromise = launching
  launching.catch(() => {
    if (browserPromise === launching) browserPromise = null
  })
  return launching
}

export interface IsolatedPage {
  page: Page
  close: () => Promise<void>
}

/** External pages never share cookies, cache or service workers across users
 *  or imports. Closing the wrapper tears down the entire browser context. */
export async function openIsolatedPage(): Promise<IsolatedPage> {
  inUse++
  if (idleTimer) clearTimeout(idleTimer)
  const release = () => {
    if (--inUse === 0) armIdleClose()
  }
  let context: Awaited<ReturnType<Browser['createBrowserContext']>>
  try {
    context = await (await getBrowser()).createBrowserContext()
  } catch (error) {
    release()
    throw error
  }
  try {
    const page = await context.newPage()
    let closed = false
    return {
      page,
      close: async () => {
        if (closed) return
        closed = true
        await context.close().catch(() => {})
        release()
      },
    }
  } catch (error) {
    await context.close().catch(() => {})
    release()
    throw error
  }
}

async function loadFramePage(frame: Frame): Promise<IsolatedPage> {
  const loaded = await openIsolatedPage()
  const { page } = loaded
  try {
    const assetOrigin = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:4300').origin
    await guardPublicPageRequests(page, {
      allowUrl: (url) => url.origin === assetOrigin && url.pathname.startsWith('/a/'),
    })
    await page.setViewport({
      width: Math.max(1, Math.round(frame.width)),
      /* A viewport does not need to span an entire imported landing page for
         layout/computed-style inspection; full-page content remains in the DOM. */
      height: Math.max(1, Math.min(Math.round(frame.height), 4000)),
      deviceScaleFactor: 1,
    })
    try {
      await page.setContent(renderableHtml(frame, await utilitiesFor(frame.canvasId)), {
        waitUntil: 'load',
        timeout: 8000,
      })
    } catch {
      /* Slow external resources: inspect whatever has rendered. */
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    return loaded
  } catch (error) {
    await loaded.close()
    throw error
  }
}

/** Past this a frame page is stuck (a script that never yields, a resource that
 *  never settles) — a normal load and capture takes about a second. Without it a
 *  stuck render held an agent's call for minutes, long enough to expire its presence. */
export const FRAME_PAGE_DEADLINE_MS = 20_000

export class FramePageTimeout extends Error {
  constructor(ms: number) {
    super(
      `rendering the frame took over ${ms / 1000} s and was stopped — usually a script that never yields or an asset that never loads. Try again; if it repeats, look for those in the frame.`,
    )
  }
}

/** Load the frame in its own browser context, run fn on it, close it — within
 *  the deadline. A stuck page's context is torn down, which is what frees it. */
async function withFramePage<T>(
  frame: Frame,
  fn: (page: Page) => Promise<T>,
  deadlineMs = FRAME_PAGE_DEADLINE_MS,
): Promise<T> {
  let loaded: IsolatedPage | undefined
  let expired = false
  const work = loadFramePage(frame).then((l) => {
    loaded = l
    if (expired) throw new FramePageTimeout(deadlineMs)
    return fn(l.page)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new FramePageTimeout(deadlineMs))
    }, deadlineMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
    if (!expired) await loaded?.close()
    else {
      void loaded?.close()
      /* a load that lands after the deadline closes as soon as it does */
      work.catch(() => {}).finally(() => void loaded?.close())
    }
  }
}

export interface FrameInspection {
  document: { title: string; width: number; height: number; htmlChars: number }
  design: {
    colors: string[]
    backgrounds: string[]
    fonts: string[]
    fontSizes: string[]
    radii: string[]
    shadows: string[]
    cssVariables: Record<string, string>
  }
  elements: Array<{
    selector: string
    tag: string
    role?: string
    text?: string
    rect: { x: number; y: number; width: number; height: number }
    style: { color: string; background: string; font: string; fontSize: string; fontWeight: string }
  }>
}

/** A compact, rendered representation for agents. It intentionally relies on
 * visible text, semantics, geometry and computed styles rather than classes. */
export async function inspectFrame(frame: Frame): Promise<FrameInspection> {
  return withFramePage(frame, async (page) => {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serializes the callback without that runtime helper. A tiny in-page
       identity shim keeps the evaluated code independent of the loader. */
    await page.evaluate('globalThis.__name = (target) => target')
    const inspection = await page.evaluate(() => {
      const MAX_ELEMENTS = 64
      const MAX_STYLE_SAMPLES = 500
      const semanticTags = new Set([
        'header',
        'nav',
        'main',
        'section',
        'article',
        'aside',
        'footer',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'p',
        'a',
        'button',
        'input',
        'textarea',
        'select',
        'form',
        'img',
        'ul',
        'ol',
        'table',
      ])

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const style = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          rect.width > 1 &&
          rect.height > 1
        )
      }

      function selectorFor(el: Element): string {
        if (el.id && el.id.length < 80) return `#${CSS.escape(el.id)}`
        const parts: string[] = []
        let node: Element | null = el
        while (node && node !== document.body && parts.length < 7) {
          const tag = node.tagName.toLowerCase()
          const parent: Element | null = node.parentElement
          if (!parent) {
            parts.unshift(tag)
            break
          }
          const sameTag = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName)
          const suffix = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(node) + 1})` : ''
          parts.unshift(tag + suffix)
          node = parent
        }
        return `body > ${parts.join(' > ')}`
      }

      function cleanText(value: string | null | undefined, max = 180): string | undefined {
        const text = (value || '').replace(/\s+/g, ' ').trim()
        if (!text) return undefined
        return text.length > max ? `${text.slice(0, max - 1)}…` : text
      }

      function normalizedColor(value: string): string | undefined {
        if (!value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent') return undefined
        return value
      }

      const counts = {
        colors: new Map<string, number>(),
        backgrounds: new Map<string, number>(),
        fonts: new Map<string, number>(),
        fontSizes: new Map<string, number>(),
        radii: new Map<string, number>(),
        shadows: new Map<string, number>(),
      }
      const bump = (map: Map<string, number>, value?: string) => {
        if (value) map.set(value, (map.get(value) || 0) + 1)
      }

      const all = Array.from(document.body.querySelectorAll('*')).filter(visible)
      for (const el of all.slice(0, MAX_STYLE_SAMPLES)) {
        const style = getComputedStyle(el)
        bump(counts.colors, normalizedColor(style.color))
        bump(counts.backgrounds, normalizedColor(style.backgroundColor))
        bump(counts.fonts, style.fontFamily)
        bump(counts.fontSizes, style.fontSize)
        if (style.borderRadius !== '0px') bump(counts.radii, style.borderRadius)
        if (style.boxShadow !== 'none') bump(counts.shadows, style.boxShadow)
      }

      const semantic = all
        .filter((el) => semanticTags.has(el.tagName.toLowerCase()) || !!el.getAttribute('role'))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const candidates: HTMLElement[] = []
      const selected = new Set<HTMLElement>()
      const take = (limit: number, predicate: (el: HTMLElement) => boolean) => {
        for (const el of semantic) {
          if (candidates.length >= MAX_ELEMENTS || limit <= 0) break
          if (selected.has(el) || !predicate(el)) continue
          selected.add(el)
          candidates.push(el)
          limit--
        }
      }
      take(18, (el) =>
        ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].includes(el.tagName.toLowerCase()),
      )
      take(16, (el) => /^h[1-6]$/.test(el.tagName.toLowerCase()))
      take(
        16,
        (el) =>
          ['button', 'a', 'input', 'textarea', 'select', 'form'].includes(el.tagName.toLowerCase()) ||
          !!el.getAttribute('role'),
      )
      take(14, (el) => ['p', 'img', 'ul', 'ol', 'table'].includes(el.tagName.toLowerCase()))
      take(MAX_ELEMENTS - candidates.length, () => true)

      const elements = candidates.map((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const image = el instanceof HTMLImageElement ? cleanText(el.alt || el.getAttribute('aria-label')) : undefined
        return {
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          text: image || cleanText(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')),
          rect: {
            x: Math.round(rect.left + scrollX),
            y: Math.round(rect.top + scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          style: {
            color: style.color,
            background: style.backgroundColor,
            font: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
          },
        }
      })

      const top = (map: Map<string, number>, limit: number) =>
        [...map.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([value]) => value)
      const rootStyle = getComputedStyle(document.documentElement)
      const cssVariables: Record<string, string> = {}
      for (const name of Array.from(rootStyle)) {
        if (!name.startsWith('--') || Object.keys(cssVariables).length >= 40) continue
        const value = rootStyle.getPropertyValue(name).trim()
        if (value && value.length <= 160) cssVariables[name] = value
      }

      return {
        title: document.title,
        design: {
          colors: top(counts.colors, 10),
          backgrounds: top(counts.backgrounds, 10),
          fonts: top(counts.fonts, 8),
          fontSizes: top(counts.fontSizes, 10),
          radii: top(counts.radii, 8),
          shadows: top(counts.shadows, 6),
          cssVariables,
        },
        elements,
      }
    })

    return {
      document: {
        title: inspection.title,
        width: Math.round(frame.width),
        height: Math.round(frame.height),
        htmlChars: frame.html.length,
      },
      design: inspection.design,
      elements: inspection.elements,
    }
  })
}

/** Where one element sits on the rendered frame, cut to what viewers can see
 *  (frames do not scroll). Throws with a message fit for the agent. */
async function elementClip(page: Page, frame: Frame, selector: string) {
  const box = await page.evaluate((sel) => {
    let el: Element | null
    try {
      el = document.querySelector(sel)
    } catch {
      return 'invalid' as const
    }
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }
  }, selector)
  if (box === 'invalid') throw new Error(`"${selector}" is not a valid CSS selector`)
  if (!box) throw new Error(`no element matches "${selector}"`)
  const x = Math.max(0, box.x)
  const y = Math.max(0, box.y)
  const right = Math.min(frame.width, box.x + box.width)
  const bottom = Math.min(frame.height, box.y + box.height)
  if (right <= x || bottom <= y) throw new Error(`"${selector}" is outside the frame's visible area`)
  return { x, y, width: right - x, height: bottom - y }
}

export async function renderFrame(
  frame: Frame,
  /* output pixel density — fractional values downscale huge frames */
  scale: number = 1,
  opts: {
    type?: 'png' | 'jpeg'
    quality?: number
    maxHeight?: number
    selector?: string
    deadlineMs?: number
    /** more work on the same loaded page once the shot is taken — one page load, not two */
    after?: (page: Page) => Promise<void>
  } = {},
): Promise<Buffer> {
  return withFramePage(
    frame,
    async (page) => {
      await page.setViewport({
        width: Math.max(1, Math.round(frame.width)),
        height: Math.max(1, Math.round(frame.height)),
        deviceScaleFactor: scale,
      })
      const type = opts.type ?? 'png'
      const clip = opts.selector
        ? await elementClip(page, frame, opts.selector)
        : opts.maxHeight && frame.height > opts.maxHeight
          ? { x: 0, y: 0, width: Math.round(frame.width), height: Math.round(opts.maxHeight) }
          : undefined
      const buf = await page.screenshot({
        type,
        ...(type === 'jpeg' ? { quality: opts.quality ?? 90 } : {}),
        ...(clip ? { clip } : {}),
      })
      await opts.after?.(page)
      return Buffer.from(buf)
    },
    opts.deadlineMs,
  )
}

/** Run the design check on a frame (one page load, ~0.2–0.5 s plus the check itself). */
export async function auditFrame(frame: Frame): Promise<FrameAudit> {
  return withFramePage(frame, async (page) => {
    await page.setViewport({
      width: Math.max(1, Math.round(frame.width)),
      height: Math.max(1, Math.round(frame.height)),
    })
    return auditPage(page, frame, designOfCanvas(frame.canvasId).theme)
  })
}

/** Tallest a fitted frame gets: past this a page is a document, not a design. */
const MAX_FIT_HEIGHT = 30_000

/** The height a scrolling page needs at the frame's width: the scroll height
 *  when it overflows, else the bottom of its lowest element, so a frame shrinks
 *  as well as grows. One page load (~0.2–0.5 s), run once per full write. */
export async function measureFrameHeight(frame: Frame): Promise<number> {
  return withFramePage(frame, async (page) => {
    await page.setViewport({
      width: Math.max(1, Math.round(frame.width)),
      height: Math.max(1, Math.round(frame.height)),
    })
    const height = await page.evaluate(() => {
      const root = document.documentElement
      if (root.scrollHeight > innerHeight + 1) return root.scrollHeight
      /* descendants, not body: in quirks mode (no doctype) body fills the viewport */
      let bottom = 0
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.height > 0 && getComputedStyle(el).position !== 'fixed') bottom = Math.max(bottom, r.bottom + scrollY)
      }
      const body = getComputedStyle(document.body)
      return Math.ceil(bottom + parseFloat(body.paddingBottom) + parseFloat(body.marginBottom))
    })
    return Math.min(MAX_FIT_HEIGHT, Math.max(1, height))
  })
}
