import * as actions from './actions.ts'
import type { ThemePatch } from './actions.ts'
import * as designSystems from './designSystems.ts'
import { store } from './store.ts'
import { forgetCanvas } from './utilities.ts'
import * as workspaces from './workspaces.ts'
import {
  mergeComponents,
  mergeGuidelines,
  mergeTheme,
  snapshotOf,
  type CanvasSystemLink,
  type DesignSnapshot,
  type DesignSystemMeta,
} from '../shared/designSystem.ts'
import type { Actor, Canvas } from '../shared/types.ts'

/**
 * Design-system operations that also rewrite a canvas's own layer
 * (.context/specs/design-systems.md, Lifecycle). Kept apart from
 * designSystems.ts, which actions.ts imports, so the registry never needs actions.
 */

type Result<T> = designSystems.SystemResult<T>
const fail = (status: number, error: string) => ({ ok: false, status, error }) as const

/** What a canvas renders from its link, as one layer of its own. */
function flattened(c: Canvas, link: CanvasSystemLink): DesignSnapshot {
  const theme = mergeTheme(link.snapshot.theme, c.theme)
  return {
    ...(theme ? { theme } : {}),
    components: mergeComponents(link.snapshot.components, c.components),
    guidelines: mergeGuidelines(link.snapshot.guidelines, c.guidelines),
  }
}

/** A new system whose draft is a new hidden canvas in the given scope (a kit theme, or Tailwind on). */
export async function createDesignSystem(
  name: string,
  userId: string,
  actor: Actor,
  opts: { workspaceId?: string; theme?: ThemePatch } = {},
): Promise<Result<{ system: DesignSystemMeta; sourceCanvasId: string }>> {
  const trimmed = name.trim().slice(0, 80)
  if (!trimmed) return fail(400, 'name is required')
  const source = store.createCanvas(trimmed, userId, opts.workspaceId)
  const r = designSystems.createSystem(source, trimmed, userId)
  if (!r.ok) {
    actions.deleteCanvas(source.id)
    return r
  }
  await actions.setTheme(source.id, opts.theme ?? { utilities: 'tailwind' }, actor)
  return { ok: true, value: { system: r.value, sourceCanvasId: source.id } }
}

/** Extract a canvas's design into a new system published as v1, and put the
 *  canvas on it with its own layer cleared: it renders the same and stays a canvas. */
export async function extractDesignSystem(
  canvas: Canvas,
  name: string,
  userId: string,
  actor: Actor,
): Promise<Result<DesignSystemMeta>> {
  const trimmed = name.trim().slice(0, 80)
  if (!trimmed) return fail(400, 'name is required')
  if (designSystems.systemOfSource(canvas.id)) return fail(409, 'this canvas is already a design system’s draft')
  const using = canvas.designSystemId ? designSystems.getSystem(canvas.designSystemId) : undefined
  if (using) return fail(409, `this canvas uses “${using.name}” — stop using it before making a system from it`)

  const source = store.createCanvas(trimmed, userId, canvas.workspaceId)
  const created = designSystems.createSystem(source, trimmed, userId)
  if (!created.ok) {
    actions.deleteCanvas(source.id)
    return created
  }
  actions.setDesignLayer(source.id, snapshotOf(canvas), actor, `started the design system from “${canvas.name}”`)
  const published = await designSystems.publish(created.value.id, actor.name, { note: `From “${canvas.name}”` })
  if (!published.ok) return published
  const linked = await designSystems.useSystem(canvas, created.value.id)
  if (!linked.ok) return linked
  actions.setDesignLayer(
    canvas.id,
    { components: [], guidelines: [] },
    actor,
    `moved its theme, components and rules into the design system “${trimmed}”`,
  )
  return published
}

/** Stop using a system. keepCopy (the default) first flattens the version the
 *  canvas rendered into its own layer, so its frames keep rendering. */
export async function stopUsing(canvas: Canvas, actor: Actor, keepCopy = true): Promise<Result<null>> {
  const link = designSystems.linkFor(canvas)
  if (keepCopy && link)
    actions.setDesignLayer(
      canvas.id,
      flattened(canvas, link),
      actor,
      `stopped using the design system “${link.system.name}” and kept a copy of its design`,
    )
  const r = await designSystems.useSystem(canvas, null)
  return r.ok ? { ok: true, value: null } : r
}

/** After a canvas moved: a system outside its new scope detaches with a copy. Returns that system's name. */
export async function afterMove(canvas: Canvas, actor: Actor): Promise<string | undefined> {
  const s = canvas.designSystemId ? designSystems.getSystem(canvas.designSystemId) : undefined
  if (!s || designSystems.inScope(s, canvas)) return undefined
  await stopUsing(canvas, actor)
  return s.name
}

/** A new canvas in a workspace starts on the workspace's default system. */
export async function applyDefault(canvas: Canvas): Promise<DesignSystemMeta | undefined> {
  const s = designSystems.defaultSystemFor(canvas.workspaceId)
  if (s) await designSystems.useSystem(canvas, s.id)
  return s
}

/** A duplicate keeps the source's system when it lands in the same scope; otherwise it gets a flattened copy. */
export async function carryLink(source: Canvas, copy: Canvas, actor: Actor) {
  const link = designSystems.linkFor(source)
  if (!link) return
  if (designSystems.inScope(link.system, copy))
    await designSystems.useSystem(copy, link.system.id, link.pinned ? link.version : null)
  else actions.setDesignLayer(copy.id, flattened(source, link), actor, `copied the design of “${link.system.name}”`)
}

export function renameDesignSystem(systemId: string, name: string, actor: Actor): Result<DesignSystemMeta> {
  const r = designSystems.renameSystem(systemId, name)
  if (r.ok) actions.renameCanvas(r.value.sourceCanvasId, r.value.name, actor)
  return r
}

/** Delete an unused system together with its draft canvas. */
export function deleteDesignSystem(systemId: string): Result<null> {
  const r = designSystems.deleteSystem(systemId)
  if (!r.ok) return r
  actions.deleteCanvas(r.value)
  forgetCanvas(r.value)
  return { ok: true, value: null }
}

/* A deleted workspace's systems went personal; their consumers owned by anyone else detach with a copy. */
workspaces.onWorkspaceDeleted((workspaceId) => {
  const actor = actions.resolveActor({ name: 'Draft', kind: 'user' })
  for (const s of designSystems.workspaceGone(workspaceId)) {
    for (const c of designSystems.consumersOf(s.id)) {
      if (!designSystems.inScope(s, c))
        stopUsing(c, actor).catch((e) => console.error('[design-systems] detach failed', c.id, e))
    }
  }
})

/** The systems a user may put this canvas on. */
export function usableFor(userId: string, c: Canvas): DesignSystemMeta[] {
  return designSystems.listSystems(userId).filter((s) => s.publishedVersion > 0 && designSystems.inScope(s, c))
}
