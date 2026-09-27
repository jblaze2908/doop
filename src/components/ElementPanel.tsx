import { useEffect, useMemo, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import {
  inspectElement,
  onFrameReady,
  setElementAttrs,
  setElementClasses,
  styleElement,
  type ElementInfo,
  type StylePatch,
} from '../lib/frameBridge'
import { ancestorsOf, buildLayerTree, elementHtml, elementPath, findLayer, layerName } from '../lib/layers'
import { replaceLayerHtml } from '../lib/layerEdits'
import {
  borderSummary,
  compactBox,
  lengthValue,
  rgbToHex,
  shorthandValue,
  sizeMode,
  type SizeMode,
} from '../lib/cssValues'
import { cn } from '@/lib/utils'
import { LayerKindIcon } from './LayerKindIcon'
import { ClassEditor, ComponentProps, SwapToComponent, TokenValue } from './ElementSystem'
import { themeClassNames, tokensOf } from '../lib/designTokens'
import { liveComponents, type ComponentDef } from '../../shared/components'
import type { ThemeToken } from '../../shared/theme'
import {
  Panel,
  PanelBody,
  PanelClose,
  PanelHeader,
  PanelTab,
  PanelTabPanel,
  PanelTabs,
  PanelTabsRoot,
} from './ui/panel'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Tooltip } from './ui/tooltip'
import { ArrowUpIcon } from './ui/icons'
import {
  ColorField,
  FieldUnit,
  NumberField,
  PropertyRow,
  PropertySection,
  SelectField,
  StaticField,
  TextField,
  ToggleField,
} from './ui/property-field'

const TAB_KEY = 'doop:element-panel-tab'
/* the runtime answers in a frame or two; the wait lets a streaming agent's
   chunks settle before every re-read */
const INSPECT_DELAY_MS = 120
const HTML_SAVE_DELAY_MS = 700

type Tab = 'design' | 'html'

function readTab(): Tab {
  try {
    return localStorage.getItem(TAB_KEY) === 'html' ? 'html' : 'design'
  } catch {
    return 'design'
  }
}

/** The element properties rail — the second panel at the right, opened from
 *  a Layers row. Reads the element's computed styles out of the live frame
 *  and writes edits back as inline styles; the HTML tab edits its markup. */
export function ElementPanel({ frame, selector, className }: { frame: Frame; selector: string; className?: string }) {
  /* the tab sticks across elements and visits: walking the tree in HTML
     view must not snap back to Design on every row */
  const [tab, setTab] = useState<Tab>(readTab)
  const [info, setInfo] = useState<ElementInfo | null>(null)

  const tree = useMemo(() => buildLayerTree(frame.html), [frame.html])
  const node = useMemo(() => findLayer(tree, selector), [tree, selector])
  const parentNode = useMemo(() => ancestorsOf(tree, selector)?.at(-1) ?? null, [tree, selector])

  /* re-read after every html change — remote edits and our own saves alike —
     and again if the frame's runtime comes up after the panel did */
  useEffect(() => {
    let live = true
    let timer: number | null = null
    const read = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        inspectElement(frame.id, selector)
          .then((next) => {
            if (live) setInfo(next)
          })
          .catch(console.error)
      }, INSPECT_DELAY_MS)
    }
    read()
    const off = onFrameReady(frame.id, read)
    return () => {
      live = false
      off()
      if (timer) window.clearTimeout(timer)
    }
  }, [frame.id, frame.html, selector])

  function apply(styles: StylePatch) {
    styleElement(frame.id, selector, styles)
      .then((next) => {
        if (next) setInfo(next)
      })
      .catch(console.error)
  }

  const theme = useStore((s) => s.canvas?.theme)
  const componentDefs = useStore((s) => s.canvas?.components)
  const system = useMemo<DesignSystem>(
    () => ({
      colors: tokensOf(theme, ['color']),
      sizes: tokensOf(theme, ['size']),
      fonts: tokensOf(theme, ['font']),
      classes: themeClassNames(theme?.css ?? ''),
      components: liveComponents(componentDefs),
    }),
    [theme, componentDefs],
  )

  function setClasses(classes: string[]) {
    setElementClasses(frame.id, selector, classes)
      .then((next) => next && setInfo(next))
      .catch(console.error)
  }

  function setAttr(name: string, value: string | null) {
    setElementAttrs(frame.id, selector, { [name]: value })
      .then((next) => next && setInfo(next))
      .catch(console.error)
  }

  /* the element becomes an instance: its children turn into slot content,
     and the selection follows it to its new (tag-based) selector */
  function swapTo(name: string) {
    const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id) ?? frame
    const outer = elementHtml(live.html, selector)
    if (!outer || !info) return
    const tpl = document.createElement('template')
    tpl.innerHTML = outer
    const inner = tpl.content.firstElementChild?.innerHTML ?? ''
    if (!replaceLayerHtml(live, selector, `<${name}>${inner}</${name}>`)) return
    const next = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
    const doc = new DOMParser().parseFromString(next?.html ?? '', 'text/html')
    const host = doc.querySelector(parentNode?.selector ?? 'body')?.children[info.index - 1]
    if (host) useStore.getState().setSelectedElement({ frameId: frame.id, selector: elementPath(host) })
  }

  function selectTab(next: Tab) {
    setTab(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      /* private mode: the choice just doesn't stick */
    }
  }

  function close() {
    useStore.getState().pickElement(null)
  }

  const name = node ? layerName(node) : selector.split(' > ').at(-1)
  const parentLabel = parentNode ? `${parentNode.tag}${parentNode.detail}` : 'body'

  return (
    <Panel className={cn('right-3 top-3 max-h-[calc(100%-24px)] w-[260px] transition-[right] duration-150', className)}>
      <PanelTabsRoot value={tab} onValueChange={(v) => selectTab(v === 'html' ? 'html' : 'design')}>
        <PanelHeader className="px-2.5 py-2">
          <PanelTabs>
            <PanelTab value="design">Design</PanelTab>
            <PanelTab value="html">HTML</PanelTab>
          </PanelTabs>
          <PanelClose onClick={close} />
        </PanelHeader>
        <div className="flex flex-none items-center gap-[7px] border-b border-line-soft px-3 py-2.5">
          <span className="grid size-5 flex-none place-items-center rounded-[5px] bg-paper-deep text-ink-soft">
            <LayerKindIcon kind={node?.kind ?? 'box'} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">
            {name}
            <small className="ml-[5px] font-mono text-[9.5px] font-normal text-ink-faint">in {parentLabel}</small>
          </span>
          {parentNode && (
            <Tooltip label="Select parent" side="bottom" align="end">
              <Button
                variant="bare"
                size="icon-sm"
                className="size-[22px] text-ink-faint hover:bg-paper-deep hover:text-ink"
                aria-label="Select parent"
                onClick={() =>
                  useStore.getState().setSelectedElement({ frameId: frame.id, selector: parentNode.selector })
                }
              >
                <ArrowUpIcon width={12} height={12} />
              </Button>
            </Tooltip>
          )}
        </div>
        <PanelTabPanel value="design">
          <PanelBody>
            {info ? (
              <DesignTab
                info={info}
                apply={apply}
                system={system}
                onClasses={setClasses}
                onAttr={setAttr}
                onSwap={swapTo}
              />
            ) : (
              <Waiting />
            )}
          </PanelBody>
        </PanelTabPanel>
        <PanelTabPanel value="html">
          <HtmlTab key={selector} frame={frame} selector={selector} />
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

function Waiting() {
  return <div className="px-3 py-6 text-center text-[12px] text-ink-faint">Reading the element…</div>
}

/* ---- Design tab ---- */

const DISPLAYS: { value: string; label: string }[] = [
  { value: 'block', label: 'block' },
  { value: 'flex-row', label: 'flex · row' },
  { value: 'flex-column', label: 'flex · column' },
  { value: 'grid', label: 'grid' },
  { value: 'inline-block', label: 'inline-block' },
  { value: 'inline-flex', label: 'inline-flex' },
  { value: 'inline', label: 'inline' },
  { value: 'none', label: 'none' },
]
const POSITIONS = ['static', 'relative', 'absolute', 'fixed', 'sticky']
const WEIGHTS = ['300', '400', '500', '600', '700', '800']
const ALIGNS = ['left', 'center', 'right', 'justify']
const SIZE_MODES: { value: SizeMode; label: string }[] = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'fill', label: 'Fill' },
  { value: 'hug', label: 'Hug' },
]

function displayValue(info: ElementInfo): string {
  if (info.display === 'flex') return info.flexDirection.startsWith('column') ? 'flex-column' : 'flex-row'
  return DISPLAYS.some((d) => d.value === info.display) ? info.display : 'block'
}

function parentLayout(info: ElementInfo): string {
  const p = info.parent
  if (!p) return ''
  if (p.display === 'grid' || p.display === 'inline-grid') return 'grid'
  if (p.display === 'flex' || p.display === 'inline-flex') return `flex ${p.flexDirection.replace('-reverse', '')}`
  return p.display
}

interface DesignSystem {
  colors: ThemeToken[]
  sizes: ThemeToken[]
  fonts: ThemeToken[]
  classes: string[]
  components: ComponentDef[]
}

const ALIGN_ITEMS = ['stretch', 'flex-start', 'center', 'flex-end', 'baseline']
const JUSTIFY = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']

function optionsFor(values: string[], current: string) {
  const all = values.includes(current) ? values : [current, ...values]
  return all.map((v) => ({ value: v, label: v === 'normal' ? 'normal' : v.replace('flex-', '') }))
}

function DesignTab({
  info,
  apply,
  system,
  onClasses,
  onAttr,
  onSwap,
}: {
  info: ElementInfo
  apply: (styles: StylePatch) => void
  system: DesignSystem
  onClasses: (classes: string[]) => void
  onAttr: (name: string, value: string | null) => void
  onSwap: (name: string) => void
}) {
  const instanceOf = info.component ? system.components.find((c) => c.name === info.component) : undefined
  const isFlex = info.display === 'flex' || info.display === 'inline-flex'
  const isGrid = info.display === 'grid' || info.display === 'inline-grid'
  const token = (prop: string, tokens: ThemeToken[], literal: string | null, field: React.ReactNode) => (
    <TokenValue
      inline={info.inline[prop]}
      tokens={tokens}
      onPick={(ref) => apply({ [prop]: ref })}
      onDetach={() => apply({ [prop]: literal })}
    >
      {field}
    </TokenValue>
  )
  const visible = info.visibility !== 'hidden'
  const fill = rgbToHex(info.backgroundColor)
  const borderColor = rgbToHex(info.borderColor)
  const gapMixed = info.rowGap !== info.columnGap
  const border = borderSummary(info.borderWidths)
  function setSize(axis: 'width' | 'height', mode: SizeMode) {
    if (mode === 'fixed') apply({ [axis]: `${info[axis] ?? 0}px` })
    else if (mode === 'fill') apply({ [axis]: '100%' })
    else apply({ [axis]: null })
  }
  return (
    <>
      {instanceOf ? (
        <ComponentProps def={instanceOf} attributes={info.attributes} onChange={onAttr} />
      ) : (
        info.tag !== 'body' && <SwapToComponent components={system.components} onSwap={onSwap} />
      )}
      <ClassEditor classes={info.classes} suggestions={system.classes} onChange={onClasses} />
      <PropertySection title="Position">
        <PropertyRow label="Type">
          <SelectField
            value={info.position}
            options={POSITIONS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => apply({ position: v === 'static' ? null : v })}
          />
        </PropertyRow>
        <PropertyRow label="Order">
          <StaticField>
            {info.index}
            <FieldUnit>
              of {info.count}
              {parentLayout(info) && ` · ${parentLayout(info)}`}
            </FieldUnit>
          </StaticField>
        </PropertyRow>
      </PropertySection>
      <PropertySection title="Size">
        <PropertyRow label="Width">
          <NumberField value={info.width} unit="px" onCommit={(v) => apply({ width: `${v}px` })} />
          <SelectField
            className="flex-[0_0_66px]"
            value={sizeMode(info.inline['width'])}
            options={SIZE_MODES}
            onChange={(v) => setSize('width', v)}
          />
        </PropertyRow>
        <PropertyRow label="Height">
          <NumberField value={info.height} unit="px" onCommit={(v) => apply({ height: `${v}px` })} />
          <SelectField
            className="flex-[0_0_66px]"
            value={sizeMode(info.inline['height'])}
            options={SIZE_MODES}
            onChange={(v) => setSize('height', v)}
          />
        </PropertyRow>
        <PropertyRow label="Min width">
          <TextField
            value={info.inline['min-width'] ?? (info.minWidth === '0px' ? '' : info.minWidth)}
            placeholder="auto"
            onCommit={(v) => apply({ 'min-width': lengthValue(v) })}
          />
        </PropertyRow>
      </PropertySection>
      <PropertySection title="Layout">
        <PropertyRow label="Display">
          <SelectField
            value={displayValue(info)}
            options={DISPLAYS}
            onChange={(v) =>
              v.startsWith('flex-')
                ? apply({ display: 'flex', 'flex-direction': v === 'flex-column' ? 'column' : 'row' })
                : apply({ display: v, 'flex-direction': null })
            }
          />
        </PropertyRow>
        <PropertyRow label="Gap">
          {token(
            'gap',
            system.sizes,
            info.rowGap === null ? null : `${info.rowGap}px`,
            <NumberField
              value={info.rowGap ?? 0}
              unit={gapMixed ? 'row' : 'px'}
              onCommit={(v) => apply({ gap: `${v}px` })}
            />,
          )}
        </PropertyRow>
        {(isFlex || isGrid) && (
          <PropertyRow label="Align">
            <SelectField
              value={info.alignItems}
              options={optionsFor(ALIGN_ITEMS, info.alignItems)}
              onChange={(v) => apply({ 'align-items': v })}
            />
            <SelectField
              value={info.justifyContent}
              options={optionsFor(JUSTIFY, info.justifyContent)}
              onChange={(v) => apply({ 'justify-content': v })}
            />
          </PropertyRow>
        )}
        {isFlex && (
          <PropertyRow label="Wrap">
            <ToggleField
              value={info.flexWrap !== 'nowrap'}
              labels={['Wrap', 'No wrap']}
              onChange={(on) => apply({ 'flex-wrap': on ? 'wrap' : null })}
            />
          </PropertyRow>
        )}
      </PropertySection>
      <PropertySection title="Spacing">
        <PropertyRow label="Padding">
          {token(
            'padding',
            system.sizes,
            shorthandValue(compactBox(info.padding)),
            <TextField value={compactBox(info.padding)} onCommit={(v) => apply({ padding: shorthandValue(v) })} />,
          )}
        </PropertyRow>
        <PropertyRow label="Margin">
          {token(
            'margin',
            system.sizes,
            shorthandValue(compactBox(info.margin)),
            <TextField value={compactBox(info.margin)} onCommit={(v) => apply({ margin: shorthandValue(v) })} />,
          )}
        </PropertyRow>
      </PropertySection>
      <PropertySection title="Styles">
        <PropertyRow label="Opacity">
          <NumberField
            className="flex-[0_0_52px]"
            value={info.opacity === null ? null : Math.round(info.opacity * 100)}
            unit="%"
            onCommit={(v) => apply({ opacity: String(Math.min(100, Math.max(0, v)) / 100) })}
          />
          <input
            type="range"
            min={0}
            max={100}
            aria-label="Opacity"
            className="h-6 min-w-0 flex-1 accent-ink"
            value={info.opacity === null ? 100 : Math.round(info.opacity * 100)}
            onChange={(e) => apply({ opacity: String(Number(e.target.value) / 100) })}
          />
        </PropertyRow>
        <PropertyRow label="Visible">
          <ToggleField
            value={visible}
            labels={['Yes', 'No']}
            onChange={(on) => apply({ visibility: on ? null : 'hidden' })}
          />
        </PropertyRow>
        <PropertyRow label="Fill">
          {token(
            'background-color',
            system.colors,
            fill,
            <ColorField value={fill} onCommit={(v) => apply({ 'background-color': v ?? 'transparent' })} />,
          )}
        </PropertyRow>
        <PropertyRow label="Border">
          {token(
            'border-color',
            system.colors,
            borderColor,
            <ColorField
              value={borderColor}
              onCommit={(v) =>
                apply({ 'border-color': v, ...(v && info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}) })
              }
            />,
          )}
          <NumberField
            className="flex-[0_0_78px]"
            value={border.width}
            unit={border.sides || 'px'}
            onCommit={(v) =>
              apply({
                'border-width': `${v}px`,
                ...(v > 0 && info.borderStyle === 'none' ? { 'border-style': 'solid' } : {}),
              })
            }
          />
        </PropertyRow>
        <PropertyRow label="Radius">
          {token(
            'border-radius',
            system.sizes,
            info.borderRadius === null ? null : `${info.borderRadius}px`,
            <NumberField value={info.borderRadius} unit="px" onCommit={(v) => apply({ 'border-radius': `${v}px` })} />,
          )}
        </PropertyRow>
      </PropertySection>
      {info.hasText && (
        <PropertySection title="Text">
          <PropertyRow label="Size">
            {token(
              'font-size',
              system.sizes,
              info.fontSize === null ? null : `${info.fontSize}px`,
              <NumberField value={info.fontSize} unit="px" onCommit={(v) => apply({ 'font-size': `${v}px` })} />,
            )}
            <SelectField
              className="flex-[0_0_66px]"
              value={WEIGHTS.includes(info.fontWeight) ? info.fontWeight : '400'}
              options={WEIGHTS.map((w) => ({ value: w, label: w }))}
              onChange={(v) => apply({ 'font-weight': v })}
            />
          </PropertyRow>
          <PropertyRow label="Color">
            {token(
              'color',
              system.colors,
              rgbToHex(info.color),
              <ColorField value={rgbToHex(info.color)} onCommit={(v) => apply({ color: v })} />,
            )}
          </PropertyRow>
          <PropertyRow label="Font">
            {token(
              'font-family',
              system.fonts,
              info.fontFamily,
              <StaticField className="truncate">{info.fontFamily.split(',')[0]?.replace(/["']/g, '')}</StaticField>,
            )}
          </PropertyRow>
          <PropertyRow label="Leading">
            <TextField
              value={info.inline['line-height'] ?? info.lineHeight}
              onCommit={(v) => apply({ 'line-height': lengthValue(v) })}
            />
            <TextField
              className="flex-[0_0_78px]"
              value={info.inline['letter-spacing'] ?? (info.letterSpacing === 'normal' ? '' : info.letterSpacing)}
              placeholder="0"
              unit="ls"
              onCommit={(v) => apply({ 'letter-spacing': lengthValue(v) })}
            />
          </PropertyRow>
          <PropertyRow label="Align">
            <SelectField
              value={ALIGNS.includes(info.textAlign) ? info.textAlign : 'left'}
              options={ALIGNS.map((a) => ({ value: a, label: a }))}
              onChange={(v) => apply({ 'text-align': v })}
            />
          </PropertyRow>
        </PropertySection>
      )}
    </>
  )
}

/* ---- HTML tab ---- */

function HtmlTab({ frame, selector }: { frame: Frame; selector: string }) {
  const source = useMemo(() => elementHtml(frame.html, selector) ?? '', [frame.html, selector])
  const [draft, setDraft] = useState(source)
  const [typing, setTyping] = useState(false)
  /* the save waiting for the typing to pause; flushed when the editor goes
     away so a quick switch to another row neither loses nor delays the edit */
  const pendingSave = useRef<{ timer: number; run: () => void } | null>(null)
  useEffect(
    () => () => {
      if (!pendingSave.current) return
      window.clearTimeout(pendingSave.current.timer)
      pendingSave.current.run()
    },
    [],
  )
  /* remote html changes replace the draft unless the person is typing */
  const [seen, setSeen] = useState(source)
  if (seen !== source) {
    setSeen(source)
    if (!typing) setDraft(source)
  }

  function onChange(value: string) {
    setDraft(value)
    if (pendingSave.current) window.clearTimeout(pendingSave.current.timer)
    const run = () => {
      pendingSave.current = null
      const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id) ?? frame
      replaceLayerHtml(live, selector, value)
    }
    pendingSave.current = { timer: window.setTimeout(run, HTML_SAVE_DELAY_MS), run }
  }

  return (
    <Textarea
      variant="bare"
      className="min-h-[320px] flex-1 bg-[#17171b] p-3 font-mono text-[11.5px] leading-[1.55] text-[#e9e9ee] [tab-size:2] md:text-[11.5px]"
      value={draft}
      spellCheck={false}
      onFocus={() => setTyping(true)}
      onBlur={() => setTyping(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
