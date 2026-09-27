import { describe, expect, it } from 'vitest'
import {
  getAttr,
  outlineOf,
  outlinePath,
  parseHtml,
  querySelectorAll,
  replaceSource,
  resolveOne,
  sourceOf,
  type DocumentNode,
  type ElementNode,
  type TreeChild,
  type TreeParent,
} from '../server/htmlTree.ts'

const LANDING = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ledger</title>
  <style>.hero > h1 { color: red } /* </div> <p class="x"> */</style>
</head>
<body>
  <header class="nav bar sticky top shadow"><a href="/" class="logo">Ledger</a><nav><a href="#f">Features</a><a href="#p">Pricing</a></nav></header>
  <section id="hero" class="hero">
    <h1 class="t-display">Every rupee you own, on one quiet page.</h1>
    <p>Track   accounts,
      cards and loans without the noise of a banking app.</p>
    <script>window.boot('<div>')</script>
    <div class="cta"><button>Start</button><button class="ghost">Tour</button></div>
  </section>
  <section class="grid">
    <div class="card"><svg viewBox="0 0 24 24"><path d="M0 0h24"/><circle r="4"/></svg><h3>Accounts</h3><ul><li>One</li><li>Two</li></ul></div>
    <div class="card"><h3>Cards</h3></div>
  </section>
  <footer>© Ledger</footer>
</body>
</html>
`

// no html/head/body, unclosed p/li/td, raw text holding tags, `>` inside quotes, EOF mid-element
const SLOPPY = `<style>.card > p { color: red } /* </div> <p> */</style>
<!-- <section id="ghost"><p>not real</p></section> -->
<section id="hero" data-tip="a > b" class='hero dark' hidden>
  <p>Lead copy
  <p>Second paragraph
  <ul><li>One<li>Two<li>Three</ul>
  <table><tr><td>A<td>B<tr><td>C</table>
</section>
<div class="tail"><p>Unclosed at EOF`

const isElement = (node: TreeChild): node is ElementNode => node.type === 'element'

function elementsOf(root: TreeParent): ElementNode[] {
  return root.children.filter(isElement).flatMap((el) => [el, ...elementsOf(el)])
}

/** Element structure as `tag(child,child)`, text and comments left out. */
function shape(root: TreeParent): string {
  return root.children
    .filter(isElement)
    .map((el) => (el.children.some(isElement) ? `${el.tag}(${shape(el)})` : el.tag))
    .join(',')
}

const bodyShape = (html: string): string => shape(resolveOne(parseHtml(html), 'body'))

function ownText(el: ElementNode): string {
  return el.children.map((c) => (c.type === 'text' ? c.value : '')).join('')
}

const texts = (doc: DocumentNode, selector: string): string[] => querySelectorAll(doc, selector).map(ownText)

describe('parseHtml', () => {
  it('parses a well-formed document with offsets on the tags themselves', () => {
    const doc = parseHtml(LANDING)
    expect(shape(doc)).toBe(
      'html(head(meta,title,style),body(header(a,nav(a,a)),section(h1,p,script,div(button,button)),' +
        'section(div(svg(path,circle),h3,ul(li,li)),div(h3)),footer))',
    )
    const h1 = resolveOne(doc, 'h1')
    expect(sourceOf(LANDING, h1)).toBe('<h1 class="t-display">Every rupee you own, on one quiet page.</h1>')
    expect(LANDING.slice(h1.start, h1.openEnd)).toBe('<h1 class="t-display">')
    expect(elementsOf(doc).some((el) => el.implied)).toBe(false)
  })

  it('tiles every element exactly: open tag + children + end tag = its source', () => {
    const doc = parseHtml(LANDING)
    expect(doc.children.map((c) => LANDING.slice(c.start, c.end)).join('')).toBe(LANDING)
    for (const el of elementsOf(doc)) {
      const src = sourceOf(LANDING, el)
      expect(src).toBe(LANDING.slice(el.start, el.end))
      const open = LANDING.slice(el.start, el.openEnd)
      expect(open.toLowerCase().startsWith(`<${el.tag}`)).toBe(true)
      expect(open.endsWith('>')).toBe(true)
      const close = el.end === el.openEnd ? '' : `</${el.tag}>`
      expect(src.toLowerCase().endsWith(close)).toBe(true)
      const inner = LANDING.slice(el.openEnd, el.end - close.length)
      expect(el.children.map((c) => LANDING.slice(c.start, c.end)).join('')).toBe(inner)
      for (const c of el.children) if (c.type === 'text') expect(c.value).toBe(LANDING.slice(c.start, c.end))
    }
  })

  it('keeps spans ordered, nested and exact in sloppy markup', () => {
    const doc = parseHtml(SLOPPY)
    for (const el of elementsOf(doc)) {
      let cursor = el.openEnd
      for (const c of el.children) {
        expect(c.start).toBeGreaterThanOrEqual(cursor)
        expect(c.end).toBeLessThanOrEqual(el.end)
        if (c.type === 'text') expect(c.value).toBe(SLOPPY.slice(c.start, c.end))
        cursor = c.end
      }
    }
    expect(sourceOf(SLOPPY, resolveOne(doc, 'section > p:nth-of-type(1)'))).toBe('<p>Lead copy\n  ')
    expect(sourceOf(SLOPPY, resolveOne(doc, 'td:nth-child(2)'))).toBe('<td>B')
  })

  it('synthesizes implied html/head/body where a browser opens them', () => {
    const doc = parseHtml(SLOPPY)
    expect(shape(doc)).toBe('html(head(style),body(section(p,p,ul(li,li,li),table(tbody(tr(td,td),tr(td)))),div(p)))')
    const [html, head, body] = ['html', 'head', 'body'].map((tag) => resolveOne(doc, tag))
    expect([html?.implied, head?.implied, body?.implied]).toEqual([true, true, true])
    const firstContent = SLOPPY.indexOf('<section id="hero"') // not the decoy inside the comment
    expect(body?.start).toBe(firstContent)
    expect(body?.openEnd).toBe(firstContent)
    expect(body && sourceOf(SLOPPY, body)).toBe(SLOPPY.slice(firstContent))
    expect(resolveOne(doc, 'tbody').implied).toBe(true)
  })

  it('treats void elements as empty, and `/>` as self-closing only in SVG', () => {
    expect(bodyShape('<div><img src="a.png"><br/><input disabled><hr></div><div/>inside</div>')).toBe(
      'div(img,br,input,hr),div',
    )
    const doc = parseHtml('<svg viewBox="0 0 24 24"><linearGradient id="g"><stop/></linearGradient><path/></svg><p>x')
    expect(shape(resolveOne(doc, 'body'))).toBe('svg(lineargradient(stop),path),p')
    expect(resolveOne(doc, 'path').ns).toBe('svg')
    expect(resolveOne(doc, 'p').ns).toBe('html')
    const br = resolveOne(parseHtml('<p>a<br/>b</p>'), 'br')
    expect(br.end).toBe(br.openEnd)
  })

  it('parses HTML inside foreignObject as HTML again', () => {
    const doc = parseHtml('<svg><foreignObject><p>x<div>y</div></foreignObject></svg>')
    expect(shape(resolveOne(doc, 'svg'))).toBe('foreignobject(p,div)')
    expect(resolveOne(doc, 'div').ns).toBe('html')
  })

  it('never parses markup inside raw-text elements', () => {
    const html =
      '<style>.a > p { color: red } /* </div> <p> */</STYLE><script>if (a < b) write("<div>")</script>' +
      '<textarea><b>raw</b></textarea><title>A &amp; <i>B</i></title><p>real</p>'
    const doc = parseHtml(html)
    expect(querySelectorAll(doc, 'p, div, b, i').map((el) => el.tag)).toEqual(['p'])
    const style = resolveOne(doc, 'style')
    expect(style.children).toHaveLength(1)
    expect(ownText(style)).toBe('.a > p { color: red } /* </div> <p> */')
    expect(sourceOf(html, style).endsWith('</STYLE>')).toBe(true)
    expect(ownText(resolveOne(doc, 'textarea'))).toBe('<b>raw</b>')

    const open = '<script>let s = "</scrip"'
    const script = resolveOne(parseHtml(open), 'script')
    expect(script.end).toBe(open.length)
    expect(ownText(script)).toBe('let s = "</scrip"')
  })

  it('reads double, single, unquoted and valueless attributes, with `>` inside quotes', () => {
    const html = `<a HREF="/x?a=1&b=2" data-tip='say "hi" > there' title=plain disabled data-empty="" data-tip="dup">x</a>`
    const a = resolveOne(parseHtml(html), 'a')
    expect(a.attrs).toEqual([
      { name: 'href', value: '/x?a=1&b=2' },
      { name: 'data-tip', value: 'say "hi" > there' },
      { name: 'title', value: 'plain' },
      { name: 'disabled', value: '' },
      { name: 'data-empty', value: '' },
    ])
    expect(html.slice(a.openEnd)).toBe('x</a>')
    expect(getAttr(resolveOne(parseHtml('<a href=/docs/>x</a>'), 'a'), 'href')).toBe('/docs/')
  })

  it('keeps comments and doctypes as nodes and never parses tags inside them', () => {
    const html = '<!DOCTYPE html><!-- <div id="ghost"><p>not real</p></div> --><?xml x?><main><!----><p>x</p></main>'
    const doc = parseHtml(html)
    expect(doc.children.map((c) => c.type)).toEqual(['doctype', 'comment', 'comment', 'element'])
    expect(querySelectorAll(doc, 'div, #ghost')).toEqual([])
    expect(shape(resolveOne(doc, 'main'))).toBe('p')

    const unclosed = '<main><p>a</p><!-- runs to EOF </main>'
    expect(resolveOne(parseHtml(unclosed), 'main').end).toBe(unclosed.length)
  })

  it('closes p on block-level start tags and keeps inline content inside', () => {
    expect(bodyShape('<p>One<p>Two<div>Block</div><p>Three<h2>T</h2><p>Four<section>S</section>')).toBe(
      'p,p,div,p,h2,p,section',
    )
    expect(bodyShape('<p>Inline <span>stays</span> <a href="#">inside</a> <img src="x.png">')).toBe('p(span,a,img)')
  })

  it('closes li, dt/dd, option and headings implied by their next sibling', () => {
    expect(bodyShape('<ul><li>One<li>Two<ul><li>Nested</ul><li>Three</ul>')).toBe('ul(li,li(ul(li)),li)')
    expect(bodyShape('<dl><dt>Term<dd>Def<dt>Term 2<dd>Def 2</dl>')).toBe('dl(dt,dd,dt,dd)')
    expect(bodyShape('<select><option>A<option>B<optgroup label="g"><option>C</select>')).toBe(
      'select(option,option,optgroup(option))',
    )
    expect(bodyShape('<h1>One<h2>Two')).toBe('h1,h2')
  })

  it('closes rows and cells, implying tbody/tr the way the DOM does', () => {
    expect(bodyShape('<table><thead><tr><th>H</thead><tr><td>A<td>B<tr><td>C</table><p>after')).toBe(
      'table(thead(tr(th)),tbody(tr(td,td),tr(td))),p',
    )
    expect(bodyShape('<table><td>x</table>')).toBe('table(tbody(tr(td)))')
    const html = '<table><tr><td>open</table>'
    const td = resolveOne(parseHtml(html), 'td')
    expect(td.end).toBe(html.indexOf('</table>'))
  })

  it('closes the nearest matching element, ignores strays, and never closes through a block', () => {
    const html = '<div><span>x</div>tail'
    const doc = parseHtml(html)
    expect(resolveOne(doc, 'span').end).toBe(html.indexOf('</div>'))
    expect(resolveOne(doc, 'div').end).toBe(html.indexOf('tail'))

    const stray = '<section><p>x</p></div></article></section>'
    expect(bodyShape(stray)).toBe('section(p)')
    expect(resolveOne(parseHtml(stray), 'section').end).toBe(stray.length)

    // browsers ignore </span> when a <div> opened inside it is still open
    expect(bodyShape('<span><div>y</span>z</div>')).toBe('span(div)')
  })

  it('ends elements left open at EOF at html.length', () => {
    const html = '<main><section><p>open'
    const doc = parseHtml(html)
    for (const tag of ['html', 'body', 'main', 'section', 'p']) expect(resolveOne(doc, tag).end).toBe(html.length)
  })

  it('moves content after </body> back into body, and head tags after </head> into head', () => {
    const late = '<html><body><p>a</p></body></html>\n<script>late()</script>'
    const doc = parseHtml(late)
    expect(resolveOne(doc, 'script').parent).toBe(resolveOne(doc, 'body'))
    expect(resolveOne(doc, 'body').end).toBe(late.length)
    expect(shape(parseHtml('<head><title>x</title></head><style>.a{}</style><body><p>b'))).toBe(
      'html(head(title,style),body(p))',
    )
  })

  it('parses template content as ordinary children, even inside head', () => {
    const doc = parseHtml('<head><template id="t"><div class="row">x</div></template></head><body><template><p>a<p>b')
    expect(querySelectorAll(doc, 'head > template > div.row')).toHaveLength(1)
    expect(resolveOne(doc, 'body').implied).toBe(false)
    expect(shape(resolveOne(doc, 'body'))).toBe('template(p,p)')
  })
})

describe('querySelectorAll', () => {
  const LIST = parseHtml(
    '<ul><li>1</li><li>2</li><li>3</li><li>4</li><li>5</li></ul><p>a</p><span>b</span><p>c</p>' +
      '<div class="a"><div class="b"><div class="x"><div class="b"><em class="c">deep</em></div></div></div></div>',
  )

  it('matches type, universal, id and class selectors case-correctly', () => {
    const doc = parseHtml(LANDING)
    expect(querySelectorAll(doc, 'a')).toHaveLength(3)
    expect(querySelectorAll(doc, 'A')).toHaveLength(3)
    expect(querySelectorAll(doc, '*')).toHaveLength(elementsOf(doc).length)
    expect(querySelectorAll(doc, '#hero').map((el) => el.tag)).toEqual(['section'])
    expect(querySelectorAll(doc, '.card')).toHaveLength(2)
    expect(querySelectorAll(doc, 'button.ghost')).toHaveLength(1)
    expect(querySelectorAll(doc, '.nav.shadow.bar')).toHaveLength(1)
    expect(querySelectorAll(doc, '.nav.missing')).toHaveLength(0)
    expect(querySelectorAll(doc, '.Card')).toHaveLength(0)
    const svg = parseHtml('<svg><linearGradient id="g"></linearGradient></svg>')
    expect(querySelectorAll(svg, 'svg > linearGradient#g')).toHaveLength(1)
  })

  it('supports every attribute operator and the i flag', () => {
    const doc = parseHtml(
      '<a href="https://x.dev/docs/start" data-tags="alpha beta" lang="en-GB" title="Hello World">1</a>' +
        '<a href="/local.pdf" data-tags="beta">2</a><input disabled>',
    )
    const cases: [string, string[]][] = [
      ['[disabled]', ['input']],
      ['[data-tags~=beta]', ['1', '2']],
      ['[data-tags~=alp]', []],
      ['[href^="https://"]', ['1']],
      ['[href$=".pdf"]', ['2']],
      ['[href*=docs]', ['1']],
      ['[lang|=en]', ['1']],
      ['[title="hello world" i]', ['1']],
      ['[title="hello world"]', []],
      ["[title='Hello World']", ['1']],
      ['[href^=""]', []],
    ]
    for (const [selector, expected] of cases) {
      const got = querySelectorAll(doc, selector).map((el) => (el.tag === 'input' ? 'input' : ownText(el)))
      expect(got, selector).toEqual(expected)
    }
  })

  it('supports structural pseudo-classes, integers and an+b', () => {
    const cases: [string, string[]][] = [
      ['li:first-child', ['1']],
      ['li:last-child', ['5']],
      ['li:nth-child(2)', ['2']],
      ['li:nth-child(odd)', ['1', '3', '5']],
      ['li:nth-child(even)', ['2', '4']],
      ['li:nth-child(3n+1)', ['1', '4']],
      ['li:nth-child(-n + 2)', ['1', '2']],
      ['li:nth-last-child(1)', ['5']],
      ['li:only-child', []],
      ['p:nth-of-type(2)', ['c']],
      ['p:first-of-type', ['a']],
      ['p:last-of-type', ['c']],
      ['span:only-of-type', ['b']],
      ['body > p:nth-child(2)', ['a']],
    ]
    for (const [selector, expected] of cases) expect(texts(LIST, selector), selector).toEqual(expected)
    expect(querySelectorAll(LIST, ':root').map((el) => el.tag)).toEqual(['html'])
  })

  it('supports descendant, child and sibling combinators', () => {
    expect(querySelectorAll(LIST, 'ul > li')).toHaveLength(5)
    expect(querySelectorAll(LIST, 'body li')).toHaveLength(5)
    expect(querySelectorAll(LIST, 'html > li')).toHaveLength(0)
    expect(texts(LIST, 'p + span')).toEqual(['b'])
    expect(texts(LIST, 'span + p')).toEqual(['c'])
    expect(texts(LIST, 'p ~ p')).toEqual(['c'])
    expect(texts(LIST, 'ul ~ span')).toEqual(['b'])
    expect(texts(LIST, 'ul + span')).toEqual([])
    // the nearest .b fails `.a >`; matching must backtrack to the outer one
    expect(texts(LIST, '.a > .b .c')).toEqual(['deep'])
    expect(texts(LIST, '.a > .x .c')).toEqual([])
  })

  it('returns selector lists in document order without duplicates', () => {
    expect(texts(LIST, 'p, li:first-child, p, span')).toEqual(['1', 'a', 'b', 'c'])
  })

  it('unescapes CSS identifiers the way CSS.escape writes them', () => {
    const doc = parseHtml('<div id="123">digits</div><div id="a:b">colon</div>')
    expect(texts(doc, '#\\31 23')).toEqual(['digits'])
    expect(texts(doc, '#a\\:b')).toEqual(['colon'])
    expect(texts(doc, '[id="a:b"]')).toEqual(['colon'])
  })

  it('resolves the paths the frame runtime generates, with or without html/body in the source', () => {
    const body = '<section>One</section><section><div><h1>Target</h1><h1>Other</h1></div><div>Second</div></section>'
    for (const html of [`<!doctype html><html><head><style>x</style></head><body>${body}</body></html>`, body]) {
      const doc = parseHtml(html)
      expect(ownText(resolveOne(doc, 'body > section:nth-of-type(2) > div:nth-of-type(1) > h1:nth-of-type(1)'))).toBe(
        'Target',
      )
      expect(ownText(resolveOne(doc, 'body:nth-of-type(1) > section:nth-of-type(2) > div:nth-of-type(2)'))).toBe(
        'Second',
      )
      expect(querySelectorAll(doc, 'html > body > section')).toHaveLength(2)
    }
    const doc = parseHtml(LANDING)
    expect(resolveOne(doc, '#hero > div:nth-of-type(1) > button:nth-of-type(2)')).toBe(resolveOne(doc, '.ghost'))
  })

  it.each([
    ['', /it is empty/],
    ['a:hover', /:hover is not supported/],
    [':not(.x)', /:not\(\) is not supported/],
    ['p::before', /pseudo-elements like ::before/],
    ['div >', /it ends where a selector is expected/],
    ['a,', /it ends where a selector is expected/],
    ['div!', /unexpected "!" at position 3/],
    ['#', /expected an id after "#"/],
    ['svg|rect', /namespace prefixes/],
    ['[href="x]', /unterminated string/],
    ['[href=/x]', /quote values that are not plain words/],
    ['[data-x!=1]', /unsupported operator/],
    ['[data-x="1"', /expected "\]"/],
    ['li:nth-child(first)', /needs a number, odd, even or an\+b/],
    ['li:nth-child(2', /is missing its "\)"/],
  ])('rejects %j with a caller-facing error', (selector, message) => {
    expect(() => querySelectorAll(LIST, selector)).toThrow(message)
    expect(() => querySelectorAll(LIST, selector)).toThrow(/^Invalid selector /)
  })
})

describe('outlineOf', () => {
  const doc = parseHtml(LANDING)

  it('lists body elements with @paths, ids, classes and own text, skipping scripts', () => {
    expect(outlineOf(doc)).toBe(
      [
        '1 header.nav.bar.sticky…',
        '  1.1 a.logo "Ledger"',
        '  1.2 nav',
        '    1.2.1 a "Features"',
        '    1.2.2 a "Pricing"',
        '2 section#hero.hero',
        '  2.1 h1.t-display "Every rupee you own, on one quiet page."',
        '  2.2 p "Track accounts, cards and loans without…"',
        '  2.3 div.cta',
        '    2.3.1 button "Start"',
        '    2.3.2 button.ghost "Tour"',
        '3 section.grid',
        '  3.1 div.card',
        '    3.1.1 svg [2]',
        '    3.1.2 h3 "Accounts"',
        '    3.1.3 ul [2]',
        '  3.2 div.card',
        '    3.2.1 h3 "Cards"',
        '4 footer "© Ledger"',
      ].join('\n'),
    )
  })

  it('cuts off at depth with a count of the hidden children', () => {
    expect(outlineOf(doc, { depth: 1 })).toBe(
      '1 header.nav.bar.sticky… [2]\n2 section#hero.hero [3]\n3 section.grid [2]\n4 footer "© Ledger"',
    )
    expect(outlineOf(doc, { depth: 2 }).split('\n')).toContain('  3.1 div.card [3]')
  })

  it('stops at maxNodes and says how many more lines there were', () => {
    const full = outlineOf(doc).split('\n')
    const cut = outlineOf(doc, { maxNodes: 5 }).split('\n')
    expect(cut.slice(0, 5)).toEqual(full.slice(0, 5))
    expect(cut[5]).toBe(`… ${full.length - 5} more elements`)
    expect(cut).toHaveLength(6)
  })

  it('outlines a subtree from any element, expanding svg when asked directly', () => {
    expect(outlineOf(doc, { from: resolveOne(doc, '#hero'), depth: 1 })).toBe(
      [
        '2 section#hero.hero',
        '  2.1 h1.t-display "Every rupee you own, on one quiet page."',
        '  2.2 p "Track accounts, cards and loans without…"',
        '  2.3 div.cta [2]',
      ].join('\n'),
    )
    expect(outlineOf(doc, { from: resolveOne(doc, 'svg') })).toBe('3.1.1 svg\n  3.1.1.1 path\n  3.1.1.2 circle')
  })

  it('numbers from the implied body of a fragment', () => {
    expect(outlineOf(parseHtml(SLOPPY))).toBe(
      [
        '1 section#hero.hero.dark',
        '  1.1 p "Lead copy"',
        '  1.2 p "Second paragraph"',
        '  1.3 ul',
        '    1.3.1 li "One"',
        '    1.3.2 li "Two"',
        '    1.3.3 li "Three"',
        '  1.4 table',
        '    1.4.1 tbody [2]',
        '2 div.tail',
        '  2.1 p "Unclosed at EOF"',
      ].join('\n'),
    )
  })

  it('leaves noscript, template, script and style out of the listing and the numbering', () => {
    const html = '<body><noscript><p>js off</p></noscript><template><p>t</p></template><script>x</script><main><p>m'
    expect(outlineOf(parseHtml(html))).toBe('1 main\n  1.1 p "m"')
    expect(outlineOf(parseHtml('<!doctype html><title>Empty</title>'))).toBe('')
  })
})

describe('resolveOne and outlinePath', () => {
  const doc = parseHtml(LANDING)

  it('resolves @paths from the outline', () => {
    expect(resolveOne(doc, '@2.1')).toBe(resolveOne(doc, 'h1'))
    expect(resolveOne(doc, ' @3.1.1.2 ')).toBe(resolveOne(doc, 'circle'))
    expect(outlinePath(resolveOne(doc, '.ghost'))).toBe('2.3.2')
  })

  it('round-trips every outline line and every body element through its @path', () => {
    for (const line of outlineOf(doc, { depth: 99 }).split('\n')) {
      const [path = '', tag = ''] = line.trim().split(' ')
      expect(resolveOne(doc, `@${path}`).tag).toBe(tag.split(/[#.]/)[0])
    }
    for (const el of elementsOf(resolveOne(doc, 'body')).filter((el) => el.tag !== 'script')) {
      expect(resolveOne(doc, `@${outlinePath(el)}`)).toBe(el)
    }
  })

  it('requires a selector to match exactly one element', () => {
    expect(resolveOne(doc, 'meta').tag).toBe('meta')
    expect(() => resolveOne(doc, '#nope')).toThrow('no element matches "#nope"')
    expect(() => resolveOne(doc, '.card')).toThrow(
      '".card" matches 2 elements — make it more specific, or use an outline path like @3.1 (matches: @3.1, @3.2)',
    )
    expect(() => resolveOne(doc, 'head > *')).toThrow(
      '"head > *" matches 3 elements — make it more specific, or use an outline path like @2.1',
    )
    expect(() => resolveOne(doc, 'a:hover')).toThrow(/^Invalid selector "a:hover"/)
  })

  it('explains bad and missing paths', () => {
    expect(() => resolveOne(doc, '  ')).toThrow(/^empty locator/)
    expect(() => resolveOne(doc, '@')).toThrow('"@" is not an outline path')
    expect(() => resolveOne(doc, '@2.x')).toThrow('"@2.x" is not an outline path')
    expect(() => resolveOne(doc, '@9')).toThrow('outline path @9 does not exist: <body> has 4 children in the outline')
    expect(() => resolveOne(doc, '@2.9')).toThrow('outline path @2.9 does not exist: @2 has 3 children in the outline')
    expect(() => resolveOne(doc, '@2.0')).toThrow('positions start at 1')
    expect(() => outlinePath(resolveOne(doc, 'meta'))).toThrow('<meta> is not in the <body> outline')
    expect(() => outlinePath(resolveOne(doc, 'script'))).toThrow('<script> is not in the <body> outline')
  })
})

describe('sourceOf and replaceSource', () => {
  it('replaces exactly one element span and leaves every other byte alone', () => {
    const doc = parseHtml(LANDING)
    const h1 = resolveOne(doc, '#hero > h1')
    const replacement = '<h1 class="t-display">New headline</h1>'
    const next = replaceSource(LANDING, h1, replacement)
    expect(next).toBe(LANDING.slice(0, h1.start) + replacement + LANDING.slice(h1.end))

    const again = parseHtml(next)
    expect(sourceOf(next, resolveOne(again, '#hero > h1'))).toBe(replacement)
    const delta = next.length - LANDING.length
    const before = elementsOf(doc)
    const after = elementsOf(again)
    expect(after).toHaveLength(before.length)
    before.forEach((el, k) => {
      const twin = after[k]
      if (el.end <= h1.start) expect([twin?.start, twin?.end]).toEqual([el.start, el.end])
      if (el.start >= h1.end) expect([twin?.start, twin?.end]).toEqual([el.start + delta, el.end + delta])
    })
  })

  it('splices inside an implied body without inventing tags', () => {
    const doc = parseHtml(SLOPPY)
    const next = replaceSource(SLOPPY, resolveOne(doc, '@2.1'), '<p>Closed now</p>')
    expect(next).toBe(SLOPPY.replace('<p>Unclosed at EOF', '<p>Closed now</p>'))
  })

  it('refuses an element parsed from a different document', () => {
    const h1 = resolveOne(parseHtml(LANDING), 'h1')
    expect(() => replaceSource('<p>short</p>', h1, 'x')).toThrow(/different document/)
    expect(() => sourceOf('<p>short</p>', h1)).toThrow(/different document/)
  })
})

describe('performance', () => {
  function syntheticDocument(minLength: number): string {
    const head = `<!doctype html><html><head><meta charset="utf-8"><title>Big</title><style>${'.c > p { margin: 0 } '.repeat(100)}</style></head><body>`
    const parts = [head]
    for (let i = 0, size = head.length; size < minLength; i++) {
      const section =
        `<section id="s${i}" class="band ${i % 2 ? 'dark' : 'light'}" data-note="a > b"><h2 class="t-h2">Section ${i}</h2>` +
        `<p>Copy for section ${i} with <em>emphasis</em> and a <a href="/x?i=${i}&amp;y=1">link</a>.` +
        `<ul><li>One<li>Two<li>Three</ul><div class="card"><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>` +
        `<img src="/i/${i}.png" alt=""><button type="button">Go</button></div><!-- card ${i} --></section>\n`
      parts.push(section)
      size += section.length
    }
    parts.push('<script>boot()</script></body></html>')
    return parts.join('')
  }

  it('parses a 60 KB document well under 50 ms', () => {
    const html = syntheticDocument(60 * 1024)
    expect(html.length).toBeGreaterThanOrEqual(60 * 1024)
    const t0 = performance.now()
    const doc = parseHtml(html)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(50)
    const sections = querySelectorAll(doc, 'body > section')
    expect(sections.length).toBeGreaterThan(100)
    expect(querySelectorAll(doc, 'section:nth-of-type(7) > ul > li:last-child').map(ownText)).toEqual(['Three'])
    expect(outlineOf(doc)).toMatch(/\n… \d+ more elements$/)
  })
})
