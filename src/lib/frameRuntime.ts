import { FRAME_REPLAY_RUNTIME } from './frameReplayRuntime'
import { COMPONENT_RUNTIME } from '../../shared/components'

/**
 * Bootstrap document loaded once per frame iframe. The parent posts HTML in
 * via postMessage and the runtime morphs the live DOM to match — only changed
 * elements are touched, so updates render in place with no white reload flash.
 * Works inside sandbox="allow-scripts" (no same-origin access needed).
 */
export const FRAME_BOOTSTRAP = `<!doctype html>
<html><head></head><body><script data-v-boot>
(function () {
  ${FRAME_REPLAY_RUNTIME}
  ${COMPONENT_RUNTIME}
  /* horizontal overscroll inside a frame must not chain to the parent page,
     where the browser turns it into a history back/forward swipe. Adopted
     sheet, not a <style> tag — the morph would wipe a tag from <head>. */
  try {
    var vSheet = new CSSStyleSheet()
    vSheet.replaceSync('html,body{overscroll-behavior-x:none}')
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(vSheet)
  } catch (e) {}
  function syncAttrs(from, to) {
    for (var i = from.attributes.length - 1; i >= 0; i--) {
      var name = from.attributes[i].name
      if (name === 'data-v-ran') continue
      if (!to.hasAttribute(name)) from.removeAttribute(name)
    }
    for (var j = 0; j < to.attributes.length; j++) {
      var a = to.attributes[j]
      if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value)
    }
  }

  function isOpaque(el) {
    // subtrees we swap wholesale instead of walking
    var n = el.nodeName
    return n === 'STYLE' || n === 'TEXTAREA' || n === 'IFRAME' || el.namespaceURI !== 'http://www.w3.org/1999/xhtml'
  }

  function morphChildren(from, to) {
    var tc = to.childNodes
    for (var i = 0; i < tc.length; i++) {
      var t = tc[i]
      var f = from.childNodes[i]
      if (!f) {
        from.appendChild(document.importNode(t, true))
        continue
      }
      if (f.nodeType !== t.nodeType || (f.nodeType === 1 && f.nodeName !== t.nodeName)) {
        from.replaceChild(document.importNode(t, true), f)
        continue
      }
      if (t.nodeType === 3 || t.nodeType === 8) {
        if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue
        continue
      }
      if (t.nodeType === 1) {
        syncAttrs(f, t)
        if (f.nodeName === 'SCRIPT') {
          if (f.textContent !== t.textContent) {
            f.textContent = t.textContent
            f.removeAttribute('data-v-ran') // changed script: re-execute
          }
        } else if (isOpaque(f)) {
          if (f.innerHTML !== t.innerHTML) f.innerHTML = t.innerHTML
        } else {
          morphChildren(f, t)
        }
      }
    }
    while (from.childNodes.length > tc.length) from.removeChild(from.lastChild)
  }

  /* cloned/imported script nodes never execute — swap in fresh ones */
  function activateScripts() {
    var scripts = document.querySelectorAll('script:not([data-v-ran]):not([data-v-boot])')
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i]
      if (old === replayScript) continue
      var s = document.createElement('script')
      for (var j = 0; j < old.attributes.length; j++) s.setAttribute(old.attributes[j].name, old.attributes[j].value)
      s.textContent = old.textContent
      s.setAttribute('data-v-ran', '1')
      old.parentNode.replaceChild(s, old)
    }
  }

  /* ---- canvas theme ----
     The parent posts the compiled theme. It rides as a <style> first in
     <head>, where the server's screenshots splice it too: an adopted sheet
     would cascade AFTER the frame's own styles, and the frame must win.
     It is added to every parsed document before the morph, so the morph
     leaves it in place, and serialize() drops it. */
  var themeCss = ''

  function themeOff(root) {
    return root.getAttribute('data-doop-theme') === 'off'
  }

  function addTheme(doc) {
    if (!themeCss || themeOff(doc.documentElement)) return
    var st = doc.createElement('style')
    st.setAttribute('data-doop-theme', '')
    st.textContent = themeCss
    doc.head.insertBefore(st, doc.head.firstChild)
  }

  function setTheme(css) {
    if (css === themeCss) return
    themeCss = css
    var live = document.head.querySelector('style[data-doop-theme]')
    if (live) live.parentNode.removeChild(live)
    addTheme(document)
    shareTheme()
  }

  /* component shadow roots see the theme only through their own sheet */
  function shareTheme() {
    doopComponents.setTheme(themeOff(document.documentElement) ? '' : themeCss)
  }

  function render(html) {
    var doc
    try {
      doc = new DOMParser().parseFromString(html, 'text/html')
      addTheme(doc)
      syncAttrs(document.documentElement, doc.documentElement)
      /* the incoming html carries no root style, so the sync drops our
         crisp-render zoom — put it back before the page reflows */
      if (curZoom !== 1) document.documentElement.style.zoom = String(curZoom)
      morphChildren(document.head, doc.head)
      morphChildren(document.body, doc.body)
      activateScripts()
      shareTheme()
      doopComponents.refresh() // the morph may have changed instance attributes
    } catch (e) {
      if (doc) document.documentElement.innerHTML = doc.documentElement.innerHTML
    }
  }

  /* ---- inline text editing ----
     The parent flips edit mode on. Instead of designMode (which makes the
     whole document a caret trap), we hit-test: hovering a text-bearing
     element outlines it, clicking makes JUST that element editable with the
     caret placed at the click point. Edits debounce-serialize back to the
     parent, which saves them through the normal frame-update path. */
  var editing = false
  var activeEl = null
  var editTimer = null

  var EDIT_CSS =
    '[data-v-hover]{outline:1.5px dashed rgba(39,67,238,0.75)!important;outline-offset:2px;cursor:text}' +
    '[data-v-active]{outline:2px solid rgba(39,67,238,0.9)!important;outline-offset:2px;cursor:text}' +
    '[data-v-active]:focus{outline:2px solid rgba(39,67,238,0.9)!important}'

  function hasOwnText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.replace(/[\\s\\u00a0]+/g, '')) return true
    }
    return false
  }

  /* nearest ancestor (incl. self) that directly contains visible text */
  function candidate(start) {
    var el = start && start.nodeType === 3 ? start.parentElement : start
    while (el && el !== document.body && el !== document.documentElement) {
      if (hasOwnText(el)) return el
      el = el.parentElement
    }
    return null
  }

  function clearHover() {
    var h = document.querySelector('[data-v-hover]')
    if (h) h.removeAttribute('data-v-hover')
  }

  function deactivate() {
    if (!activeEl) return
    activeEl.removeAttribute('contenteditable')
    activeEl.removeAttribute('data-v-active')
    activeEl = null
    postActive()
  }

  /* tell the parent which element is selected for editing, so it can anchor
     the element toolbar (comment etc.) to it */
  function activeInfo() {
    return activeEl ? hitInfo(activeEl) : null
  }

  function postActive() {
    parent.postMessage({ type: 'doop:active', hit: activeInfo() }, '*')
  }

  function placeCaret(x, y) {
    var r = null
    if (document.caretRangeFromPoint) {
      r = document.caretRangeFromPoint(x, y)
    } else if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y)
      if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true) }
    }
    if (r) {
      var s = getSelection()
      s.removeAllRanges()
      s.addRange(r)
    }
  }

  function activate(el, x, y, keepSelection) {
    if (activeEl !== el) {
      deactivate()
      activeEl = el
      el.removeAttribute('data-v-hover')
      el.setAttribute('data-v-active', '1')
      try { el.contentEditable = 'plaintext-only' } catch (e) { el.contentEditable = 'true' }
      el.focus({ preventScroll: true })
      postActive()
    }
    /* double/triple clicks carry a native word/paragraph selection —
       placing a caret here would collapse it the instant it appears */
    if (!keepSelection) placeCaret(x, y)
  }

  function serialize() {
    var root = document.documentElement.cloneNode(true)
    // Remove only our pending loader's clone, preserving design-owned attributes.
    if (replayScript && replayScript.parentNode === document.documentElement) {
      var replayIndex = Array.prototype.indexOf.call(document.documentElement.childNodes, replayScript)
      root.childNodes[replayIndex].remove()
    }
    var boot = root.querySelector('script[data-v-boot]')
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot)
    var es = root.querySelector('style[data-v-edit]')
    if (es && es.parentNode) es.parentNode.removeChild(es)
    var themes = root.querySelectorAll('style[data-doop-theme]')
    for (var t = 0; t < themes.length; t++) themes[t].parentNode.removeChild(themes[t])
    var ran = root.querySelectorAll('[data-v-ran]')
    for (var i = 0; i < ran.length; i++) ran[i].removeAttribute('data-v-ran')
    var marked = root.querySelectorAll('[data-v-active],[data-v-hover]')
    for (var j = 0; j < marked.length; j++) {
      marked[j].removeAttribute('contenteditable')
      marked[j].removeAttribute('data-v-active')
      marked[j].removeAttribute('data-v-hover')
    }
    root.style.removeProperty('zoom') // crisp-render zoom is ours, not the design's
    if (!root.getAttribute('style')) root.removeAttribute('style')
    return '<!doctype html>\\n' + root.outerHTML
  }

  function postEdited() {
    parent.postMessage({ type: 'doop:edited', html: serialize() }, '*')
    /* typing can move/grow the element — keep the parent's toolbar anchored */
    if (editing && activeEl) postActive()
  }

  function setEdit(on) {
    if (on === editing) return
    editing = on
    if (on) {
      var st = document.createElement('style')
      st.setAttribute('data-v-edit', '')
      st.textContent = EDIT_CSS
      document.head.appendChild(st)
    } else {
      if (editTimer) { clearTimeout(editTimer); editTimer = null }
      deactivate()
      clearHover()
      var st2 = document.querySelector('style[data-v-edit]')
      if (st2 && st2.parentNode) st2.parentNode.removeChild(st2)
      postEdited() // flush the final state before renders resume
    }
  }

  /* capture-phase: no link navigation or button handlers while editing */
  document.addEventListener('click', function (ev) {
    if (!editing) return
    ev.preventDefault()
    ev.stopPropagation()
    var el = candidate(ev.target)
    if (el) activate(el, ev.clientX, ev.clientY, ev.detail > 1)
    else deactivate()
  }, true)

  document.addEventListener('mousemove', function (ev) {
    if (!editing) return
    var el = candidate(ev.target)
    var prev = document.querySelector('[data-v-hover]')
    if (prev && prev !== el) prev.removeAttribute('data-v-hover')
    if (el && el !== activeEl) el.setAttribute('data-v-hover', '1')
  }, true)

  document.addEventListener('input', function () {
    if (!editing) return
    if (editTimer) clearTimeout(editTimer)
    editTimer = setTimeout(postEdited, 400)
  })

  /* Escape pressed with focus inside the frame: the parent never sees the
     key event itself, so relay it (present mode closes on it) */
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return
    if (editing) {
      setEdit(false)
      parent.postMessage({ type: 'doop:edit-esc' }, '*')
    } else {
      parent.postMessage({ type: 'doop:esc' }, '*')
    }
  })

  /* ---- element probe + locate (comments) ----
     The parent can't see into this sandboxed document, so it asks: probe
     resolves the element at a point (for the click toolbar), locate finds a
     stored selector again (to place comment pins). Coordinates cross the
     boundary in design px; the crisp-render zoom is unapplied on both ends. */
  var curZoom = 1

  function cssPath(el) {
    var parts = []
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break }
      var tag = el.tagName.toLowerCase()
      var nth = 1
      for (var s = el.previousElementSibling; s; s = s.previousElementSibling) {
        if (s.tagName === el.tagName) nth++
      }
      parts.unshift(tag + ':nth-of-type(' + nth + ')')
      el = el.parentElement
    }
    return parts.join(' > ')
  }

  function designRect(el) {
    var r = el.getBoundingClientRect()
    return { x: r.left / curZoom, y: r.top / curZoom, width: r.width / curZoom, height: r.height / curZoom }
  }

  function hitInfo(el) {
    var snippet = el.outerHTML || ''
    if (snippet.length > 400) snippet = snippet.slice(0, 397) + '...'
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      snippet: snippet,
      rect: designRect(el),
    }
  }

  function probe(x, y) {
    var el = document.elementFromPoint(x * curZoom, y * curZoom)
    if (!el || el === document.documentElement || el === document.body) return null
    return hitInfo(el)
  }

  /* the Layers panel selects by selector rather than by point */
  function describe(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el || el === document.documentElement || el === document.body) return null
    return hitInfo(el)
  }

  /* hover inspection: like probe but fired on every (throttled) pointer move,
     so it skips the outerHTML/selector work and returns just tag + rect */
  function hoverProbe(x, y) {
    var el = document.elementFromPoint(x * curZoom, y * curZoom)
    if (!el || el === document.documentElement || el === document.body) return null
    return { tag: el.tagName.toLowerCase(), rect: designRect(el) }
  }

  /* full source of one element, with runtime markers stripped */
  function elementCode(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el) return null
    var c = el.cloneNode(true)
    var nodes = [c].concat(Array.prototype.slice.call(c.querySelectorAll('*')))
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute('data-v-ran')
      nodes[i].removeAttribute('data-v-hover')
      nodes[i].removeAttribute('data-v-active')
      nodes[i].removeAttribute('contenteditable')
    }
    var html = c.outerHTML
    if (html.length > 20000) html = html.slice(0, 20000) + '\\n<!-- truncated -->'
    return html
  }

  /* ---- element properties (the Design panel) ----
     The panel cannot read computed styles across the sandbox, so it asks for
     a summary of one element and writes changes back as inline styles; the
     edited document then goes to the parent through the usual save path. */
  function px(v) {
    var n = parseFloat(v)
    return isNaN(n) ? null : Math.round(n * 100) / 100
  }

  function inspect(selector) {
    var el = null
    try { el = selector ? document.querySelector(selector) : null } catch (e) { /* bad selector */ }
    if (!el || el === document.documentElement) return null
    var cs = getComputedStyle(el)
    var parentEl = el.parentElement
    var pcs = parentEl ? getComputedStyle(parentEl) : null
    var siblings = parentEl ? parentEl.children : [el]
    var index = 0
    for (var i = 0; i < siblings.length; i++) if (siblings[i] === el) index = i + 1
    var inline = {}
    for (var j = 0; j < el.style.length; j++) {
      var name = el.style[j]
      inline[name] = el.style.getPropertyValue(name)
    }
    var classes = (el.getAttribute('class') || '').trim().split(/[ ]+/).filter(Boolean)
    var text = ''
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) text += n.nodeValue
    var sides = ['Top', 'Right', 'Bottom', 'Left']
    var drawn = 'Top'
    for (var b = 0; b < sides.length; b++) {
      if (px(cs['border' + sides[b] + 'Width']) > 0 && cs['border' + sides[b] + 'Style'] !== 'none') { drawn = sides[b]; break }
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: classes,
      parent: parentEl && parentEl !== document.documentElement
        ? { tag: parentEl.tagName.toLowerCase(), id: parentEl.id || '', className: (parentEl.getAttribute('class') || '').trim().split(/[ ]+/)[0] || '', display: pcs.display, flexDirection: pcs.flexDirection }
        : null,
      index: index,
      count: siblings.length,
      inline: inline,
      hasText: text.replace(/\\s+/g, '') !== '',
      rect: designRect(el),
      position: cs.position,
      display: cs.display,
      flexDirection: cs.flexDirection,
      width: px(cs.width),
      height: px(cs.height),
      minWidth: cs.minWidth,
      rowGap: px(cs.rowGap),
      columnGap: px(cs.columnGap),
      padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
      opacity: px(cs.opacity),
      visibility: cs.visibility,
      backgroundColor: cs.backgroundColor,
      /* rounded: the crisp-render zoom snaps hairlines to device pixels */
      borderWidths: [
        Math.round(px(cs.borderTopWidth)),
        Math.round(px(cs.borderRightWidth)),
        Math.round(px(cs.borderBottomWidth)),
        Math.round(px(cs.borderLeftWidth)),
      ],
      borderStyle: cs['border' + drawn + 'Style'],
      borderColor: cs['border' + drawn + 'Color'],
      borderRadius: px(cs.borderTopLeftRadius),
      color: cs.color,
      fontSize: px(cs.fontSize),
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
      textAlign: cs.textAlign,
      margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
      alignItems: cs.alignItems,
      justifyContent: cs.justifyContent,
      flexWrap: cs.flexWrap,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      attributes: plainAttributes(el),
      /* a linked component instance: its props are attributes, its look is the definition */
      component: el.shadowRoot && customElements.get(el.localName) ? el.localName : null,
    }
  }

  /* attributes a person may edit as props — not styling, ids or our markers */
  function plainAttributes(el) {
    var out = {}
    for (var i = 0; i < el.attributes.length; i++) {
      var n = el.attributes[i].name
      if (n === 'style' || n === 'class' || n === 'id' || n === 'contenteditable' || n.indexOf('data-v-') === 0) continue
      out[n] = el.attributes[i].value
    }
    return out
  }

  var styleTimer = null
  /* a slider fires many of these a second — one save once it settles. While
     one is pending, incoming renders are skipped: morphing now would wipe the
     unsaved change, and the parent re-sends the frame after the save. */
  function scheduleSave() {
    if (styleTimer) clearTimeout(styleTimer)
    styleTimer = setTimeout(function () {
      styleTimer = null
      postEdited()
    }, 250)
  }

  function findEl(selector) {
    try { return selector ? document.querySelector(selector) : null } catch (e) { return null }
  }

  function applyStyle(selector, styles) {
    var el = findEl(selector)
    if (!el) return false
    for (var k in styles) {
      if (!Object.prototype.hasOwnProperty.call(styles, k)) continue
      if (styles[k] === null || styles[k] === '') el.style.removeProperty(k)
      else el.style.setProperty(k, String(styles[k]))
    }
    if (!el.getAttribute('style')) el.removeAttribute('style')
    scheduleSave()
    return true
  }

  function applyClasses(selector, classes) {
    var el = findEl(selector)
    if (!el || el === document.documentElement) return false
    var clean = []
    for (var i = 0; i < classes.length; i++) {
      var c = String(classes[i]).trim()
      if (c && !/[^A-Za-z0-9_-]/.test(c) && clean.indexOf(c) < 0) clean.push(c)
    }
    if (clean.length) el.setAttribute('class', clean.join(' '))
    else el.removeAttribute('class')
    scheduleSave()
    return true
  }

  /* props of component instances and plain attributes; never event handlers,
     styling or ids, which have their own editors */
  function applyAttrs(selector, attrs) {
    var el = findEl(selector)
    if (!el || el === document.documentElement) return false
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue
      var n = String(k).toLowerCase()
      if (!/^[a-z][a-z0-9-]*$/.test(n) || n.indexOf('on') === 0 || n === 'style' || n === 'class' || n === 'id') continue
      if (attrs[k] === null) el.removeAttribute(n)
      else el.setAttribute(n, String(attrs[k]))
    }
    doopComponents.refresh()
    scheduleSave()
    return true
  }

  window.addEventListener('message', function (ev) {
    /* only the parent drives this document — a script inside the frame must
       not be able to pose as the panel and push edits into the save path */
    if (ev.source !== parent) return
    var d = ev.data
    if (!d) return
    if (d.type === 'doop:inspect') {
      parent.postMessage({ type: 'doop:inspect-result', reqId: d.reqId, info: inspect(d.selector) }, '*')
    }
    if (d.type === 'doop:style' && d.styles && typeof d.styles === 'object') {
      var applied = applyStyle(d.selector, d.styles)
      parent.postMessage({ type: 'doop:style-result', reqId: d.reqId, ok: applied, info: applied ? inspect(d.selector) : null }, '*')
    }
    if (d.type === 'doop:theme' && typeof d.css === 'string') setTheme(d.css)
    if (d.type === 'doop:components' && Array.isArray(d.defs)) doopComponents.set(d.defs)
    if (d.type === 'doop:classes' && Array.isArray(d.classes)) {
      var classed = applyClasses(d.selector, d.classes)
      parent.postMessage({ type: 'doop:classes-result', reqId: d.reqId, ok: classed, info: classed ? inspect(d.selector) : null }, '*')
    }
    if (d.type === 'doop:attrs' && d.attrs && typeof d.attrs === 'object') {
      var attred = applyAttrs(d.selector, d.attrs)
      parent.postMessage({ type: 'doop:attrs-result', reqId: d.reqId, ok: attred, info: attred ? inspect(d.selector) : null }, '*')
    }
    if (d.type === 'doop:html' && typeof d.html === 'string' && !editing && !styleTimer) render(d.html)
    if (d.type === 'doop:edit') setEdit(!!d.on)
    if (d.type === 'doop:probe') {
      parent.postMessage({ type: 'doop:probe-result', reqId: d.reqId, hit: probe(d.x, d.y) }, '*')
    }
    if (d.type === 'doop:hover') {
      parent.postMessage({ type: 'doop:hover-result', reqId: d.reqId, hit: hoverProbe(d.x, d.y) }, '*')
    }
    if (d.type === 'doop:select') {
      parent.postMessage({ type: 'doop:select-result', reqId: d.reqId, hit: describe(d.selector) }, '*')
    }
    if (d.type === 'doop:code') {
      parent.postMessage({ type: 'doop:code-result', reqId: d.reqId, html: elementCode(d.selector) }, '*')
    }
    if (d.type === 'doop:locate') {
      var found = null
      try {
        var target = d.selector ? document.querySelector(d.selector) : null
        if (target) found = designRect(target)
      } catch (e) { /* bad selector -> null */ }
      parent.postMessage({ type: 'doop:located', reqId: d.reqId, rect: found }, '*')
    }
    /* re-rasterize crisply when the canvas is zoomed in: layout stays identical
       (viewport is scaled up by the same factor outside) but pixels are k-times denser */
    if (d.type === 'doop:zoom' && typeof d.zoom === 'number') {
      curZoom = d.zoom
      document.documentElement.style.zoom = String(d.zoom)
    }
  })
  parent.postMessage({ type: 'doop:frame-ready' }, '*')
})()
</script></body></html>`
