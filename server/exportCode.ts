import { parseHtml, type ElementNode, type TreeChild } from './htmlTree.ts'
import {
  camelProp,
  decodeEntities,
  jsxAttrName,
  jsxStyle,
  jsxTag,
  jsxText,
  rewriteSelectors,
  scopeComponentCss,
} from './jsx.ts'
import { compileTheme } from '../shared/theme.ts'
import {
  liveComponents,
  prepareFrameHtml,
  runtimeDefs,
  templateSlots,
  type ComponentDef,
} from '../shared/components.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/**
 * Frame → code. `react` writes a page component plus one component file per
 * linked component it uses, the theme as plain CSS, and the frame's own CSS;
 * `html` writes one self-contained document (theme and component runtime
 * inlined, exactly what draft renders). Both are pure functions of the canvas.
 */

export interface ExportFile {
  path: string
  content: string
}

export interface CodeExport {
  target: 'react' | 'html'
  entry: string
  files: ExportFile[]
  warnings: string[]
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
const DROPPED = new Set(['script', 'style', 'link', 'meta', 'title', 'base', 'noscript', 'template', 'head'])
const BOOLEAN = new Set([
  'disabled',
  'checked',
  'selected',
  'readonly',
  'required',
  'multiple',
  'autofocus',
  'hidden',
  'open',
  'novalidate',
  'defer',
  'async',
  'controls',
  'autoplay',
  'loop',
  'muted',
  'playsinline',
  'allowfullscreen',
  'default',
  'reversed',
  'itemscope',
  'inert',
])

export function pascal(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  const joined = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')
  return /^[A-Z]/.test(joined) ? joined : `Frame${joined}`
}

const isElement = (n: TreeChild): n is ElementNode => n.type === 'element'
const attrOf = (el: ElementNode, name: string) => el.attrs.find((a) => a.name === name)?.value

function textOf(el: ElementNode): string {
  return el.children.map((c) => (c.type === 'text' ? c.value : isElement(c) ? textOf(c) : '')).join('')
}

function findAll(nodes: TreeChild[], tag: string, out: ElementNode[] = []): ElementNode[] {
  for (const n of nodes) {
    if (!isElement(n)) continue
    if (n.tag === tag) out.push(n)
    findAll(n.children, tag, out)
  }
  return out
}

interface Ctx {
  components: Map<string, ComponentDef>
  used: Set<string>
  warnings: Set<string>
  /** inside a component template: {{prop}} placeholders become expressions */
  template?: { props: Set<string>; defaults: Map<string, string | undefined> }
  pre?: boolean
  /** a style object used a custom property, which CSSProperties does not type */
  cssVars?: { used: boolean }
}

/* "a {{b}} c" → template-literal parts, for attribute values */
function templateAttr(value: string, ctx: Ctx): string | null {
  if (!ctx.template || !/\{\{\s*[a-z][a-z0-9-]*\s*\}\}/.test(value)) return null
  const body = decodeEntities(value)
    .replace(/[`\\]/g, (c) => `\\${c}`)
    .replace(/\$\{/g, '\\${')
    .replace(/\{\{\s*([a-z][a-z0-9-]*)\s*\}\}/g, (_, p: string) => `\${${propExpr(p, ctx)}}`)
  return `{\`${body}\`}`
}

function propExpr(name: string, ctx: Ctx): string {
  const id = camelProp(name)
  const fallback = ctx.template?.defaults.get(name)
  return fallback === undefined ? `(${id} ?? '')` : `(${id} ?? ${JSON.stringify(fallback)})`
}

function textChild(raw: string, ctx: Ctx): string {
  if (!ctx.template || !raw.includes('{{')) return jsxText(raw, ctx.pre)
  return raw
    .split(/(\{\{\s*[a-z][a-z0-9-]*\s*\}\})/)
    .map((part) => {
      const m = /^\{\{\s*([a-z][a-z0-9-]*)\s*\}\}$/.exec(part)
      if (m) return `{${propExpr(m[1]!, ctx)}}`
      return part ? jsxText(part, ctx.pre) : ''
    })
    .join('')
}

function propsOf(el: ElementNode, ctx: Ctx, skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  for (const { name, value } of el.attrs) {
    if (skip.has(name)) continue
    const prop = jsxAttrName(name)
    if (!prop) {
      ctx.warnings.add(`dropped inline event handler ${name}="…" — wire it up in React instead`)
      continue
    }
    if (name === 'style') {
      const style = jsxStyle(decodeEntities(value))
      const vars = style.includes('"--')
      if (vars && ctx.cssVars) ctx.cssVars.used = true
      out.push(vars ? `style={${style.slice(1, -1)} as CSSProperties}` : `style=${style}`)
      continue
    }
    let key = prop
    if (el.tag === 'input' && name === 'value') key = 'defaultValue'
    if (el.tag === 'input' && name === 'checked') key = 'defaultChecked'
    if (BOOLEAN.has(name) && (value === '' || value.toLowerCase() === name)) {
      out.push(key === 'defaultChecked' ? 'defaultChecked' : key)
      continue
    }
    out.push(`${key}=${templateAttr(value, ctx) ?? JSON.stringify(decodeEntities(value))}`)
  }
  return out
}

function children(nodes: TreeChild[], ctx: Ctx): string {
  return nodes.map((n) => node(n, ctx)).join('')
}

function node(n: TreeChild, ctx: Ctx): string {
  if (n.type === 'text') return textChild(n.value, ctx)
  if (!isElement(n)) return ''
  /* html/head/body/tbody the parser synthesized are not in the source */
  if (n.implied) return n.tag === 'head' ? '' : children(n.children, ctx)
  if (DROPPED.has(n.tag)) return ''
  const def = ctx.components.get(n.tag)
  if (def) return instance(n, def, ctx)
  if (n.tag === 'slot' && ctx.template) {
    const name = attrOf(n, 'name')
    const expr = name ? camelProp(name) : 'children'
    const fallback = children(n.children, ctx).trim()
    return fallback && fallback !== "{' '}" ? `{${expr} ?? <>${fallback}</>}` : `{${expr}}`
  }
  if (n.tag.includes('-')) ctx.warnings.add(`<${n.tag}> is not a linked component on this canvas; exported as a <div>`)
  const tag = n.tag.includes('-') ? 'div' : jsxTag(n.tag)
  const props = propsOf(n, ctx)
  if (n.tag === 'textarea') {
    const text = decodeEntities(textOf(n))
    if (text) props.push(`defaultValue=${JSON.stringify(text)}`)
    return `<textarea${props.length ? ' ' + props.join(' ') : ''} />`
  }
  const open = `<${tag}${props.length ? ' ' + props.join(' ') : ''}`
  if (VOID.has(n.tag)) return `${open} />`
  const inner = children(n.children, { ...ctx, pre: ctx.pre || n.tag === 'pre' })
  return inner ? `${open}>${inner}</${tag}>` : `${open} />`
}

/* <tj-feature title="…"><svg slot="icon">…</svg>Body</tj-feature>
   → <TjFeature title="…" icon={<svg>…</svg>}>Body</TjFeature> */
function instance(el: ElementNode, def: ComponentDef, ctx: Ctx): string {
  ctx.used.add(def.name)
  const Name = pascal(def.name)
  const propNames = new Set(def.props.map((p) => p.name))
  const out: string[] = []
  for (const { name, value } of el.attrs) {
    if (propNames.has(name)) out.push(`${camelProp(name)}=${JSON.stringify(decodeEntities(value))}`)
  }
  out.push(...propsOf(el, ctx, propNames))
  const named = new Map<string, TreeChild[]>()
  const rest: TreeChild[] = []
  for (const c of el.children) {
    const slot = isElement(c) ? attrOf(c, 'slot') : undefined
    if (slot && isElement(c)) {
      const unslotted: ElementNode = { ...c, attrs: c.attrs.filter((a) => a.name !== 'slot') }
      named.set(slot, [...(named.get(slot) ?? []), unslotted])
    } else rest.push(c)
  }
  for (const [slot, nodes] of named) {
    const jsx = children(nodes, ctx)
    out.push(`${camelProp(slot)}={${nodes.filter(isElement).length > 1 ? `<>${jsx}</>` : jsx}}`)
  }
  const inner = rest.every((c) => c.type === 'text' && !c.value.trim()) ? '' : children(rest, ctx)
  const open = `<${Name}${out.length ? ' ' + out.join(' ') : ''}`
  return inner ? `${open}>${inner}</${Name}>` : `${open} />`
}

/** Components the given ones use in their templates, transitively. */
function closure(names: Set<string>, defs: Map<string, ComponentDef>): string[] {
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    const def = defs.get(name)
    if (!def) return
    for (const el of walkElements(parseHtml(def.html).children)) if (defs.has(el.tag)) visit(el.tag)
  }
  names.forEach(visit)
  return [...seen].filter((n) => defs.has(n)).sort()
}

function walkElements(nodes: TreeChild[], out: ElementNode[] = []): ElementNode[] {
  for (const n of nodes) {
    if (!isElement(n)) continue
    out.push(n)
    walkElements(n.children, out)
  }
  return out
}

/* type selectors naming a component become the class its React wrapper carries */
function componentSelectors(css: string, names: string[]): string {
  if (!names.length) return css
  const re = new RegExp(`(^|[\\s>+~,(])(${names.join('|')})(?=[\\s>+~,.:#\\[)]|$)`, 'g')
  return rewriteSelectors(css, (list) => list.replace(re, '$1.$2'))
}

function componentFile(def: ComponentDef, defs: Map<string, ComponentDef>, warnings: Set<string>): ExportFile[] {
  const Name = pascal(def.name)
  const slots = templateSlots(def.html).filter((s) => s !== 'default')
  const hasDefault = templateSlots(def.html).includes('default')
  const hostAttrs = def.props.map((p) => p.name).filter((p) => new RegExp(`\\[${p}(?=[\\]=~^$*|])`).test(def.css))
  const ctx: Ctx = {
    components: defs,
    used: new Set(),
    warnings,
    cssVars: { used: false },
    template: {
      props: new Set(def.props.map((p) => p.name)),
      defaults: new Map(def.props.map((p) => [p.name, p.default])),
    },
  }
  const body = children(parseHtml(def.html).children, ctx)
  const own = [...def.props.map((p) => camelProp(p.name)), ...slots.map(camelProp)]
  const omit = [...new Set([...own, 'children'])].map((k) => JSON.stringify(k)).join(' | ')
  const fields = [
    ...def.props.map((p) => `  ${camelProp(p.name)}?: string${p.description ? ` // ${p.description}` : ''}`),
    ...slots.map((s) => `  ${camelProp(s)}?: ReactNode`),
    '  children?: ReactNode',
  ]
  const imports = [...ctx.used].sort().map((n) => `import { ${pascal(n)} } from './${pascal(n)}'`)
  const destructure = [...new Set([...own, 'children', 'className'])].join(', ')
  const data = hostAttrs.map((a) => ` data-${a}={${camelProp(a)}}`).join('')
  const tsx = [
    `import type { ${ctx.cssVars!.used ? 'CSSProperties, ' : ''}HTMLAttributes, ReactNode } from 'react'`,
    ...imports,
    `import './${Name}.css'`,
    '',
    ...(def.description ? [`/** ${def.description} */`] : []),
    `export interface ${Name}Props extends Omit<HTMLAttributes<HTMLDivElement>, ${omit}> {`,
    ...fields,
    '}',
    '',
    `export function ${Name}({ ${destructure}, ...rest }: ${Name}Props) {`,
    ...(hasDefault ? [] : ['  void children']),
    '  return (',
    `    <div {...rest} className={['${def.name}', className].filter(Boolean).join(' ')}${data}>`,
    `      ${body}`,
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
  return [
    { path: `components/${Name}.tsx`, content: tsx },
    { path: `components/${Name}.css`, content: scopeComponentCss(def.css, def.name, hostAttrs) + '\n' },
  ]
}

/** utilityCss: the canvas's Tailwind sheet (server/utilities.ts), '' when it has not opted in. */
export function exportFrameCode(frame: Frame, canvas: Canvas, target: 'react' | 'html', utilityCss = ''): CodeExport {
  if (target === 'html') {
    const html = prepareFrameHtml(frame.html, compileTheme(canvas.theme), runtimeDefs(canvas.components), utilityCss)
    return { target, entry: 'index.html', files: [{ path: 'index.html', content: html }], warnings: [] }
  }
  const defs = new Map(liveComponents(canvas.components).map((d) => [d.name, d]))
  const warnings = new Set<string>()
  const root = parseHtml(frame.html)
  const all = root.children
  const styles = findAll(all, 'style').map((s) => textOf(s).trim())
  const links = findAll(all, 'link')
    .filter((l) => (attrOf(l, 'rel') ?? '').toLowerCase() === 'stylesheet' && attrOf(l, 'href'))
    .map((l) => `@import url(${JSON.stringify(attrOf(l, 'href'))});`)
  if (findAll(all, 'script').length) warnings.add('dropped <script> elements — port any behaviour to React by hand')
  const body = findAll(all, 'body')[0]
  if (body && body.attrs.some((a) => a.name === 'class' || a.name === 'style'))
    warnings.add('<body> class/style are not exported — apply them to your app shell')
  const ctx: Ctx = { components: defs, used: new Set(), warnings, cssVars: { used: false } }
  const jsx = children(body ? body.children : all, ctx)
  const used = closure(ctx.used, defs)
  const Page = pascal(frame.name)
  const theme = canvas.theme
  const tokens = theme?.tokens.length
    ? `:root {\n${theme.tokens.map((t) => `  ${t.name}: ${t.value};`).join('\n')}\n}\n`
    : ''
  const files: ExportFile[] = []
  if (tokens || theme?.fontFaces)
    files.push({
      path: 'styles/tokens.css',
      content: [tokens, theme?.fontFaces ?? ''].filter(Boolean).join('\n') + '\n',
    })
  if (theme?.css) files.push({ path: 'styles/theme.css', content: theme.css + '\n' })
  if (utilityCss) files.push({ path: 'styles/utilities.css', content: utilityCss + '\n' })
  for (const name of used) files.push(...componentFile(defs.get(name)!, defs, warnings))
  const pageCss = componentSelectors([...links, ...styles].join('\n'), used)
  files.push({ path: `${Page}.css`, content: pageCss + '\n' })
  const page = [
    ...(ctx.cssVars!.used ? [`import type { CSSProperties } from 'react'`] : []),
    ...(files.some((f) => f.path === 'styles/tokens.css') ? [`import './styles/tokens.css'`] : []),
    ...(theme?.css ? [`import './styles/theme.css'`] : []),
    ...(utilityCss ? [`import './styles/utilities.css'`] : []),
    ...[...ctx.used].sort().map((n) => `import { ${pascal(n)} } from './components/${pascal(n)}'`),
    `import './${Page}.css'`,
    '',
    `/** Exported from the draft frame “${frame.name}” (${Math.round(frame.width)}×${Math.round(frame.height)}). */`,
    `export default function ${Page}() {`,
    '  return (',
    `    <>${jsx}</>`,
    '  )',
    '}',
    '',
  ].join('\n')
  files.push({ path: `${Page}.tsx`, content: page })
  return { target, entry: `${Page}.tsx`, files, warnings: [...warnings] }
}
