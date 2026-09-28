import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { compile } from 'tailwindcss'
import { store } from './store.ts'
import type { CanvasTheme, ThemeToken } from '../shared/theme.ts'
import type { Frame, ServerMessage } from '../shared/types.ts'

/**
 * Tailwind utilities for canvases that opt in (theme.utilities = 'tailwind').
 * One compiler per canvas is fed every class its frames use; Tailwind's
 * compiler keeps each class it has built, so each rebuild only adds the new
 * ones (~0.4 ms), and the sheet rides the theme into every frame. A theme
 * change starts a fresh compiler because the token aliases change with it.
 */

const TW_DIR = path.resolve(path.dirname(createRequire(import.meta.url).resolve('tailwindcss')), '..')
const sheets = new Map<string, string>()

/* only Tailwind's own sheets: nothing a frame writes reaches the file system */
async function loadStylesheet(id: string) {
  const file = id.replace(/^tailwindcss\//, '')
  if (!/^[a-z-]+\.css$/.test(file)) throw new Error(`unsupported import ${id}`)
  let content = sheets.get(file)
  if (content === undefined) sheets.set(file, (content = readFileSync(path.join(TW_DIR, file), 'utf8')))
  return { path: path.join(TW_DIR, file), base: TW_DIR, content }
}

const NAMESPACE: Partial<Record<ThemeToken['type'], string>> = { color: 'color', font: 'font', shadow: 'shadow' }

/** Canvas tokens as Tailwind theme keys: colour --vellum → bg-vellum, font
 *  --font-display → font-display, size --radius-card → rounded-card. `inline
 *  reference` makes utilities read the token itself and emits no variable of
 *  its own — a same-named alias (--font-display: var(--font-display)) would be
 *  circular and void the token. */
function aliases(theme: CanvasTheme): string {
  const lines = theme.tokens.flatMap((t) => {
    const name = t.name.slice(2)
    const ns = NAMESPACE[t.type] ?? (t.type === 'size' && name.startsWith('radius') ? 'radius' : undefined)
    if (!ns) return []
    const key = name.startsWith(`${ns}-`) ? name : `${ns}-${name}`
    return [`--${key}: var(${t.name});`]
  })
  return `@theme inline reference { ${lines.join(' ')} }`
}

/* Tailwind's own layers for its variables and preflight, so canvas tokens and
   frame CSS beat both; utilities unlayered, since layered ones would lose to
   any unlayered rule (a frame's `* { padding: 0 }` would cancel every p-4) */
const input = (theme: CanvasTheme) =>
  `@layer theme, base; @import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/preflight.css" layer(base); @import "tailwindcss/utilities.css"; ${aliases(theme)}`

const CLASS_ATTR = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const classCache = new Map<string, { at: number; classes: string[] }>()

/** The class names a frame uses, cached per frame render stamp. */
function classesOf(f: Frame): string[] {
  const hit = classCache.get(f.id)
  if (hit?.at === f.updatedAt) return hit.classes
  const found = new Set<string>()
  for (const m of f.html.matchAll(CLASS_ATTR)) for (const c of (m[1] ?? m[2] ?? '').split(/\s+/)) if (c) found.add(c)
  const classes = [...found]
  classCache.set(f.id, { at: f.updatedAt, classes })
  return classes
}

interface Sheet {
  version: number
  build: (candidates: string[]) => string
  seen: Set<string>
  css: string
}
const canvasSheets = new Map<string, Promise<Sheet>>()

async function sheetFor(canvasId: string, theme: CanvasTheme): Promise<Sheet> {
  const cached = canvasSheets.get(canvasId)
  if (cached) {
    const sheet = await cached
    if (sheet.version === theme.version) return sheet
  }
  const fresh = compile(input(theme), { loadStylesheet }).then((c) => ({
    version: theme.version,
    build: (candidates: string[]) => c.build(candidates),
    seen: new Set<string>(),
    css: '',
  }))
  canvasSheets.set(canvasId, fresh)
  return fresh
}

/** The canvas's utility stylesheet ('' when it has not opted in). Cost: a
 *  class scan of frames whose html changed, then an incremental build. */
export async function utilitiesFor(canvasId: string): Promise<string> {
  const theme = store.getCanvas(canvasId)?.theme
  if (theme?.utilities !== 'tailwind') return ''
  const sheet = await sheetFor(canvasId, theme)
  const added: string[] = []
  for (const f of store.getCanvas(canvasId)?.frames ?? []) {
    for (const c of classesOf(f)) {
      if (!sheet.seen.has(c)) {
        sheet.seen.add(c)
        added.push(c)
      }
    }
  }
  if (added.length || !sheet.css) sheet.css = sheet.build(added)
  return sheet.css
}

let broadcast: (canvasId: string, msg: ServerMessage) => void = () => {}
export function wireUtilities(send: typeof broadcast) {
  broadcast = send
}

const pending = new Set<string>()
const sent = new Map<string, string>()
const DEBOUNCE_MS = 50

/** Runs on every store change (per streamed chunk too): opted-out canvases
 *  return at once; opted-in ones rebuild at most every 50 ms and broadcast
 *  only when the sheet actually changed. */
export function canvasTouched(canvasId: string) {
  if (pending.has(canvasId) || store.getCanvas(canvasId)?.theme?.utilities !== 'tailwind') return
  pending.add(canvasId)
  setTimeout(() => {
    pending.delete(canvasId)
    utilitiesFor(canvasId)
      .then((css) => {
        if (sent.get(canvasId) === css) return
        sent.set(canvasId, css)
        broadcast(canvasId, { type: 'utilities', css })
      })
      .catch((e) => console.error('[utilities]', e))
  }, DEBOUNCE_MS)
}

export function forgetCanvas(canvasId: string) {
  canvasSheets.delete(canvasId)
  sent.delete(canvasId)
}
