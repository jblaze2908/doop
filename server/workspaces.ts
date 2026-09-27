import express from 'express'
import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as authSchema from './db/auth-schema.ts'
import { store } from './store.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import { isWorkspaceRole } from '../shared/types.ts'
import type {
  WorkspaceDetail,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSummary,
} from '../shared/types.ts'

/**
 * Shared workspaces: the org-level home for canvases. Membership is the
 * whole access model — a member opens every canvas in the workspace — so the
 * membership index lives in memory next to the canvases (canAccessCanvas
 * runs on every request and every MCP call) and is written through to the
 * database the way the store does it.
 */

export interface WorkspaceRecord {
  id: string
  name: string
  ownerId: string
  createdAt: number
  updatedAt: number
}

interface Membership {
  role: WorkspaceRole
  addedAt: number
}

const records = new Map<string, WorkspaceRecord>()
/** workspaceId -> userId -> membership */
const members = new Map<string, Map<string, Membership>>()

const ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:4300'

function swallow(p: Promise<unknown>) {
  p.catch((err) => console.error('[workspaces] write failed', err))
}

export async function hydrateWorkspaces(): Promise<void> {
  const [rows, memberRows] = await Promise.all([db.select().from(t.workspaces), db.select().from(t.workspaceMembers)])
  records.clear()
  members.clear()
  for (const r of rows) {
    records.set(r.id, {
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })
  }
  for (const m of memberRows) {
    if (!records.has(m.workspaceId) || !isWorkspaceRole(m.role)) continue
    membersOf(m.workspaceId).set(m.userId, { role: m.role, addedAt: m.addedAt })
  }
}

function membersOf(workspaceId: string): Map<string, Membership> {
  let map = members.get(workspaceId)
  if (!map) members.set(workspaceId, (map = new Map()))
  return map
}

/* ---- reads ---- */

export function getWorkspace(id: string): WorkspaceRecord | undefined {
  return records.get(id)
}

export function isWorkspaceMember(workspaceId: string, userId: string | undefined): boolean {
  return !!userId && !!members.get(workspaceId)?.has(userId)
}

export function roleOf(workspaceId: string, userId: string | undefined): WorkspaceRole | undefined {
  return userId ? members.get(workspaceId)?.get(userId)?.role : undefined
}

const RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 }

export function hasRole(workspaceId: string, userId: string | undefined, atLeast: WorkspaceRole): boolean {
  const role = roleOf(workspaceId, userId)
  return !!role && RANK[role] >= RANK[atLeast]
}

export function workspaceIdsFor(userId: string): string[] {
  const ids: string[] = []
  for (const [id, map] of members) if (map.has(userId)) ids.push(id)
  return ids
}

/** Everything the dashboard lists for a user: personal, invited, and every
 *  canvas of every workspace they belong to. */
export function canvasesFor(userId: string) {
  return store.listCanvases(userId, workspaceIdsFor(userId))
}

export function summaryFor(ws: WorkspaceRecord, viewerId: string): WorkspaceSummary {
  return {
    id: ws.id,
    name: ws.name,
    ownerId: ws.ownerId,
    role: roleOf(ws.id, viewerId) ?? 'member',
    memberCount: members.get(ws.id)?.size ?? 0,
    canvasCount: store.countWorkspaceCanvases(ws.id),
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
  }
}

export function listFor(userId: string): WorkspaceSummary[] {
  return workspaceIdsFor(userId)
    .map((id) => records.get(id))
    .filter((ws): ws is WorkspaceRecord => !!ws)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((ws) => summaryFor(ws, userId))
}

/* ---- writes ---- */

export function createWorkspace(name: string, ownerId: string): WorkspaceRecord {
  const now = Date.now()
  const ws: WorkspaceRecord = { id: nanoid(10), name, ownerId, createdAt: now, updatedAt: now }
  records.set(ws.id, ws)
  membersOf(ws.id).set(ownerId, { role: 'owner', addedAt: now })
  swallow(
    db.transaction(async (tx) => {
      await tx.insert(t.workspaces).values(ws)
      await tx
        .insert(t.workspaceMembers)
        .values({ workspaceId: ws.id, userId: ownerId, role: 'owner', addedBy: ownerId, addedAt: now })
    }),
  )
  return ws
}

export function renameWorkspace(id: string, name: string): WorkspaceRecord | undefined {
  const ws = records.get(id)
  if (!ws) return undefined
  ws.name = name
  ws.updatedAt = Date.now()
  swallow(db.update(t.workspaces).set({ name, updatedAt: ws.updatedAt }).where(eq(t.workspaces.id, id)))
  return ws
}

/** Tear a workspace down: its canvases return to their owners' personal
 *  spaces (nothing is deleted). */
export async function deleteWorkspace(id: string): Promise<void> {
  if (!records.has(id)) return
  store.detachWorkspace(id)
  records.delete(id)
  members.delete(id)
  await db.transaction(async (tx) => {
    await tx.delete(t.workspaceMembers).where(eq(t.workspaceMembers.workspaceId, id))
    await tx.delete(t.workspaceInvites).where(eq(t.workspaceInvites.workspaceId, id))
    await tx.delete(t.workspaces).where(eq(t.workspaces.id, id))
  })
}

export function addMember(workspaceId: string, userId: string, role: WorkspaceRole, addedBy: string): boolean {
  if (!records.has(workspaceId)) return false
  const map = membersOf(workspaceId)
  if (map.has(userId)) return false
  const addedAt = Date.now()
  map.set(userId, { role, addedAt })
  swallow(db.insert(t.workspaceMembers).values({ workspaceId, userId, role, addedBy, addedAt }).onConflictDoNothing())
  return true
}

export function setRole(workspaceId: string, userId: string, role: WorkspaceRole): boolean {
  const entry = members.get(workspaceId)?.get(userId)
  if (!entry) return false
  entry.role = role
  swallow(
    db
      .update(t.workspaceMembers)
      .set({ role })
      .where(and(eq(t.workspaceMembers.workspaceId, workspaceId), eq(t.workspaceMembers.userId, userId))),
  )
  return true
}

/** Unlike an add or a role change, a revocation is durable before it
 *  answers: one that only reached memory would quietly come back at the
 *  next restart, with the member's access to every workspace canvas. */
export async function removeMember(workspaceId: string, userId: string): Promise<boolean> {
  const map = members.get(workspaceId)
  if (!records.has(workspaceId) || !map?.has(userId)) return false
  await db
    .delete(t.workspaceMembers)
    .where(and(eq(t.workspaceMembers.workspaceId, workspaceId), eq(t.workspaceMembers.userId, userId)))
  map.delete(userId)
  return true
}

/* ---- invites for people without an account ---- */

async function createInvite(workspaceId: string, email: string, role: WorkspaceRole, invitedBy: string) {
  const invite = { id: nanoid(12), workspaceId, email, role, invitedBy, createdAt: Date.now() }
  await db
    .insert(t.workspaceInvites)
    .values(invite)
    .onConflictDoUpdate({
      target: [t.workspaceInvites.workspaceId, t.workspaceInvites.email],
      set: { role, invitedBy, createdAt: invite.createdAt },
    })
  return invite
}

async function listInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
  const rows = await db.select().from(t.workspaceInvites).where(eq(t.workspaceInvites.workspaceId, workspaceId))
  const inviterIds = [...new Set(rows.map((r) => r.invitedBy))]
  const names = await userRows(inviterIds)
  return rows
    .map((r) => ({
      id: r.id,
      email: r.email,
      role: isWorkspaceRole(r.role) ? r.role : 'member',
      invitedByName: names.get(r.invitedBy)?.name ?? 'someone',
      createdAt: r.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Invites can only be honoured for an address someone has proven they
 *  own. With a mailer that is email verification; without one nobody can
 *  ever verify, so in production such invites are refused up front (the
 *  same line ADMIN_EMAILS draws) and local development takes the address
 *  at face value. */
export function unknownEmailInvitesAllowed(): boolean {
  return mailerConfigured || process.env.NODE_ENV !== 'production'
}

/** Turn an invite into a membership: the member row and the invite's
 *  deletion land in one transaction, so a failed write leaves the invite
 *  to retry rather than a person with neither access nor an invite. */
async function acceptInvite(
  ws: WorkspaceRecord,
  userId: string,
  invite: { id: string; role: string; invitedBy: string },
): Promise<void> {
  const role: WorkspaceRole = isWorkspaceRole(invite.role) ? invite.role : 'member'
  const addedAt = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .insert(t.workspaceMembers)
      .values({ workspaceId: ws.id, userId, role, addedBy: invite.invitedBy, addedAt })
      .onConflictDoNothing()
    await tx.delete(t.workspaceInvites).where(eq(t.workspaceInvites.id, invite.id))
  })
  const map = membersOf(ws.id)
  if (!map.has(userId)) map.set(userId, { role, addedAt })
}

/** A new account with an invited email joins its workspaces on arrival.
 *  Called from the auth hooks — after email verification where a mailer
 *  exists, after signup in mailer-less development. */
export async function acceptInvites(userId: string, email: string): Promise<void> {
  const clean = email.trim().toLowerCase()
  const rows = await db.select().from(t.workspaceInvites).where(eq(t.workspaceInvites.email, clean))
  for (const invite of rows) {
    const ws = records.get(invite.workspaceId)
    if (!ws) {
      /* the workspace is gone; nothing to wait for */
      await db.delete(t.workspaceInvites).where(eq(t.workspaceInvites.id, invite.id))
      continue
    }
    await acceptInvite(ws, userId, invite)
  }
}

async function userRows(ids: string[]) {
  const rows = ids.length
    ? await db
        .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
        .from(authSchema.user)
        .where(inArray(authSchema.user.id, ids))
    : []
  return new Map(rows.map((r) => [r.id, r]))
}

async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const map = members.get(workspaceId) ?? new Map<string, Membership>()
  const users = await userRows([...map.keys()])
  return [...map]
    .map(([userId, m]) => ({
      userId,
      name: users.get(userId)?.name ?? 'Unknown',
      email: users.get(userId)?.email ?? '',
      role: m.role,
      addedAt: m.addedAt,
    }))
    .sort((a, b) => RANK[b.role] - RANK[a.role] || a.addedAt - b.addedAt)
}

async function detailFor(ws: WorkspaceRecord, viewerId: string): Promise<WorkspaceDetail> {
  const admin = hasRole(ws.id, viewerId, 'admin')
  const [memberList, invites] = await Promise.all([listMembers(ws.id), admin ? listInvites(ws.id) : []])
  return { ...summaryFor(ws, viewerId), members: memberList, invites }
}

/* ------------------------------------------------------------------ */
/* Routes: /api/workspaces (behind the session gate in index.ts)       */
/* ------------------------------------------------------------------ */

export const workspacesRouter = express.Router()

function requireWorkspace(req: express.Request, res: express.Response, id: string, atLeast: WorkspaceRole = 'member') {
  const ws = records.get(id)
  if (!ws || !isWorkspaceMember(id, req.user!.id)) {
    /* 404 for non-members: a workspace's existence is its members' business */
    res.status(404).json({ error: 'workspace not found' })
    return null
  }
  if (!hasRole(id, req.user!.id, atLeast)) {
    res.status(403).json({ error: `only workspace ${atLeast === 'owner' ? 'owners' : 'admins'} can do that` })
    return null
  }
  return ws
}

workspacesRouter.get('/', (req, res) => {
  res.json({ workspaces: listFor(req.user!.id) })
})

workspacesRouter.post('/', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : ''
  if (!name) return res.status(400).json({ error: 'name required' })
  const ws = createWorkspace(name, req.user!.id)
  res.json(summaryFor(ws, req.user!.id))
})

workspacesRouter.get('/:id', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id)
  if (!ws) return
  res.json(await detailFor(ws, req.user!.id))
})

workspacesRouter.patch('/:id', (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : ''
  if (!name) return res.status(400).json({ error: 'name required' })
  renameWorkspace(ws.id, name)
  res.json(summaryFor(ws, req.user!.id))
})

workspacesRouter.delete('/:id', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'owner')
  if (!ws) return
  try {
    await deleteWorkspace(ws.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('[workspaces] delete failed', err)
    res.status(500).json({ error: 'could not delete the workspace — try again' })
  }
})

/* ---- members ---- */

workspacesRouter.post('/:id/members', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'a valid email is required' })
  const role: WorkspaceRole = req.body?.role === 'admin' ? 'admin' : 'member'
  const [row] = await db
    .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  if (row) {
    if (!addMember(ws.id, row.id, role, req.user!.id)) return res.status(400).json({ error: 'already a member' })
    const member: WorkspaceMember = { userId: row.id, name: row.name, email: row.email, role, addedAt: Date.now() }
    return res.json({ member })
  }
  if (!unknownEmailInvitesAllowed())
    return res.status(404).json({ error: 'no doop account with that email — ask them to sign up first' })
  const invite = await createInvite(ws.id, email, role, req.user!.id)
  if (mailerConfigured) {
    sendMail({
      to: email,
      subject: `${req.user!.name} invited you to "${ws.name}" on doop`,
      text: `${req.user!.name} invited you to the "${ws.name}" workspace on doop.\n\nCreate an account with this email address and you'll be in:\n\n${ORIGIN}/\n`,
    }).catch((err) => console.error('[workspaces] invite email failed', err))
  }
  const pending: WorkspaceInvite = {
    id: invite.id,
    email,
    role,
    invitedByName: req.user!.name,
    createdAt: invite.createdAt,
  }
  res.json({ invite: pending, emailed: mailerConfigured })
})

workspacesRouter.patch('/:id/members/:userId', (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  const role = req.body?.role
  if (role !== 'admin' && role !== 'member') return res.status(400).json({ error: 'role must be admin or member' })
  if (req.params.userId === ws.ownerId) return res.status(400).json({ error: 'the owner keeps the owner role' })
  if (!setRole(ws.id, req.params.userId, role)) return res.status(404).json({ error: 'not a member' })
  res.json({ ok: true })
})

workspacesRouter.delete('/:id/members/:userId', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id)
  if (!ws) return
  const target = req.params.userId
  const self = target === req.user!.id
  if (!self && !hasRole(ws.id, req.user!.id, 'admin'))
    return res.status(403).json({ error: 'only workspace admins can remove people' })
  if (target === ws.ownerId)
    return res
      .status(400)
      .json({ error: self ? 'delete the workspace instead of leaving it' : 'the owner cannot be removed' })
  try {
    if (!(await removeMember(ws.id, target))) return res.status(404).json({ error: 'not a member' })
  } catch (err) {
    console.error('[workspaces] remove member failed', err)
    return res.status(500).json({ error: 'could not remove the member' })
  }
  res.json({ ok: true })
})

workspacesRouter.delete('/:id/invites/:inviteId', async (req, res) => {
  const ws = requireWorkspace(req, res, req.params.id, 'admin')
  if (!ws) return
  await db
    .delete(t.workspaceInvites)
    .where(and(eq(t.workspaceInvites.workspaceId, ws.id), eq(t.workspaceInvites.id, req.params.inviteId)))
  res.json({ ok: true })
})
