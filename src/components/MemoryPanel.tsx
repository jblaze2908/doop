import { useState } from 'react'
import type { MemoryReference } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { PanelBody } from './ui/panel'
import { ListHint, ListItem, ListMeta, ListRow, ListSection, ListTitle } from './ui/list'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { prepareFrameHtml } from '../../shared/components'
import { useComponentDefs, useThemeCss, useUtilityCss } from '../lib/theme'

/* Timestamp/author line under a modal heading. */
const meta = 'mt-1.5 text-[11.5px] text-ink-faint'
const modalHead = 'flex flex-wrap items-baseline gap-2.5'

/* stable fallback: a fresh [] from a selector re-renders on every store update */
const NO_REFS: MemoryReference[] = []

/** The Memory tab in the side panel: what this canvas has learned of your
 *  taste. References (pinned exemplar frames) and Decisions (captured
 *  feedback); the design itself is the Design tab. */
export function MemoryPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const references = useStore((s) => s.canvas?.references ?? NO_REFS)
  const decisions = useStore((s) => s.decisions)
  const [openRef, setOpenRef] = useState<string | null>(null)

  if (!canvasId) return null

  const empty = references.length === 0 && decisions.length === 0

  return (
    <PanelBody className="flex flex-col py-2">
      {empty && (
        <div className="border-b border-line-soft px-4 py-3.5">
          <p className="text-[12.5px] leading-[1.5] font-semibold text-ink">
            Memory is how this canvas remembers your taste — and how every agent designs with it.
          </p>
          <ul className="mt-2.5 flex flex-col gap-2 pl-4">
            <li className="text-[12px] leading-[1.5] text-ink-soft">
              <b>References</b> — pin a frame you love (the 🧠 on its corner). Agents copy its colors, type and layout
              when they design something new.
            </li>
            <li className="text-[12px] leading-[1.5] text-ink-soft">
              <b>Decisions</b> — feedback you give agents is captured here automatically once it’s addressed.
            </li>
          </ul>
          <p className="mt-2.5 text-[12px] leading-[1.5] text-ink-soft">
            Theme, components and rules live in the <b>Design</b> tab.
          </p>
        </div>
      )}

      <ListSection>
        <span>References</span>
      </ListSection>
      {references.length === 0 ? (
        <ListHint>
          No references yet. Pin a frame you like (the 🧠 on its corner) and agents will copy its colors, type and
          layout in new designs.
        </ListHint>
      ) : (
        references.map((r) => (
          <ListRow key={r.id} className="gap-1 py-2.5" onClick={() => setOpenRef(r.id)}>
            <RefThumb reference={r} />
            <ListTitle>{r.title}</ListTitle>
            <ListMeta>
              {r.pinnedBy} · {timeAgo(r.pinnedAt)}
            </ListMeta>
          </ListRow>
        ))
      )}

      {decisions.length > 0 && (
        <>
          <ListSection>
            <span>Decisions</span>
          </ListSection>
          {decisions.slice(0, 20).map((d) => (
            <ListItem key={d.id} title={d.summary ? `${d.from}: “${d.text}”` : undefined}>
              <span className="text-[12.5px] leading-[1.45] text-ink">{d.summary ?? `“${d.text}”`}</span>
              <ListMeta>
                {d.from}
                {d.agentName ? ` → ${d.agentName}` : ''} · {timeAgo(d.at)}
              </ListMeta>
            </ListItem>
          ))}
        </>
      )}

      {openRef !== null && (
        <RefModal
          canvasId={canvasId}
          reference={references.find((r) => r.id === openRef) ?? null}
          onClose={() => setOpenRef(null)}
        />
      )}
    </PanelBody>
  )
}

/** Live thumbnail of a pinned reference: its snapshotted HTML, scaled down. */
function RefThumb({ reference }: { reference: MemoryReference }) {
  const w = 264 // panel content width
  const scale = w / reference.width
  const html = prepareFrameHtml(reference.html, useThemeCss(), useComponentDefs(), useUtilityCss())
  return (
    <span
      className="block w-full overflow-hidden rounded-[8px] border border-line bg-white"
      style={{ height: Math.min(reference.height * scale, 150) }}
    >
      <iframe
        className="pointer-events-none origin-top-left border-0"
        title={reference.title}
        srcDoc={html}
        sandbox="allow-scripts"
        tabIndex={-1}
        style={{ width: reference.width, height: reference.height, transform: `scale(${scale})` }}
      />
    </span>
  )
}

/** One pinned reference in a modal: full-size preview + unpin. */
function RefModal({
  canvasId,
  reference,
  onClose,
}: {
  canvasId: string
  reference: MemoryReference | null
  onClose: () => void
}) {
  const themeCss = useThemeCss()
  const componentDefs = useComponentDefs()
  const utilityCss = useUtilityCss()
  if (!reference) {
    return (
      <Modal size="xl" onClose={onClose}>
        <ModalTitle className="sr-only">Reference</ModalTitle>
        <ModalLede>This reference is no longer pinned.</ModalLede>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </ModalActions>
      </Modal>
    )
  }
  const w = Math.min(696, window.innerWidth - 110)
  const scale = Math.min(1, w / reference.width)
  const html = prepareFrameHtml(reference.html, themeCss, componentDefs, utilityCss)
  return (
    <Modal size="xl" onClose={onClose}>
      <>
        <div className={modalHead}>
          <ModalTitle>{reference.title}</ModalTitle>
          <Badge tone="outline" className="rounded-full px-2 py-px">
            {Math.round(reference.width)}×{Math.round(reference.height)}
          </Badge>
        </div>
        <div className={meta}>
          pinned by {reference.pinnedBy} · {new Date(reference.pinnedAt).toLocaleString()} — agents copy this design’s
          colors, type and layout in new work
        </div>
        <div
          className="mt-3.5 overflow-auto rounded-[12px] border border-line bg-white"
          style={{ height: Math.min(reference.height * scale, window.innerHeight * 0.55) }}
        >
          <iframe
            className="pointer-events-none origin-top-left border-0"
            title={reference.title}
            srcDoc={html}
            sandbox="allow-scripts"
            tabIndex={-1}
            style={{ width: reference.width, height: reference.height, transform: `scale(${scale})` }}
          />
        </div>
        <ModalActions>
          <Button
            variant="ghost"
            onClick={() => {
              api.unpinReference(canvasId, reference.id).catch(console.error)
              onClose()
            }}
          >
            Unpin
          </Button>
          <ModalSpacer />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}
