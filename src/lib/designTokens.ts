import type { CanvasTheme, ThemeToken, ThemeTokenType } from '../../shared/theme'

/** The token a value references, when it is exactly `var(--name)` (with or
 *  without a fallback); null for literals and composite values. */
export function tokenRef(value: string | undefined): string | null {
  const m = /^var\(\s*(--[a-z0-9][a-z0-9-]*)\s*(?:,[^)]*)?\)$/.exec((value ?? '').trim())
  return m ? m[1]! : null
}

export function tokensOf(theme: CanvasTheme | undefined, types: readonly ThemeTokenType[]): ThemeToken[] {
  return (theme?.tokens ?? []).filter((t) => types.includes(t.type))
}

/** Class names the theme's shared CSS defines, for class-list suggestions.
 *  Strings and url() bodies are dropped first so file names don't count. */
export function themeClassNames(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)|"[^"]*"|'[^']*'/g, '')
  const names = new Set<string>()
  for (const block of code.split('{')) {
    const selector = block.slice(block.lastIndexOf('}') + 1)
    for (const m of selector.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) names.add(m[1]!)
  }
  return [...names].sort()
}
