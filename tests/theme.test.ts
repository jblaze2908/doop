import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compileTheme,
  mergeTokens,
  normalizeFontSpecs,
  normalizeThemeCss,
  normalizeToken,
  sanitizeFontFaces,
  spliceTheme,
  themeFontFaces,
  themeOptedOut,
  withoutTheme,
  type CanvasTheme,
} from '../shared/theme.ts'
import { resolveFonts } from '../server/theme.ts'

const theme = (over: Partial<CanvasTheme> = {}): CanvasTheme => ({
  tokens: [],
  css: '',
  fonts: [],
  fontFaces: '',
  version: 1,
  updatedAt: 0,
  updatedBy: 't',
  ...over,
})

describe('theme tokens', () => {
  it('adds the -- prefix, infers a type and collapses whitespace', () => {
    expect(normalizeToken({ name: 'color-ink', value: ' #17171B ' })).toEqual({
      name: '--color-ink',
      type: 'color',
      value: '#17171B',
    })
    expect(normalizeToken({ name: '--space-4', value: '16px' }).type).toBe('size')
    expect(normalizeToken({ name: '--font-ui', value: "'Geist', sans-serif" }).type).toBe('font')
    expect(normalizeToken({ name: '--shadow-card', value: '0 1px 2px rgba(0,0,0,.1)' }).type).toBe('shadow')
  })

  it('rejects names and values that are not a custom property or could escape :root', () => {
    expect(() => normalizeToken({ name: '--Color', value: '#fff' })).toThrow(/invalid token name/)
    expect(() => normalizeToken({ name: '--x', value: 'red;} body{display:none' })).toThrow(/may not contain/)
    expect(() => normalizeToken({ name: '--x', value: '</style><script>' })).toThrow(/may not contain/)
    expect(() => normalizeToken(null as never)).toThrow(/needs a name/)
  })

  it('merges by name keeping positions, deletes on empty value, replaces wholesale', () => {
    const current = mergeTokens(
      [],
      [
        { name: '--a', value: '1px' },
        { name: '--b', value: '2px' },
      ],
      'replace',
    )
    expect(
      mergeTokens(
        current,
        [
          { name: '--b', value: '3px' },
          { name: '--c', value: '4px' },
        ],
        'merge',
      ).map((t) => `${t.name}:${t.value}`),
    ).toEqual(['--a:1px', '--b:3px', '--c:4px'])
    expect(mergeTokens(current, [{ name: '--a', value: '' }], 'merge').map((t) => t.name)).toEqual(['--b'])
    expect(mergeTokens(current, [{ name: '--z', value: '0' }], 'replace').map((t) => t.name)).toEqual(['--z'])
  })

  it('caps the token count', () => {
    const many = Array.from({ length: 301 }, (_, i) => ({ name: `--t-${i}`, value: '1px' }))
    expect(() => mergeTokens([], many, 'replace')).toThrow(/at most 300/)
  })
})

describe('theme css and fonts', () => {
  it('refuses @import and anything that closes the style element', () => {
    expect(normalizeThemeCss('  .a{color:red}\r\n')).toBe('.a{color:red}')
    expect(() => normalizeThemeCss('@import url(x.css);')).toThrow(/@import/)
    expect(() => normalizeThemeCss('.a{}</STYLE><script>')).toThrow(/<\/style>/)
    expect(() => normalizeThemeCss('a'.repeat(64_001))).toThrow(/limit/)
  })

  it('accepts css2 family specs, de-duplicated by family', () => {
    expect(normalizeFontSpecs(['Geist', ' Inter:wght@400;600 ', 'Geist:wght@100..900'])).toEqual([
      'Geist:wght@100..900',
      'Inter:wght@400;600',
    ])
    expect(normalizeFontSpecs(['Fraunces:ital,wght@0,400;1,700'])).toEqual(['Fraunces:ital,wght@0,400;1,700'])
    expect(() => normalizeFontSpecs(['Inter"><script>'])).toThrow(/invalid font/)
  })

  it('keeps only @font-face blocks from a Google Fonts response', () => {
    const css = `/* latin */\n@font-face {\n  font-family: 'Geist';\n  src: url(https://fonts.gstatic.com/g.woff2) format('woff2');\n}\n.evil{}\n@font-face{src:url(x)</style>}`
    expect(sanitizeFontFaces(css)).toBe(
      "@font-face {\n  font-family: 'Geist';\n  src: url(https://fonts.gstatic.com/g.woff2) format('woff2');\n}",
    )
  })
})

describe('compileTheme', () => {
  it('orders tokens, font faces, then css, and memoizes per theme object', () => {
    const t = theme({
      tokens: [{ name: '--ink', type: 'color', value: '#111' }],
      fontFaces: '@font-face{font-family:X}',
      css: '.btn{color:var(--ink)}',
    })
    const css = compileTheme(t)
    expect(css).toBe(':root {\n  --ink: #111;\n}\n@font-face{font-family:X}\n.btn{color:var(--ink)}')
    expect(compileTheme(t)).toBe(css)
    expect(compileTheme(undefined)).toBe('')
  })
})

describe('spliceTheme', () => {
  const tag = '<style data-draft-theme>X</style>'

  it('puts the theme first in <head> for every document shape', () => {
    expect(spliceTheme('<!doctype html><html><head><title>t</title></head></html>', 'X')).toBe(
      `<!doctype html><html><head>${tag}<title>t</title></head></html>`,
    )
    expect(spliceTheme('<!doctype html><html lang="en"><body>b</body></html>', 'X')).toBe(
      `<!doctype html><html lang="en">${tag}<body>b</body></html>`,
    )
    expect(spliceTheme('<!DOCTYPE html><div>b</div>', 'X')).toBe(`<!DOCTYPE html>${tag}<div>b</div>`)
    expect(spliceTheme('<div>b</div>', 'X')).toBe(`${tag}<div>b</div>`)
    /* <header> is not <head> */
    expect(spliceTheme('<html><body><header>h</header></body></html>', 'X')).toBe(
      `<html>${tag}<body><header>h</header></body></html>`,
    )
  })

  it('opts imported documents out, idempotently', () => {
    expect(withoutTheme('<!doctype html>\n<html lang="en"><head></head></html>')).toBe(
      '<!doctype html>\n<html data-draft-theme="off" lang="en"><head></head></html>',
    )
    expect(withoutTheme('<!doctype html><p>x</p>')).toBe('<!doctype html><html data-draft-theme="off"><p>x</p>')
    const off = withoutTheme('<html><body></body></html>')
    expect(withoutTheme(off)).toBe(off)
    expect(spliceTheme(off, 'X')).toBe(off)
  })

  it('leaves opted-out frames and empty themes alone', () => {
    const off = '<html data-draft-theme="off"><head></head></html>'
    expect(themeOptedOut(off)).toBe(true)
    expect(spliceTheme(off, 'X')).toBe(off)
    expect(spliceTheme('<p>x</p>', '')).toBe('<p>x</p>')
  })
})

describe('resolveFonts', () => {
  afterEach(() => vi.unstubAllGlobals())

  const face = (family: string) => `@font-face { font-family: '${family}'; src: url(x.woff2); }`

  it('falls back from the full variable range to plain shapes, reporting what never resolved', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('Static') && url.includes('100..900')) return new Response('', { status: 400 })
      if (url.includes('Nope')) return new Response('', { status: 400 })
      return new Response(`/* latin */\n${face(url.includes('Static') ? 'Static' : 'Geist')}`)
    })
    vi.stubGlobal('fetch', fetch)
    const { fontFaces, unresolved } = await resolveFonts(['Geist', 'Static Sans', 'Nope'])
    expect(fontFaces).toBe(`${face('Geist')}\n${face('Static')}`)
    expect(unresolved).toEqual(['Nope'])
    const urls = fetch.mock.calls.map(([u]) => u)
    expect(urls[0]).toBe('https://fonts.googleapis.com/css2?family=Geist:ital,wght@0,100..900;1,100..900&display=swap')
    expect(urls.filter((u) => u.includes('Static+Sans'))).toHaveLength(3)
  })

  it('treats an unreachable Google Fonts as unresolved, not fatal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    expect(await resolveFonts(['Inter:wght@400'])).toEqual({ fontFaces: '', unresolved: ['Inter'] })
  })
})

describe('themeFontFaces', () => {
  const faces = `@font-face {
  font-family: 'Geist';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/geist/v5/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face { font-family: "Mono"; src: url('https://fonts.gstatic.com/s/mono/a.woff2') format('woff2'); }
@font-face { font-family: 'NoSource'; font-weight: 400; }`

  it('reads family, first url and descriptors, and skips blocks without a source', () => {
    expect(themeFontFaces(faces)).toEqual([
      {
        family: 'Geist',
        url: 'https://fonts.gstatic.com/s/geist/v5/latin.woff2',
        descriptors: { style: 'normal', weight: '100 900', display: 'swap', unicodeRange: 'U+0000-00FF, U+0131' },
      },
      { family: 'Mono', url: 'https://fonts.gstatic.com/s/mono/a.woff2', descriptors: {} },
    ])
  })

  it('leaves the rules out of the live-frame stylesheet only', () => {
    const theme = { tokens: [], css: 'p{}', fonts: [], fontFaces: faces, version: 1, updatedAt: 1, updatedBy: 'x' }
    expect(compileTheme(theme)).toContain('@font-face')
    expect(compileTheme(theme, false)).not.toContain('@font-face')
    expect(compileTheme(theme, false)).toContain('p{}')
  })
})
