import { nanoid } from 'nanoid'
import * as persist from './db/persist.ts'
import type { Canvas, Frame, GuidelineDoc, MemoryReference } from '../shared/types.ts'
import type { CanvasTheme } from '../shared/theme.ts'
import type { ComponentDef } from '../shared/components.ts'

/**
 * In-memory canvas/frame state — the hot path for reads, reveals and
 * broadcasts. Every committed mutation is mirrored to the database via
 * the write-through helpers in db/persist.ts; boot hydrates from there.
 */
class Store {
  canvases = new Map<string, Canvas>()
  private frameIndex = new Map<string, string>() // frameId -> canvasId

  init(canvases: Canvas[]) {
    for (const c of canvases) {
      this.canvases.set(c.id, c)
      for (const f of c.frames) this.frameIndex.set(f.id, c.id)
    }
  }

  /** The dashboard row for one canvas, marked as shared-with-me unless the
   *  viewer owns it. */
  private toMeta(c: Canvas, viewerId: string) {
    return {
      id: c.id,
      name: c.name,
      ownerId: c.ownerId,
      shared: c.ownerId !== viewerId || undefined,
      ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      frameCount: c.frames.length,
      /* most recently touched frame — the home dashboard renders it as the
         canvas preview via the public /i/ image pipeline */
      previewFrameId: c.frames.length ? c.frames.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id : undefined,
    }
  }

  /** Canvases visible to a user: their own, ones they were invited to, and
   *  every canvas in the workspaces they belong to (the caller resolves
   *  membership — see workspaces.canvasesFor). Unowned (legacy/seeded)
   *  canvases are NOT listed — listing them to everyone leaked one user's
   *  work onto every other user's dashboard. They remain reachable by their
   *  unguessable id and claimable there. */
  listCanvases(userId: string, workspaceIds: readonly string[] = []) {
    return [...this.canvases.values()]
      .filter(
        (c) =>
          c.ownerId === userId ||
          c.memberIds?.includes(userId) ||
          (c.workspaceId !== undefined && workspaceIds.includes(c.workspaceId)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => this.toMeta(c, userId))
  }

  createCanvas(name: string, ownerId?: string, workspaceId?: string): Canvas {
    const now = Date.now()
    const canvas: Canvas = { id: nanoid(10), name, ownerId, createdAt: now, updatedAt: now, frames: [] }
    if (workspaceId) canvas.workspaceId = workspaceId
    this.canvases.set(canvas.id, canvas)
    persist.saveCanvas(canvas)
    return canvas
  }

  /** Copy reusable design content into a new private canvas named
   * "<source> copy". Collaboration, activity, tasks and external connections
   * belong to the source only; `workspaceId` files the copy in a workspace
   * (the caller checks membership). */
  async duplicateCanvas(
    id: string,
    ownerId: string,
    by: string,
    options: { workspaceId?: string } = {},
  ): Promise<Canvas | undefined> {
    const source = this.canvases.get(id)
    if (!source) return undefined
    const now = Date.now()
    const canvasId = nanoid(10)
    const frameIds = new Map(source.frames.map((frame) => [frame.id, nanoid(10)]))
    const frames = source.frames.map((frame) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      canvasId,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }))
    const guidelines = source.guidelines?.map((doc) => ({ ...doc, updatedAt: now, updatedBy: by }))
    const references = source.references?.map((ref) => ({
      ...ref,
      id: nanoid(10),
      frameId: frameIds.get(ref.frameId) ?? ref.frameId,
      pinnedBy: by,
      pinnedAt: now,
    }))
    const canvas: Canvas = {
      id: canvasId,
      name: `${source.name} copy`,
      ownerId,
      createdAt: now,
      updatedAt: now,
      frames,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(guidelines?.length ? { guidelines } : {}),
      ...(references?.length ? { references } : {}),
      ...(source.theme ? { theme: { ...source.theme, updatedAt: now, updatedBy: by } } : {}),
      ...(source.components?.length
        ? { components: source.components.map((d) => ({ ...d, updatedAt: now, updatedBy: by })) }
        : {}),
    }
    await persist.saveCanvasCopy(canvas)
    this.canvases.set(canvas.id, canvas)
    for (const frame of frames) this.frameIndex.set(frame.id, canvas.id)
    return canvas
  }

  getCanvas(id: string) {
    return this.canvases.get(id)
  }

  /** Remove a canvas and its frames from memory + database. */
  deleteCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    for (const f of c.frames) this.frameIndex.delete(f.id)
    this.canvases.delete(id)
    persist.deleteCanvas(id)
    return c
  }

  /** Take ownership of a pre-auth (unowned) canvas. No-op if already owned. */
  claimCanvas(id: string, userId: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c || c.ownerId) return undefined
    c.ownerId = userId
    persist.saveCanvas(c)
    return c
  }

  /** Owner-set link policy ('none' is the default and stored as unset).
   *  Deliberately does not bump updatedAt — a privacy toggle is not a
   *  design edit. */
  setLinkAccess(id: string, mode: 'edit' | 'none'): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (mode === 'edit') c.linkAccess = 'edit'
    else delete c.linkAccess
    persist.saveCanvas(c)
    return c
  }

  /* ---- workspaces ---- */

  /** File a canvas in a workspace, or take it back to its owner's personal
   *  space (undefined). Access checks are the caller's; like the privacy
   *  toggles this is not a design edit, so updatedAt stays put. */
  setWorkspace(id: string, workspaceId: string | undefined): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (workspaceId) c.workspaceId = workspaceId
    else delete c.workspaceId
    persist.saveCanvas(c)
    return c
  }

  countWorkspaceCanvases(workspaceId: string): number {
    let n = 0
    for (const c of this.canvases.values()) if (c.workspaceId === workspaceId) n++
    return n
  }

  /** A workspace is going away: every canvas in it becomes personal again. */
  detachWorkspace(workspaceId: string): void {
    for (const c of this.canvases.values()) {
      if (c.workspaceId === workspaceId) {
        delete c.workspaceId
        persist.saveCanvas(c)
      }
    }
  }

  /** Invite a user to collaborate. Idempotent; the owner is never listed. */
  addMember(canvasId: string, userId: string, addedBy: string): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c || c.ownerId === userId) return c
    if (!(c.memberIds ??= []).includes(userId)) {
      c.memberIds.push(userId)
      persist.saveMember(canvasId, userId, addedBy, Date.now())
    }
    return c
  }

  removeMember(canvasId: string, userId: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.memberIds?.indexOf(userId) ?? -1
    if (!c || idx === -1) return false
    c.memberIds!.splice(idx, 1)
    persist.deleteMember(canvasId, userId)
    return true
  }

  renameCanvas(id: string, name: string) {
    const c = this.canvases.get(id)
    if (!c) return undefined
    c.name = name
    c.updatedAt = Date.now()
    persist.saveCanvas(c)
    return c
  }

  /** Replace the canvas theme wholesale — themes are never mutated in place,
   *  so compileTheme can memoize per object. A theme change is a design edit. */
  setTheme(canvasId: string, theme: CanvasTheme): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    c.theme = theme
    c.updatedAt = theme.updatedAt
    persist.saveCanvasTheme(canvasId, theme)
    persist.saveCanvas(c)
    return c
  }

  getComponents(canvasId: string): ComponentDef[] {
    return this.canvases.get(canvasId)?.components ?? []
  }

  /** Upsert a definition (or tombstone) by name, keeping the list sorted.
   *  A definition change is a design edit. */
  putComponent(canvasId: string, def: ComponentDef): ComponentDef | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const list = (c.components ??= []).filter((d) => d.name !== def.name)
    list.push(def)
    list.sort((a, b) => a.name.localeCompare(b.name))
    c.components = list
    c.updatedAt = def.updatedAt
    persist.saveComponent(canvasId, def)
    persist.saveCanvas(c)
    return def
  }

  getGuidelines(canvasId: string): GuidelineDoc[] {
    return this.canvases.get(canvasId)?.guidelines ?? []
  }

  /** Upsert a design doc by name. New docs without a position are auto-placed
   *  as a card to the left of the frames, stacked downward. */
  setGuideline(
    canvasId: string,
    name: string,
    markdown: string,
    by: string,
    pos?: { x: number; y: number },
    title?: string,
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const docs = (c.guidelines ??= [])
    const now = Date.now()
    let doc = docs.find((d) => d.name === name)
    if (doc) {
      doc.markdown = markdown
      doc.updatedAt = now
      doc.updatedBy = by
      if (pos) Object.assign(doc, pos)
      if (title !== undefined) doc.title = title || undefined
    } else {
      const placed = pos ?? this.placeGuideline(c, docs.length)
      doc = { name, markdown, ...(title ? { title } : {}), updatedAt: now, updatedBy: by, ...placed }
      docs.push(doc)
      docs.sort((a, b) => a.name.localeCompare(b.name))
    }
    c.updatedAt = now
    persist.saveGuideline(canvasId, doc)
    persist.saveCanvas(c)
    return doc
  }

  private placeGuideline(c: Canvas, index: number): { x: number; y: number } {
    const CARD_W = 360
    if (!c.frames.length) return { x: 120, y: 120 + index * 380 }
    const minX = Math.min(...c.frames.map((f) => f.x))
    const minY = Math.min(...c.frames.map((f) => f.y))
    return { x: minX - CARD_W - 100, y: minY + index * 380 }
  }

  /** Patch card position / display title; content and history stay untouched. */
  patchGuideline(
    canvasId: string,
    name: string,
    patch: { x?: number; y?: number; title?: string },
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    const doc = c?.guidelines?.find((d) => d.name === name)
    if (!c || !doc) return undefined
    if (patch.x !== undefined) doc.x = patch.x
    if (patch.y !== undefined) doc.y = patch.y
    if (patch.title !== undefined) doc.title = patch.title || undefined
    persist.saveGuideline(canvasId, doc)
    return doc
  }

  deleteGuideline(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.guidelines?.findIndex((d) => d.name === name) ?? -1
    if (!c || idx === -1) return false
    c.guidelines!.splice(idx, 1)
    c.updatedAt = Date.now()
    persist.deleteGuideline(canvasId, name)
    persist.saveCanvas(c)
    return true
  }

  getReferences(canvasId: string): MemoryReference[] {
    return this.canvases.get(canvasId)?.references ?? []
  }

  /** Pin a frame to Memory: snapshot its HTML now, decoupled from the frame. */
  addReference(canvasId: string, frame: Frame, by: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const ref: MemoryReference = {
      id: nanoid(10),
      frameId: frame.id,
      title: frame.name,
      html: frame.html,
      width: frame.width,
      height: frame.height,
      pinnedBy: by,
      pinnedAt: Date.now(),
    }
    ;(c.references ??= []).unshift(ref)
    persist.saveReference(canvasId, ref)
    return ref
  }

  deleteReference(canvasId: string, id: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    const idx = c?.references?.findIndex((r) => r.id === id) ?? -1
    if (!c || idx === -1) return undefined
    const [ref] = c.references!.splice(idx, 1)
    persist.deleteReference(id)
    return ref
  }

  getFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    return this.canvases.get(canvasId)?.frames.find((f) => f.id === frameId)
  }

  createFrame(
    canvasId: string,
    input: { name: string; x?: number; y?: number; width?: number; height?: number; html?: string; demo?: boolean },
    by: string,
  ): Frame | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const now = Date.now()
    // auto-place: to the right of the right-most frame
    let x = input.x
    let y = input.y
    if (x === undefined || y === undefined) {
      const rightmost = c.frames.reduce((mx, f) => Math.max(mx, f.x + f.width), 0)
      x ??= c.frames.length ? rightmost + 80 : 120
      y ??= 120
    }
    const frame: Frame = {
      id: nanoid(10),
      canvasId,
      name: input.name,
      x,
      y,
      width: input.width ?? 640,
      height: input.height ?? 480,
      html: input.html ?? '',
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }
    if (input.demo) frame.demo = true
    c.frames.push(frame)
    c.updatedAt = now
    this.frameIndex.set(frame.id, canvasId)
    persist.saveFrame(frame, true)
    persist.saveCanvas(c)
    return frame
  }

  updateFrame(
    frameId: string,
    patch: Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html'>>,
    by: string,
  ): Frame | undefined {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    /* updatedAt is the frame's part of the render stamp that thumbnail and
       preview caches key on: a move or rename does not change the render */
    const rerenders = (['html', 'width', 'height'] as const).some(
      (k) => patch[k] !== undefined && patch[k] !== frame[k],
    )
    Object.assign(frame, patch)
    if (rerenders) {
      frame.updatedAt = Date.now()
      frame.updatedBy = by
    }
    const c = this.canvases.get(frame.canvasId)!
    c.updatedAt = Date.now()
    persist.saveFrame(frame) // debounced: streaming appends land as one write per burst
    persist.saveCanvasSoon(c) // likewise: updatedAt moves on every chunk
    return frame
  }

  deleteFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const idx = c.frames.findIndex((f) => f.id === frameId)
    if (idx === -1) return undefined
    const [frame] = c.frames.splice(idx, 1)
    c.updatedAt = Date.now()
    this.frameIndex.delete(frameId)
    persist.deleteFrame(frameId)
    persist.saveCanvas(c)
    return frame
  }
}

export const store = new Store()
