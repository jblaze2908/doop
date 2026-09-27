import { themeFontFaces, type CanvasTheme, type ThemeFontFace } from '../../shared/theme'

/** A theme font as a frame runtime registers it: a data: url of bytes the
 *  parent fetched, or the original url. Either way a url source, so the face
 *  stays lazy like @font-face: decoded only once text needs it. (An
 *  ArrayBuffer source is decoded synchronously on arrival, which made a warm
 *  24-frame load ~150 ms slower.) */
export interface FrameFont {
  family: string
  descriptors: ThemeFontFace['descriptors']
  url: string
}

/* Only Google's font host is fetched here: frame HTML runs its own scripts,
   which see every message posted in, so bytes from any other origin (above
   all this one, with its cookies) must never be handed to a frame. */
const FETCHABLE = /^https:\/\/fonts\.gstatic\.com\//
/* latin and latin-ext, which nearly every design renders; other subsets stay
   lazy url sources, as their unicode-range made them under @font-face */
const EAGER = /(^|,)\s*U\+(0000-00FF|0100-)/i

const dataUrls = new Map<string, Promise<string | null>>()
const perTheme = new WeakMap<CanvasTheme, Promise<FrameFont[]>>()

function fetchFont(url: string): Promise<string | null> {
  let p = dataUrls.get(url)
  if (!p) {
    p = fetch(url, { credentials: 'omit', mode: 'cors' })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => (blob ? toDataUrl(new Blob([blob], { type: 'font/woff2' })) : null))
      .catch(() => null)
    dataUrls.set(url, p)
  }
  return p
}

function toDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
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
        const local = eager ? await fetchFont(url) : null
        return { family, descriptors, url: local ?? url }
      }),
    )
    perTheme.set(theme, p)
  }
  return p
}
