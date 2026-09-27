import { useEffect, useMemo, useState } from 'react'
import { frameById, useStore } from '../lib/store'
import { api, type SyncFlow } from '../lib/api'
import { isSyncedFrame } from '../lib/sync'

/**
 * The information architecture of a synced app, drawn on the canvas: when a
 * design-synced frame is selected, every same-app link hotspot on it gets a
 * connector to the frame it navigates to, weighted with how often real users
 * took that path. Selection-scoped on purpose — always-on connectors would
 * turn a synced canvas into spaghetti. Purely presentational overlay in world
 * coordinates; pointer events pass through.
 */

interface Connector {
  /** hotspot outline on the source frame, world coords */
  box: { x: number; y: number; w: number; h: number }
  path: string
  label: string | null
  count: number
  /** label anchor */
  mx: number
  my: number
}

export function FlowOverlay() {
  const canvasId = useStore((s) => s.canvas?.id)
  const selectedId = useStore((s) => s.selectedId)
  const [flow, setFlow] = useState<SyncFlow | null>(null)

  const selected = useStore((s) => frameById(s, s.selectedId))
  const selectedIsSynced = !!selected && isSyncedFrame(selected.html)
  /* other frames' positions matter only while connectors are drawn */
  const frames = useStore((s) => (selectedIsSynced && flow ? s.canvas?.frames : undefined))

  /* fetch lazily, on the first selection of a synced frame (and refresh on
     later selections — sync updates land while the canvas is open) */
  useEffect(() => {
    if (!canvasId || !selectedIsSynced) return
    let stale = false
    api
      .syncFlow(canvasId)
      .then((f) => !stale && setFlow(f))
      .catch(() => !stale && setFlow(null))
    return () => {
      stale = true
    }
  }, [canvasId, selectedId, selectedIsSynced])

  const connectors = useMemo<Connector[]>(() => {
    if (!frames || !selected || !selectedIsSynced || !flow) return []
    const byId = new Map(frames.map((f) => [f.id, f]))
    const countFor = new Map(flow.edges.filter((e) => e.fromFrameId === selected.id).map((e) => [e.toFrameId, e.count]))
    const out: Connector[] = []
    for (const link of flow.links) {
      if (link.fromFrameId !== selected.id) continue
      const target = byId.get(link.toFrameId)
      if (!target || target.id === selected.id) continue
      /* hotspot coordinates are in the snapshot's own pixels; clamp into the
         frame so a since-resized frame degrades gracefully */
      const bx = selected.x + Math.min(link.x, selected.width - 8)
      const by = selected.y + Math.min(link.y, selected.height - 8)
      const bw = Math.min(link.width, selected.width - (bx - selected.x))
      const bh = Math.min(link.height, selected.height - (by - selected.y))
      const targetLeft = target.x + target.width / 2 >= bx
      const sx = targetLeft ? bx + bw : bx
      const sy = by + bh / 2
      const tx = targetLeft ? target.x : target.x + target.width
      const ty = target.y + Math.min(120, target.height / 2)
      const bend = Math.max(60, Math.abs(tx - sx) / 3) * (targetLeft ? 1 : -1)
      out.push({
        box: { x: bx, y: by, w: bw, h: bh },
        path: `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`,
        label: link.label,
        count: countFor.get(target.id) ?? 0,
        mx: (sx + tx) / 2,
        my: (sy + ty) / 2 - 10,
      })
    }
    return out
  }, [frames, selected, selectedIsSynced, flow])

  if (!connectors.length) return null

  /* one SVG spanning everything it draws, placed in world space */
  const pad = 80
  const xs = connectors.flatMap((c) => [c.box.x, c.box.x + c.box.w, c.mx])
  const ys = connectors.flatMap((c) => [c.box.y, c.box.y + c.box.h, c.my])
  for (const f of frames ?? []) {
    xs.push(f.x, f.x + f.width)
    ys.push(f.y, f.y + f.height)
  }
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  const w = Math.max(...xs) - minX + pad * 2
  const h = Math.max(...ys) - minY + pad * 2

  return (
    <svg
      /* pointer events pass through: this is a read-only overlay above the
         frames (z-6) that must never intercept a drag or a right-click */
      className="pointer-events-none absolute z-[6] overflow-visible text-accent-ink"
      style={{ left: minX, top: minY, width: w, height: h }}
      viewBox={`${minX} ${minY} ${w} ${h}`}
    >
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </marker>
      </defs>
      {connectors.map((c, i) => (
        <g key={i}>
          <rect
            x={c.box.x}
            y={c.box.y}
            width={c.box.w}
            height={c.box.h}
            rx={4}
            className="fill-brand/[0.08] stroke-current [stroke-dasharray:4_3] [stroke-width:1.5]"
          />
          <path
            d={c.path}
            className="fill-none stroke-current opacity-75 [stroke-width:2]"
            markerEnd="url(#flow-arrow)"
          />
          {c.count > 0 && (
            <text
              x={c.mx}
              y={c.my}
              className="fill-current text-[13px] font-semibold [paint-order:stroke] [stroke-width:4] stroke-surface"
              textAnchor="middle"
            >
              {c.count}×
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}
