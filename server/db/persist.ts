import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from './index.ts'
import * as t from './schema.ts'
import { extractAssetIds } from '../assets.ts'
import { isCanvasTheme, type CanvasTheme } from '../../shared/theme.ts'
import type { ComponentDef } from '../../shared/components.ts'
import type {
  ActivityItem,
  AgentTask,
  Canvas,
  DesignDecision,
  ElementComment,
  Frame,
  GuidelineDoc,
  MemoryReference,
  TaskFeedback,
} from '../../shared/types.ts'

/**
 * Write-through persistence: the in-memory maps stay the source of truth and
 * the hot path; every committed mutation is mirrored here asynchronously.
 * Nothing on the live path (presence, cursors, reveal ticks) awaits the DB.
 */

function swallow(p: Promise<unknown>) {
  p.catch((err) => console.error('[db] write failed', err))
}

/** every mutable canvas column, so insert and upsert can't drift apart.
 *  Not the theme: saveCanvas runs on every frame edit, and the theme (up to
 *  ~180 KB of jsonb) changes rarely — it has its own write below. */
function canvasColumns(c: Canvas) {
  return {
    name: c.name,
    ownerId: c.ownerId ?? null,
    linkAccess: c.linkAccess ?? null,
    workspaceId: c.workspaceId ?? null,
    updatedAt: c.updatedAt,
  }
}

export function saveCanvas(c: Canvas) {
  swallow(
    db
      .insert(t.canvases)
      .values({ id: c.id, ...canvasColumns(c), createdAt: c.createdAt })
      .onConflictDoUpdate({ target: t.canvases.id, set: canvasColumns(c) }),
  )
}

const canvasTimers = new Map<string, { canvas: Canvas; timer: ReturnType<typeof setTimeout> }>()

/** saveCanvas for the frame-edit hot path: every streamed chunk bumps the
 *  canvas's updatedAt, so the upsert is coalesced like frame writes are. */
export function saveCanvasSoon(c: Canvas) {
  const pending = canvasTimers.get(c.id)
  if (pending) clearTimeout(pending.timer)
  canvasTimers.set(c.id, {
    canvas: c,
    timer: setTimeout(() => {
      canvasTimers.delete(c.id)
      saveCanvas(c)
    }, FRAME_DEBOUNCE_MS),
  })
}

export function saveCanvasTheme(canvasId: string, theme: CanvasTheme) {
  swallow(db.update(t.canvases).set({ theme }).where(eq(t.canvases.id, canvasId)))
}

/** Persist a newly duplicated canvas as one unit. Unlike ordinary live edits,
 * duplication must not report success until every copied row is durable. */
export async function saveCanvasCopy(c: Canvas): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(t.canvases)
      .values({ id: c.id, ...canvasColumns(c), theme: c.theme ?? null, createdAt: c.createdAt })

    if (c.frames.length) {
      await tx.insert(t.frames).values(
        c.frames.map((frame) => ({
          id: frame.id,
          canvasId: frame.canvasId,
          name: frame.name,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          html: frame.html,
          createdAt: frame.createdAt,
          updatedAt: frame.updatedAt,
          updatedBy: frame.updatedBy,
          demo: frame.demo ?? null,
        })),
      )
    }

    if (c.guidelines?.length) {
      await tx.insert(t.guidelines).values(
        c.guidelines.map((doc) => ({
          canvasId: c.id,
          name: doc.name,
          markdown: doc.markdown,
          title: doc.title ?? null,
          updatedAt: doc.updatedAt,
          updatedBy: doc.updatedBy,
          x: doc.x ?? null,
          y: doc.y ?? null,
        })),
      )
    }

    if (c.components?.length) {
      await tx.insert(t.components).values(c.components.map((d) => componentRow(c.id, d)))
    }

    if (c.references?.length) {
      await tx.insert(t.memoryReferences).values(
        c.references.map((ref) => ({
          id: ref.id,
          canvasId: c.id,
          frameId: ref.frameId,
          title: ref.title,
          html: ref.html,
          width: ref.width,
          height: ref.height,
          pinnedBy: ref.pinnedBy,
          pinnedAt: ref.pinnedAt,
        })),
      )
    }

    const refs = c.frames.flatMap((frame) =>
      [...extractAssetIds(frame.html)].map((assetId) => ({ assetId, frameId: frame.id })),
    )
    if (refs.length) await tx.insert(t.assetRefs).values(refs)
  })
}

export function saveMember(canvasId: string, userId: string, addedBy: string, addedAt: number) {
  swallow(db.insert(t.canvasMembers).values({ canvasId, userId, addedBy, addedAt }).onConflictDoNothing())
}

export function deleteMember(canvasId: string, userId: string) {
  swallow(
    db.delete(t.canvasMembers).where(and(eq(t.canvasMembers.canvasId, canvasId), eq(t.canvasMembers.userId, userId))),
  )
}

/* Single-shot writes (one save per explicit edit) — no debounce needed. */
function componentRow(canvasId: string, d: ComponentDef) {
  return {
    canvasId,
    name: d.name,
    html: d.html,
    css: d.css,
    props: d.props,
    description: d.description ?? null,
    version: d.version,
    updatedAt: d.updatedAt,
    updatedBy: d.updatedBy,
    deletedAt: d.deletedAt ?? null,
  }
}

/** Upsert a definition or its tombstone. */
export function saveComponent(canvasId: string, d: ComponentDef) {
  const row = componentRow(canvasId, d)
  const { canvasId: _c, name: _n, ...set } = row
  swallow(
    db
      .insert(t.components)
      .values(row)
      .onConflictDoUpdate({ target: [t.components.canvasId, t.components.name], set }),
  )
}

export function saveGuideline(canvasId: string, doc: GuidelineDoc) {
  const row = {
    canvasId,
    name: doc.name,
    markdown: doc.markdown,
    title: doc.title ?? null,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    x: doc.x ?? null,
    y: doc.y ?? null,
  }
  swallow(
    db
      .insert(t.guidelines)
      .values(row)
      .onConflictDoUpdate({
        target: [t.guidelines.canvasId, t.guidelines.name],
        set: {
          markdown: row.markdown,
          title: row.title,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
          x: row.x,
          y: row.y,
        },
      }),
  )
}

export function deleteGuideline(canvasId: string, name: string) {
  swallow(db.delete(t.guidelines).where(and(eq(t.guidelines.canvasId, canvasId), eq(t.guidelines.name, name))))
}

/* Append-only doc history: a snapshot per save, '' marks a deletion. */
const MAX_GUIDELINE_VERSIONS = 50

export function saveGuidelineVersion(canvasId: string, name: string, markdown: string, by: string, at: number) {
  swallow(appendGuidelineVersion(canvasId, name, markdown, by, at))
}

async function appendGuidelineVersion(canvasId: string, name: string, markdown: string, by: string, at: number) {
  await db.insert(t.guidelineVersions).values({ id: nanoid(10), canvasId, name, markdown, savedAt: at, savedBy: by })
  const excess = await db
    .select({ id: t.guidelineVersions.id })
    .from(t.guidelineVersions)
    .where(and(eq(t.guidelineVersions.canvasId, canvasId), eq(t.guidelineVersions.name, name)))
    .orderBy(desc(t.guidelineVersions.savedAt))
    .offset(MAX_GUIDELINE_VERSIONS)
  if (excess.length) {
    await db.delete(t.guidelineVersions).where(
      inArray(
        t.guidelineVersions.id,
        excess.map((e) => e.id),
      ),
    )
  }
}

/** Newest first. Cold path — read straight from the database on demand. */
export function listGuidelineVersions(canvasId: string, name: string) {
  return db
    .select()
    .from(t.guidelineVersions)
    .where(and(eq(t.guidelineVersions.canvasId, canvasId), eq(t.guidelineVersions.name, name)))
    .orderBy(desc(t.guidelineVersions.savedAt))
}

/* Design memory: single-shot writes, like guidelines. */
export function saveReference(canvasId: string, ref: MemoryReference) {
  swallow(
    db
      .insert(t.memoryReferences)
      .values({
        id: ref.id,
        canvasId,
        frameId: ref.frameId,
        title: ref.title,
        html: ref.html,
        width: ref.width,
        height: ref.height,
        pinnedBy: ref.pinnedBy,
        pinnedAt: ref.pinnedAt,
      })
      .onConflictDoNothing(),
  )
}

export function deleteReference(id: string) {
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.id, id)))
}

export function saveDecision(canvasId: string, d: DesignDecision) {
  const row = {
    id: d.id,
    canvasId,
    text: d.text,
    summary: d.summary ?? null,
    source: d.source,
    frameId: d.frameId ?? null,
    fromName: d.from,
    agentName: d.agentName ?? null,
    at: d.at,
  }
  swallow(db.insert(t.decisions).values(row).onConflictDoNothing())
}

/* Streaming appends update a frame's html on every chunk — debounce per frame
   so the DB sees one row write per burst, not one per keystroke of the reveal. */
const frameTimers = new Map<string, NodeJS.Timeout>()
const FRAME_DEBOUNCE_MS = 400

export function saveFrame(f: Frame, immediate = false) {
  const existing = frameTimers.get(f.id)
  if (existing) clearTimeout(existing)
  if (immediate) {
    frameTimers.delete(f.id)
    swallow(writeFrame(f))
    return
  }
  frameTimers.set(
    f.id,
    setTimeout(() => {
      frameTimers.delete(f.id)
      swallow(writeFrame(f)) // f is mutated in place by the store, so the ref holds the latest state
    }, FRAME_DEBOUNCE_MS),
  )
}

async function writeFrame(f: Frame) {
  const row = {
    id: f.id,
    canvasId: f.canvasId,
    name: f.name,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    html: f.html,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    updatedBy: f.updatedBy,
    demo: f.demo ?? null,
  }
  const { id, createdAt, ...set } = row
  await db.insert(t.frames).values(row).onConflictDoUpdate({ target: t.frames.id, set })
  await syncAssetRefs(f.id, f.html)
}

/* asset_refs is a projection of frame HTML: recompute this frame's full ref
   set on every durable write (never increment/decrement — nothing to drift).
   Boot reconciles the whole table, so a lost write here self-heals. */
async function syncAssetRefs(frameId: string, html: string) {
  const ids = [...extractAssetIds(html)]
  await db.delete(t.assetRefs).where(eq(t.assetRefs.frameId, frameId))
  if (ids.length) {
    await db
      .insert(t.assetRefs)
      .values(ids.map((assetId) => ({ assetId, frameId })))
      .onConflictDoNothing()
  }
}

export function deleteCanvas(canvasId: string) {
  /* refs must go before the frames rows the subquery reads */
  swallow(
    db
      .delete(t.assetRefs)
      .where(
        inArray(
          t.assetRefs.frameId,
          db.select({ id: t.frames.id }).from(t.frames).where(eq(t.frames.canvasId, canvasId)),
        ),
      )
      .then(() => db.delete(t.frames).where(eq(t.frames.canvasId, canvasId))),
  )
  swallow(db.delete(t.tasks).where(eq(t.tasks.canvasId, canvasId)))
  swallow(db.delete(t.feedback).where(eq(t.feedback.canvasId, canvasId)))
  swallow(db.delete(t.comments).where(eq(t.comments.canvasId, canvasId)))
  swallow(db.delete(t.activity).where(eq(t.activity.canvasId, canvasId)))
  swallow(db.delete(t.guidelines).where(eq(t.guidelines.canvasId, canvasId)))
  swallow(db.delete(t.guidelineVersions).where(eq(t.guidelineVersions.canvasId, canvasId)))
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.canvasId, canvasId)))
  swallow(db.delete(t.decisions).where(eq(t.decisions.canvasId, canvasId)))
  swallow(db.delete(t.memoryProposals).where(eq(t.memoryProposals.canvasId, canvasId)))
  swallow(db.delete(t.canvasMembers).where(eq(t.canvasMembers.canvasId, canvasId)))
  swallow(db.delete(t.canvases).where(eq(t.canvases.id, canvasId)))
}

export function deleteFrame(frameId: string) {
  const timer = frameTimers.get(frameId)
  if (timer) {
    clearTimeout(timer)
    frameTimers.delete(frameId)
  }
  swallow(db.delete(t.frames).where(eq(t.frames.id, frameId)))
  swallow(db.delete(t.assetRefs).where(eq(t.assetRefs.frameId, frameId)))
}

/* Task rows are written as whole snapshots and never awaited by callers, so
   two quick edits could otherwise race on the pool and leave the older one
   in the table. Writes to the same task queue behind each other instead. */
const taskWrites = new Map<string, Promise<unknown>>()

export function saveTask(canvasId: string, task: AgentTask) {
  const row = {
    id: task.id,
    canvasId,
    agentName: task.agentName,
    owner: task.owner ?? null,
    color: task.color,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? null,
    auto: task.auto ?? false,
    queuedBy: task.queuedBy ?? null,
    claimedAt: task.claimedAt ?? null,
    failedAt: task.failedAt ?? null,
    failureReason: task.failureReason ?? null,
    frameIds: task.frameIds?.join(',') ?? null,
  }
  const write = () =>
    db
      .insert(t.tasks)
      .values(row)
      .onConflictDoUpdate({
        target: t.tasks.id,
        set: {
          endedAt: row.endedAt,
          status: row.status,
          agentName: row.agentName,
          color: row.color,
          claimedAt: row.claimedAt,
          failedAt: row.failedAt,
          failureReason: row.failureReason,
          frameIds: row.frameIds,
        },
      })
  const queued = (taskWrites.get(task.id) ?? Promise.resolve()).then(write, write)
  taskWrites.set(task.id, queued)
  swallow(queued.finally(() => taskWrites.get(task.id) === queued && taskWrites.delete(task.id)))
}

export function saveFeedback(fb: TaskFeedback) {
  const row = {
    id: fb.id,
    taskId: fb.taskId,
    canvasId: fb.canvasId,
    agentName: fb.agentName,
    fromName: fb.from,
    text: fb.text,
    at: fb.at,
    deliveredAt: fb.deliveredAt ?? null,
    claimedBy: fb.claimedBy ?? null,
    completedAt: fb.completedAt ?? null,
    failedAt: fb.failedAt ?? null,
    failureReason: fb.failureReason ?? null,
  }
  swallow(
    db
      .insert(t.feedback)
      .values(row)
      .onConflictDoUpdate({
        target: t.feedback.id,
        set: {
          deliveredAt: row.deliveredAt,
          claimedBy: row.claimedBy,
          completedAt: row.completedAt,
          failedAt: row.failedAt,
          failureReason: row.failureReason,
        },
      }),
  )
}

export function saveComment(c: ElementComment) {
  const row = {
    id: c.id,
    canvasId: c.canvasId,
    frameId: c.frameId,
    selector: c.selector,
    snippet: c.snippet,
    fromName: c.from,
    text: c.text,
    at: c.at,
    forAgent: c.forAgent ?? false,
    targetAgent: c.targetAgent ?? null,
    claimedBy: c.claimedBy ?? null,
    claimedAt: c.claimedAt ?? null,
    failedAt: c.failedAt ?? null,
    failureReason: c.failureReason ?? null,
    resolvedBy: c.resolvedBy ?? null,
    resolvedAt: c.resolvedAt ?? null,
    parentId: c.parentId ?? null,
  }
  swallow(
    db
      .insert(t.comments)
      .values(row)
      .onConflictDoUpdate({
        target: t.comments.id,
        set: {
          claimedBy: row.claimedBy,
          claimedAt: row.claimedAt,
          failedAt: row.failedAt,
          failureReason: row.failureReason,
          resolvedBy: row.resolvedBy,
          resolvedAt: row.resolvedAt,
        },
      }),
  )
}

export function saveActivity(canvasId: string, item: ActivityItem) {
  swallow(
    db.insert(t.activity).values({
      id: item.id,
      canvasId,
      actorName: item.actorName,
      actorKind: item.actorKind,
      actorColor: item.actorColor,
      message: item.message,
      frameId: item.frameId ?? null,
      at: item.at,
    }),
  )
}

/** Flush pending debounced frame and canvas writes (called on shutdown). */
export async function flush(getFrame: (id: string) => Frame | undefined): Promise<void> {
  const ids = [...frameTimers.keys()]
  for (const [, timer] of frameTimers) clearTimeout(timer)
  frameTimers.clear()
  const canvases = [...canvasTimers.values()]
  for (const { timer } of canvases) clearTimeout(timer)
  canvasTimers.clear()
  await Promise.allSettled([
    ...ids.map((id) => {
      const f = getFrame(id)
      return f ? writeFrame(f) : Promise.resolve()
    }),
    ...canvases.map(({ canvas: c }) =>
      db
        .insert(t.canvases)
        .values({ id: c.id, ...canvasColumns(c), createdAt: c.createdAt })
        .onConflictDoUpdate({ target: t.canvases.id, set: canvasColumns(c) }),
    ),
  ])
}

/* ------------------------------------------------------------------ */
/* Boot hydration                                                     */
/* ------------------------------------------------------------------ */

export interface Hydrated {
  canvases: Canvas[]
  tasks: Map<string, AgentTask[]> // canvasId -> newest first
  feedback: Map<string, TaskFeedback[]>
  comments: Map<string, ElementComment[]>
  activity: Map<string, ActivityItem[]>
  decisions: Map<string, DesignDecision[]>
}

const LOG_CAP = 100

export async function hydrate(): Promise<Hydrated> {
  const [
    canvasRows,
    frameRows,
    taskRows,
    feedbackRows,
    commentRows,
    activityRows,
    guidelineRows,
    referenceRows,
    decisionRows,
    memberRows,
    componentRows,
  ] = await Promise.all([
    db.select().from(t.canvases),
    db.select().from(t.frames),
    db.select().from(t.tasks).orderBy(desc(t.tasks.startedAt)),
    db.select().from(t.feedback).orderBy(desc(t.feedback.at)),
    db.select().from(t.comments).orderBy(desc(t.comments.at)),
    db.select().from(t.activity).orderBy(desc(t.activity.at)),
    db.select().from(t.guidelines).orderBy(t.guidelines.name),
    db.select().from(t.memoryReferences).orderBy(desc(t.memoryReferences.pinnedAt)),
    db.select().from(t.decisions).orderBy(desc(t.decisions.at)),
    db.select().from(t.canvasMembers).orderBy(t.canvasMembers.addedAt),
    db.select().from(t.components).orderBy(t.components.name),
  ])

  const canvases: Canvas[] = canvasRows.map((c) => ({
    id: c.id,
    name: c.name,
    ownerId: c.ownerId ?? undefined,
    linkAccess: c.linkAccess === 'edit' ? 'edit' : undefined,
    ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
    ...(isCanvasTheme(c.theme) ? { theme: c.theme } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    frames: [],
  }))
  const byId = new Map(canvases.map((c) => [c.id, c]))
  for (const m of memberRows) {
    const c = byId.get(m.canvasId)
    if (c) (c.memberIds ??= []).push(m.userId)
  }
  for (const f of frameRows) byId.get(f.canvasId)?.frames.push({ ...f, demo: f.demo ?? undefined })
  for (const c of canvases) c.frames.sort((a, b) => a.createdAt - b.createdAt)
  for (const r of referenceRows) {
    const c = byId.get(r.canvasId)
    if (!c) continue
    ;(c.references ??= []).push({
      id: r.id,
      frameId: r.frameId,
      title: r.title,
      html: r.html,
      width: r.width,
      height: r.height,
      pinnedBy: r.pinnedBy,
      pinnedAt: r.pinnedAt,
    })
  }
  for (const d of componentRows) {
    const c = byId.get(d.canvasId)
    if (!c) continue
    ;(c.components ??= []).push({
      name: d.name,
      html: d.html,
      css: d.css,
      props: d.props,
      ...(d.description ? { description: d.description } : {}),
      version: d.version,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy,
      ...(d.deletedAt != null ? { deletedAt: d.deletedAt } : {}),
    })
  }
  for (const g of guidelineRows) {
    const c = byId.get(g.canvasId)
    if (!c) continue
    ;(c.guidelines ??= []).push({
      name: g.name,
      markdown: g.markdown,
      ...(g.title != null ? { title: g.title } : {}),
      updatedAt: g.updatedAt,
      updatedBy: g.updatedBy,
      ...(g.x != null ? { x: g.x } : {}),
      ...(g.y != null ? { y: g.y } : {}),
    })
  }

  const now = Date.now()
  const interruptedReason = 'The agent stopped before finishing. Retry when you are ready.'
  const tasks = new Map<string, AgentTask[]>()
  for (const row of taskRows) {
    const list = tasks.get(row.canvasId) ?? []
    /* A task still open across a restart belongs to an agent that's gone.
       Ordinary status tasks close; claimed board cards pause in a visible
       failed state and require a human retry. */
    const isOpenCard = row.queuedBy != null && row.endedAt == null
    /* the cap bounds history, never open work: an unfinished card older than
       the newest hundred rows still belongs on the board (same rule as
       actions.trimTaskLog keeps in memory) */
    if (list.length >= LOG_CAP && !isOpenCard) continue
    const endedAt = isOpenCard ? undefined : (row.endedAt ?? now)
    const interruptedCard = isOpenCard && !!row.agentName
    const failedAt = row.failedAt ?? (interruptedCard ? now : undefined)
    const failureReason = row.failureReason ?? (interruptedCard ? interruptedReason : undefined)
    if (row.endedAt == null && !isOpenCard) swallow(db.update(t.tasks).set({ endedAt }).where(eq(t.tasks.id, row.id)))
    if (interruptedCard && row.failedAt == null) {
      swallow(db.update(t.tasks).set({ failedAt, failureReason }).where(eq(t.tasks.id, row.id)))
    }
    list.push({
      id: row.id,
      agentName: row.agentName,
      ...(row.owner != null ? { owner: row.owner } : {}),
      color: row.color,
      status: row.status,
      startedAt: row.startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(row.auto ? { auto: true } : {}),
      ...(row.queuedBy != null ? { queuedBy: row.queuedBy } : {}),
      ...(row.claimedAt != null ? { claimedAt: row.claimedAt } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(row.frameIds ? { frameIds: row.frameIds.split(',').filter(Boolean) } : {}),
    })
    tasks.set(row.canvasId, list)
  }

  const feedback = new Map<string, TaskFeedback[]>()
  for (const row of feedbackRows) {
    const list = feedback.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    /* feedback is delivered to agents running elsewhere (MCP) — a restart
       interrupts nothing, so rows load as they are */
    list.push({
      id: row.id,
      taskId: row.taskId,
      canvasId: row.canvasId,
      agentName: row.agentName,
      from: row.fromName,
      text: row.text,
      at: row.at,
      ...(row.deliveredAt != null ? { deliveredAt: row.deliveredAt } : {}),
      ...(row.claimedBy != null ? { claimedBy: row.claimedBy } : {}),
      ...(row.completedAt != null ? { completedAt: row.completedAt } : {}),
      ...(row.failedAt != null ? { failedAt: row.failedAt } : {}),
      ...(row.failureReason != null ? { failureReason: row.failureReason } : {}),
    })
    feedback.set(row.canvasId, list)
  }

  const comments = new Map<string, ElementComment[]>()
  for (const row of commentRows) {
    const list = comments.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      canvasId: row.canvasId,
      frameId: row.frameId,
      selector: row.selector,
      snippet: row.snippet,
      from: row.fromName,
      text: row.text,
      at: row.at,
      ...(row.forAgent ? { forAgent: true } : {}),
      ...(row.targetAgent != null ? { targetAgent: row.targetAgent } : {}),
      ...(row.claimedBy != null ? { claimedBy: row.claimedBy } : {}),
      ...(row.claimedAt != null ? { claimedAt: row.claimedAt } : {}),
      ...(row.failedAt != null ? { failedAt: row.failedAt } : {}),
      ...(row.failureReason != null ? { failureReason: row.failureReason } : {}),
      ...(row.resolvedBy != null ? { resolvedBy: row.resolvedBy } : {}),
      ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
      ...(row.parentId != null ? { parentId: row.parentId } : {}),
    })
    comments.set(row.canvasId, list)
  }

  const activity = new Map<string, ActivityItem[]>()
  for (const row of activityRows) {
    const list = activity.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      actorName: row.actorName,
      actorKind: row.actorKind as ActivityItem['actorKind'],
      actorColor: row.actorColor,
      message: row.message,
      frameId: row.frameId ?? undefined,
      at: row.at,
    })
    activity.set(row.canvasId, list)
  }

  const decisions = new Map<string, DesignDecision[]>()
  for (const row of decisionRows) {
    const list = decisions.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      text: row.text,
      ...(row.summary != null ? { summary: row.summary } : {}),
      source: row.source as DesignDecision['source'],
      ...(row.frameId != null ? { frameId: row.frameId } : {}),
      from: row.fromName,
      ...(row.agentName != null ? { agentName: row.agentName } : {}),
      at: row.at,
    })
    decisions.set(row.canvasId, list)
  }

  return { canvases, tasks, feedback, comments, activity, decisions }
}

/** One-time import of the pre-DB data/store.json so existing canvases survive. */
export async function importLegacyJson(): Promise<Canvas[] | null> {
  const file = path.join(process.cwd(), 'data', 'store.json')
  let parsed: Canvas[]
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  for (const c of parsed) {
    await db
      .insert(t.canvases)
      .values({ id: c.id, name: c.name, createdAt: c.createdAt, updatedAt: c.updatedAt })
      .onConflictDoNothing()
    for (const f of c.frames) await writeFrame(f)
  }
  fs.renameSync(file, `${file}.imported`)
  console.log(`[db] imported ${parsed.length} canvas(es) from legacy store.json`)
  return parsed
}
