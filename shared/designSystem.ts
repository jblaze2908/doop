import { componentsStamp, liveComponents, type ComponentDef } from './components.ts'
import type { CanvasTheme } from './theme.ts'
import type { GuidelineDoc } from './types.ts'

/**
 * Design systems shared across canvases (.context/specs/design-systems.md).
 * A published version is a snapshot of the source canvas's design; a canvas
 * that uses it layers its own theme, components and guidelines on top.
 */

export interface DesignSnapshot {
  theme?: CanvasTheme
  components: ComponentDef[]
  guidelines: GuidelineDoc[]
}

export interface DesignSystemMeta {
  id: string
  name: string
  sourceCanvasId: string
  workspaceId?: string
  ownerId: string
  /** 0 = never published */
  publishedVersion: number
  /** the source's draftStamp at the last publish */
  publishedStamp?: string
  publishedAt?: number
  publishedBy?: string
  createdAt: number
  updatedAt: number
}

/** One published version, as the history lists it (the snapshot loads on demand). */
export interface DesignSystemVersion {
  systemId: string
  version: number
  note?: string
  publishedAt: number
  publishedBy: string
}

/** What a consuming canvas renders from: the system, the version it is on, and that version's snapshot. */
export interface CanvasSystemLink {
  system: DesignSystemMeta
  version: number
  /** true when the canvas pinned `version` instead of following the latest publish */
  pinned: boolean
  snapshot: DesignSnapshot
}

export interface DesignLayer {
  theme?: CanvasTheme
  components?: ComponentDef[]
  guidelines?: GuidelineDoc[]
}

/** Changes whenever the source canvas's design does; compared with publishedStamp for "draft has changes". */
export function draftStamp(source: DesignLayer): string {
  const docs = source.guidelines ?? []
  const docsAt = docs.length ? Math.max(...docs.map((d) => d.updatedAt)) : 0
  return `${source.theme?.version ?? 0}:${componentsStamp(source.components)}:${docs.length}.${docsAt}`
}

/** The snapshot a publish stores: tombstones dropped, guideline card positions kept. */
export function snapshotOf(source: DesignLayer): DesignSnapshot {
  return {
    ...(source.theme ? { theme: source.theme } : {}),
    components: liveComponents(source.components),
    guidelines: source.guidelines ?? [],
  }
}

const mergedThemes = new WeakMap<CanvasTheme, WeakMap<CanvasTheme, CanvasTheme>>()

/** System theme under the local one: tokens by name (local value wins, system
 *  order kept), fonts unioned, font faces and CSS system-first so local CSS
 *  wins the cascade. Memoized per object pair, so compileTheme's own
 *  per-object memo keeps working. */
export function mergeTheme(system: CanvasTheme | undefined, local: CanvasTheme | undefined): CanvasTheme | undefined {
  if (!system) return local
  if (!local) return system
  let byLocal = mergedThemes.get(system)
  if (!byLocal) mergedThemes.set(system, (byLocal = new WeakMap()))
  let merged = byLocal.get(local)
  if (!merged) {
    const localTokens = new Map(local.tokens.map((t) => [t.name, t]))
    const tokens = system.tokens.map((t) => localTokens.get(t.name) ?? t)
    const systemNames = new Set(system.tokens.map((t) => t.name))
    for (const t of local.tokens) if (!systemNames.has(t.name)) tokens.push(t)
    const unresolved = [...new Set([...(system.unresolvedFonts ?? []), ...(local.unresolvedFonts ?? [])])]
    const utilities = local.utilities ?? system.utilities
    merged = {
      tokens,
      css: [system.css, local.css].filter(Boolean).join('\n'),
      fonts: [...new Set([...system.fonts, ...local.fonts])],
      fontFaces: [system.fontFaces, local.fontFaces].filter(Boolean).join('\n'),
      ...(unresolved.length ? { unresolvedFonts: unresolved } : {}),
      ...(utilities ? { utilities } : {}),
      version: local.version,
      updatedAt: Math.max(system.updatedAt, local.updatedAt),
      updatedBy: local.updatedBy,
    }
    byLocal.set(local, merged)
  }
  return merged
}

const EMPTY: ComponentDef[] = []
const mergedComponents = new WeakMap<readonly ComponentDef[], WeakMap<readonly ComponentDef[], ComponentDef[]>>()

/** System definitions under the local ones, sorted by name. A live local
 *  definition wins; a local tombstone does not hide the system's. */
export function mergeComponents(
  system: readonly ComponentDef[] | undefined,
  local: readonly ComponentDef[] | undefined,
): ComponentDef[] {
  if (!system?.length) return (local as ComponentDef[] | undefined) ?? EMPTY
  const own = local ?? EMPTY
  let byLocal = mergedComponents.get(system)
  if (!byLocal) mergedComponents.set(system, (byLocal = new WeakMap()))
  let merged = byLocal.get(own)
  if (!merged) {
    const byName = new Map(system.map((d) => [d.name, d]))
    for (const d of own) if (!d.deletedAt || !byName.has(d.name)) byName.set(d.name, d)
    merged = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    byLocal.set(own, merged)
  }
  return merged
}

/** System guideline docs under the local ones, by name. Cheap enough to run per call: a handful of docs. */
export function mergeGuidelines(
  system: readonly GuidelineDoc[] | undefined,
  local: readonly GuidelineDoc[] | undefined,
): GuidelineDoc[] {
  if (!system?.length) return (local as GuidelineDoc[] | undefined) ?? []
  const names = new Set((local ?? []).map((d) => d.name))
  return [...system.filter((d) => !names.has(d.name)), ...(local ?? [])]
}

export type DesignOrigin = 'system' | 'override' | 'local'

/** Where an effective token, component or guide comes from, for the UI: the
 *  system alone, a local override of it, or the canvas alone. */
export function originOf(
  name: string,
  system: readonly { name: string }[] | undefined,
  local: readonly { name: string; deletedAt?: number }[] | undefined,
): DesignOrigin {
  const own = !!local?.some((d) => d.name === name && !d.deletedAt)
  const inSystem = !!system?.some((d) => d.name === name)
  return own ? (inSystem ? 'override' : 'local') : 'system'
}

/** Render-cache key for a canvas's effective design; never theme.version alone, since two systems can share one. */
export function designKey(link: CanvasSystemLink | undefined, local: DesignLayer): string {
  const own = `${local.theme?.version ?? 0}.${componentsStamp(local.components)}`
  return link ? `${link.system.id}@${link.version}|${own}` : own
}
