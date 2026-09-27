import { store } from './store.ts'
import { compileTheme, fontFamilyOf, MAX_FONT_FACE_CHARS, sanitizeFontFaces } from '../shared/theme.ts'
import type { Frame } from '../shared/types.ts'

/* Google serves woff2 with unicode-range subsets only to a modern browser UA */
const FONT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

/** Compiled theme CSS for a frame's canvas: an in-memory lookup plus a
 *  memoized compile, cheap enough for every render. */
export function themeCssFor(frame: Pick<Frame, 'canvasId'>): string {
  return compileTheme(store.getCanvas(frame.canvasId)?.theme)
}

/** Everything a frame render depends on: the frame and its canvas theme.
 *  Render caches compare this, not frame.updatedAt alone. */
export function renderStamp(frame: Pick<Frame, 'canvasId' | 'updatedAt'>): string {
  return `${frame.updatedAt}:${store.getCanvas(frame.canvasId)?.theme?.version ?? 0}`
}

/* a bare family asks for every weight first; static families 400 on a range */
function queriesFor(spec: string): string[] {
  return spec.includes(':') ? [spec] : [`${spec}:ital,wght@0,100..900;1,100..900`, `${spec}:wght@100..900`, spec]
}

async function fetchFontFaces(spec: string): Promise<string> {
  for (const q of queriesFor(spec)) {
    const url = `https://fonts.googleapis.com/css2?family=${q.replace(/ /g, '+')}&display=swap`
    const res = await fetch(url, { headers: { 'User-Agent': FONT_UA }, signal: AbortSignal.timeout(5000) })
    if (res.status === 400) continue // unknown family or axis range: try the next shape
    if (!res.ok) throw new Error(`Google Fonts answered ${res.status}`)
    const faces = sanitizeFontFaces(await res.text())
    if (faces) return faces
  }
  return ''
}

/** Resolve font specs to @font-face rules ONCE, when the theme is set:
 *  constructable/injected sheets cannot @import, and renders are per request.
 *  A family that cannot be fetched is reported, never fatal. */
export async function resolveFonts(specs: readonly string[]): Promise<{ fontFaces: string; unresolved: string[] }> {
  const results = await Promise.all(specs.map((spec) => fetchFontFaces(spec).catch(() => '')))
  const unresolved = specs.filter((_, i) => !results[i]).map(fontFamilyOf)
  const fontFaces = results.filter(Boolean).join('\n')
  if (fontFaces.length > MAX_FONT_FACE_CHARS)
    throw new Error(
      `these fonts resolve to ${fontFaces.length} chars of @font-face rules — pick fewer families or axes`,
    )
  return { fontFaces, unresolved }
}
