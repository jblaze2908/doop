import type { CanvasTheme } from './theme.ts'
import type { ComponentDef } from './components.ts'

export interface Frame {
  id: string
  canvasId: string
  name: string
  x: number
  y: number
  width: number
  height: number
  html: string
  createdAt: number
  updatedAt: number
  updatedBy: string
  /** product-made onboarding/example content (welcome demo, seeded frames) —
   *  not the user's work; agents must never read it as the canvas's style */
  demo?: boolean
}

export interface CanvasMeta {
  id: string
  name: string
  /** user id of the creator; unset for legacy/seeded canvases (visible to everyone) */
  ownerId?: string
  /** true when this canvas is on the list because the user was invited */
  shared?: boolean
  /** the shared workspace it lives in; unset = a personal canvas */
  workspaceId?: string
  createdAt: number
  updatedAt: number
  frameCount: number
  /** most recently updated frame — render /i/<id>.jpg for a canvas preview */
  previewFrameId?: string
  /** that frame's render stamp (its updatedAt): the preview image is stale once this moves */
  previewAt?: number
  /** agents that have worked on this canvas (most recent first) */
  agents?: { name: string; owner?: string; lastAt?: number }[]
}

/** The dashboard preview render (`/i/<id>.jpg?preview`) clips a
 *  frame at this many frame pixels of height — a tall page's thumbnail is
 *  its top section, not the whole page. Anything sizing a tile around that
 *  image must assume this cap, not the frame's real height. */
export const PREVIEW_MAX_HEIGHT = 1200

export interface Canvas {
  id: string
  name: string
  ownerId?: string
  /** what the share link grants people who are not the owner or invited:
   *  'edit' (anyone with the link collaborates) or 'none' (private — the
   *  default; unset means 'none'). */
  linkAccess?: 'edit' | 'none'
  /** user ids invited to collaborate (the owner is not listed) */
  memberIds?: string[]
  /** the shared workspace this canvas belongs to — every workspace member
   *  can open it, on top of the owner and invited members. Unset = the
   *  owner's personal space. */
  workspaceId?: string
  createdAt: number
  updatedAt: number
  frames: Frame[]
  /** named design docs (brand rules, style recipes) every actor on the canvas follows */
  guidelines?: GuidelineDoc[]
  /** frames pinned to Memory as style exemplars — HTML snapshotted at pin time */
  references?: MemoryReference[]
  /** design tokens, fonts and CSS every frame on the canvas inherits */
  theme?: CanvasTheme
  /** linked component definitions (tombstones included), sorted by name */
  components?: ComponentDef[]
}

/* ---- workspaces ---- */

export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value)
}

/** A workspace as the dashboard lists it — for one viewer, hence `role`. */
export interface WorkspaceSummary {
  id: string
  name: string
  ownerId: string
  /** the viewer's role in it */
  role: WorkspaceRole
  memberCount: number
  canvasCount: number
  createdAt: number
  updatedAt: number
}

export interface WorkspaceMember {
  userId: string
  name: string
  email: string
  role: WorkspaceRole
  addedAt: number
}

/** An outstanding invite to an email with no draft account yet. */
export interface WorkspaceInvite {
  id: string
  email: string
  role: WorkspaceRole
  invitedByName: string
  createdAt: number
}

export interface WorkspaceDetail extends WorkspaceSummary {
  members: WorkspaceMember[]
  /** only admins and the owner see these */
  invites: WorkspaceInvite[]
}

/* ---- design memory ---- */

/** A frame pinned to Memory as a style reference: "more like this one".
 *  The HTML is snapshotted at pin time, so later edits to (or deletion of)
 *  the frame never change what the exemplar shows. */
export interface MemoryReference {
  id: string
  /** the frame it was pinned from; the frame may no longer exist */
  frameId: string
  title: string
  html: string
  width: number
  height: number
  pinnedBy: string
  pinnedAt: number
}

/** A resolved design decision, captured automatically when an @agent element
 *  comment gets resolved, or reported by a connected agent (save_decision). */
export interface DesignDecision {
  id: string
  /** the human's words — what they asked to change */
  text: string
  /** a generalized one-line preference the UI leads with; only decisions
   *  from before the summarizer was removed carry one */
  summary?: string
  /** where the decision came from: task feedback (older decisions only), an
   *  @agent element comment, or the human's conversation with a connected agent */
  source: 'feedback' | 'comment' | 'chat'
  frameId?: string
  /** the human who gave the feedback */
  from: string
  /** the agent that addressed it */
  agentName?: string
  at: number
}

/** A named design markdown attached to a canvas — palettes, fonts, layout
 *  recipes, asset URLs. Written for agents, readable by humans. Rendered as
 *  a pinned "style guide" card on the canvas next to the frames. */
export interface GuidelineDoc {
  /** slug, unique per canvas (e.g. "feature-image") */
  name: string
  /** pretty display name (e.g. "Featured Images"); fall back to the slug */
  title?: string
  markdown: string
  updatedAt: number
  updatedBy: string
  /** world position of the card on the canvas; unset = auto-placed */
  x?: number
  y?: number
}

export type ActorKind = 'user' | 'agent'

export interface Actor {
  name: string
  kind: ActorKind
  color: string
  clientId?: string
  /** for agents: display name of the user whose OAuth token authorized it */
  owner?: string
}

export interface Presence {
  clientId: string
  name: string
  color: string
  kind: ActorKind
  cursor?: { x: number; y: number }
  /** the region of the canvas this client is looking at — pan/zoom plus the
   *  stage size, so a follower can fit the same world rect on its own screen */
  viewport?: PeerViewport
  activeFrameId?: string | null
  /** one-line "what I'm working on right now" (agents set this via set_status) */
  status?: string
  /** for agents: whose token they connected with */
  owner?: string
}

/** A unit of work an agent announced via set_status. A new status completes the previous task.
 *  Board cards are the same object: a human queues one (queuedBy set, agentName empty) and
 *  it stays open until explicitly completed. */
export interface AgentTask {
  id: string
  /** empty string while a queued card waits for an agent */
  agentName: string
  /** whose token the agent connected with */
  owner?: string
  color: string
  status: string
  startedAt: number
  endedAt?: number
  /** inferred by the server from frame edits (agent never called set_status) */
  auto?: boolean
  /** frames the agent edited while this task was open, most recent last —
   *  lets the Agents panel jump the camera to where the work happened */
  frameIds?: string[]
  /** human who queued this as a board card */
  queuedBy?: string
  claimedAt?: number
  /** unsuccessful agent attempt; failed work waits for an explicit human retry */
  failedAt?: number
  failureReason?: string
}

/** Human feedback left on an agent task: an open request on the canvas that ANY
 *  agent can pick up — delivered inside the next identified agent tool result. */
export interface TaskFeedback {
  id: string
  taskId: string
  canvasId: string
  /** whose work the feedback is about (the task's agent), not who must handle it */
  agentName: string
  from: string
  text: string
  at: number
  /** set once the feedback has been included in some agent's tool result */
  deliveredAt?: number
  /** the agent that picked it up */
  claimedBy?: string
  /** an agent reported it handled (older feedback only) */
  completedAt?: number
  /** an interrupted attempt (older feedback only); waits for a human retry */
  failedAt?: number
  failureReason?: string
}

/** A comment pinned to a specific element inside a frame. A comment that
 *  @mentions an agent role is a request for an agent; others are notes for
 *  the humans in the room. */
export interface ElementComment {
  id: string
  canvasId: string
  frameId: string
  /** CSS selector of the anchored element, resolved at comment time */
  selector: string
  /** outerHTML excerpt of the element, for agent context and dead-anchor display */
  snippet: string
  from: string
  text: string
  at: number
  /** true when the text @mentions an agent role — a request for an agent */
  forAgent?: boolean
  /** the role that was mentioned (shared/agents.ts) */
  targetAgent?: string
  claimedBy?: string
  claimedAt?: number
  /** unsuccessful agent attempt; the comment remains paused until retried */
  failedAt?: number
  failureReason?: string
  resolvedBy?: string
  resolvedAt?: number
  /** set on a reply: the root comment of its thread. Replies inherit the
   *  root's anchor and are listed under its pin instead of getting their own */
  parentId?: string
}

export interface ActivityItem {
  id: string
  actorName: string
  actorKind: ActorKind
  actorColor: string
  message: string
  frameId?: string
  at: number
}

/** An activity row on the dashboard's live feed, with the canvas it happened on. */
export type HomeActivity = ActivityItem & { canvasId: string; canvasName: string }

/** A client's camera: world→screen transform plus the stage size it fills. */
export interface PeerViewport {
  x: number
  y: number
  zoom: number
  width: number
  height: number
}

/* ---- websocket protocol ---- */

export type ClientMessage =
  | { type: 'join'; canvasId: string; clientId: string; name: string; kind: ActorKind }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'viewport'; viewport: PeerViewport }
  | { type: 'editing'; frameId: string | null }
  | { type: 'frame:drag'; frameId: string; x: number; y: number; width: number; height: number }
  /** a dashboard socket: live rows for every canvas the user can list */
  | { type: 'home' }

export type ServerMessage =
  | { type: 'home:canvas'; canvas: CanvasMeta }
  | { type: 'home:canvas:removed'; canvasId: string }
  /** access or workspaces changed in a way a row cannot express: refetch the lists */
  | { type: 'home:refresh' }
  | { type: 'home:activity'; item: HomeActivity }
  | {
      type: 'init'
      canvas: Canvas
      presences: Presence[]
      activity: ActivityItem[]
      tasks: AgentTask[]
      feedback: TaskFeedback[]
      comments: ElementComment[]
      decisions: DesignDecision[]
      selfColor: string
      /** id of the client bundle the server is serving; 'dev' outside production */
      serverBuild: string
    }
  | { type: 'presence:join'; presence: Presence }
  | { type: 'presence:leave'; clientId: string }
  | { type: 'cursor'; clientId: string; x: number; y: number }
  | { type: 'viewport'; clientId: string; viewport: PeerViewport }
  | { type: 'editing'; clientId: string; frameId: string | null }
  | { type: 'status'; clientId: string; status: string | null }
  | { type: 'task'; task: AgentTask }
  | { type: 'feedback'; feedback: TaskFeedback }
  | { type: 'comment'; comment: ElementComment }
  | { type: 'frame:drag'; clientId: string; frameId: string; x: number; y: number; width: number; height: number }
  | { type: 'frame:created'; frame: Frame; actor: Actor }
  | { type: 'frame:updated'; frame: Frame; actor: Actor }
  /** a move, resize or rename: only the changed fields, never the html */
  | {
      type: 'frame:patched'
      frameId: string
      patch: Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height'>>
      updatedAt: number
      updatedBy: string
      actor: Actor
    }
  /** a live stream or reveal grew the frame: `chunk` goes at raw offset `at`.
   *  Heal the accumulated raw html before rendering; a frame:updated with the
   *  whole frame always ends the stream. */
  | {
      type: 'frame:append'
      frameId: string
      at: number
      chunk: string
      updatedAt: number
      updatedBy: string
      actor: Actor
    }
  | { type: 'frame:deleted'; frameId: string; actor: Actor }
  | { type: 'frame:streaming'; frameId: string; active: boolean; actor: Actor }
  | { type: 'canvas:renamed'; name: string; actor: Actor }
  /** a style-guide doc was written, moved (doc set) or deleted (doc null) */
  | { type: 'guidelines'; name: string; doc: GuidelineDoc | null; actor: Actor }
  /** the canvas theme changed; carries the whole new theme */
  | { type: 'theme'; theme: CanvasTheme; actor: Actor }
  /** a component definition was written or tombstoned (deletedAt set) */
  | { type: 'component'; component: ComponentDef; actor: Actor }
  /** a frame was pinned to (reference set) or unpinned from (null) Memory */
  | { type: 'reference'; id: string; reference: MemoryReference | null; actor: Actor }
  /** a design decision was captured into Memory */
  | { type: 'decision'; decision: DesignDecision }
  | { type: 'canvas:deleted' }
  | { type: 'activity'; item: ActivityItem }

export const CURSOR_PALETTE = [
  '#2743EE', // cursor blue — the brand accent leads
  '#0E9F6E', // green
  '#8B5CF6', // violet
  '#D0341F', // vermillion
  '#C77800', // amber
  '#D62A7E', // magenta
  '#0E8A8A', // teal
  '#8E2E5C', // plum
]

export function colorFor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  /* the modulo keeps the index in range */
  return CURSOR_PALETTE[h % CURSOR_PALETTE.length]!
}
