import { nanoid } from 'nanoid'
import * as persist from './db/persist.ts'
import { store } from './store.ts'
import * as workspaces from './workspaces.ts'
import type { ComponentDef } from '../shared/components.ts'
import {
  designKey,
  draftStamp,
  mergeComponents,
  mergeGuidelines,
  mergeTheme,
  snapshotOf,
  type CanvasSystemLink,
  type DesignSnapshot,
  type DesignSystemMeta,
} from '../shared/designSystem.ts'
import type { CanvasTheme } from '../shared/theme.ts'
import type { Canvas, GuidelineDoc, ServerMessage } from '../shared/types.ts'

/**
 * Design systems shared across canvases (.context/specs/design-systems.md).
 * Memory holds every system's meta plus the snapshots some canvas renders
 * (each system's latest, and any pinned version); history loads on demand.
 */

const systems = new Map<string, DesignSystemMeta>()
const bySource = new Map<string, string>() // source canvas id -> system id
const snapshots = new Map<string, Map<number, DesignSnapshot>>()

let broadcast: (canvasId: string, msg: ServerMessage) => void = () => {}
export function wireDesignSystems(send: typeof broadcast) {
  broadcast = send
}

function put(s: DesignSystemMeta) {
  systems.set(s.id, s)
  bySource.set(s.sourceCanvasId, s.id)
}

function cacheSnapshot(systemId: string, version: number, snap: DesignSnapshot) {
  let m = snapshots.get(systemId)
  if (!m) snapshots.set(systemId, (m = new Map()))
  m.set(version, snap)
}

async function ensureSnapshot(systemId: string, version: number): Promise<DesignSnapshot | undefined> {
  const hit = snapshots.get(systemId)?.get(version)
  if (hit) return hit
  const snap = await persist.loadDesignSystemSnapshot(systemId, version)
  if (snap) cacheSnapshot(systemId, version, snap)
  return snap
}

/** Boot, after store.init: every system, plus the snapshots canvases render. */
export async function hydrateDesignSystems() {
  for (const s of await persist.hydrateDesignSystems()) put(s)
  const need = new Set<string>()
  for (const s of systems.values()) if (s.publishedVersion) need.add(`${s.id}@${s.publishedVersion}`)
  for (const c of store.canvases.values()) {
    if (c.designSystemId && c.designSystemPin) need.add(`${c.designSystemId}@${c.designSystemPin}`)
  }
  await Promise.all(
    [...need].map((k) => {
      const [id = '', v = '0'] = k.split('@')
      return ensureSnapshot(id, Number(v))
    }),
  )
}

export const getSystem = (id: string) => systems.get(id)
export const systemOfSource = (canvasId: string) => {
  const id = bySource.get(canvasId)
  return id ? systems.get(id) : undefined
}

export function canSeeSystem(userId: string | undefined, s: DesignSystemMeta): boolean {
  if (!userId) return false
  return s.ownerId === userId || (!!s.workspaceId && workspaces.isWorkspaceMember(s.workspaceId, userId))
}

/** Publishing (and renaming, deleting) is the owner's or a workspace admin's. */
export function canPublish(userId: string | undefined, s: DesignSystemMeta): boolean {
  if (!userId) return false
  return s.ownerId === userId || (!!s.workspaceId && workspaces.hasRole(s.workspaceId, userId, 'admin'))
}

export function listSystems(userId: string | undefined): DesignSystemMeta[] {
  return [...systems.values()].filter((s) => canSeeSystem(userId, s)).sort((a, b) => a.name.localeCompare(b.name))
}

export function consumersOf(systemId: string): Canvas[] {
  return [...store.canvases.values()].filter((c) => c.designSystemId === systemId)
}

const links = new WeakMap<DesignSystemMeta, Map<string, CanvasSystemLink>>()

/** The version a canvas renders, or undefined (no system, or its snapshot is not loaded). Stable per meta object. */
export function linkFor(c: Canvas | undefined): CanvasSystemLink | undefined {
  const s = c?.designSystemId ? systems.get(c.designSystemId) : undefined
  if (!c || !s) return undefined
  const pinned = c.designSystemPin !== undefined
  const version = c.designSystemPin ?? s.publishedVersion
  const snapshot = snapshots.get(s.id)?.get(version)
  if (!snapshot) return undefined
  let byKey = links.get(s)
  if (!byKey) links.set(s, (byKey = new Map()))
  const key = `${version}:${pinned}`
  let link = byKey.get(key)
  if (!link) byKey.set(key, (link = { system: s, version, pinned, snapshot }))
  return link
}

export interface EffectiveDesign {
  theme?: CanvasTheme
  components: ComponentDef[]
  guidelines: GuidelineDoc[]
  /** render-cache key: changes with the system version and the local layer */
  key: string
  link?: CanvasSystemLink
}

/** What a canvas renders: its system's snapshot under its own layer. Per render; the merges are memoized. */
export function designOf(c: Canvas | undefined): EffectiveDesign {
  if (!c) return { components: [], guidelines: [], key: '0' }
  const link = linkFor(c)
  const snap = link?.snapshot
  return {
    theme: mergeTheme(snap?.theme, c.theme),
    components: mergeComponents(snap?.components, c.components),
    guidelines: mergeGuidelines(snap?.guidelines, c.guidelines),
    key: designKey(link, c),
    ...(link ? { link } : {}),
  }
}

export const designOfCanvas = (canvasId: string) => designOf(store.getCanvas(canvasId))

/** The canvas as consumers that take a Canvas (code export) should see it: effective theme and components. */
export function effectiveCanvas(c: Canvas): Canvas {
  const d = designOf(c)
  return d.link ? { ...c, ...(d.theme ? { theme: d.theme } : {}), components: d.components } : c
}

export type SystemResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }
const fail = (status: number, error: string) => ({ ok: false, status, error }) as const

/** Make a canvas the source of a new system: its theme, components and guidelines become the draft. */
export function createSystem(canvas: Canvas, name: string, userId: string): SystemResult<DesignSystemMeta> {
  const trimmed = name.trim().slice(0, 80)
  if (!trimmed) return fail(400, 'name is required')
  if (bySource.has(canvas.id)) return fail(409, 'this canvas is already the source of a design system')
  if (canvas.designSystemId) return fail(409, 'a canvas that uses a design system cannot be the source of one')
  const now = Date.now()
  const s: DesignSystemMeta = {
    id: nanoid(10),
    name: trimmed,
    sourceCanvasId: canvas.id,
    ...(canvas.workspaceId ? { workspaceId: canvas.workspaceId } : {}),
    ownerId: userId,
    publishedVersion: 0,
    createdAt: now,
    updatedAt: now,
  }
  put(s)
  persist.saveDesignSystem(s)
  broadcast(canvas.id, { type: 'system:source', system: s })
  return { ok: true, value: s }
}

/** Publish the source canvas's design as the next version (or republish an old
 *  one: rollback). Every canvas following the system updates live. Cost: one
 *  durable snapshot write, then a broadcast and a store touch per follower. */
export async function publish(
  systemId: string,
  by: string,
  opts: { note?: string; fromVersion?: number } = {},
): Promise<SystemResult<DesignSystemMeta>> {
  const s = systems.get(systemId)
  if (!s) return fail(404, 'no such design system')
  const source = store.getCanvas(s.sourceCanvasId)
  if (!source) return fail(409, 'the source canvas no longer exists')
  let snapshot: DesignSnapshot | undefined
  if (opts.fromVersion !== undefined) {
    snapshot = await ensureSnapshot(s.id, opts.fromVersion)
    if (!snapshot) return fail(404, `version ${opts.fromVersion} does not exist`)
  } else snapshot = snapshotOf(source)
  const version = s.publishedVersion + 1
  const now = Date.now()
  const note = opts.note?.trim().slice(0, 280) || (opts.fromVersion ? `Restored version ${opts.fromVersion}` : '')
  await persist.saveDesignSystemVersion({
    systemId: s.id,
    version,
    snapshot,
    ...(note ? { note } : {}),
    publishedAt: now,
    publishedBy: by,
  })
  const next: DesignSystemMeta = {
    ...s,
    publishedVersion: version,
    /* a restore publishes something other than the draft, so the draft still counts as changed */
    publishedStamp: opts.fromVersion ? `restored:${opts.fromVersion}` : draftStamp(source),
    publishedAt: now,
    publishedBy: by,
    updatedAt: now,
  }
  put(next)
  cacheSnapshot(s.id, version, snapshot)
  forgetUnused(s.id)
  persist.saveDesignSystem(next)
  broadcast(s.sourceCanvasId, { type: 'system:source', system: next })
  for (const c of consumersOf(s.id)) if (c.designSystemPin === undefined) notify(c)
  return { ok: true, value: next }
}

/* keep only the versions a canvas renders */
function forgetUnused(systemId: string) {
  const s = systems.get(systemId)
  const m = snapshots.get(systemId)
  if (!s || !m) return
  const used = new Set([s.publishedVersion])
  for (const c of consumersOf(systemId)) if (c.designSystemPin !== undefined) used.add(c.designSystemPin)
  for (const v of m.keys()) if (!used.has(v)) m.delete(v)
}

function notify(c: Canvas) {
  broadcast(c.id, { type: 'system', link: linkFor(c) ?? null })
  store.touch(c.id)
}

/** Point a canvas at a system (systemId null = stop using one). pin: a
 *  published version to stay on; null = follow the latest. Access is the caller's. */
export async function useSystem(
  canvas: Canvas,
  systemId: string | null,
  pin: number | null = null,
): Promise<SystemResult<CanvasSystemLink | null>> {
  if (systemId === null) {
    const from = canvas.designSystemId
    store.setDesignSystem(canvas.id, undefined, undefined)
    if (from) forgetUnused(from)
    notify(canvas)
    return { ok: true, value: null }
  }
  const s = systems.get(systemId)
  if (!s) return fail(404, 'no such design system')
  if (bySource.has(canvas.id)) return fail(409, 'a design system source canvas cannot use a design system')
  if (!s.publishedVersion)
    return fail(409, `“${s.name}” has not been published yet — publish it from its source canvas first`)
  if (pin !== null && (!Number.isInteger(pin) || pin < 1 || pin > s.publishedVersion)) {
    return fail(400, `pin must be a published version, 1–${s.publishedVersion}`)
  }
  if (!(await ensureSnapshot(s.id, pin ?? s.publishedVersion))) return fail(404, `version ${pin} does not exist`)
  const from = canvas.designSystemId
  store.setDesignSystem(canvas.id, s.id, pin ?? undefined)
  if (from && from !== s.id) forgetUnused(from)
  forgetUnused(s.id)
  notify(canvas)
  return { ok: true, value: linkFor(canvas) ?? null }
}

/** A source canvas cannot go while canvases use its system; with none, the system goes with it. */
export function beforeCanvasDelete(canvasId: string): string | undefined {
  const s = systemOfSource(canvasId)
  if (!s) return undefined
  const n = consumersOf(s.id).length
  if (n)
    return `This canvas is the source of the design system “${s.name}”, which ${n} canvas${n === 1 ? '' : 'es'} use. Switch them to another system first.`
  systems.delete(s.id)
  bySource.delete(canvasId)
  snapshots.delete(s.id)
  persist.deleteDesignSystem(s.id)
  return undefined
}

export const listVersions = (systemId: string) => persist.listDesignSystemVersions(systemId)

/** For the source canvas's panel: the system and whether its draft differs from the last publish. */
export function sourceStatus(canvasId: string): (DesignSystemMeta & { draftChanged: boolean }) | undefined {
  const s = systemOfSource(canvasId)
  const c = store.getCanvas(canvasId)
  if (!s || !c) return undefined
  return { ...s, draftChanged: s.publishedStamp !== draftStamp(c) }
}
