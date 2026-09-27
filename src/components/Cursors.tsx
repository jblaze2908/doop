import { memo, useLayoutEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../lib/store'
import { getIdentity } from '../lib/identity'
import { AgentIcon } from './AgentIcon'

type Pos = { x: number; y: number }
const place = (el: HTMLDivElement | null, pos: Pos | undefined) => {
  if (el && pos) el.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(calc(1 / var(--zoom, 1)))`
}

/* React renders who has a cursor; where it is goes straight to the DOM, so a
   peer's 20 Hz cursor stream costs no render at all. */
export const Cursors = memo(function Cursors() {
  const me = getIdentity().clientId
  const ids = useStore(useShallow((s) => Object.keys(s.cursors).filter((id) => id !== me && s.presences[id])))
  return (
    <>
      {ids.map((id) => (
        <Cursor key={id} clientId={id} />
      ))}
    </>
  )
})

const Cursor = memo(function Cursor({ clientId }: { clientId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const p = useStore((s) => s.presences[clientId])
  useLayoutEffect(() => {
    place(ref.current, useStore.getState().cursors[clientId])
    return useStore.subscribe((s, prev) => {
      const pos = s.cursors[clientId]
      if (pos !== prev.cursors[clientId]) place(ref.current, pos)
    })
  }, [clientId])
  if (!p) return null
  return (
    <div ref={ref} className="pointer-events-none absolute z-30 origin-top-left [transition:transform_0.06s_linear]">
      <svg width="18" height="20" viewBox="0 0 18 20">
        <path
          d="M1 1 L16 8.5 L9 10.5 L6.5 18 Z"
          fill={p.color}
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="absolute left-3.5 top-4 whitespace-nowrap rounded-[999px_999px_999px_4px] px-2 py-[3px] text-[11px] font-bold text-white"
        style={{ background: p.color }}
      >
        {p.kind === 'agent' && (
          <>
            <AgentIcon name={p.name} size={9} color="#fff" />{' '}
          </>
        )}
        {p.name}
      </span>
    </div>
  )
})
