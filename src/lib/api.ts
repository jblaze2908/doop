import type { CanvasTheme, ThemeTokenInput } from '../../shared/theme'
import type { ComponentDef, ComponentInput } from '../../shared/components'
import type {
  Canvas,
  CanvasMeta,
  Frame,
  HomeActivity,
  WorkspaceDetail,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSummary,
} from '../../shared/types'

export type { HomeActivity }

export interface CanvasMember {
  userId: string
  name: string
  email: string
  owner: boolean
}

/** A write-only design-sync key: apps embed its secret in the draft-sync
 *  snippet to push their live screens onto this canvas. */
export interface SyncKeyInfo {
  id: string
  secret: string
  canvasId: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  /** synced frames currently on the canvas */
  frames: number
}

/** The flow map of a canvas's synced app(s): link hotspots between frames
 *  and how often users actually navigated each pair. */
export interface SyncFlow {
  links: {
    fromFrameId: string
    toFrameId: string
    x: number
    y: number
    width: number
    height: number
    label: string | null
  }[]
  edges: { fromFrameId: string; toFrameId: string; count: number; lastAt: number }[]
}

export interface DiscoveredPage {
  url: string
  title: string
}

export interface DiscoveredSite {
  siteUrl: string
  pages: DiscoveredPage[]
  truncated: boolean
}

export interface WebsiteImportResult {
  frames: Frame[]
  failures: { url: string; error: string }[]
}

import { getIdentity } from './identity'

export interface WorkspacesResponse {
  workspaces: WorkspaceSummary[]
}

/** An invite lands one of two ways: an existing account is a member at
 *  once; an unknown email waits (and was emailed, when SMTP is set up). */
export type WorkspaceInviteResult = { member: WorkspaceMember } | { invite: WorkspaceInvite; emailed: boolean }

function actor() {
  const { clientId, name } = getIdentity()
  return { clientId, name, kind: 'user' as const }
}

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, text: string) {
    super(`${status} ${text}`)
    this.status = status
    try {
      this.body = JSON.parse(text)
    } catch {
      this.body = {}
    }
  }
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return String(err.body.error ?? err.body.message ?? fallback)
  return fallback
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.json()
}

export const api = {
  listCanvases: () => req<CanvasMeta[]>('/api/canvases'),
  getCanvas: (id: string) => req<Canvas>(`/api/canvases/${id}`),
  deleteCanvas: (id: string) => req(`/api/canvases/${id}`, { method: 'DELETE' }),
  homeActivity: () => req<HomeActivity[]>('/api/home/activity'),
  createCanvas: (name: string, workspaceId?: string) =>
    req<Canvas>('/api/canvases', { method: 'POST', body: JSON.stringify({ name, workspaceId }) }),
  /* file a canvas in a workspace, or back in its owner's personal space (null) */
  moveCanvas: (id: string, workspaceId: string | null) =>
    req(`/api/canvases/${id}/workspace`, { method: 'PUT', body: JSON.stringify({ workspaceId }) }),
  duplicateCanvas: (id: string) => req<Canvas>(`/api/canvases/${id}/duplicate`, { method: 'POST' }),
  claimCanvas: (id: string) => req(`/api/canvases/${id}/claim`, { method: 'POST' }),
  renameCanvas: (id: string, name: string) =>
    req('/api/canvases/' + id, { method: 'PATCH', body: JSON.stringify({ name, actor: actor() }) }),
  /* owner-only: what the share link grants people who aren't invited */
  setLinkAccess: (id: string, linkAccess: 'edit' | 'none') =>
    req('/api/canvases/' + id, { method: 'PATCH', body: JSON.stringify({ linkAccess }) }),
  /* collaborators: the owner plus invited members */
  listMembers: (canvasId: string) => req<CanvasMember[]>(`/api/canvases/${canvasId}/members`),
  inviteMember: (canvasId: string, email: string) =>
    req<CanvasMember>(`/api/canvases/${canvasId}/members`, { method: 'POST', body: JSON.stringify({ email }) }),
  removeMember: (canvasId: string, userId: string) =>
    req(`/api/canvases/${canvasId}/members/${userId}`, { method: 'DELETE' }),
  /* design-sync keys for the embeddable snippet */
  listSyncKeys: (canvasId: string) => req<SyncKeyInfo[]>(`/api/canvases/${canvasId}/sync-keys`),
  createSyncKey: (canvasId: string, name: string) =>
    req<SyncKeyInfo>(`/api/canvases/${canvasId}/sync-keys`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteSyncKey: (canvasId: string, keyId: string) =>
    req(`/api/canvases/${canvasId}/sync-keys/${keyId}`, { method: 'DELETE' }),
  syncFlow: (canvasId: string) => req<SyncFlow>(`/api/canvases/${canvasId}/sync-flow`),
  guidelineHistory: (canvasId: string, name: string) =>
    req<{ markdown: string; savedAt: number; savedBy: string }[]>(
      `/api/canvases/${canvasId}/guidelines/${encodeURIComponent(name)}/history`,
    ),
  /* empty markdown deletes the guide; title is the pretty display name */
  setGuideline: (canvasId: string, name: string, markdown: string, title?: string) =>
    req(`/api/canvases/${canvasId}/guidelines/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ markdown, ...(title !== undefined ? { title } : {}) }),
    }),
  /* the canvas theme: any subset of tokens (merge by default), css, fonts */
  setTheme: (
    canvasId: string,
    patch: { tokens?: ThemeTokenInput[]; mode?: 'merge' | 'replace'; css?: string; fonts?: string[] },
  ) => req<CanvasTheme>(`/api/canvases/${canvasId}/theme`, { method: 'PUT', body: JSON.stringify(patch) }),
  setComponent: (canvasId: string, input: ComponentInput) =>
    req<ComponentDef>(`/api/canvases/${canvasId}/components/${encodeURIComponent(input.name)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteComponent: (canvasId: string, name: string) =>
    req(`/api/canvases/${canvasId}/components/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /* design memory */
  pinReference: (canvasId: string, frameId: string) =>
    req(`/api/canvases/${canvasId}/references`, { method: 'POST', body: JSON.stringify({ frameId }) }),
  unpinReference: (canvasId: string, refId: string) =>
    req(`/api/canvases/${canvasId}/references/${refId}`, { method: 'DELETE' }),
  /* raw image bytes -> permanent /a/ URL (5 MB cap, type sniffed server-side) */
  uploadAsset: async (canvasId: string, blob: Blob) => {
    const res = await fetch(`/api/canvases/${canvasId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    })
    if (!res.ok) {
      if (res.status === 413) throw new Error('image exceeds the 5 MB limit')
      const text = await res.text()
      let msg = `${res.status} ${text}`
      try {
        msg = JSON.parse(text).error || msg
      } catch {
        /* non-JSON error body */
      }
      throw new Error(msg)
    }
    return res.json() as Promise<{ url: string; mime: string; size: number }>
  },
  createFrame: (canvasId: string, input: Partial<Frame> & { name: string }) =>
    req<Frame>(`/api/canvases/${canvasId}/frames`, {
      method: 'POST',
      body: JSON.stringify({ ...input, actor: actor() }),
    }),
  updateFrame: (frameId: string, patch: Partial<Frame>) =>
    req<Frame>('/api/frames/' + frameId, { method: 'PATCH', body: JSON.stringify({ ...patch, actor: actor() }) }),
  deleteFrame: (frameId: string) =>
    req('/api/frames/' + frameId, { method: 'DELETE', body: JSON.stringify({ actor: actor() }) }),
  sendTaskFeedback: (taskId: string, text: string) =>
    req(`/api/tasks/${taskId}/feedback`, { method: 'POST', body: JSON.stringify({ text, from: getIdentity().name }) }),
  importPage: (canvasId: string, url: string) =>
    req<Frame>(`/api/canvases/${canvasId}/import`, { method: 'POST', body: JSON.stringify({ url }) }),
  discoverSitePages: (canvasId: string, url: string) =>
    req<DiscoveredSite>(`/api/canvases/${canvasId}/import/discover`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  importSitePages: (canvasId: string, urls: string[]) =>
    req<WebsiteImportResult>(`/api/canvases/${canvasId}/import`, {
      method: 'POST',
      body: JSON.stringify({ urls }),
    }),
  addCard: (canvasId: string, title: string) =>
    req(`/api/canvases/${canvasId}/cards`, { method: 'POST', body: JSON.stringify({ title }) }),
  completeCard: (canvasId: string, cardId: string) =>
    req(`/api/canvases/${canvasId}/cards/${cardId}/done`, { method: 'POST' }),
  retryCard: (canvasId: string, cardId: string) =>
    req(`/api/canvases/${canvasId}/cards/${cardId}/retry`, { method: 'POST' }),
  addComment: (frameId: string, input: { selector: string; snippet: string; text: string }) =>
    req(`/api/frames/${frameId}/comments`, { method: 'POST', body: JSON.stringify(input) }),
  replyComment: (commentId: string, text: string) =>
    req(`/api/comments/${commentId}/replies`, { method: 'POST', body: JSON.stringify({ text }) }),
  resolveComment: (commentId: string) => req(`/api/comments/${commentId}/resolve`, { method: 'POST' }),
  retryComment: (commentId: string) => req(`/api/comments/${commentId}/retry`, { method: 'POST' }),
  retryTaskFeedback: (feedbackId: string) => req(`/api/feedback/${feedbackId}/retry`, { method: 'POST' }),
  /* workspaces: a team's shared space for canvases */
  listWorkspaces: () => req<WorkspacesResponse>('/api/workspaces'),
  createWorkspace: (name: string) =>
    req<WorkspaceSummary>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
  getWorkspace: (id: string) => req<WorkspaceDetail>(`/api/workspaces/${id}`),
  renameWorkspace: (id: string, name: string) =>
    req<WorkspaceSummary>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteWorkspace: (id: string) => req(`/api/workspaces/${id}`, { method: 'DELETE' }),
  inviteToWorkspace: (id: string, email: string, role: WorkspaceRole = 'member') =>
    req<WorkspaceInviteResult>(`/api/workspaces/${id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),
  setWorkspaceRole: (id: string, userId: string, role: WorkspaceRole) =>
    req(`/api/workspaces/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeWorkspaceMember: (id: string, userId: string) =>
    req(`/api/workspaces/${id}/members/${userId}`, { method: 'DELETE' }),
  revokeWorkspaceInvite: (id: string, inviteId: string) =>
    req(`/api/workspaces/${id}/invites/${inviteId}`, { method: 'DELETE' }),
}

/** better-auth's admin endpoint, not ours: ending a "view as" session swaps
 *  the cookie back, so the caller reloads rather than reconcile state. */
export const adminApi = {
  stopImpersonating: () => req('/api/auth/admin/stop-impersonating', { method: 'POST' }),
}
