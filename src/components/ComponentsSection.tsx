import { useState } from 'react'
import {
  componentUsages,
  liveComponents,
  MAX_COMPONENT_CSS_CHARS,
  MAX_COMPONENT_HTML_CHARS,
  prepareFrameHtml,
  templateSlots,
  type ComponentDef,
} from '../../shared/components'
import { originOf, type DesignOrigin } from '../../shared/designSystem'
import { useStore } from '../lib/store'
import type { Frame } from '../../shared/types'
import { originPrefix } from './RulesSection'
import { api, errorMessage } from '../lib/api'
import { useComponentDefs, useEffectiveComponents, useThemeCss, useUtilityCss } from '../lib/theme'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { ListHint, ListMeta, ListRow, ListSection, ListTitle } from './ui/list'
import { Modal, ModalActions, ModalSpacer, ModalTitle } from './ui/modal'
import { ConfirmDialog } from './ui/alert-dialog'

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** One instance with sample content: defaults for props, names for slots. */
function sampleInstance(d: ComponentDef): string {
  const attrs = d.props.map((p) => ` ${p.name}="${escapeAttr(p.default ?? p.name)}"`).join('')
  const slots = templateSlots(d.html)
    .map((s) => (s === 'default' ? 'Content' : `<span slot="${escapeAttr(s)}">${s}</span>`))
    .join('')
  return `<${d.name}${attrs}>${slots}</${d.name}>`
}

function usageLabel(used: { count: number }[]): string {
  const n = used.reduce((sum, u) => sum + u.count, 0)
  return `${n} instance${n === 1 ? '' : 's'} in ${used.length} frame${used.length === 1 ? '' : 's'}`
}

/* stable fallback: a fresh [] from a selector re-renders on every store update */
const NO_FRAMES: Frame[] = []

/** The Components section of the Design tab: every linked component with a
 *  live preview and its usage count; a click opens the editor. The design
 *  system's read until overridden here. */
export function ComponentsSection({ canvasId }: { canvasId: string }) {
  const defs = useEffectiveComponents()
  const own = useStore((s) => s.canvas?.components)
  const systemDefs = useStore((s) => s.system?.snapshot.components)
  const systemName = useStore((s) => s.system?.system.name)
  const frames = useStore((s) => s.canvas?.frames ?? NO_FRAMES)
  const [open, setOpen] = useState<string | null>(null)
  const live = liveComponents(defs)

  return (
    <>
      <ListSection>
        <span>Components</span>
      </ListSection>
      {live.length === 0 && (
        <ListHint>
          Reusable pieces every frame can use. Change one and every instance on every frame follows. Agents create them
          with set_component.
        </ListHint>
      )}
      {live.map((d) => {
        const used = componentUsages(frames, d.name)
        return (
          <ListRow key={d.name} className="gap-1 py-2.5" onClick={() => setOpen(d.name)}>
            <ComponentPreview def={d} />
            <ListTitle className="font-mono text-[12px]">&lt;{d.name}&gt;</ListTitle>
            <ListMeta>
              {originPrefix(originOf(d.name, systemDefs, own), systemName)}
              {used.length ? usageLabel(used) : 'unused'} · {d.updatedBy} · {timeAgo(d.updatedAt)}
            </ListMeta>
          </ListRow>
        )
      })}
      {open !== null && (
        <ComponentModal
          canvasId={canvasId}
          def={live.find((d) => d.name === open) ?? null}
          origin={originOf(open, systemDefs, own)}
          systemName={systemName}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

function ComponentPreview({ def }: { def: ComponentDef }) {
  const html = prepareFrameHtml(
    `<!doctype html><html><head></head><body style="margin:0;padding:10px;background:transparent">${sampleInstance(def)}</body></html>`,
    useThemeCss(),
    useComponentDefs(),
    useUtilityCss(),
  )
  return (
    <span className="block h-[72px] w-full overflow-hidden rounded-[8px] border border-line bg-white">
      <iframe
        className="pointer-events-none h-full w-full border-0"
        title={def.name}
        srcDoc={html}
        sandbox="allow-scripts"
        tabIndex={-1}
      />
    </span>
  )
}

function ComponentModal({
  canvasId,
  def,
  origin,
  systemName,
  onClose,
}: {
  canvasId: string
  def: ComponentDef | null
  origin: DesignOrigin
  systemName?: string
  onClose: () => void
}) {
  const frames = useStore((s) => s.canvas?.frames ?? NO_FRAMES)
  const [html, setHtml] = useState(def?.html ?? '')
  const [css, setCss] = useState(def?.css ?? '')
  const [description, setDescription] = useState(def?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /* the system's definition reads until "Override here" */
  const [overriding, setOverriding] = useState(false)
  const locked = origin === 'system' && !overriding

  if (!def) {
    return (
      <Modal size="xl" onClose={onClose}>
        <>
          <ModalTitle>Component</ModalTitle>
          <p className="mt-2 text-[13px] text-ink-soft">This component no longer exists.</p>
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </ModalActions>
        </>
      </Modal>
    )
  }

  const used = componentUsages(frames, def.name)
  /* an override starts as a copy of the system's, so saving it unchanged is a real write */
  const dirty = overriding || html !== def.html || css !== def.css || description !== (def.description ?? '')
  const disabled = busy || locked

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onClose()
    } catch (e) {
      setError(errorMessage(e, 'save failed'))
    } finally {
      setBusy(false)
    }
  }

  const field =
    'mt-1.5 min-h-[20dvh] resize-y rounded-[12px] bg-surface px-4 py-3 font-mono leading-[1.6] focus:ring-0 md:text-[12px]'
  return (
    <Modal size="xl" onClose={() => !busy && onClose()}>
      <>
        <ModalTitle className="font-mono">&lt;{def.name}&gt;</ModalTitle>
        <p className="mt-1.5 text-[11.5px] text-ink-faint">
          props: {def.props.map((p) => p.name).join(', ') || 'none'} · slots:{' '}
          {templateSlots(def.html).join(', ') || 'none'} ·{' '}
          {used.length ? `used in ${used.map((u) => u.frameName).join(', ')}` : 'not used yet'}
          {origin === 'system'
            ? ` · from ${systemName}${overriding ? ' — saving overrides it on this canvas only' : ''}`
            : origin === 'override'
              ? ` · overrides ${systemName}`
              : ''}
        </p>
        <Input
          className="mt-3"
          placeholder="What it is for"
          value={description}
          disabled={disabled}
          onChange={(e) => setDescription(e.target.value)}
        />
        <label className="mt-3 block text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">Template</label>
        <Textarea
          className={field}
          value={html}
          maxLength={MAX_COMPONENT_HTML_CHARS}
          disabled={disabled}
          onChange={(e) => setHtml(e.target.value)}
        />
        <label className="mt-3 block text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">CSS</label>
        <Textarea
          className={field}
          value={css}
          maxLength={MAX_COMPONENT_CSS_CHARS}
          disabled={disabled}
          onChange={(e) => setCss(e.target.value)}
        />
        {error && <p className="mt-2.5 text-[13px] text-accent-ink">{error}</p>}
        <ModalActions className="items-center">
          {origin !== 'system' && (
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
              {origin === 'override' ? 'Reset to system' : 'Delete'}
            </Button>
          )}
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={origin === 'override' ? `Reset <${def.name}>?` : `Delete <${def.name}>?`}
            description={
              origin === 'override'
                ? `This canvas’s version goes and every instance renders “${systemName}”’s again.`
                : used.length
                  ? `Its ${used.reduce((n, u) => n + u.count, 0)} instances stay in their frames and show a “missing component” box until it is recreated.`
                  : 'It is not used in any frame.'
            }
            confirmLabel={origin === 'override' ? 'Reset to system' : 'Delete component'}
            destructive
            onConfirm={() => run(() => api.deleteComponent(canvasId, def.name))}
          />
          <ModalSpacer />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {locked ? (
            <Button variant="primary" onClick={() => setOverriding(true)}>
              Override here
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || !dirty || !html.trim()}
              onClick={() =>
                run(() => api.setComponent(canvasId, { name: def.name, html, css, props: def.props, description }))
              }
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          )}
        </ModalActions>
      </>
    </Modal>
  )
}
