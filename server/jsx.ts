/**
 * HTML → JSX building blocks for code export: attribute and tag names,
 * inline styles, text, and component CSS scoping. Pure string work; the
 * tree walk lives in exportCode.ts.
 */

const ATTR_NAMES: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  minlength: 'minLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  srcset: 'srcSet',
  crossorigin: 'crossOrigin',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  enctype: 'encType',
  contenteditable: 'contentEditable',
  spellcheck: 'spellCheck',
  cellpadding: 'cellPadding',
  cellspacing: 'cellSpacing',
  datetime: 'dateTime',
  frameborder: 'frameBorder',
  allowfullscreen: 'allowFullScreen',
  inputmode: 'inputMode',
  novalidate: 'noValidate',
  playsinline: 'playsInline',
  referrerpolicy: 'referrerPolicy',
  usemap: 'useMap',
  accesskey: 'accessKey',
  // SVG attributes whose case the HTML parser folds away
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  patternunits: 'patternUnits',
  patterntransform: 'patternTransform',
  patterncontentunits: 'patternContentUnits',
  clippathunits: 'clipPathUnits',
  maskunits: 'maskUnits',
  maskcontentunits: 'maskContentUnits',
  markerwidth: 'markerWidth',
  markerheight: 'markerHeight',
  markerunits: 'markerUnits',
  refx: 'refX',
  refy: 'refY',
  stddeviation: 'stdDeviation',
  basefrequency: 'baseFrequency',
  numoctaves: 'numOctaves',
  filterunits: 'filterUnits',
  primitiveunits: 'primitiveUnits',
  lengthadjust: 'lengthAdjust',
  textlength: 'textLength',
  startoffset: 'startOffset',
  spreadmethod: 'spreadMethod',
  pathlength: 'pathLength',
  'xlink:href': 'xlinkHref',
  'xmlns:xlink': 'xmlnsXlink',
  'xml:space': 'xmlSpace',
}

const SVG_TAGS: Record<string, string> = {
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
  foreignobject: 'foreignObject',
  textpath: 'textPath',
  animatetransform: 'animateTransform',
  animatemotion: 'animateMotion',
  fegaussianblur: 'feGaussianBlur',
  feoffset: 'feOffset',
  feblend: 'feBlend',
  fecolormatrix: 'feColorMatrix',
  fecomposite: 'feComposite',
  feflood: 'feFlood',
  femerge: 'feMerge',
  femergenode: 'feMergeNode',
  feturbulence: 'feTurbulence',
  fedisplacementmap: 'feDisplacementMap',
  fedropshadow: 'feDropShadow',
  femorphology: 'feMorphology',
}

export function jsxTag(tag: string): string {
  return SVG_TAGS[tag] ?? tag
}

/** A DOM attribute's JSX prop name; null for ones that cannot be exported
 *  safely or meaningfully (inline event handlers). */
export function jsxAttrName(name: string): string | null {
  const n = name.toLowerCase()
  if (n.startsWith('on')) return null
  if (ATTR_NAMES[n]) return ATTR_NAMES[n]
  if (n.startsWith('data-') || n.startsWith('aria-')) return n
  return n.replace(/[-:]([a-z])/g, (_, c: string) => c.toUpperCase())
}

export function camelProp(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  rarr: '→',
  larr: '←',
  uarr: '↑',
  darr: '↓',
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' ',
  zwj: '‍',
  zwnj: '‌',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED[ref.toLowerCase()] ?? whole
  })
}

/** Text for a JSX child. HTML collapses whitespace runs to one space; so does
 *  this (outside <pre>), and edge spaces are kept as string expressions
 *  because JSX would trim them at line breaks. */
export function jsxText(raw: string, preformatted = false): string {
  const text = decodeEntities(raw)
  if (preformatted) return `{${JSON.stringify(text)}}`
  const collapsed = text.replace(/[\t\n\f\r ]+/g, ' ')
  if (collapsed === ' ') return "{' '}"
  if (/^[^{}<>&\s][^{}<>&]*[^{}<>&\s]$|^[^{}<>&\s]$/.test(collapsed) && !/ {2}/.test(collapsed)) return collapsed
  return `{${JSON.stringify(collapsed)}}`
}

/** `style="a:b;--c:d"` → a JSX style object literal. */
export function jsxStyle(css: string): string {
  const entries: string[] = []
  for (const decl of splitDeclarations(css)) {
    const i = decl.indexOf(':')
    if (i <= 0) continue
    const prop = decl.slice(0, i).trim()
    const value = decl.slice(i + 1).trim()
    if (!prop || !value) continue
    const key = prop.startsWith('--')
      ? JSON.stringify(prop)
      : prop
          .toLowerCase()
          .replace(/^-(webkit|moz|ms|o)-/, (_, v: string) => `${v === 'ms' ? 'ms' : v[0]!.toUpperCase() + v.slice(1)}-`)
    const name = key.startsWith('"') ? key : camelProp(key)
    entries.push(`${name}: ${JSON.stringify(decodeEntities(value))}`)
  }
  return `{{ ${entries.join(', ')} }}`
}

/* semicolons inside parentheses or quotes (url(data:...;base64), content:";") are not separators */
function splitDeclarations(css: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!
    if (quote) {
      if (ch === quote && css[i - 1] !== '\\') quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      out.push(css.slice(start, i))
      start = i + 1
    }
  }
  out.push(css.slice(start))
  return out
}

/**
 * Shadow-scoped component CSS → global CSS scoped to the component's root
 * class. `:host` becomes `.root`, `:host(x)` becomes `.root` + x (attribute
 * selectors move to the data-* the React wrapper renders), `::slotted(x)`
 * becomes a descendant, every other selector is prefixed. Custom elements are
 * inline by default; the wrapper is a div, so that default is restated.
 */
export function scopeComponentCss(css: string, root: string, hostAttrs: readonly string[]): string {
  const cls = `.${root}`
  const toData = (sel: string) =>
    hostAttrs.reduce((s, a) => s.replace(new RegExp(`\\[${a}(?=[\\]=~^$*|])`, 'g'), `[data-${a}`), sel)
  const scopeSelector = (sel: string): string => {
    const s = sel.trim()
    if (!s) return s
    if (s.startsWith(':host(')) {
      const close = matchParen(s, ':host('.length - 1)
      const inner = s.slice(':host('.length, close)
      return `${cls}${toData(inner)}${s.slice(close + 1).replace(/::slotted\(([^)]*)\)/g, ' $1')}`
    }
    if (s.startsWith(':host')) return `${cls}${s.slice(':host'.length).replace(/::slotted\(([^)]*)\)/g, ' $1')}`
    return `${cls} ${s.replace(/::slotted\(([^)]*)\)/g, '$1')}`
  }
  const body = rewriteSelectors(css, (list) => splitTopLevel(list, ',').map(scopeSelector).join(', '))
  return `${cls}{display:inline}\n${body}`
}

function matchParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i
  }
  return s.length - 1
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === sep && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

/* Walk rules, rewriting selector lists; at-rule preludes (@media, @supports)
   are kept and their blocks recursed into, @keyframes/@font-face left alone. */
export function rewriteSelectors(css: string, rewrite: (selectorList: string) => string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let out = ''
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    /* statement at-rules (@import, @charset, @layer a, b;) end at ; and have no block */
    const semi = src.indexOf(';', i)
    if (src.slice(i).trimStart().startsWith('@') && semi >= 0 && (open < 0 || semi < open)) {
      out += `${src.slice(i, semi + 1).trim()}\n`
      i = semi + 1
      continue
    }
    if (open < 0) {
      out += src.slice(i)
      break
    }
    const prelude = src.slice(i, open)
    const close = blockEnd(src, open)
    const block = src.slice(open + 1, close)
    const head = prelude.trim()
    if (head.startsWith('@')) {
      const nested = /^@(media|supports|container|layer)\b/i.test(head)
      out += `${head}{${nested ? rewriteSelectors(block, rewrite) : block}}`
    } else if (head) {
      out += `${rewrite(head)}{${block}}`
    }
    i = close + 1
  }
  return out
}

function blockEnd(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i
  }
  return s.length
}
