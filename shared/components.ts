/**
 * Linked components: canvas-level definitions that frames use as custom
 * elements (`<ds-stat label="Net worth">₹18,42,300</ds-stat>`). Each instance
 * renders its definition into a shadow root with native <slot>s, so editing
 * the definition restyles every instance while frame HTML stays linked
 * (serialize() only ever sees the light DOM).
 */

import { spliceHead, spliceTheme } from './theme.ts'

export interface ComponentProp {
  name: string
  default?: string
  description?: string
}

export interface ComponentDef {
  /** the custom element tag, e.g. "ds-stat" */
  name: string
  /** shadow template: <slot>, <slot name="x">, {{prop}} placeholders */
  html: string
  /** scoped to the shadow root: :host, :host([variant="primary"]), inner classes */
  css: string
  props: ComponentProp[]
  description?: string
  version: number
  updatedAt: number
  updatedBy: string
  /** tombstone: instances render a visible "missing component" box */
  deletedAt?: number
}

/** What a frame runtime needs to render instances. */
export type ComponentRuntimeDef = Pick<ComponentDef, 'name' | 'html' | 'css' | 'props' | 'version' | 'deletedAt'>

export type ComponentInput = {
  name: string
  html: string
  css?: string
  props?: { name: string; default?: string; description?: string }[]
  description?: string
}

export const MAX_COMPONENTS = 100
export const MAX_COMPONENT_HTML_CHARS = 32_000
export const MAX_COMPONENT_CSS_CHARS = 32_000
export const MAX_COMPONENT_PROPS = 30

export const COMPONENT_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/
const PROP_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
/* reserved by the HTML spec — customElements.define rejects them */
const RESERVED = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
])

export function isComponentDef(value: unknown): value is ComponentDef {
  const d = value as ComponentDef | null
  return !!d && typeof d.name === 'string' && typeof d.html === 'string' && Array.isArray(d.props)
}

export function liveComponents(defs: readonly ComponentDef[] | undefined): ComponentDef[] {
  return (defs ?? []).filter((d) => !d.deletedAt)
}

export function normalizeComponentName(raw: string): string {
  const name = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (name.length > 48 || !COMPONENT_NAME_RE.test(name) || RESERVED.has(name))
    throw new Error(
      `invalid component name “${raw}” — use a lowercase custom-element tag with a hyphen, like "ds-stat" or "tj-ledger-row"`,
    )
  return name
}

/** `{{prop}}` names used in a template, in first-use order. */
export function templatePlaceholders(html: string): string[] {
  const names = new Set<string>()
  for (const m of html.matchAll(/\{\{\s*([a-z][a-z0-9-]*)\s*\}\}/g)) names.add(m[1]!)
  return [...names]
}

/** Slot names a template exposes; "default" is the unnamed slot. */
export function templateSlots(html: string): string[] {
  const slots = new Set<string>()
  for (const m of html.matchAll(/<slot\b([^>]*)>/gi)) {
    const named = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(m[1] ?? '')
    slots.add(named ? named[1]! : 'default')
  }
  return [...slots]
}

/** Validate a definition write; throws with a caller-facing message. Props
 *  used as {{placeholders}} but not declared are added without a default. */
export function normalizeComponent(input: ComponentInput): Omit<ComponentDef, 'version' | 'updatedAt' | 'updatedBy'> {
  const name = normalizeComponentName(input.name)
  const html = String(input.html ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (!html) throw new Error('component html is empty — delete_component removes a component')
  if (html.length > MAX_COMPONENT_HTML_CHARS)
    throw new Error(`component html is ${html.length} chars — the limit is ${MAX_COMPONENT_HTML_CHARS}`)
  if (/<script\b/i.test(html)) throw new Error('component html may not contain <script>')
  const css = String(input.css ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (css.length > MAX_COMPONENT_CSS_CHARS)
    throw new Error(`component css is ${css.length} chars — the limit is ${MAX_COMPONENT_CSS_CHARS}`)
  if (/@import\b/i.test(css)) throw new Error('component css may not use @import')

  const props = new Map<string, ComponentProp>()
  for (const raw of input.props ?? []) {
    if (!raw || typeof raw !== 'object') throw new Error('each prop needs a name')
    const propName = String(raw.name ?? '')
      .trim()
      .toLowerCase()
    if (!PROP_NAME_RE.test(propName))
      throw new Error(`invalid prop name “${raw.name}” on ${name} — use a lowercase attribute name like "variant"`)
    const description = raw.description?.replace(/\s+/g, ' ').trim().slice(0, 200)
    props.set(propName, {
      name: propName,
      ...(raw.default !== undefined ? { default: String(raw.default).slice(0, 400) } : {}),
      ...(description ? { description } : {}),
    })
  }
  for (const p of templatePlaceholders(html)) if (!props.has(p)) props.set(p, { name: p })
  if (props.size > MAX_COMPONENT_PROPS) throw new Error(`a component takes at most ${MAX_COMPONENT_PROPS} props`)
  const description = input.description?.replace(/\s+/g, ' ').trim().slice(0, 300)
  return { name, html, css, props: [...props.values()], ...(description ? { description } : {}) }
}

/** A universal reset in the page (`*{margin:0;padding:0}`) is an outer-tree
 *  rule, and outer rules beat :host for normal declarations — so :host
 *  margin/padding would be silently dropped. Returns a caller-facing warning. */
export function hostBoxWarning(css: string, pageCss: string): string | undefined {
  const hostBox = /:host\b[^{]*\{[^}]*\b(margin|padding)\b/i.test(css)
  const universalReset = /(^|[},]\s*)\*\s*(,[^{]*)?\{[^}]*\b(margin|padding)\b/.test(pageCss)
  if (hostBox && universalReset)
    return 'The theme resets margin/padding with a * rule, which overrides :host margin/padding. Put box styles (padding, margin) on an element inside the template instead, and keep :host to display and layout.'
  return undefined
}

/** Frames that use a component, and how many instances each holds. */
export function componentUsages(
  frames: readonly { id: string; name: string; html: string }[],
  name: string,
): { frameId: string; frameName: string; count: number }[] {
  const out: { frameId: string; frameName: string; count: number }[] = []
  const re = new RegExp(`<${name}(?=[\\s/>])`, 'gi')
  for (const f of frames) {
    const count = f.html.match(re)?.length ?? 0
    if (count) out.push({ frameId: f.id, frameName: f.name, count })
  }
  return out
}

/** Changes whenever any definition (or tombstone) does — render caches join it. */
export function componentsStamp(defs: readonly ComponentDef[] | undefined): string {
  if (!defs?.length) return '0'
  return `${defs.length}.${Math.max(...defs.map((d) => d.updatedAt))}`
}

export function runtimeDefs(defs: readonly ComponentDef[] | undefined): ComponentRuntimeDef[] {
  return (defs ?? []).map(({ name, html, css, props, version, deletedAt }) => ({
    name,
    html,
    css,
    props,
    version,
    ...(deletedAt ? { deletedAt } : {}),
  }))
}

/**
 * The instance runtime, as source: the browser frame runtime embeds it and
 * server renders inject it, so both paths render components identically.
 * `doopComponents.set(defs)` (re)defines and refreshes; `.refresh()` after a
 * DOM morph; `.setTheme(css)` shares the canvas theme into every shadow root,
 * where document styles do not reach. Plain ES2015, no backslashes: it lives
 * inside other template strings.
 */
export const COMPONENT_RUNTIME = `var doopComponents = (function () {
  var registry = {}
  var defined = []
  var sheets = {}
  var themeCss = null
  var themeSheet = new CSSStyleSheet()
  var fallbackSheet = new CSSStyleSheet()
  fallbackSheet.replaceSync(':host{display:block;outline:1.5px dashed #d0341f;outline-offset:-1.5px;padding:8px 10px;font:12px/1.4 ui-monospace,monospace;color:#d0341f;background:rgba(208,52,31,.06)}')
  var MAX_DEPTH = 8

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function propDefault(def, name) {
    for (var i = 0; i < def.props.length; i++) if (def.props[i].name === name) return def.props[i].default
    return undefined
  }

  /* {{prop}} -> the instance attribute, else the prop default; always escaped */
  function fill(def, el) {
    var tpl = def.html
    var out = ''
    var i = 0
    for (;;) {
      var a = tpl.indexOf('{{', i)
      if (a < 0) break
      var b = tpl.indexOf('}}', a + 2)
      if (b < 0) break
      var name = tpl.slice(a + 2, b).trim()
      out += tpl.slice(i, a)
      if (/^[a-z][a-z0-9-]*$/.test(name)) {
        var v = el.getAttribute(name)
        if (v === null) v = propDefault(def, name)
        out += esc(v == null ? '' : v)
      } else {
        out += tpl.slice(a, b + 2)
      }
      i = b + 2
    }
    return out + tpl.slice(i)
  }

  /* what a render depends on: the definition version and the instance attributes */
  function keyOf(def, el) {
    var k = def ? (def.deletedAt ? 'x' : def.version) + ':' : '?:'
    for (var i = 0; i < el.attributes.length; i++) {
      var n = el.attributes[i].name
      if (n === 'style' || n === 'class' || n === 'contenteditable' || n.indexOf('data-v-') === 0) continue
      k += n + '=' + el.attributes[i].value + ';'
    }
    return k
  }

  function depth(el) {
    var d = 0
    for (var r = el.getRootNode(); r && r.host; r = r.host.getRootNode()) d++
    return d
  }

  function sheetFor(def) {
    var s = sheets[def.name]
    if (!s || s.v !== def.version) {
      s = { v: def.version, sheet: new CSSStyleSheet() }
      s.sheet.replaceSync(def.css || '')
      sheets[def.name] = s
    }
    return s.sheet
  }

  function render(el) {
    var def = registry[el.localName]
    var key = keyOf(def, el)
    if (el.__doopKey === key) return
    el.__doopKey = key
    var root = el.shadowRoot || el.attachShadow({ mode: 'open' })
    if (!def || def.deletedAt || depth(el) > MAX_DEPTH) {
      root.adoptedStyleSheets = [fallbackSheet]
      root.innerHTML = (def && !def.deletedAt ? 'Component nested too deep: &lt;' : 'Missing component: &lt;') + esc(el.localName) + '&gt; <slot></slot>'
      return
    }
    root.adoptedStyleSheets = [themeSheet, sheetFor(def)]
    root.innerHTML = fill(def, el)
  }

  function define(name) {
    if (customElements.get(name)) return
    customElements.define(name, class extends HTMLElement {
      connectedCallback() { render(this) }
    })
    defined.push(name)
  }

  function refresh(root) {
    if (!defined.length) return
    var els = root.querySelectorAll(defined.join(','))
    for (var i = 0; i < els.length; i++) {
      render(els[i])
      if (els[i].shadowRoot) refresh(els[i].shadowRoot)
    }
  }

  function set(list) {
    var next = {}
    for (var i = 0; i < list.length; i++) next[list[i].name] = list[i]
    registry = next
    for (var n in next) define(n)
    refresh(document)
  }

  function setTheme(css) {
    if (css === themeCss) return
    themeCss = css
    themeSheet.replaceSync(css || '')
  }

  /* server renders: the theme <style> precedes this script in <head> */
  function boot(list) {
    var st = document.querySelector('style[data-doop-theme]')
    setTheme(st ? st.textContent : '')
    set(list)
  }

  return { set: set, refresh: function () { refresh(document) }, setTheme: setTheme, boot: boot }
})()`

/** The server-render <script>: runtime plus definitions, JSON made safe
 *  inside a <script> element. */
export function componentScript(defs: readonly ComponentRuntimeDef[]): string {
  if (!defs.length) return ''
  /* "<" escaped so no "</script" or "<!--" survives; U+2028/9 are line breaks to old JS parsers */
  const json = JSON.stringify(defs)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`)
  return `<script data-doop-components>${COMPONENT_RUNTIME};doopComponents.boot(${json})</script>`
}

/** A frame document as server renders load it: theme first in <head>, then
 *  the component runtime, so instances upgrade as the parser creates them. */
export function prepareFrameHtml(html: string, themeCss: string, defs: readonly ComponentRuntimeDef[]): string {
  return spliceTheme(spliceHead(html, componentScript(defs)), themeCss)
}
