import { useEffect, useRef } from 'react'
import type { CanvasMeta, HomeActivity, ServerMessage } from '../../shared/types'

/* A dashboard's live channel (server/homeFeed.ts): rows for every canvas the
   user can list, pushed as they change. One socket per mounted page. */
export interface HomeFeedHandlers {
  canvas?: (canvas: CanvasMeta) => void
  removed?: (canvasId: string) => void
  /** lists need a refetch: an access or workspace change, or a reconnect that may have missed events */
  refresh?: () => void
  activity?: (item: HomeActivity) => void
}

export function useHomeFeed(handlers: HomeFeedHandlers) {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    let socket: WebSocket | null = null
    let retry: number | undefined
    let attempt = 0
    let dropped = false
    let stopped = false

    function open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const s = new WebSocket(`${proto}://${location.host}/ws`)
      socket = s
      s.onopen = () => {
        attempt = 0
        s.send(JSON.stringify({ type: 'home' }))
        if (dropped) latest.current.refresh?.()
      }
      s.onmessage = (ev) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        const h = latest.current
        if (msg.type === 'home:canvas') h.canvas?.(msg.canvas)
        else if (msg.type === 'home:canvas:removed') h.removed?.(msg.canvasId)
        else if (msg.type === 'home:refresh') h.refresh?.()
        else if (msg.type === 'home:activity') h.activity?.(msg.item)
      }
      s.onclose = (ev) => {
        /* signed out: the page's own auth handling takes over, no retry loop */
        if (stopped || ev.code === 4401) return
        dropped = true
        retry = window.setTimeout(open, Math.min(30_000, 500 * 2 ** attempt++))
      }
    }

    open()
    return () => {
      stopped = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [])
}
