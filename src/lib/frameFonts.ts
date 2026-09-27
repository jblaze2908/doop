import { themeFontFaces, type CanvasTheme, type ThemeFontFace } from '../../shared/theme'

/** A theme font as a frame runtime registers it: bytes when the parent
 *  fetched them, otherwise a url the frame loads on demand. */
export interface FrameFont {
  family: string
  descriptors: ThemeFontFace['descriptors']
  data?: ArrayBuffer
  url?: string
}

/* Only Google's font host is fetched here: frame HTML runs its own scripts,
   which see every message posted in, so bytes from any other origin (above
   all this one, with its cookies) must never be handed to a frame. */
const FETCHABLE = /^https:\/\/fonts\.gstatic\.com\//
/* latin and latin-ext, which nearly every design renders; other subsets stay
   lazy url sources, as their unicode-range made them under @font-face */
const EAGER = /(^|,)\s*U\+(0000-00FF|0100-)/i

const bytes = new Map<string, Promise<ArrayBuffer | null>>()
const perTheme = new WeakMap<CanvasTheme, Promise<FrameFont[]>>()

function fetchFont(url: string): Promise<ArrayBuffer | null> {
  let p = bytes.get(url)
  if (!p) {
    p = fetch(url, { credentials: 'omit', mode: 'cors' })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
    bytes.set(url, p)
  }
  return p
}

/** One fetch per font file for the whole canvas, through the page's normal
 *  HTTP cache. Each sandboxed srcdoc frame has an opaque origin, so its own
 *  @font-face requests are cache-partitioned: every frame re-downloaded every
 *  font on every load. Memoized per theme object. */
export function themeFonts(theme: CanvasTheme): Promise<FrameFont[]> {
  let p = perTheme.get(theme)
  if (!p) {
    p = Promise.all(
      themeFontFaces(theme.fontFaces).map(async ({ family, url, descriptors }): Promise<FrameFont> => {
        const eager = FETCHABLE.test(url) && (!descriptors.unicodeRange || EAGER.test(descriptors.unicodeRange))
        const data = eager ? await fetchFont(url) : null
        return data ? { family, descriptors, data } : { family, descriptors, url }
      }),
    )
    perTheme.set(theme, p)
  }
  return p
}
