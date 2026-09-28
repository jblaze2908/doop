import type { WebSocket } from 'ws'
import { store } from './store.ts'
import * as workspaces from './workspaces.ts'
import type { ActivityItem, Canvas, CanvasMeta, ServerMessage } from '../shared/types.ts'

/**
 * Live dashboards. A signed-in user on a home page holds a socket here; every
 * change a dashboard row shows reaches every user who can list that canvas.
 * Rows are coalesced: a streaming agent touches a canvas per chunk, a
 * dashboard needs it about once a second.
 */

type Send = (ws: WebSocket, msg: ServerMessage) => void
type Row = (canvas: Canvas, viewerId: string) => CanvasMeta

const homes = new Map<string, Set<WebSocket>>() // userId -> dashboard sockets
const owners = new WeakMap<WebSocket, string>()
const dirty = new Set<string>()
const MIN_GAP_MS = 500
let timer: ReturnType<typeof setTimeout> | undefined
let lastFlush = 0
let send: Send = () => {}
let row: Row = (c, viewerId) => store.toMeta(c, viewerId)

export function wireHome(sender: Send, rowFor: Row) {
  send = sender
  row = rowFor
}

export function addHome(userId: string, ws: WebSocket) {
  let set = homes.get(userId)
  if (!set) homes.set(userId, (set = new Set()))
  set.add(ws)
  owners.set(ws, userId)
}

export function dropHome(ws: WebSocket) {
  const userId = owners.get(ws)
  if (!userId) return
  const set = homes.get(userId)
  set?.delete(ws)
  if (set?.size === 0) homes.delete(userId)
}

/** The users whose dashboards list this canvas — the same rule as store.listCanvases. */
function viewersOf(c: Canvas): Set<string> {
  const ids = new Set<string>(c.memberIds)
  if (c.ownerId) ids.add(c.ownerId)
  if (c.workspaceId) for (const id of workspaces.memberIdsOf(c.workspaceId)) ids.add(id)
  return ids
}

function toUsers(userIds: Iterable<string>, msg: ServerMessage | ((userId: string) => ServerMessage)) {
  for (const userId of userIds) {
    const sockets = homes.get(userId)
    if (!sockets) continue
    const m = typeof msg === 'function' ? msg(userId) : msg
    for (const ws of sockets) send(ws, m)
  }
}

function flush() {
  timer = undefined
  lastFlush = Date.now()
  for (const id of dirty) {
    const c = store.getCanvas(id)
    if (c && !store.hiddenFromLists(id))
      toUsers(viewersOf(c), (userId) => ({ type: 'home:canvas', canvas: row(c, userId) }))
  }
  dirty.clear()
}

/** Runs on every store write that a row shows, per stream chunk included, so
 *  the no-dashboard case returns before doing anything. */
export function canvasChanged(canvasId: string) {
  if (homes.size === 0) return
  dirty.add(canvasId)
  timer ??= setTimeout(flush, Math.max(0, lastFlush + MIN_GAP_MS - Date.now()))
}

export function canvasRemoved(c: Canvas) {
  dirty.delete(c.id)
  toUsers(viewersOf(c), { type: 'home:canvas:removed', canvasId: c.id })
}

export function accessLost(canvasId: string, userIds: string[]) {
  toUsers(userIds, { type: 'home:canvas:removed', canvasId })
  canvasChanged(canvasId)
}

/** A canvas left a workspace: its old members may no longer list it. */
export function canvasMoved(canvasId: string, fromWorkspaceId: string | undefined) {
  if (fromWorkspaceId) refresh(workspaces.memberIdsOf(fromWorkspaceId))
  canvasChanged(canvasId)
}

/** Workspace or access changes a row cannot express: those dashboards refetch. */
export function refresh(userIds: Iterable<string>) {
  toUsers(userIds, { type: 'home:refresh' })
}

export function activity(canvasId: string, item: ActivityItem) {
  if (homes.size === 0) return
  const c = store.getCanvas(canvasId)
  if (c && !store.hiddenFromLists(canvasId))
    toUsers(viewersOf(c), { type: 'home:activity', item: { ...item, canvasId, canvasName: c.name } })
}

store.onChange(canvasChanged)
store.onRemoved = canvasRemoved
store.onAccessLost = accessLost
store.onMoved = canvasMoved
workspaces.onMembershipChange(refresh)
