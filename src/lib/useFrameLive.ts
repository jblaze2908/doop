import { useEffect, useState } from 'react'
import { frameById, useStore } from './store'

/* Every live frame is a whole iframe document (~7 MB of Chrome memory each,
   measured), so only frames on or near the screen keep one. */
const MARGIN = 0.75 // of a screen, around the viewport, where frames pre-mount
const UNMOUNT_AFTER_MS = 4000 // so panning back and forth doesn't rebuild documents

type State = ReturnType<typeof useStore.getState>

/** the frame's screen box against the viewport grown by `margin` screens */
function within(s: State, id: string, margin: number): boolean {
  const f = frameById(s, id)
  if (!f) return false
  const { x, y, zoom } = s.viewport
  const w = window.innerWidth
  const h = window.innerHeight
  const left = f.x * zoom + x
  const top = f.y * zoom + y
  return (
    left < w * (1 + margin) &&
    left + f.width * zoom > -w * margin &&
    top < h * (1 + margin) &&
    top + f.height * zoom > -h * margin
  )
}

/* Mounting a frame runs its bootstrap and first render on the main thread;
   frames entering the margin mount one per idle slot so a pan keeps its
   frame rate, while frames actually on screen mount at once. */
const pending = new Map<string, () => void>()
let draining = false

const idle: (cb: () => void) => void =
  typeof requestIdleCallback === 'function'
    ? (cb) => requestIdleCallback(cb, { timeout: 250 })
    : (cb) => window.setTimeout(cb, 60) // WebKit (the desktop shell) has no requestIdleCallback

function drain() {
  const id = pending.keys().next().value
  if (id === undefined) {
    draining = false
    return
  }
  const mount = pending.get(id)
  pending.delete(id)
  mount?.()
  idle(drain)
}

function cancel(id: string) {
  pending.delete(id)
}

function mountSoon(id: string, mount: () => void) {
  pending.set(id, mount)
  if (!draining) {
    draining = true
    idle(drain)
  }
}

/** Whether a frame should hold a live iframe: near the viewport, or pinned
 *  (selected, streaming, being edited or dragged). Runs per store update per
 *  frame, so it only compares numbers; a render happens only when it flips. */
export function useFrameLive(id: string, pinned: boolean): boolean {
  const [live, setLive] = useState(() => within(useStore.getState(), id, 0))
  useEffect(() => {
    let timer = 0
    const check = () => {
      const s = useStore.getState()
      if (within(s, id, MARGIN)) {
        window.clearTimeout(timer)
        timer = 0
        if (within(s, id, 0)) {
          cancel(id)
          setLive(true)
        } else {
          mountSoon(id, () => {
            if (within(useStore.getState(), id, MARGIN)) setLive(true)
          })
        }
      } else if (!timer) {
        cancel(id)
        timer = window.setTimeout(() => {
          timer = 0
          if (!within(useStore.getState(), id, MARGIN)) setLive(false)
        }, UNMOUNT_AFTER_MS)
      }
    }
    const unsub = useStore.subscribe((s, prev) => {
      if (s.viewport !== prev.viewport || s.canvas?.frames !== prev.canvas?.frames) check()
    })
    window.addEventListener('resize', check)
    return () => {
      unsub()
      window.removeEventListener('resize', check)
      window.clearTimeout(timer)
      cancel(id)
    }
  }, [id])
  return live || pinned
}
