/**
 * Tolerant, dependency-free HTML parser that keeps source offsets, so agent tools can outline a
 * frame, read one element's source and splice in a replacement without re-serializing the rest.
 */

export type Namespace = 'html' | 'svg' | 'math'

export interface HtmlAttr {
  name: string
  value: string
}

export interface DocumentNode {
  type: 'document'
  children: TreeChild[]
  start: number
  end: number
}

export interface ElementNode {
  type: 'element'
  /** Lowercased; SVG camelCase names (`linearGradient`) keep their case only in the source. */
  tag: string
  ns: Namespace
  /** Source order, names lowercased; a repeated name keeps its first value, as in the DOM. */
  attrs: HtmlAttr[]
  children: TreeChild[]
  parent: TreeParent
  /** Index of the start tag's `<`. */
  start: number
  /** Just past the start tag's `>`; equals `start` for an implied element. */
  openEnd: number
  /** Just past the end tag, else where it was implicitly closed (html.length at EOF). */
  end: number
  /** Missing html/head/body (and tbody/tr) are synthesized where a browser opens them, so
   *  `body > …` selectors and outline paths work on fragments too. */
  implied: boolean
}

export interface TextNode {
  type: 'text'
  /** Raw source, entities undecoded. */
  value: string
  parent: TreeParent
  start: number
  end: number
}

/** A comment, doctype, or bogus `<!…>` / `<?…>` construct. */
export interface MarkupNode {
  type: 'comment' | 'doctype'
  parent: TreeParent
  start: number
  end: number
}

export type TreeParent = DocumentNode | ElementNode
export type TreeChild = ElementNode | TextNode | MarkupNode
export type HtmlNode = DocumentNode | TreeChild

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '))

const VOID = words('area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr')
const RAW_TEXT = words('script style textarea title xmp iframe noembed noframes')
const HEAD_CONTENT = words('base basefont bgsound link meta noframes noscript script style template title')
const HEADINGS = words('h1 h2 h3 h4 h5 h6')
const CLOSES_P = words(
  'address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hgroup hr li dd dt listing main menu nav ol p plaintext pre search section summary ' +
    'table ul xmp',
)
const SPECIAL = words(
  'address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup ' +
    'dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head ' +
    'header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes ' +
    'noscript object ol p param plaintext pre script search section select source style summary table tbody td ' +
    'template textarea tfoot th thead title tr track ul wbr xmp',
)
const HTML_SCOPE = words('applet caption html table td th marquee object template')
const SVG_INTEGRATION = words('foreignobject desc title')
const MATH_INTEGRATION = words('mi mo mn ms mtext annotation-xml')
const TABLE_SCOPED = words('table caption tbody thead tfoot tr td th')
const TABLE_SECTIONS = words('tbody thead tfoot')
const LIST_ITEM_PASS = words('address div p')
const BREAKOUT_END = words('head body html br')

// target lists for open-element lookups, which iterate them rather than test membership
const HEADING_TAGS = [...HEADINGS]
const SECTION_TAGS = [...TABLE_SECTIONS]
const CELL_TAGS = ['td', 'th']
const DD_DT = ['dd', 'dt']
const ONLY_P = ['p']
const ONLY_LI = ['li']
const ONLY_TR = ['tr']
const ONLY_BUTTON = ['button']

const TAB = 9
const LF = 10
const FF = 12
const CR = 13
const SPACE = 32
const BANG = 33
const DQUOTE = 34
const SQUOTE = 39
const DASH = 45
const SLASH = 47
const EQUALS = 61
const GT = 62
const QUESTION = 63
const BACKSLASH = 92

function isSpace(c: number): boolean {
  return c === SPACE || c === LF || c === TAB || c === CR || c === FF
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90)
}

function isBlank(s: string): boolean {
  for (let k = 0; k < s.length; k++) if (!isSpace(s.charCodeAt(k))) return false
  return true
}

/** `word` must be lowercase ASCII letters; `| 0x20` folds only A-Z onto a-z for those. */
function startsWithWord(html: string, at: number, word: string): boolean {
  for (let k = 0; k < word.length; k++) if ((html.charCodeAt(at + k) | 0x20) !== word.charCodeAt(k)) return false
  return true
}

/* ---------------------------------------------------------------- tokenizer */

interface TagToken {
  tag: string
  attrs: HtmlAttr[]
  start: number
  end: number
  selfClosing: boolean
}

/** Scans a start or end tag from its name; null when EOF cuts it off (browsers drop such a tag). */
function readTag(html: string, lt: number, nameStart: number): TagToken | null {
  const n = html.length
  let i = nameStart
  while (i < n) {
    const c = html.charCodeAt(i)
    if (isSpace(c) || c === SLASH || c === GT) break
    i++
  }
  const tag = html.slice(nameStart, i).toLowerCase()
  const attrs: HtmlAttr[] = []
  for (;;) {
    let c = html.charCodeAt(i)
    while (isSpace(c) || (c === SLASH && html.charCodeAt(i + 1) !== GT)) c = html.charCodeAt(++i)
    if (i >= n) return null
    if (c === GT) return { tag, attrs, start: lt, end: i + 1, selfClosing: false }
    if (c === SLASH) return { tag, attrs, start: lt, end: i + 2, selfClosing: true }

    const nameAt = i++ // a leading '=' belongs to the name
    while (i < n) {
      const d = html.charCodeAt(i)
      if (isSpace(d) || d === SLASH || d === GT || d === EQUALS) break
      i++
    }
    const name = html.slice(nameAt, i).toLowerCase()
    while (isSpace(html.charCodeAt(i))) i++
    let value = ''
    if (html.charCodeAt(i) === EQUALS) {
      i++
      while (isSpace(html.charCodeAt(i))) i++
      const q = html.charCodeAt(i)
      if (q === DQUOTE || q === SQUOTE) {
        const close = html.indexOf(q === DQUOTE ? '"' : "'", i + 1)
        if (close === -1) return null
        value = html.slice(i + 1, close)
        i = close + 1
      } else {
        const valueAt = i
        while (i < n && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== GT) i++
        value = html.slice(valueAt, i)
      }
    }
    if (!attrs.some((a) => a.name === name)) attrs.push({ name, value })
  }
}

function commentEnd(html: string, lt: number): number {
  const body = lt + 4
  if (html.charCodeAt(body) === GT) return body + 1
  if (html.charCodeAt(body) === DASH && html.charCodeAt(body + 1) === GT) return body + 2
  const close = html.indexOf('-->', body)
  return close === -1 ? html.length : close + 3
}

/** Comments, doctypes and bogus markup; returns the index just past it. */
function readMarkup(html: string, tree: TreeBuilder, lt: number): number {
  if (html.startsWith('</>', lt)) return lt + 3
  if (html.startsWith('<!--', lt)) {
    const end = commentEnd(html, lt)
    tree.markup('comment', lt, end)
    return end
  }
  const gt = html.indexOf('>', lt + 2)
  const end = gt === -1 ? html.length : gt + 1
  const doctype = html.charCodeAt(lt + 1) === BANG && startsWithWord(html, lt + 2, 'doctype')
  tree.markup(doctype ? 'doctype' : 'comment', lt, end)
  return end
}

/** Raw-text content (script/style/…) runs to the first matching end tag; returns where parsing resumes. */
function readRawText(html: string, tree: TreeBuilder, el: ElementNode): number {
  const from = el.openEnd
  for (let k = html.indexOf('</', from); k !== -1; k = html.indexOf('</', k + 2)) {
    const after = html.charCodeAt(k + 2 + el.tag.length)
    if (!startsWithWord(html, k + 2, el.tag) || !(isSpace(after) || after === SLASH || after === GT)) continue
    const close = readTag(html, k, k + 2)
    if (!close) break
    if (k > from) tree.rawText(el, html.slice(from, k), from, k)
    tree.closeElement(el, close.end, close.end)
    return close.end
  }
  if (html.length > from) tree.rawText(el, html.slice(from), from, html.length)
  return html.length
}

/** Parses a whole document or a fragment; linear in input size, never throws. */
export function parseHtml(html: string): DocumentNode {
  const tree = new TreeBuilder(html.length)
  const n = html.length
  let pos = 0
  let scan = 0
  const flush = (upTo: number): void => {
    if (upTo > pos) tree.text(html.slice(pos, upTo), pos, upTo)
  }
  while (scan < n) {
    const lt = html.indexOf('<', scan)
    if (lt === -1) break
    const next = html.charCodeAt(lt + 1)
    const endTag = next === SLASH && isAsciiAlpha(html.charCodeAt(lt + 2))
    if (isAsciiAlpha(next) || endTag) {
      flush(lt)
      const tok = readTag(html, lt, endTag ? lt + 2 : lt + 1)
      if (!tok) {
        pos = n
        break
      }
      pos = tok.end
      if (endTag) tree.endTag(tok.tag, lt, tok.end)
      else {
        const el = tree.startTag(tok)
        if (el && el.ns === 'html' && RAW_TEXT.has(el.tag)) pos = readRawText(html, tree, el)
      }
    } else if (next === BANG || next === QUESTION || (next === SLASH && lt + 2 < n)) {
      flush(lt)
      pos = readMarkup(html, tree, lt)
    } else {
      scan = lt + 1 // a literal '<' in text
      continue
    }
    scan = pos
  }
  flush(n)
  tree.finish(n)
  return tree.doc
}

/* ------------------------------------------------------------- tree builder */

type Mode = 'initial' | 'beforeHead' | 'inHead' | 'afterHead' | 'inBody' | 'afterBody' | 'afterAfterBody'
type Scope = 'default' | 'button' | 'list' | 'table'

function isIntegrationPoint(el: ElementNode): boolean {
  return el.ns === 'svg' ? SVG_INTEGRATION.has(el.tag) : el.ns === 'math' && MATH_INTEGRATION.has(el.tag)
}

function isSpecial(el: ElementNode): boolean {
  return el.ns === 'html' ? SPECIAL.has(el.tag) : isIntegrationPoint(el)
}

function isForeignContext(parent: TreeParent): boolean {
  return parent.type === 'element' && parent.ns !== 'html' && !isIntegrationPoint(parent)
}

/** HTML elements key by tag, foreign ones by `ns tag`, so `<svg><title>` never closes an HTML title. */
function keyOf(el: ElementNode): string {
  return el.ns === 'html' ? el.tag : `${el.ns} ${el.tag}`
}

/** Open elements are tracked per mark: each scope's boundaries, specials, HTML ones and templates. */
type Mark = Scope | 'special' | 'html' | 'template'
const MARKS: readonly Mark[] = ['default', 'button', 'list', 'table', 'special', 'html', 'template']

function hasMark(el: ElementNode, mark: Mark): boolean {
  const html = el.ns === 'html'
  switch (mark) {
    case 'default':
      return html ? HTML_SCOPE.has(el.tag) : isIntegrationPoint(el)
    case 'button':
      return hasMark(el, 'default') || (html && el.tag === 'button')
    case 'list':
      return hasMark(el, 'default') || (html && (el.tag === 'ol' || el.tag === 'ul'))
    case 'table':
      return html && (el.tag === 'html' || el.tag === 'table' || el.tag === 'template')
    case 'special':
      return isSpecial(el)
    case 'html':
      return html
    case 'template':
      return html && el.tag === 'template'
  }
}

function namespaceFor(tag: string, parent: TreeParent): Namespace {
  if (tag === 'svg') return 'svg'
  if (tag === 'math') return 'math'
  return isForeignContext(parent) && parent.type === 'element' ? parent.ns : 'html'
}

function endTagScope(tag: string): Scope {
  if (tag === 'p') return 'button'
  if (tag === 'li') return 'list'
  return TABLE_SCOPED.has(tag) ? 'table' : 'default'
}

/** The stack of open elements, indexed by key so scope checks are O(1) lookups: walking the stack
 *  instead made 12k nested <div>s take ~1 s to parse. */
class OpenElements {
  readonly items: ElementNode[] = []
  private readonly byKey = new Map<string, number[]>()
  // one stack per mark, reachable by name for lookups and by bit position for push/pop
  private readonly marked: Record<Mark, number[]> = {
    default: [],
    button: [],
    list: [],
    table: [],
    special: [],
    html: [],
    template: [],
  }
  private readonly markStacks: number[][] = MARKS.map((mark) => this.marked[mark])
  // per open item: its byKey list and mark bits, so popping needs no lookups
  private readonly slots: number[][] = []
  private readonly bits: number[] = []
  // marks depend only on the key; cached per parse, never module-wide, as tag names are unbounded input
  private readonly bitsByKey = new Map<string, number>()

  get length(): number {
    return this.items.length
  }

  top(): ElementNode | undefined {
    return this.items[this.items.length - 1]
  }

  push(el: ElementNode): void {
    const k = this.items.length
    const key = keyOf(el)
    let slot = this.byKey.get(key)
    if (!slot) {
      slot = []
      this.byKey.set(key, slot)
    }
    let bits = this.bitsByKey.get(key)
    if (bits === undefined) {
      bits = MARKS.reduce((acc, mark, b) => (hasMark(el, mark) ? acc | (1 << b) : acc), 0)
      this.bitsByKey.set(key, bits)
    }
    slot.push(k)
    for (let b = 0; b < MARKS.length; b++) if (bits & (1 << b)) this.markStacks[b]!.push(k)
    this.items.push(el)
    this.slots.push(slot)
    this.bits.push(bits)
  }

  /** Drops items[k] and everything above it. */
  truncate(k: number): void {
    for (let j = this.items.length - 1; j >= k; j--) {
      this.slots[j]!.pop()
      const bits = this.bits[j]!
      for (let b = 0; b < MARKS.length; b++) if (bits & (1 << b)) this.markStacks[b]!.pop()
    }
    this.items.length = k
    this.slots.length = k
    this.bits.length = k
  }

  /** Index of the topmost open element whose key is in `keys`, or -1. */
  nearest(keys: readonly string[]): number {
    let best = -1
    for (const key of keys) {
      const at = this.byKey.get(key)
      const k = at && at.length ? at[at.length - 1]! : -1
      if (k > best) best = k
    }
    return best
  }

  nearestMarked(mark: Mark): number {
    const at = this.marked[mark]
    return at.length ? at[at.length - 1]! : -1 // never read at[-1]: an out-of-bounds read is V8's slow path
  }

  /** Index of the topmost open special element, passing over HTML ones tagged in `pass`. */
  nearestSpecial(pass?: ReadonlySet<string>): number {
    const specials = this.marked.special
    for (let s = specials.length - 1; s >= 0; s--) {
      const k = specials[s]!
      const el = this.items[k]!
      if (!pass || el.ns !== 'html' || !pass.has(el.tag)) return k
    }
    return -1
  }
}

/** Applies the HTML5 insertion rules that decide an element's parent, so selectors computed on the
 *  live DOM (the frame runtime's) land on the same element here. */
class TreeBuilder {
  readonly doc: DocumentNode
  private readonly open = new OpenElements()
  private mode: Mode = 'initial'
  private html: ElementNode | null = null
  private head: ElementNode | null = null
  private body: ElementNode | null = null

  constructor(length: number) {
    this.doc = { type: 'document', children: [], start: 0, end: length }
  }

  text(value: string, start: number, end: number): void {
    if (!this.inTemplate() && this.mode !== 'inBody' && !isBlank(value)) this.enterBody(start)
    const parent = this.current()
    parent.children.push({ type: 'text', value, parent, start, end })
  }

  rawText(el: ElementNode, value: string, start: number, end: number): void {
    el.children.push({ type: 'text', value, parent: el, start, end })
  }

  markup(type: MarkupNode['type'], start: number, end: number): void {
    const parent = this.current()
    parent.children.push({ type, parent, start, end })
  }

  /** Returns the inserted element, or null when the tag is dropped (a repeated html/head/body). */
  startTag(tok: TagToken): ElementNode | null {
    const { tag, start } = tok
    for (;;) {
      switch (this.inTemplate() ? 'inBody' : this.mode) {
        case 'initial':
          this.mode = 'beforeHead'
          this.html = tag === 'html' ? this.insert(tok) : this.imply('html', start)
          if (tag === 'html') return this.html
          continue
        case 'beforeHead':
          if (tag === 'html') return null
          this.mode = 'inHead'
          this.head = tag === 'head' ? this.insert(tok) : this.imply('head', start)
          if (tag === 'head') return this.head
          continue
        case 'inHead':
          if (HEAD_CONTENT.has(tag)) return this.insert(tok)
          if (tag === 'html' || tag === 'head') return null
          this.closeElement(this.head, start, start)
          this.mode = 'afterHead'
          continue
        case 'afterHead':
          if (tag === 'html' || tag === 'head') return null
          if (HEAD_CONTENT.has(tag) && this.head) {
            this.open.push(this.head) // `</head><style>` still lands in head
            this.mode = 'inHead'
            continue
          }
          this.mode = 'inBody'
          this.body = tag === 'body' ? this.insert(tok) : this.imply('body', start)
          if (tag === 'body') return this.body
          continue
        case 'inBody':
          if (tag === 'html' || tag === 'head' || tag === 'body') return null
          return this.insertInBody(tok)
        case 'afterBody':
        case 'afterAfterBody':
          this.reopenBody()
      }
    }
  }

  endTag(tag: string, start: number, end: number): void {
    for (;;) {
      switch (this.inTemplate() ? 'inBody' : this.mode) {
        case 'initial':
        case 'beforeHead':
        case 'afterHead':
          if (!BREAKOUT_END.has(tag)) return
          this.enterBody(start)
          continue
        case 'inHead':
          if (tag === 'head') {
            this.closeElement(this.head, start, end)
            this.mode = 'afterHead'
            return
          }
          if (!BREAKOUT_END.has(tag)) return this.endInBody(tag, start, end)
          this.enterBody(start)
          continue
        case 'inBody':
          if (this.inTemplate() || (tag !== 'body' && tag !== 'html')) return this.endInBody(tag, start, end)
          this.closeElement(this.body, start, tag === 'body' ? end : start)
          this.mode = 'afterBody'
          if (tag === 'body') return
          continue
        case 'afterBody':
          if (tag === 'html') {
            this.closeElement(this.html, start, end)
            this.mode = 'afterAfterBody'
          }
          return
        case 'afterAfterBody':
          return
      }
    }
  }

  finish(length: number): void {
    if (this.mode !== 'afterBody' && this.mode !== 'afterAfterBody') this.enterBody(length)
    this.closeAt(0, length, length)
  }

  closeElement(el: ElementNode | null, innerEnd: number, outerEnd: number): void {
    const k = el ? this.open.items.lastIndexOf(el) : -1
    if (k >= 0) this.closeAt(k, innerEnd, outerEnd)
  }

  private current(): TreeParent {
    return this.open.top() ?? this.doc
  }

  private currentTag(): string {
    const el = this.open.top()
    return el && el.ns === 'html' ? el.tag : ''
  }

  private inTemplate(): boolean {
    return this.open.nearestMarked('template') >= 0
  }

  /** The "anything else" path: open whatever of html/head/body is still missing, then enter body. */
  private enterBody(pos: number): void {
    if (this.mode === 'initial') {
      this.html = this.imply('html', pos)
      this.mode = 'beforeHead'
    }
    if (this.mode === 'beforeHead') {
      this.head = this.imply('head', pos)
      this.mode = 'inHead'
    }
    if (this.mode === 'inHead') {
      this.closeElement(this.head, pos, pos)
      this.mode = 'afterHead'
    }
    if (this.mode === 'afterHead') {
      this.body = this.imply('body', pos)
      this.mode = 'inBody'
    }
    if (this.mode === 'afterBody' || this.mode === 'afterAfterBody') this.reopenBody()
  }

  /** Content after `</body>` belongs to body in the DOM, so body reopens and its span grows. */
  private reopenBody(): void {
    if (this.html && this.open.length === 0) this.open.push(this.html)
    if (this.body) this.open.push(this.body)
    this.mode = 'inBody'
  }

  private imply(tag: string, pos: number): ElementNode {
    const parent = this.current()
    const el: ElementNode = {
      type: 'element',
      tag,
      ns: 'html',
      attrs: [],
      children: [],
      parent,
      start: pos,
      openEnd: pos,
      end: pos,
      implied: true,
    }
    parent.children.push(el)
    this.open.push(el)
    return el
  }

  private insert(tok: TagToken): ElementNode {
    const parent = this.current()
    const ns = namespaceFor(tok.tag, parent)
    const el: ElementNode = {
      type: 'element',
      tag: tok.tag,
      ns,
      attrs: tok.attrs,
      children: [],
      parent,
      start: tok.start,
      openEnd: tok.end,
      end: tok.end,
      implied: false,
    }
    parent.children.push(el)
    // `/>` only self-closes in SVG/MathML; in HTML only void elements have no content
    if (ns === 'html' ? !VOID.has(tok.tag) : !tok.selfClosing) this.open.push(el)
    return el
  }

  private insertInBody(tok: TagToken): ElementNode {
    const { tag, start } = tok
    if (isForeignContext(this.current())) return this.insert(tok)
    if (tag === 'li') this.closeListItem(ONLY_LI, start)
    else if (tag === 'dd' || tag === 'dt') this.closeListItem(DD_DT, start)
    if (CLOSES_P.has(tag)) this.closeInScope(ONLY_P, 'button', start)

    if (HEADINGS.has(tag)) {
      if (HEADINGS.has(this.currentTag())) this.closeAt(this.open.length - 1, start, start)
    } else if (tag === 'option' || tag === 'optgroup') {
      if (this.currentTag() === 'option') this.closeAt(this.open.length - 1, start, start)
    } else if (tag === 'button') {
      this.closeInScope(ONLY_BUTTON, 'default', start)
    } else if (TABLE_SECTIONS.has(tag)) {
      this.closeInScope(SECTION_TAGS, 'table', start)
    } else if (tag === 'tr') {
      this.closeInScope(ONLY_TR, 'table', start)
      if (this.currentTag() === 'table') this.imply('tbody', start)
    } else if (CELL_TAGS.includes(tag)) {
      this.closeInScope(CELL_TAGS, 'table', start)
      if (this.currentTag() === 'table') this.imply('tbody', start)
      if (TABLE_SECTIONS.has(this.currentTag())) this.imply('tr', start)
    }
    return this.insert(tok)
  }

  private endInBody(tag: string, start: number, end: number): void {
    // inside SVG/MathML an end tag closes the nearest same-named foreign element above any HTML one
    if (this.open.top()?.ns !== 'html') {
      const foreign = this.open.nearest([`svg ${tag}`, `math ${tag}`])
      if (foreign > this.open.nearestMarked('html')) return this.closeAt(foreign, start, end)
    }
    if (SPECIAL.has(tag)) {
      const k = this.findInScope(HEADINGS.has(tag) ? HEADING_TAGS : [tag], endTagScope(tag))
      if (k >= 0) this.closeAt(k, start, end)
      return
    }
    // any other end tag: nearest match, but never through a special element (`<span><div></span>`)
    const k = this.open.nearest([tag])
    if (k >= 0 && k > this.open.nearestSpecial()) this.closeAt(k, start, end)
  }

  /** A new li/dd/dt closes the open one unless a special element other than address/div/p intervenes. */
  private closeListItem(targets: readonly string[], pos: number): void {
    const k = this.open.nearest(targets)
    if (k >= 0 && k >= this.open.nearestSpecial(LIST_ITEM_PASS)) this.closeAt(k, pos, pos)
  }

  private findInScope(targets: readonly string[], scope: Scope): number {
    const k = this.open.nearest(targets)
    return k >= 0 && k >= this.open.nearestMarked(scope) ? k : -1
  }

  private closeInScope(targets: readonly string[], scope: Scope, pos: number): void {
    const k = this.findInScope(targets, scope)
    if (k >= 0) this.closeAt(k, pos, pos)
  }

  /** Pops open[k] and everything above it; the ones above end at innerEnd, open[k] at outerEnd. */
  private closeAt(k: number, innerEnd: number, outerEnd: number): void {
    for (let j = this.open.length - 1; j >= k; j--) this.open.items[j]!.end = j === k ? outerEnd : innerEnd
    this.open.truncate(k)
  }
}

/* ----------------------------------------------------------------- queries */

export function getAttr(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value
}

const CLASS_SEPARATOR = /[\t\n\f\r ]+/

function classList(el: ElementNode): string[] {
  const value = getAttr(el, 'class')
  return value ? value.split(CLASS_SEPARATOR).filter(Boolean) : []
}

function isElement(node: TreeChild): node is ElementNode {
  return node.type === 'element'
}

function parentElement(el: ElementNode): ElementNode | null {
  return el.parent.type === 'element' ? el.parent : null
}

/** Every element under `root`, document order; iterative so pathological nesting can't overflow. */
function elementsUnder(root: TreeParent): ElementNode[] {
  const out: ElementNode[] = []
  const stack: TreeChild[] = root.children.slice().reverse()
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type !== 'element') continue
    out.push(node)
    for (let k = node.children.length - 1; k >= 0; k--) stack.push(node.children[k]!)
  }
  return out
}

/* ---------------------------------------------------------------- selectors */

type Combinator = ' ' | '>' | '+' | '~'
type AttrOp = '' | '=' | '~=' | '|=' | '^=' | '$=' | '*='

interface AttrTest {
  name: string
  op: AttrOp
  value: string
  caseless: boolean
}

interface NthTest {
  kind: 'nth'
  a: number
  b: number
  ofType: boolean
  last: boolean
}

type PseudoTest = NthTest | { kind: 'root' }

interface Compound {
  tag: string // '' matches any
  ids: string[]
  classes: string[]
  attrs: AttrTest[]
  pseudos: PseudoTest[]
}

interface ComplexSelector {
  parts: Compound[]
  combinators: Combinator[] // combinators[i] joins parts[i] and parts[i + 1]
}

const nthFirst = (ofType: boolean): NthTest => ({ kind: 'nth', a: 0, b: 1, ofType, last: false })
const nthLast = (ofType: boolean): NthTest => ({ kind: 'nth', a: 0, b: 1, ofType, last: true })

const SIMPLE_PSEUDOS = new Map<string, PseudoTest[]>([
  ['first-child', [nthFirst(false)]],
  ['last-child', [nthLast(false)]],
  ['only-child', [nthFirst(false), nthLast(false)]],
  ['first-of-type', [nthFirst(true)]],
  ['last-of-type', [nthLast(true)]],
  ['only-of-type', [nthFirst(true), nthLast(true)]],
  ['root', [{ kind: 'root' }]],
])

const NTH_PSEUDOS = new Map([
  ['nth-child', { ofType: false, last: false }],
  ['nth-last-child', { ofType: false, last: true }],
  ['nth-of-type', { ofType: true, last: false }],
  ['nth-last-of-type', { ofType: true, last: true }],
])

const ATTR_OPS = new Map<string, AttrOp>([
  ['~', '~='],
  ['|', '|='],
  ['^', '^='],
  ['$', '$='],
  ['*', '*='],
])

const PSEUDO_HINT =
  'supported: :first-child :last-child :only-child :first-of-type :last-of-type :only-of-type ' +
  ':nth-child() :nth-last-child() :nth-of-type() :nth-last-of-type() :root'

function isIdentChar(c: number): boolean {
  return isAsciiAlpha(c) || (c >= 48 && c <= 57) || c === DASH || c === 95 || c >= 128
}

function isHexDigit(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
}

function parseNth(arg: string): [number, number] | null {
  const s = arg.trim().toLowerCase()
  if (s === 'odd') return [2, 1]
  if (s === 'even') return [2, 0]
  if (/^[+-]?\d+$/.test(s)) return [0, Number(s)]
  const m = /^([+-]?\d*)n(?:\s*([+-])\s*(\d+))?$/.exec(s)
  if (!m) return null
  const coef = m[1] ?? ''
  const a = coef === '' || coef === '+' ? 1 : coef === '-' ? -1 : Number(coef)
  const b = m[3] ? Number(m[3]) * (m[2] === '-' ? -1 : 1) : 0
  return [a, b]
}

class SelectorParser {
  private pos = 0
  private readonly src: string

  constructor(src: string) {
    this.src = src
  }

  parse(): ComplexSelector[] {
    if (isBlank(this.src)) throw this.error('it is empty')
    const list = [this.complex()]
    while (this.peek() === ',') {
      this.pos++
      list.push(this.complex())
    }
    return list
  }

  private complex(): ComplexSelector {
    this.skipSpace()
    const parts = [this.compound()]
    const combinators: Combinator[] = []
    for (;;) {
      const spaced = this.skipSpace()
      const ch = this.peek()
      if (ch === '' || ch === ',') return { parts, combinators }
      if (ch === '>' || ch === '+' || ch === '~') {
        this.pos++
        this.skipSpace()
        combinators.push(ch)
      } else if (spaced) combinators.push(' ')
      else throw this.unexpected()
      parts.push(this.compound())
    }
  }

  private compound(): Compound {
    const start = this.pos
    const c: Compound = { tag: '', ids: [], classes: [], attrs: [], pseudos: [] }
    if (this.peek() === '*') this.pos++
    else if (this.atIdent()) c.tag = this.ident().toLowerCase()
    if (this.peek() === '|') throw this.error('namespace prefixes (ns|tag) are not supported')
    for (;;) {
      const ch = this.peek()
      if (ch === '#') {
        this.pos++
        c.ids.push(this.requireIdent('an id after "#"'))
      } else if (ch === '.') {
        this.pos++
        c.classes.push(this.requireIdent('a class name after "."'))
      } else if (ch === '[') c.attrs.push(this.attribute())
      else if (ch === ':') c.pseudos.push(...this.pseudo())
      else break
    }
    if (this.pos === start) throw this.unexpected()
    return c
  }

  private attribute(): AttrTest {
    this.pos++
    this.skipSpace()
    const name = this.requireIdent('an attribute name after "["').toLowerCase()
    if (this.peek() === '|' && this.src.charAt(this.pos + 1) !== '=') {
      throw this.error('namespace prefixes (ns|attr) are not supported')
    }
    this.skipSpace()
    if (this.peek() === ']') {
      this.pos++
      return { name, op: '', value: '', caseless: false }
    }
    let op: AttrOp | undefined = '='
    if (this.peek() !== '=') {
      op = ATTR_OPS.get(this.peek())
      if (!op || this.src.charAt(this.pos + 1) !== '=') {
        throw this.error(`unsupported operator in [${name}…] — use =, ~=, |=, ^=, $= or *=`)
      }
      this.pos++
    }
    this.pos++
    this.skipSpace()
    const quote = this.peek()
    const value =
      quote === '"' || quote === "'"
        ? this.string(quote)
        : this.requireIdent(`a value after "${op}" in [${name}${op}…] — quote values that are not plain words`)
    this.skipSpace()
    const flag = this.peek().toLowerCase()
    if (flag === 'i' || flag === 's') {
      this.pos++
      this.skipSpace()
    }
    if (this.peek() !== ']') throw this.error(`expected "]" to close [${name}…]`)
    this.pos++
    return { name, op, value, caseless: flag === 'i' }
  }

  private pseudo(): PseudoTest[] {
    this.pos++
    if (this.peek() === ':') throw this.error('pseudo-elements like ::before never match a source element')
    const name = this.requireIdent('a pseudo-class name after ":"').toLowerCase()
    if (this.peek() !== '(') {
      const tests = SIMPLE_PSEUDOS.get(name)
      if (!tests) throw this.error(`:${name} is not supported (${PSEUDO_HINT})`)
      return tests
    }
    const nth = NTH_PSEUDOS.get(name)
    if (!nth) throw this.error(`:${name}() is not supported (${PSEUDO_HINT})`)
    const close = this.src.indexOf(')', this.pos)
    if (close === -1) throw this.error(`:${name}( is missing its ")"`)
    const arg = this.src.slice(this.pos + 1, close)
    const ab = parseNth(arg)
    if (!ab) throw this.error(`:${name}(${arg}) needs a number, odd, even or an+b`)
    this.pos = close + 1
    return [{ kind: 'nth', a: ab[0], b: ab[1], ...nth }]
  }

  private ident(): string {
    let out = ''
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos)
      if (c === BACKSLASH) out += this.escape()
      else if (isIdentChar(c)) out += this.src.charAt(this.pos++)
      else break
    }
    return out
  }

  private requireIdent(what: string): string {
    const id = this.ident()
    if (!id) throw this.error(`expected ${what}`)
    return id
  }

  /** CSS escapes, as `CSS.escape` writes them: `\31 23` → "123", `\:` → ":". */
  private escape(): string {
    this.pos++
    if (this.pos >= this.src.length) throw this.error('it ends with a dangling "\\"')
    let hex = ''
    while (hex.length < 6 && isHexDigit(this.src.charCodeAt(this.pos))) hex += this.src.charAt(this.pos++)
    if (hex) {
      if (isSpace(this.src.charCodeAt(this.pos))) this.pos++
      const cp = parseInt(hex, 16)
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp)
    }
    const ch = String.fromCodePoint(this.src.codePointAt(this.pos) ?? 0xfffd)
    this.pos += ch.length
    return ch
  }

  private string(quote: string): string {
    this.pos++
    let out = ''
    while (this.pos < this.src.length) {
      const ch = this.src.charAt(this.pos)
      if (ch === quote) {
        this.pos++
        return out
      }
      if (ch === '\\' && this.src.charAt(this.pos + 1) === '\n') this.pos += 2
      else if (ch === '\\') out += this.escape()
      else {
        out += ch
        this.pos++
      }
    }
    throw this.error('it has an unterminated string')
  }

  private atIdent(): boolean {
    const c = this.src.charCodeAt(this.pos)
    return isIdentChar(c) || c === BACKSLASH
  }

  private peek(): string {
    return this.src.charAt(this.pos)
  }

  private skipSpace(): boolean {
    const from = this.pos
    while (isSpace(this.src.charCodeAt(this.pos))) this.pos++
    return this.pos > from
  }

  private unexpected(): Error {
    const ch = this.peek()
    return this.error(ch ? `unexpected "${ch}" at position ${this.pos}` : 'it ends where a selector is expected')
  }

  private error(reason: string): Error {
    return new Error(`Invalid selector "${this.src}": ${reason}`)
  }
}

interface SiblingPosition {
  index: number
  count: number
  typeIndex: number
  typeCount: number
  previous: ElementNode | null
}

/** Per-query sibling positions, filled a whole parent at a time so :nth-* and `+`/`~` cost O(1) per
 *  element; scanning siblings per element made 7.5k flat siblings take ~90 ms per query. */
class SiblingIndex {
  private readonly positions = new Map<ElementNode, SiblingPosition>()

  of(el: ElementNode): SiblingPosition {
    const known = this.positions.get(el)
    if (known) return known
    const kids = el.parent.children.filter(isElement)
    const typeCounts = new Map<string, number>()
    for (const kid of kids) typeCounts.set(kid.tag, (typeCounts.get(kid.tag) ?? 0) + 1)
    const typeSeen = new Map<string, number>()
    let previous: ElementNode | null = null
    for (const [k, kid] of kids.entries()) {
      const typeIndex = (typeSeen.get(kid.tag) ?? 0) + 1
      typeSeen.set(kid.tag, typeIndex)
      const typeCount = typeCounts.get(kid.tag) ?? typeIndex
      this.positions.set(kid, { index: k + 1, count: kids.length, typeIndex, typeCount, previous })
      previous = kid
    }
    const filled = this.positions.get(el)
    if (!filled) throw new Error(`<${el.tag}> is missing from its parent's children`)
    return filled
  }
}

function matchAttr(el: ElementNode, test: AttrTest): boolean {
  const actual = getAttr(el, test.name)
  if (actual === undefined) return false
  const have = test.caseless ? actual.toLowerCase() : actual
  const want = test.caseless ? test.value.toLowerCase() : test.value
  switch (test.op) {
    case '':
      return true
    case '=':
      return have === want
    case '~=':
      return want !== '' && !CLASS_SEPARATOR.test(want) && have.split(CLASS_SEPARATOR).includes(want)
    case '|=':
      return have === want || have.startsWith(`${want}-`)
    case '^=':
      return want !== '' && have.startsWith(want)
    case '$=':
      return want !== '' && have.endsWith(want)
    case '*=':
      return want !== '' && have.includes(want)
  }
}

function matchPseudo(el: ElementNode, test: PseudoTest, siblings: SiblingIndex): boolean {
  if (test.kind === 'root') return el.parent.type === 'document'
  const at = siblings.of(el)
  const [index, count] = test.ofType ? [at.typeIndex, at.typeCount] : [at.index, at.count]
  const p = test.last ? count - index + 1 : index
  return test.a === 0 ? p === test.b : (p - test.b) / test.a >= 0 && (p - test.b) % test.a === 0
}

function matchCompound(el: ElementNode, c: Compound, siblings: SiblingIndex): boolean {
  if (c.tag && el.tag !== c.tag) return false
  if (c.ids.length && c.ids.some((id) => getAttr(el, 'id') !== id)) return false
  if (c.classes.length) {
    const have = classList(el)
    if (!c.classes.every((cls) => have.includes(cls))) return false
  }
  return c.attrs.every((t) => matchAttr(el, t)) && c.pseudos.every((t) => matchPseudo(el, t, siblings))
}

/** Matches one complex selector right to left. Every (part, element) pair is decided once, and
 *  ancestor/sibling walks stop at the first node already decided, so a query is linear in elements
 *  × parts; uncached, a failing `span div` over 12k nested divs took ~1.2 s. */
class ComplexMatcher {
  private readonly sel: ComplexSelector
  private readonly siblings: SiblingIndex
  private readonly self: Map<ElementNode, boolean>[] // parts[0..i] match, ending at this element
  private readonly along: Map<ElementNode, boolean>[] // …at this element or one further along its walk

  constructor(sel: ComplexSelector, siblings: SiblingIndex) {
    this.sel = sel
    this.siblings = siblings
    this.self = sel.parts.map(() => new Map())
    this.along = sel.parts.map(() => new Map())
  }

  matches(el: ElementNode): boolean {
    return this.matchAt(el, this.sel.parts.length - 1)
  }

  private matchAt(el: ElementNode, i: number): boolean {
    const cache = this.self[i]!
    const known = cache.get(el)
    if (known !== undefined) return known
    const ok = matchCompound(el, this.sel.parts[i]!, this.siblings) && (i === 0 || this.matchLeft(el, i))
    cache.set(el, ok)
    return ok
  }

  private matchLeft(el: ElementNode, i: number): boolean {
    switch (this.sel.combinators[i - 1]) {
      case '>': {
        const parent = parentElement(el)
        return parent !== null && this.matchAt(parent, i - 1)
      }
      case '+': {
        const previous = this.siblings.of(el).previous
        return previous !== null && this.matchAt(previous, i - 1)
      }
      case '~':
        return this.reach(this.siblings.of(el).previous, (s) => this.siblings.of(s).previous, i - 1)
      default:
        return this.reach(parentElement(el), parentElement, i - 1)
    }
  }

  /** Whether `start` or a node further along `next` matches parts[0..i]; every node walked caches
   *  the answer. Part i always sits left of the same combinator, so the cache means one walk kind. */
  private reach(start: ElementNode | null, next: (el: ElementNode) => ElementNode | null, i: number): boolean {
    const cache = this.along[i]!
    const walked: ElementNode[] = []
    let found = false
    for (let node = start; node; node = next(node)) {
      const known = cache.get(node)
      if (known !== undefined) {
        found = known
        break
      }
      walked.push(node)
      if (this.matchAt(node, i)) {
        found = true
        break
      }
    }
    for (const node of walked) cache.set(node, found)
    return found
  }
}

/** Elements under `root` matching a CSS selector list, in document order; throws on syntax outside
 *  the supported subset. Costs one pass over the elements per call. */
export function querySelectorAll(root: TreeParent, selector: string): ElementNode[] {
  const siblings = new SiblingIndex()
  const matchers = new SelectorParser(selector).parse().map((sel) => new ComplexMatcher(sel, siblings))
  return elementsUnder(root).filter((el) => matchers.some((m) => m.matches(el)))
}

/* ------------------------------------------------------------------ outline */

// hidden from the outline and left out of its numbering, so scripts and styles never shift paths
const OUTLINE_SKIP = words('head script style meta link base title noscript template')
// listed with a child count but not expanded unless outlined directly: icon internals cost tokens
const OUTLINE_LEAF = words('svg math')

export interface OutlineOptions {
  /** Element levels listed below <body> (or below `from`); default 3. */
  depth?: number
  /** Lines listed before the rest collapse into "… N more elements"; default 400. */
  maxNodes?: number
  /** Outline this element and its subtree instead of the whole body. */
  from?: ElementNode
}

interface OutlineEntry {
  el: ElementNode
  path: string
  level: number
}

function outlineBase(root: DocumentNode): TreeParent {
  for (const html of root.children) {
    if (html.type !== 'element' || html.tag !== 'html') continue
    for (const body of html.children) if (body.type === 'element' && body.tag === 'body') return body
  }
  return root
}

function isOutlined(node: TreeChild): node is ElementNode {
  return node.type === 'element' && !OUTLINE_SKIP.has(node.tag)
}

function outlineChildren(parent: TreeParent, prefix: string, level: number): OutlineEntry[] {
  return parent.children.filter(isOutlined).map((el, k) => ({
    el,
    path: prefix ? `${prefix}.${k + 1}` : `${k + 1}`,
    level,
  }))
}

function ownText(el: ElementNode, limit: number): string {
  let out = ''
  let count = 0
  let gap = false
  for (const kid of el.children) {
    if (kid.type !== 'text') continue
    for (const ch of kid.value) {
      if (isSpace(ch.charCodeAt(0))) {
        gap = out !== ''
        continue
      }
      if (gap && count < limit) {
        out += ' '
        count++
      }
      gap = false
      if (count >= limit) return `${out.trimEnd()}…`
      out += ch
      count++
    }
    gap = out !== ''
  }
  return out
}

function outlineLine({ el, path, level }: OutlineEntry, hidden: number): string {
  const id = getAttr(el, 'id')
  const classes = classList(el)
  const text = ownText(el, 40)
  let line = `${'  '.repeat(level)}${path} ${el.tag}`
  if (id) line += `#${id}`
  if (classes.length) line += `.${classes.slice(0, 3).join('.')}${classes.length > 3 ? '…' : ''}`
  if (text) line += ` "${text}"`
  if (hidden) line += ` [${hidden}]`
  return line
}

/** Compact text tree for agents: one line per element with its `@path` locator, `[N]` marking
 *  children cut off by depth. Walks every element once, even past maxNodes, to count the rest. */
export function outlineOf(root: DocumentNode, opts: OutlineOptions = {}): string {
  const { depth = 3, maxNodes = 400 } = opts
  const base = outlineBase(root)
  const from = opts.from && opts.from !== base ? opts.from : null
  const lastLevel = from ? depth : depth - 1
  const stack = from ? [{ el: from, path: outlinePath(from), level: 0 }] : outlineChildren(base, '', 0).reverse()
  const lines: string[] = []
  let more = 0
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const { el, path, level } = entry
    const expand = level < lastLevel && (el === from || !OUTLINE_LEAF.has(el.tag))
    const kids = expand ? outlineChildren(el, path, level + 1) : []
    if (lines.length < maxNodes) lines.push(outlineLine(entry, expand ? 0 : el.children.filter(isOutlined).length))
    else more++
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]!)
  }
  if (more) lines.push(`… ${more} more element${more === 1 ? '' : 's'}`)
  return lines.join('\n')
}

function findOutlinePath(el: ElementNode): string | null {
  let top: TreeParent = el
  while (top.type === 'element') top = top.parent
  const base = outlineBase(top)
  const parts: number[] = []
  let node: TreeParent = el
  while (node !== base) {
    if (node.type === 'document' || OUTLINE_SKIP.has(node.tag)) return null
    parts.push(node.parent.children.filter(isOutlined).indexOf(node) + 1)
    node = node.parent
  }
  return parts.reverse().join('.')
}

/** The dotted outline path (`2.1`) of an element; throws for one the outline never lists. */
export function outlinePath(el: ElementNode): string {
  const path = findOutlinePath(el)
  if (path === null) throw new Error(`<${el.tag}> is not in the <body> outline, so it has no @path — use a selector`)
  return path
}

function resolvePath(root: DocumentNode, path: string): ElementNode {
  if (!/^\d+(?:\.\d+)*$/.test(path)) {
    throw new Error(`"@${path}" is not an outline path — use the dotted numbers from the outline, e.g. @2.1`)
  }
  let parent: TreeParent = outlineBase(root)
  let found: ElementNode | null = null
  let walked = ''
  for (const part of path.split('.')) {
    const n = Number(part)
    if (n < 1) throw new Error(`outline path @${path} is invalid: positions start at 1`)
    const kids = parent.children.filter(isOutlined)
    const next = kids[n - 1]
    if (!next) {
      const owner = walked ? `@${walked}` : '<body>'
      throw new Error(`outline path @${path} does not exist: ${owner} has ${kids.length} children in the outline`)
    }
    parent = found = next
    walked = walked ? `${walked}.${part}` : part
  }
  if (!found) throw new Error(`"@${path}" is not an outline path`)
  return found
}

/** `@2.1` resolves an outline path; anything else is a selector that must match exactly one element. */
export function resolveOne(root: DocumentNode, locator: string): ElementNode {
  const loc = locator.trim()
  if (!loc) throw new Error('empty locator — pass a CSS selector such as #hero, or an outline path such as @2.1')
  if (loc.startsWith('@')) return resolvePath(root, loc.slice(1))
  const matches = querySelectorAll(root, loc)
  const [first] = matches
  if (!first) throw new Error(`no element matches "${loc}"`)
  if (matches.length === 1) return first
  // a path costs a walk to <body>, so only the few listed are computed, not one per match
  const paths: string[] = []
  for (const el of matches) {
    const path = findOutlinePath(el)
    if (path !== null) paths.push(`@${path}`)
    if (paths.length === 5) break
  }
  const listed = paths.length ? ` (matches: ${paths.join(', ')}${matches.length > paths.length ? ', …' : ''})` : ''
  throw new Error(
    `"${loc}" matches ${matches.length} elements — make it more specific, or use an outline path like ${paths[0] ?? '@2.1'}${listed}`,
  )
}

/* ---------------------------------------------------------------- splicing */

function assertFits(html: string, el: ElementNode): void {
  if (el.end > html.length) throw new Error('that element was parsed from a different document — parse it again')
}

export function sourceOf(html: string, el: ElementNode): string {
  assertFits(html, el)
  return html.slice(el.start, el.end)
}

/** Swaps exactly [el.start, el.end) for `replacement`; every other byte of the document is kept. */
export function replaceSource(html: string, el: ElementNode, replacement: string): string {
  assertFits(html, el)
  return html.slice(0, el.start) + replacement + html.slice(el.end)
}
