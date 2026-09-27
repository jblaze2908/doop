/**
 * The canvas theme: design tokens, Google Fonts and shared CSS that every
 * frame on a canvas inherits. Validation and compilation live here so the
 * server (actions, screenshots) and the browser (frame iframes) build the
 * exact same stylesheet.
 */

export const THEME_TOKEN_TYPES = ['color', 'size', 'font', 'shadow', 'other'] as const
export type ThemeTokenType = (typeof THEME_TOKEN_TYPES)[number]

export interface ThemeToken {
  /** a CSS custom property name, e.g. "--color-ink" */
  name: string
  type: ThemeTokenType
  value: string
  description?: string
}

export interface CanvasTheme {
  tokens: ThemeToken[]
  css: string
  /** Google Fonts css2 family specs, e.g. "Inter:wght@400;600" or "Geist" */
  fonts: string[]
  /** @font-face rules resolved from `fonts` when they were set — never fetched per render */
  fontFaces: string
  /** families Google Fonts could not serve when they were set (offline self-host, typo) */
  unresolvedFonts?: string[]
  /** bumped on every change; render caches key on it */
  version: number
  updatedAt: number
  updatedBy: string
}

export type ThemeTokenInput = { name: string; value: string; type?: string; description?: string }

export const MAX_THEME_TOKENS = 300
export const MAX_THEME_CSS_CHARS = 64_000
export const MAX_THEME_FONTS = 8
export const MAX_TOKEN_VALUE_CHARS = 400
export const MAX_TOKEN_DESCRIPTION_CHARS = 200
export const MAX_FONT_FACE_CHARS = 120_000

export const THEME_TOKEN_NAME_RE = /^--[a-z0-9][a-z0-9-]{0,62}$/
/* family, then an optional css2 axis spec ("ital,wght@0,400;1,700") */
const FONT_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,60}(:[A-Za-z,]+@[0-9.,;-]+)?$/

export function isCanvasTheme(value: unknown): value is CanvasTheme {
  const t = value as CanvasTheme | null
  return (
    !!t &&
    typeof t === 'object' &&
    Array.isArray(t.tokens) &&
    typeof t.css === 'string' &&
    Array.isArray(t.fonts) &&
    typeof t.fontFaces === 'string' &&
    typeof t.version === 'number'
  )
}

export function isThemeEmpty(theme: CanvasTheme | undefined): boolean {
  return !theme || (!theme.tokens.length && !theme.css && !theme.fontFaces)
}

function inferTokenType(value: string): ThemeTokenType {
  const v = value.toLowerCase()
  if (/^(#[0-9a-f]{3,8}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(|transparent$|currentcolor$)/.test(v))
    return 'color'
  if (/^-?[\d.]+(px|rem|em|%|vh|vw|ch|pt)?$|^(calc|clamp|min|max)\(/.test(v)) return 'size'
  if (/\b(serif|sans-serif|monospace|system-ui|cursive)\b|^["']/.test(v)) return 'font'
  if (/\d(px|rem)\s+-?\d/.test(v)) return 'shadow'
  return 'other'
}

/** Validate one token; throws with a caller-facing message. A bare name gets
 *  its `--` prefix — case is kept, because custom properties are case-sensitive. */
export function normalizeToken(raw: ThemeTokenInput): ThemeToken {
  if (!raw || typeof raw !== 'object') throw new Error('each token needs a name and a value')
  const trimmed = String(raw.name ?? '').trim()
  const name = trimmed.startsWith('--') ? trimmed : `--${trimmed}`
  if (!THEME_TOKEN_NAME_RE.test(name))
    throw new Error(`invalid token name “${raw.name}” — use a lowercase custom property like "--color-ink"`)
  const value = String(raw.value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (value.length > MAX_TOKEN_VALUE_CHARS)
    throw new Error(`token ${name} is ${value.length} chars — the limit is ${MAX_TOKEN_VALUE_CHARS}`)
  /* the value lands inside `:root{…}` in a <style> element */
  if (/[{};<]/.test(value)) throw new Error(`token ${name} value may not contain { } ; or <`)
  const type = (THEME_TOKEN_TYPES as readonly string[]).includes(raw.type ?? '')
    ? (raw.type as ThemeTokenType)
    : inferTokenType(value)
  const description = raw.description?.replace(/\s+/g, ' ').trim().slice(0, MAX_TOKEN_DESCRIPTION_CHARS)
  return { name, type, value, ...(description ? { description } : {}) }
}

/** Apply a token write. merge: upsert by name, an empty value deletes;
 *  replace: the list becomes the whole token set. Existing tokens keep their
 *  position so panels and diffs stay stable. */
export function mergeTokens(
  current: readonly ThemeToken[],
  input: readonly ThemeTokenInput[],
  mode: 'merge' | 'replace',
): ThemeToken[] {
  const next = new Map(mode === 'merge' ? current.map((t) => [t.name, t]) : [])
  for (const raw of input) {
    const token = normalizeToken(raw)
    if (token.value) next.set(token.name, token)
    else next.delete(token.name)
  }
  if (next.size > MAX_THEME_TOKENS)
    throw new Error(`a theme holds at most ${MAX_THEME_TOKENS} tokens — this write would leave ${next.size}`)
  return [...next.values()]
}

export function normalizeThemeCss(css: string): string {
  const clean = css.replace(/\r\n/g, '\n').trim()
  if (clean.length > MAX_THEME_CSS_CHARS)
    throw new Error(`theme CSS is ${clean.length} chars — the limit is ${MAX_THEME_CSS_CHARS}`)
  if (/<\/style/i.test(clean)) throw new Error('theme CSS may not contain </style>')
  if (/@import\b/i.test(clean))
    throw new Error('theme CSS may not use @import — set Google Fonts with set_theme_fonts instead')
  return clean
}

/** Validate and de-duplicate font specs (by family). */
export function normalizeFontSpecs(specs: readonly string[]): string[] {
  const byFamily = new Map<string, string>()
  for (const raw of specs) {
    const spec = String(raw).replace(/\s+/g, ' ').trim()
    if (!spec) continue
    if (!FONT_SPEC_RE.test(spec))
      throw new Error(`invalid font “${raw}” — use a Google Fonts family, optionally with axes: "Inter:wght@400;700"`)
    byFamily.set(fontFamilyOf(spec), spec)
  }
  if (byFamily.size > MAX_THEME_FONTS) throw new Error(`a theme holds at most ${MAX_THEME_FONTS} font families`)
  return [...byFamily.values()]
}

export function fontFamilyOf(spec: string): string {
  return spec.split(':')[0]!.trim()
}

/** Keep only @font-face blocks from a Google Fonts response. */
export function sanitizeFontFaces(css: string): string {
  return (css.match(/@font-face\s*\{[^{}]*\}/g) ?? []).filter((block) => !block.includes('<')).join('\n')
}

const compiled = new WeakMap<CanvasTheme, string>()
const compiledNoFonts = new WeakMap<CanvasTheme, string>()

/** The stylesheet every frame inherits: tokens on :root, font faces, then the
 *  shared CSS. Memoized per theme object — a theme is replaced, never mutated.
 *  `withFontFaces: false` is the live-frame variant: the parent registers the
 *  faces itself (see themeFontFaces), so each iframe need not refetch them. */
export function compileTheme(theme: CanvasTheme | undefined, withFontFaces = true): string {
  if (!theme) return ''
  const cache = withFontFaces ? compiled : compiledNoFonts
  let css = cache.get(theme)
  if (css === undefined) {
    const root = theme.tokens.length
      ? `:root {\n${theme.tokens.map((t) => `  ${t.name}: ${t.value};`).join('\n')}\n}`
      : ''
    css = [root, withFontFaces ? theme.fontFaces : '', theme.css].filter(Boolean).join('\n')
    cache.set(theme, css)
  }
  return css
}

export interface ThemeFontFace {
  family: string
  /** the first url() in src, unquoted */
  url: string
  descriptors: { style?: string; weight?: string; stretch?: string; unicodeRange?: string; display?: FontDisplay }
}

const DESCRIPTOR: Record<string, keyof ThemeFontFace['descriptors']> = {
  'font-style': 'style',
  'font-weight': 'weight',
  'font-stretch': 'stretch',
  'unicode-range': 'unicodeRange',
  'font-display': 'display',
}

/** The theme's @font-face rules as FontFace constructor arguments. Blocks
 *  without a url() source are skipped; they could not have loaded anyway. */
export function themeFontFaces(fontFaces: string): ThemeFontFace[] {
  const out: ThemeFontFace[] = []
  for (const [, body = ''] of fontFaces.matchAll(/@font-face\s*\{([^{}]*)\}/g)) {
    let family = ''
    let url = ''
    const descriptors: ThemeFontFace['descriptors'] = {}
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      const prop = decl.slice(0, i).trim().toLowerCase()
      const value = decl.slice(i + 1).trim()
      if (prop === 'font-family') family = value.replace(/^['"]|['"]$/g, '')
      else if (prop === 'src') url = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(value)?.[1] ?? ''
      else if (DESCRIPTOR[prop]) (descriptors as Record<string, string>)[DESCRIPTOR[prop]!] = value
    }
    if (family && url) out.push({ family, url, descriptors })
  }
  return out
}

/** A frame opts out with `<html data-doop-theme="off">` (imports, frames that ship their own CSS). */
export function themeOptedOut(html: string): boolean {
  return /<html\b[^>]*\bdata-doop-theme\s*=\s*["']?off\b/i.test(html)
}

/** Mark a frame as opted out. Imports and synced screens ship their own
 *  complete CSS; theme resets and class names would leak into them. */
export function withoutTheme(html: string): string {
  if (themeOptedOut(html)) return html
  const tag = /<html\b/i.exec(html)
  if (tag) {
    const at = tag.index + tag[0].length
    return `${html.slice(0, at)} data-doop-theme="off"${html.slice(at)}`
  }
  const doctype = /<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype.index + doctype[0].length : 0
  return `${html.slice(0, at)}<html data-doop-theme="off">${html.slice(at)}`
}

/** Insert markup as the first thing in the document's <head>. The anchors
 *  mirror where a parser opens <head>, so the result is first in head for
 *  every document shape: head tag, html tag only, doctype only, or a fragment. */
export function spliceHead(html: string, markup: string): string {
  if (!markup) return html
  const anchor = /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html)
  if (!anchor) return markup + html
  const at = anchor.index + anchor[0].length
  return html.slice(0, at) + markup + html.slice(at)
}

/** Put the theme first in the frame's <head>, where the frame runtime puts it
 *  in the browser: the frame's own styles come later and win the cascade. */
export function spliceTheme(html: string, css: string): string {
  if (!css || themeOptedOut(html)) return html
  return spliceHead(html, `<style data-doop-theme>${css}</style>`)
}
