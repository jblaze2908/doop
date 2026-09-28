import { nanoid } from 'nanoid'
import { store } from './store.ts'
import { designOfCanvas } from './designSystems.ts'
import * as persist from './db/persist.ts'
import * as thumbs from './thumbs.ts'
import { colorFor } from '../shared/types.ts'
import { mentionedRole } from '../shared/agents.ts'
import { decodeEscapedHtml, looksEscapedHtml, repairEscapedHtml } from './escapedHtml.ts'
import { resolveFonts } from './theme.ts'
import { compileTheme } from '../shared/theme.ts'
import { MAX_FRAME_HTML_BYTES } from './limits.ts'
import {
  componentUsages,
  hostBoxWarning,
  liveComponents,
  MAX_COMPONENTS,
  normalizeComponent,
  normalizeComponentName,
  type ComponentDef,
  type ComponentInput,
} from '../shared/components.ts'
import {
  mergeTokens,
  normalizeFontSpecs,
  normalizeThemeCss,
  normalizeToken,
  type CanvasTheme,
  type ThemeTokenInput,
} from '../shared/theme.ts'
import type {
  Actor,
  ActorKind,
  ActivityItem,
  AgentTask,
  DesignDecision,
  ElementComment,
  Frame,
  GuidelineDoc,
  MemoryReference,
  ServerMessage,
  TaskFeedback,
} from '../shared/types.ts'

/**
 * Mutations shared by the REST API and the MCP tools. Every mutation
 * appends to the canvas activity log and broadcasts to the ws room.
 */

type Broadcast = (canvasId: string, msg: ServerMessage, excludeClientId?: string) => void
type AgentTouch = (
  canvasId: string,
  agentName: string,
  frameId?: string | null,
  status?: string | null,
  owner?: string,
) => void

let broadcast: Broadcast = () => {}
let agentTouch: AgentTouch = () => {}

export function wire(b: Broadcast, t: AgentTouch) {
  broadcast = b
  agentTouch = t
}

const activityLog = new Map<string, ActivityItem[]>() // canvasId -> items (newest first)

/** Fill the log maps from the database at boot. */
export function hydrateLogs(data: {
  tasks: Map<string, AgentTask[]>
  feedback: Map<string, TaskFeedback[]>
  comments: Map<string, ElementComment[]>
  activity: Map<string, ActivityItem[]>
  decisions: Map<string, DesignDecision[]>
}) {
  for (const [canvasId, list] of data.tasks) taskLog.set(canvasId, list)
  for (const [canvasId, list] of data.feedback) feedbackLog.set(canvasId, list)
  for (const [canvasId, list] of data.comments) commentLog.set(canvasId, list)
  for (const [canvasId, list] of data.activity) activityLog.set(canvasId, list)
  for (const [canvasId, list] of data.decisions) decisionLog.set(canvasId, list)
  failInterruptedWork()
}

/** Work that was mid-flight when the process last died (deploy, crash,
 *  dev restart): no agent will ever finish it, so at boot it becomes a
 *  visible, retryable failure instead of sitting "in progress" forever. */
function failInterruptedWork() {
  const reason = 'Interrupted by a server restart. Retry when you are ready.'
  const now = Date.now()
  for (const [canvasId, list] of taskLog) {
    for (const t of list) {
      if (t.endedAt || t.failedAt || !t.agentName) continue
      if (t.queuedBy) {
        /* a claimed card whose run died — retryable */
        t.failedAt = now
        t.failureReason = reason
      } else {
        /* a live status row from the dead process — just close it out */
        t.endedAt = now
      }
      persist.saveTask(canvasId, t)
    }
  }
}

export function getActivity(canvasId: string): ActivityItem[] {
  return activityLog.get(canvasId) ?? []
}

function logActivity(canvasId: string, actor: Actor, message: string, frameId?: string) {
  const item: ActivityItem = {
    id: nanoid(8),
    actorName: actor.name,
    actorKind: actor.kind,
    actorColor: actor.color,
    message,
    frameId,
    at: Date.now(),
  }
  const list = activityLog.get(canvasId) ?? []
  list.unshift(item)
  if (list.length > 100) list.length = 100
  activityLog.set(canvasId, list)
  persist.saveActivity(canvasId, item)
  broadcast(canvasId, { type: 'activity', item })
}

export function resolveActor(
  raw: { name?: string; kind?: string; clientId?: string; owner?: string } | undefined,
): Actor {
  const kind = raw?.kind === 'agent' ? 'agent' : raw?.kind === 'user' ? 'user' : 'agent'
  const name = raw?.name?.trim() || (kind === 'agent' ? 'AI Agent' : 'Anonymous')
  return { name, kind, color: colorFor(name), clientId: raw?.clientId, owner: raw?.owner }
}

function touch(canvasId: string, actor: Actor, frameId?: string | null) {
  if (actor.kind === 'agent') agentTouch(canvasId, actor.name, frameId, undefined, actor.owner)
}

/** Refresh an agent's presence without changing its frame or status — an
 *  MCP read counts as arrival, not only a mutation. */
export function heartbeatAgent(canvasId: string, actor: Actor) {
  touch(canvasId, actor)
}

/** Same agent identity = same name. (Owner-scoping deferred until MCP auth.) */
function sameAgent(t: { agentName: string }, actor: Actor): boolean {
  return t.agentName === actor.name
}

/* ------------------------------------------------------------------ */
/* Agent tasks: every set_status becomes a task entry, so the client   */
/* can show a per-agent history of work (à la Cursor's agent panel),   */
/* not just the current status. A new status completes the previous.   */
/* ------------------------------------------------------------------ */

const taskLog = new Map<string, AgentTask[]>() // canvasId -> tasks (newest first)

export function getTasks(canvasId: string): AgentTask[] {
  return taskLog.get(canvasId) ?? []
}

/** Which canvas a task lives on — routes that take a bare task id resolve it
 *  here so the canvas access check can run before mutating. */
export function taskCanvasId(taskId: string): string | undefined {
  for (const [canvasId, list] of taskLog) if (list.some((t) => t.id === taskId)) return canvasId
  return undefined
}

/** Agent announces what it is working on right now (empty string clears it). */
export function setAgentStatus(canvasId: string, actor: Actor, status: string) {
  const clean = status.trim()
  agentTouch(canvasId, actor.name, undefined, clean || null, actor.owner)

  const list = taskLog.get(canvasId) ?? []
  /* board cards stay open until explicitly completed — a status change
     narrates work ON a card, it doesn't end it */
  const open = list.find((t) => sameAgent(t, actor) && !t.endedAt && !t.queuedBy)
  if (open?.status === clean) return // same status re-posted: nothing new
  if (open) {
    open.endedAt = Date.now()
    persist.saveTask(canvasId, open)
    broadcast(canvasId, { type: 'task', task: open })
  }
  if (clean) {
    const task: AgentTask = {
      id: nanoid(8),
      agentName: actor.name,
      owner: actor.owner,
      color: actor.color,
      status: clean,
      startedAt: Date.now(),
    }
    list.unshift(task)
    if (list.length > 100) list.length = 100
    taskLog.set(canvasId, list)
    persist.saveTask(canvasId, task)
    broadcast(canvasId, { type: 'task', task })
    logActivity(canvasId, actor, `is working on: ${clean}`)
  }
}

/* ------------------------------------------------------------------ */
/* Task feedback: humans reply to a task in the UI; the text is        */
/* delivered to the agent inside its NEXT MCP tool result (MCP is      */
/* pull-based — the result-nudge layer is our channel into the agent). */
/* ------------------------------------------------------------------ */

const feedbackLog = new Map<string, TaskFeedback[]>() // canvasId -> entries (newest first)

export function getFeedback(canvasId: string): TaskFeedback[] {
  return feedbackLog.get(canvasId) ?? []
}

/** Look a feedback entry up by id (it carries its canvasId) for access checks. */
export function findFeedback(feedbackId: string): TaskFeedback | undefined {
  for (const list of feedbackLog.values()) {
    const fb = list.find((f) => f.id === feedbackId)
    if (fb) return fb
  }
  return undefined
}

export function addTaskFeedback(taskId: string, from: string, text: string): TaskFeedback | undefined {
  const clean = text.trim()
  if (!clean) return undefined
  for (const [canvasId, tasks] of taskLog) {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) continue
    const fb: TaskFeedback = {
      id: nanoid(8),
      taskId,
      canvasId,
      agentName: task.agentName,
      from,
      text: clean,
      at: Date.now(),
    }
    const list = feedbackLog.get(canvasId) ?? []
    list.unshift(fb)
    if (list.length > 100) list.length = 100
    feedbackLog.set(canvasId, list)
    persist.saveFeedback(fb)
    broadcast(canvasId, { type: 'feedback', feedback: fb })
    logActivity(
      canvasId,
      resolveActor({ name: from, kind: 'user' }),
      `left feedback on ${task.agentName}’s task: “${clean}”`,
    )
    return fb
  }
  return undefined
}

/** Open feedback on this canvas, claimed by this agent: a canvas-level queue
 *  where the first identified agent call wins. */
export function takeFeedbackFor(canvasId: string, agentName: string): TaskFeedback[] {
  const pending = (feedbackLog.get(canvasId) ?? []).filter((f) => !f.deliveredAt && !f.failedAt)
  for (const f of pending) {
    f.deliveredAt = Date.now()
    f.claimedBy = agentName
    persist.saveFeedback(f)
    broadcast(canvasId, { type: 'feedback', feedback: f }) // clients flip the entry to "picked up"
  }
  return pending
}

export function retryTaskFeedback(feedbackId: string, by: string): TaskFeedback | undefined {
  for (const [canvasId, list] of feedbackLog) {
    const feedback = list.find((f) => f.id === feedbackId)
    if (!feedback) continue
    if (!feedback.failedAt) return feedback
    delete feedback.deliveredAt
    delete feedback.claimedBy
    delete feedback.completedAt
    delete feedback.failedAt
    delete feedback.failureReason
    persist.saveFeedback(feedback)
    broadcast(canvasId, { type: 'feedback', feedback })
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), 'retried agent feedback')
    return feedback
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Element comments: pinned to a specific element inside a frame.      */
/* A comment that @mentions an agent role is flagged as a request for  */
/* an agent; the rest are notes for the humans in the room.            */
/* ------------------------------------------------------------------ */

const commentLog = new Map<string, ElementComment[]>() // canvasId -> entries (newest first)

export function getComments(canvasId: string): ElementComment[] {
  return commentLog.get(canvasId) ?? []
}

/** Look a comment up by id (it carries its canvasId) for access checks. */
export function findComment(commentId: string): ElementComment | undefined {
  for (const list of commentLog.values()) {
    const c = list.find((x) => x.id === commentId)
    if (c) return c
  }
  return undefined
}

export function addElementComment(
  frameId: string,
  input: { selector: string; snippet: string; text: string },
  from: string,
): ElementComment | undefined {
  const frame = store.getFrame(frameId)
  if (!frame) return undefined
  return postComment(
    frame,
    { selector: String(input.selector ?? '').slice(0, 300), snippet: String(input.snippet ?? '').slice(0, 400) },
    input.text,
    from,
  )
}

/** Reply inside a thread: the reply inherits the root comment's element so an
 *  @mention in it carries the same anchor the conversation is about. */
export function replyToComment(
  commentId: string,
  text: string,
  from: string,
  kind: ActorKind = 'user',
): ElementComment | undefined {
  const open = openThread(commentId)
  if (!open) return undefined
  const { root, frame } = open
  return postComment(frame, { selector: root.selector, snippet: root.snippet, parentId: root.id }, text, from, kind)
}

/** The root and frame a reply to this comment would land on, or undefined
 *  when the thread is resolved or its frame is gone. */
export function openThread(commentId: string): { root: ElementComment; frame: Frame } | undefined {
  const parent = findComment(commentId)
  if (!parent) return undefined
  const root = parent.parentId ? findComment(parent.parentId) : parent
  if (!root || root.resolvedAt) return undefined
  const frame = store.getFrame(root.frameId)
  if (!frame) return undefined
  return { root, frame }
}

function postComment(
  frame: Frame,
  anchor: { selector: string; snippet: string; parentId?: string },
  text: string,
  from: string,
  kind: ActorKind = 'user',
): ElementComment | undefined {
  const clean = text.trim()
  if (!clean) return undefined
  /* @draft, @brand, @a11y… — the mention flags the comment as a request for an agent */
  const mentioned = mentionedRole(clean)
  const list = commentLog.get(frame.canvasId) ?? []
  /* strictly increasing per canvas: thread order is reconstructed from `at`
     after a restart, so two messages must never share a timestamp */
  const at = Math.max(Date.now(), (list[0]?.at ?? 0) + 1)
  const comment: ElementComment = {
    id: nanoid(8),
    canvasId: frame.canvasId,
    frameId: frame.id,
    selector: anchor.selector,
    snippet: anchor.snippet,
    from,
    text: clean,
    at,
    ...(mentioned ? { forAgent: true, targetAgent: mentioned.name } : {}),
    ...(anchor.parentId ? { parentId: anchor.parentId } : {}),
  }
  list.unshift(comment)
  if (list.length > 100) list.length = 100
  commentLog.set(frame.canvasId, list)
  persist.saveComment(comment)
  broadcast(frame.canvasId, { type: 'comment', comment })
  const excerpt = clean.length > 80 ? clean.slice(0, 77) + '…' : clean
  logActivity(
    frame.canvasId,
    resolveActor({ name: from, kind }),
    anchor.parentId
      ? `replied to a comment in “${frame.name}”: “${excerpt}”`
      : `commented on an element in “${frame.name}”: “${excerpt}”`,
    frame.id,
  )
  return comment
}

export function retryComment(commentId: string, by: string): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const comment = list.find((c) => c.id === commentId)
    if (!comment || comment.resolvedAt) continue
    if (!comment.failedAt) return comment
    delete comment.claimedBy
    delete comment.claimedAt
    delete comment.failedAt
    delete comment.failureReason
    persist.saveComment(comment)
    broadcast(canvasId, { type: 'comment', comment })
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), 'retried an element comment', comment.frameId)
    return comment
  }
  return undefined
}

export function resolveComment(commentId: string, by: string): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const c = list.find((x) => x.id === commentId)
    if (!c) continue
    if (c.resolvedAt) return c
    /* resolving the root closes its whole thread: an open reply under a
       resolved pin would be invisible yet still queued for an agent */
    const closing = c.parentId ? [c] : list.filter((x) => x.id === c.id || (x.parentId === c.id && !x.resolvedAt))
    for (const item of closing) {
      item.resolvedBy = by
      item.resolvedAt = Date.now()
      persist.saveComment(item)
      broadcast(canvasId, { type: 'comment', comment: item })
      /* a resolved @agent comment was an instruction that got carried out —
         capture it as a decision (plain human-to-human notes are not) */
      if (item.forAgent) {
        captureDecision(canvasId, {
          text: item.text,
          source: 'comment',
          frameId: item.frameId,
          from: item.from,
          agentName: item.claimedBy ?? (by !== item.from ? by : undefined),
        })
      }
    }
    return c
  }
  return undefined
}

/** True if the agent has an explicitly announced (non-auto) task open. */
export function hasAnnouncedTask(canvasId: string, actor: Actor): boolean {
  return (taskLog.get(canvasId) ?? []).some((t) => sameAgent(t, actor) && !t.endedAt && !t.auto)
}

/** How many frames a task remembers — the Agents panel only ever jumps to the
 *  latest one; the rest are history for a sweeping multi-frame task. */
const TASK_FRAMES_CAP = 20

/** Note that the agent's open tasks touched a frame (most recent last), so a
 *  click on the task in the Agents panel can fly the camera there. A claimed
 *  card and a set_status task can be open side by side — both are the work. */
function trackTaskFrame(canvasId: string, actor: Actor, frameId: string) {
  for (const open of taskLog.get(canvasId) ?? []) {
    if (!sameAgent(open, actor) || open.endedAt) continue
    if (open.frameIds?.at(-1) === frameId) continue
    open.frameIds = [...(open.frameIds ?? []).filter((id) => id !== frameId), frameId].slice(-TASK_FRAMES_CAP)
    persist.saveTask(canvasId, open)
    broadcast(canvasId, { type: 'task', task: open })
  }
}

/* Agents that never call set_status still get a task inferred from what
   they are visibly doing, so the Tasks panel is never silently empty. */
function autoTask(canvasId: string, actor: Actor, status: string, frameId: string) {
  const list = taskLog.get(canvasId) ?? []
  if (list.some((t) => sameAgent(t, actor) && !t.endedAt)) {
    trackTaskFrame(canvasId, actor, frameId) // any open task wins — it just gains the frame
    return
  }
  const task: AgentTask = {
    id: nanoid(8),
    agentName: actor.name,
    owner: actor.owner,
    color: actor.color,
    status,
    startedAt: Date.now(),
    auto: true,
    frameIds: [frameId],
  }
  list.unshift(task)
  if (list.length > 100) list.length = 100
  taskLog.set(canvasId, list)
  persist.saveTask(canvasId, task)
  broadcast(canvasId, { type: 'task', task })
}

function endAutoTask(canvasId: string, actor: Actor) {
  const open = (taskLog.get(canvasId) ?? []).find((t) => sameAgent(t, actor) && !t.endedAt && t.auto)
  if (open) {
    open.endedAt = Date.now()
    persist.saveTask(canvasId, open)
    broadcast(canvasId, { type: 'task', task: open })
  }
}

/** Close an agent's open tasks, e.g. when its presence expires. */
export function endAgentTasks(canvasId: string, agentName: string) {
  for (const t of taskLog.get(canvasId) ?? []) {
    if (t.agentName === agentName && !t.endedAt) {
      if (t.queuedBy) {
        /* Interrupted cards pause for a human decision; never auto-retry. */
        if (t.failedAt) continue
        t.failedAt = Date.now()
        t.failureReason = `${agentName} disconnected before finishing. Retry when you are ready.`
      } else {
        t.endedAt = Date.now()
      }
      persist.saveTask(canvasId, t)
      broadcast(canvasId, { type: 'task', task: t })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Board cards: work humans queue for agents. Same AgentTask object —  */
/* queuedBy set, agentName empty while it waits.                       */
/* ------------------------------------------------------------------ */

/** A card's text is the whole request — never shorten it for display here;
 *  the board clamps long headings visually. The cap only stops a pasted
 *  document from being stored and broadcast verbatim. */
export const MAX_CARD_CHARS = 4_000

export function addQueuedCard(canvasId: string, title: string, from: string): AgentTask | undefined {
  const clean = title.trim().slice(0, MAX_CARD_CHARS)
  if (!clean || !store.getCanvas(canvasId)) return undefined
  const list = taskLog.get(canvasId) ?? []
  const duplicate = list.find((t) => t.queuedBy === from && !t.endedAt && t.status === clean)
  if (duplicate) return duplicate
  const card: AgentTask = {
    id: nanoid(8),
    agentName: '',
    color: colorFor(from),
    status: clean,
    startedAt: Date.now(),
    queuedBy: from,
  }
  list.unshift(card)
  taskLog.set(canvasId, trimTaskLog(list))
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, resolveActor({ name: from, kind: 'user' }), `queued a card: “${clean}”`)
  bumpQueue(canvasId)
  return card
}

const TASK_LOG_CAP = 100

/** Keep the task log at its cap without losing open work: the oldest FINISHED
 *  tasks go first, so a queued, claimed or failed card never falls off the
 *  board. Open cards past the cap are kept as well. */
export function trimTaskLog(list: AgentTask[]): AgentTask[] {
  if (list.length <= TASK_LOG_CAP) return list
  const isOpen = (t: AgentTask) => !!t.queuedBy && !t.endedAt
  let room = TASK_LOG_CAP - list.filter(isOpen).length
  const kept: AgentTask[] = []
  for (const t of list) {
    if (isOpen(t)) kept.push(t)
    else if (room > 0) {
      kept.push(t)
      room--
    }
  }
  list.length = 0
  list.push(...kept)
  return list
}

export function completeCard(canvasId: string, cardId: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt) return card
  card.endedAt = Date.now()
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  return card
}

export function retryCard(canvasId: string, cardId: string, by: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt) return card
  if (!card.failedAt) return card
  card.agentName = ''
  delete card.claimedAt
  delete card.failedAt
  delete card.failureReason
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `retried a card: “${card.status}”`)
  bumpQueue(canvasId)
  return card
}

/* Cards for MCP agents: nothing on the server works the queue, so agents list
   it (get_cards), take one (claim_card) and report back (finish_card). */

/** A failure reason is a note for the human who retries, not a report. */
const MAX_REASON_CHARS = 500

export type CardResult = { ok: true; card: AgentTask } | { ok: false; error: string }

function findCard(canvasId: string, cardId: string): AgentTask | undefined {
  return (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
}

/** Cards not yet done, oldest first so the queue is worked in the order humans filled it. */
export function openCards(canvasId: string): AgentTask[] {
  return (taskLog.get(canvasId) ?? []).filter((t) => t.queuedBy && !t.endedAt).reverse()
}

const isQueued = (t: AgentTask) => !!t.queuedBy && !t.agentName && !t.failedAt && !t.endedAt

/** Whether this agent holds a claimed card that is still in flight. */
export function holdsCard(canvasId: string, agentName: string): boolean {
  return (taskLog.get(canvasId) ?? []).some((t) => t.queuedBy && t.agentName === agentName && !t.failedAt && !t.endedAt)
}

/** Claiming is exclusive: a card another agent holds, or one that failed and
 *  waits for a human retry, stays where it is. Re-claiming your own is a no-op. */
export function claimCard(canvasId: string, cardId: string, actor: Actor): CardResult {
  const card = findCard(canvasId, cardId)
  if (!card) return { ok: false, error: `no card with id ${cardId} on this canvas` }
  if (card.endedAt) return { ok: false, error: 'that card is already done' }
  if (card.failedAt) return { ok: false, error: 'that card failed and waits for a human to retry it' }
  if (card.agentName && !sameAgent(card, actor)) return { ok: false, error: `${card.agentName} already claimed it` }
  touch(canvasId, actor)
  if (card.agentName) return { ok: true, card }
  card.agentName = actor.name
  card.owner = actor.owner
  card.color = actor.color
  card.claimedAt = Date.now()
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, actor, `picked up a card: “${card.status}”`)
  return { ok: true, card }
}

/** Only the claimant finishes a card. A failed card waits for a human retry;
 *  finishing it done still counts when the work landed after all (e.g. the
 *  agent came back after its presence lapsed). */
export function finishCard(
  canvasId: string,
  cardId: string,
  actor: Actor,
  outcome: 'done' | 'failed',
  reason = '',
): CardResult {
  const card = findCard(canvasId, cardId)
  if (!card) return { ok: false, error: `no card with id ${cardId} on this canvas` }
  if (card.endedAt) return { ok: true, card }
  if (!sameAgent(card, actor)) {
    return { ok: false, error: card.agentName ? `${card.agentName} holds that card` : 'claim it with claim_card first' }
  }
  touch(canvasId, actor)
  if (outcome === 'done') {
    delete card.failedAt
    delete card.failureReason
    completeCard(canvasId, cardId)
    logActivity(canvasId, actor, `finished a card: “${card.status}”`)
    return { ok: true, card }
  }
  if (card.failedAt) return { ok: true, card }
  card.failedAt = Date.now()
  card.failureReason = reason.trim().slice(0, MAX_REASON_CHARS) || `${actor.name} could not finish it.`
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, actor, `could not finish a card: “${card.status}”`)
  return { ok: true, card }
}

/* Per-process: a canvas's queue version moves when a card becomes claimable
   (queued or retried); each agent is told once per version. A restart costs at
   most one repeat notice, the same trade-off as guidelinesSeen. */
const queueVersion = new Map<string, number>()
const queueToldAt = new Map<string, number>()

function bumpQueue(canvasId: string) {
  queueVersion.set(canvasId, (queueVersion.get(canvasId) ?? 0) + 1)
}

/** Mark the queue as seen by this agent (get_cards shows it all). */
export function markQueueSeen(canvasId: string, agentName: string) {
  queueToldAt.set(`${canvasId}:${agentName}`, queueVersion.get(canvasId) ?? 0)
}

/** Queued cards when the queue moved since this agent last heard; runs on every
 *  tool result that carries feedback, so the unchanged case is two map reads. */
export function takeQueueNews(canvasId: string, agentName: string): AgentTask[] {
  const key = `${canvasId}:${agentName}`
  const version = queueVersion.get(canvasId) ?? 0
  if (queueToldAt.get(key) === version) return []
  queueToldAt.set(key, version)
  return openCards(canvasId).filter(isQueued)
}

/* ------------------------------------------------------------------ */
/* Live rendering of agent writes.                                     */
/*                                                                     */
/* Streams (append_frame_html): every chunk broadcasts the moment it   */
/* arrives — viewers track the agent's real progress with no artificial*/
/* pacing. Stream state only carries the "designing…" badge, the       */
/* escape latch, and a timeout for agents that never send done=true.   */
/*                                                                     */
/* One-shot writes (set_frame_html, agent create_frame with html) play */
/* back as a short typewriter reveal so a paste reads as designing     */
/* rather than blinking in — drained against a fixed deadline so       */
/* playback time never grows with document size.                       */
/* ------------------------------------------------------------------ */

interface StreamState {
  actor: Actor
  /** the opening chunk was HTML-escaped: decode every chunk of this stream */
  escaped: boolean
  lastActivity: number
}

const streams = new Map<string, StreamState>() // frameId -> state

interface RevealState {
  actor: Actor
  /** how many chars of the frame's html are currently revealed to viewers */
  shown: number
  /** when the playback should have fully drained */
  deadline: number
}

const reveals = new Map<string, RevealState>() // frameId -> state

const TICK_MS = 80
const REVEAL_MIN_MS = 2500 // even a tiny one-shot plays for a beat
const REVEAL_MAX_MS = 5000 // even a huge one-shot lands within 5s
const REVEAL_CHARS_PER_MS = 8
const STREAM_IDLE_MS = 30_000

function revealDuration(chars: number): number {
  return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, chars / REVEAL_CHARS_PER_MS))
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

function appendMessage(frame: Frame, at: number, chunk: string, actor: Actor): ServerMessage {
  return {
    type: 'frame:append',
    frameId: frame.id,
    at,
    chunk,
    updatedAt: frame.updatedAt,
    updatedBy: frame.updatedBy,
    actor,
  }
}

function startReveal(frame: Frame, actor: Actor, shown: number) {
  reveals.set(frame.id, { actor, shown, deadline: Date.now() + revealDuration(frame.html.length - shown) })
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId: frame.id, active: true, actor })
}

function finishReveal(frameId: string) {
  const r = reveals.get(frameId)
  if (!r) return
  reveals.delete(frameId)
  const frame = store.getFrame(frameId)
  if (!frame) return
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: false, actor: r.actor })
  endAutoTask(frame.canvasId, r.actor)
}

function finishStream(frameId: string, logDone: boolean) {
  const s = streams.get(frameId)
  if (!s) return
  streams.delete(frameId)
  const frame = store.getFrame(frameId)
  if (!frame) return
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: false, actor: s.actor })
  if (logDone) logActivity(frame.canvasId, s.actor, `finished designing “${frame.name}”`, frameId)
  endAutoTask(frame.canvasId, s.actor)
}

setInterval(() => {
  const now = Date.now()
  for (const [frameId, r] of reveals) {
    const frame = store.getFrame(frameId)
    if (!frame) {
      reveals.delete(frameId)
      continue
    }
    const total = frame.html.length
    const remaining = total - r.shown

    if (remaining <= 0) {
      /* fully revealed: emit the exact html and close */
      broadcast(frame.canvasId, { type: 'frame:updated', frame, actor: r.actor })
      finishReveal(frameId)
      continue
    }

    /* drain the rest evenly so the playback lands exactly at the deadline;
       each tick sends only the newly revealed slice (see frame:append) */
    const ticksLeft = Math.max(1, Math.ceil((r.deadline - now) / TICK_MS))
    const at = r.shown
    r.shown = Math.min(total, r.shown + Math.ceil(remaining / ticksLeft))
    if (r.shown >= total) broadcast(frame.canvasId, { type: 'frame:updated', frame, actor: r.actor })
    else broadcast(frame.canvasId, appendMessage(frame, at, frame.html.slice(at, r.shown), r.actor))
  }
  for (const [frameId, s] of streams) {
    if (now - s.lastActivity > STREAM_IDLE_MS) finishStream(frameId, false) // agent died mid-stream
  }
}, TICK_MS)

export function appendFrameHtml(
  frameId: string,
  chunk: string,
  actor: Actor,
  opts: { start?: boolean; done?: boolean } = {},
): Frame | undefined {
  const before = store.getFrame(frameId)
  if (!before) return undefined

  const starting = opts.start || !streams.has(frameId)
  /* an agent that escapes its opening chunk escapes the whole stream, so latch
     the verdict there: a chunk mid-design can hold a legitimate `&lt;` (a code
     sample) and must never be sniffed on its own */
  const escaped = starting ? looksEscapedHtml(chunk) : (streams.get(frameId)?.escaped ?? false)
  const piece = escaped ? decodeEscapedHtml(chunk) : chunk
  /* read before the update: the store mutates the frame object in place */
  const at = opts.start ? 0 : before.html.length
  const html = opts.start ? piece : before.html + piece
  const frame = store.updateFrame(frameId, { html }, actor.name)!

  if (starting) {
    finishReveal(frameId) /* a live stream overrides any one-shot playback in flight */
    streams.set(frameId, { actor, escaped, lastActivity: Date.now() })
    broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: true, actor })
    logActivity(frame.canvasId, actor, `is designing “${frame.name}” live…`, frameId)
    autoTask(frame.canvasId, actor, `Designing “${frame.name}”`, frameId)
  }
  const s = streams.get(frameId)!
  s.lastActivity = Date.now()
  s.escaped = escaped

  /* the chunk renders the moment it arrives — viewers see the agent's real
     progress. Mid-stream only the chunk travels; the last message carries
     the whole frame, which also resyncs any viewer that missed a chunk. */
  if (opts.done) broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
  else broadcast(frame.canvasId, appendMessage(frame, at, piece, actor))
  if (opts.done) finishStream(frameId, true)

  touch(frame.canvasId, actor, frameId)
  return frame
}

/* ------------------------------------------------------------------ */

export function createFrame(
  canvasId: string,
  input: { name: string; x?: number; y?: number; width?: number; height?: number; html?: string; demo?: boolean },
  actor: Actor,
): Frame | undefined {
  if (input.html !== undefined) input = { ...input, html: repairEscapedHtml(input.html) }
  const frame = store.createFrame(canvasId, input, actor.name)
  if (!frame) return undefined
  if (actor.kind === 'agent' && frame.html.length > 0) {
    /* agent one-shot creation still plays back as a reveal */
    broadcast(canvasId, { type: 'frame:created', frame: { ...frame, html: '' }, actor })
    startReveal(frame, actor, 0)
    autoTask(canvasId, actor, `Designing “${frame.name}”`, frame.id)
  } else {
    broadcast(canvasId, { type: 'frame:created', frame, actor })
  }
  logActivity(canvasId, actor, `created frame “${frame.name}”`, frame.id)
  touch(canvasId, actor, frame.id)
  return frame
}

/** One exact find/replace, the same contract as edit_frame_html. */
export interface FrameEdit {
  old_str: string
  new_str: string
}

const COPY_GAP = 80

/** Right of the source, pushed further right past any frame the copy would
 *  cover. O(frames²) per duplicate, fine at canvas sizes. */
function besideFrame(frames: Frame[], source: Frame, width: number, height: number): { x: number; y: number } {
  const y = source.y
  let x = source.x + source.width + COPY_GAP
  const covers = (f: Frame) => f.x < x + width && x < f.x + f.width && f.y < y + height && y < f.y + f.height
  for (let hit = frames.find(covers); hit; hit = frames.find(covers)) x = hit.x + hit.width + COPY_GAP
  return { x, y }
}

/** Copy a frame on its canvas, optionally resized and with edits applied to the
 *  copy — a variant (dark mode, another headline) without re-sending the
 *  document. Edits run in order and each must match exactly once at its turn;
 *  any miss creates nothing. */
export function duplicateFrame(
  frameId: string,
  opts: { name?: string; x?: number; y?: number; width?: number; height?: number; edits?: FrameEdit[] },
  actor: Actor,
): { ok: true; frame: Frame } | { ok: false; error: string } {
  const source = store.getFrame(frameId)
  const canvas = source && store.getCanvas(source.canvasId)
  if (!source || !canvas) return { ok: false, error: `no frame with id ${frameId}` }
  let html = source.html
  for (const [i, edit] of (opts.edits ?? []).entries()) {
    const count = edit.old_str ? html.split(edit.old_str).length - 1 : 0
    if (count !== 1) {
      return {
        ok: false,
        error: `edit ${i + 1}: old_str matches ${count} times in the copy — it must match exactly once`,
      }
    }
    /* a function replacement: a string one would expand $& / $1 inside new_str */
    html = html.replace(edit.old_str, () => edit.new_str)
  }
  if (html.length > MAX_FRAME_HTML_BYTES) return { ok: false, error: 'the edited copy exceeds the frame size limit' }
  const width = opts.width ?? source.width
  const height = opts.height ?? source.height
  const beside = besideFrame(canvas.frames, source, width, height)
  const frame = store.createFrame(
    canvas.id,
    {
      name: opts.name?.trim() || `${source.name} copy`,
      x: opts.x ?? beside.x,
      y: opts.y ?? beside.y,
      width,
      height,
      html,
    },
    actor.name,
  )
  if (!frame) return { ok: false, error: `no frame with id ${frameId}` }
  /* no typewriter reveal, even for an agent: a copy is not new work */
  broadcast(canvas.id, { type: 'frame:created', frame, actor })
  logActivity(canvas.id, actor, `duplicated “${source.name}” as “${frame.name}”`, frame.id)
  touch(canvas.id, actor, frame.id)
  return { ok: true, frame }
}

export function updateFrame(
  frameId: string,
  patch: Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html'>>,
  actor: Actor,
): Frame | undefined {
  const before = store.getFrame(frameId)
  if (!before) return undefined
  if (patch.html !== undefined) patch = { ...patch, html: repairEscapedHtml(patch.html) }
  const prevName = before.name
  const prevHtml = before.html
  const frame = store.updateFrame(frameId, patch, actor.name)!

  const htmlChanged = patch.html !== undefined && patch.html !== prevHtml
  if (htmlChanged && actor.kind === 'agent') {
    finishStream(frameId, false) /* a full replace ends an open append stream */
    const prefix = commonPrefixLen(prevHtml, frame.html)
    /* mostly-unchanged replace (small tweak): broadcast at once — the client
       morphs the live DOM in place, so a reveal would only add churn */
    const smallTweak = prefix >= frame.html.length * 0.5 && prefix >= prevHtml.length * 0.5
    const openReveal = reveals.get(frameId)
    if (openReveal) {
      /* new content mid-playback: rewind to the divergence and re-arm the deadline */
      openReveal.actor = actor
      openReveal.shown = Math.min(openReveal.shown, prefix)
      openReveal.deadline = Date.now() + revealDuration(frame.html.length - openReveal.shown)
      trackTaskFrame(frame.canvasId, actor, frameId)
    } else if (smallTweak) {
      broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
      logActivity(frame.canvasId, actor, `tweaked the design of “${frame.name}”`, frame.id)
      autoTask(frame.canvasId, actor, `Tweaking “${frame.name}”`, frameId)
    } else {
      startReveal(frame, actor, prefix)
      logActivity(frame.canvasId, actor, `updated the design of “${frame.name}”`, frame.id)
      autoTask(frame.canvasId, actor, `Redesigning “${frame.name}”`, frameId)
    }
  } else {
    if (htmlChanged) {
      /* a human takes over: cancel any live stream or playback */
      finishStream(frameId, false)
      finishReveal(frameId)
      broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
    } else {
      /* a drag's drop or a rename: every viewer already has the html */
      const { html: _html, ...fields } = patch
      broadcast(frame.canvasId, {
        type: 'frame:patched',
        frameId,
        patch: fields,
        updatedAt: frame.updatedAt,
        updatedBy: frame.updatedBy,
        actor,
      })
    }
    if (htmlChanged) {
      logActivity(frame.canvasId, actor, `updated the design of “${frame.name}”`, frame.id)
    } else if (patch.name !== undefined && patch.name !== prevName) {
      logActivity(frame.canvasId, actor, `renamed “${prevName}” to “${frame.name}”`, frame.id)
    }
  }

  touch(frame.canvasId, actor, frame.id)
  return frame
}

export function deleteFrame(frameId: string, actor: Actor): Frame | undefined {
  /* close any live stream or playback while the frame still exists,
     so their auto “Designing…” tasks end with it */
  finishStream(frameId, false)
  finishReveal(frameId)
  const frame = store.deleteFrame(frameId)
  if (!frame) return undefined
  thumbs.purge(frameId)
  broadcast(frame.canvasId, { type: 'frame:deleted', frameId, actor })
  logActivity(frame.canvasId, actor, `deleted frame “${frame.name}”`, frame.id)
  touch(frame.canvasId, actor, null)
  return frame
}

/** Remove a canvas with everything attached to it; viewers are told to leave. */
export function deleteCanvas(canvasId: string): boolean {
  const c = store.deleteCanvas(canvasId)
  if (!c) return false
  for (const f of c.frames) thumbs.purge(f.id)
  broadcast(canvasId, { type: 'canvas:deleted' })
  taskLog.delete(canvasId)
  feedbackLog.delete(canvasId)
  commentLog.delete(canvasId)
  activityLog.delete(canvasId)
  decisionLog.delete(canvasId)
  queueVersion.delete(canvasId)
  return true
}

export function renameCanvas(canvasId: string, name: string, actor: Actor) {
  const canvas = store.renameCanvas(canvasId, name)
  if (!canvas) return undefined
  broadcast(canvasId, { type: 'canvas:renamed', name, actor })
  logActivity(canvasId, actor, `renamed the canvas to “${name}”`)
  return canvas
}

/* ------------------------------------------------------------------ */
/* Design guidelines: named markdown docs on a canvas (brand rules,    */
/* style recipes). Written mostly for agents; humans read/edit them    */
/* in the Guidelines panel.                                            */
/* ------------------------------------------------------------------ */

export const MAX_GUIDELINE_CHARS = 24_000
export const MAX_GUIDELINE_DOCS = 20
const GUIDELINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_GUIDELINE_TITLE_CHARS = 80

/** Display name of a design guide: the pretty title, else the prettified slug. */
export function guidelineTitle(doc: Pick<GuidelineDoc, 'name' | 'title'>): string {
  return doc.title ?? doc.name.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

/** First heading or non-empty line — the one-liner shown before an agent
 *  decides whether to fetch the full doc. */
export function guidelineSummary(doc: GuidelineDoc): string {
  for (const raw of doc.markdown.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line) return line.length > 120 ? line.slice(0, 117) + '…' : line
  }
  return ''
}

/** Upsert (or, with empty markdown, delete) a design doc. Returns the doc,
 *  null for a deletion, undefined when the canvas is missing; throws on
 *  invalid input with a message meant for the caller's error channel. */
export function setGuideline(
  canvasId: string,
  name: string,
  markdown: string,
  actor: Actor,
  pos?: { x: number; y: number },
  title?: string,
): GuidelineDoc | null | undefined {
  const slug = name.trim().toLowerCase()
  if (!GUIDELINE_NAME_RE.test(slug))
    throw new Error(`invalid doc name “${name}” — use a lowercase slug like "feature-image" (a-z, 0-9, hyphens)`)
  const clean = markdown.replace(/\r\n/g, '\n').trim()
  if (clean.length > MAX_GUIDELINE_CHARS)
    throw new Error(`doc is ${clean.length} chars — the limit is ${MAX_GUIDELINE_CHARS}`)
  const cleanTitle =
    title === undefined ? undefined : title.replace(/\s+/g, ' ').trim().slice(0, MAX_GUIDELINE_TITLE_CHARS)

  if (!clean) {
    const existing = store.getGuidelines(canvasId).find((d) => d.name === slug)
    if (!store.deleteGuideline(canvasId, slug)) return store.getCanvas(canvasId) ? null : undefined
    persist.saveGuidelineVersion(canvasId, slug, '', actor.name, Date.now())
    broadcast(canvasId, { type: 'guidelines', name: slug, doc: null, actor })
    logActivity(canvasId, actor, `deleted the design guide “${existing ? guidelineTitle(existing) : slug}”`)
    touch(canvasId, actor)
    return null
  }

  const existing = store.getGuidelines(canvasId)
  if (!existing.some((d) => d.name === slug) && existing.length >= MAX_GUIDELINE_DOCS)
    throw new Error(`this canvas already has ${MAX_GUIDELINE_DOCS} design guides — delete one first`)
  const doc = store.setGuideline(canvasId, slug, clean, actor.name, pos, cleanTitle)
  if (!doc) return undefined
  persist.saveGuidelineVersion(canvasId, slug, clean, actor.name, doc.updatedAt)
  broadcast(canvasId, { type: 'guidelines', name: slug, doc, actor })
  logActivity(canvasId, actor, `updated the design guide “${guidelineTitle(doc)}”`)
  touch(canvasId, actor)
  return doc
}

/** Patch design-guide metadata (card position, display title) without touching
 *  the content: no version snapshot, position changes make no activity noise. */
export function patchGuideline(
  canvasId: string,
  name: string,
  patch: { x?: number; y?: number; title?: string },
  actor: Actor,
): boolean {
  const clean: { x?: number; y?: number; title?: string } = {}
  if (patch.x !== undefined || patch.y !== undefined) {
    if (!Number.isFinite(patch.x) || !Number.isFinite(patch.y)) return false
    clean.x = patch.x
    clean.y = patch.y
  }
  if (patch.title !== undefined)
    clean.title = patch.title.replace(/\s+/g, ' ').trim().slice(0, MAX_GUIDELINE_TITLE_CHARS)
  if (Object.keys(clean).length === 0) return false
  const doc = store.patchGuideline(canvasId, name.trim().toLowerCase(), clean)
  if (!doc) return false
  broadcast(canvasId, { type: 'guidelines', name: doc.name, doc, actor })
  if (clean.title !== undefined) logActivity(canvasId, actor, `renamed a design guide to “${guidelineTitle(doc)}”`)
  return true
}

/* ------------------------------------------------------------------ */
/* Linked components: canvas-level custom elements frames instantiate. */
/* ------------------------------------------------------------------ */

/** Why a definition may not render as its author expects, if anything. */
export function componentWarnings(canvasId: string, def: ComponentDef): string[] {
  const warning = hostBoxWarning(def.css, compileTheme(designOfCanvas(canvasId).theme))
  return warning ? [warning] : []
}

/** Create or replace a definition. Returns it, undefined when the canvas is
 *  missing; throws on invalid input with a caller-facing message. */
export function setComponent(canvasId: string, input: ComponentInput, actor: Actor): ComponentDef | undefined {
  const c = store.getCanvas(canvasId)
  if (!c) return undefined
  const clean = normalizeComponent(input)
  const prev = store.getComponents(canvasId).find((d) => d.name === clean.name)
  if ((!prev || prev.deletedAt) && liveComponents(c.components).length >= MAX_COMPONENTS)
    throw new Error(`this canvas already has ${MAX_COMPONENTS} components — delete one first`)
  const def: ComponentDef = {
    ...clean,
    version: (prev?.version ?? 0) + 1,
    updatedAt: Date.now(),
    updatedBy: actor.name,
  }
  store.putComponent(canvasId, def)
  broadcast(canvasId, { type: 'component', component: def, actor })
  const used = componentUsages(c.frames, def.name).length
  logActivity(
    canvasId,
    actor,
    `${prev && !prev.deletedAt ? 'updated' : 'created'} the component <${def.name}>${used ? ` (used in ${used} frame${used === 1 ? '' : 's'})` : ''}`,
  )
  touch(canvasId, actor)
  return def
}

/** Tombstone a definition: instances keep their markup and render a visible
 *  "missing component" box. Returns false when there is nothing to delete. */
export function deleteComponent(canvasId: string, rawName: string, actor: Actor): boolean {
  const name = normalizeComponentName(rawName)
  const prev = store.getComponents(canvasId).find((d) => d.name === name)
  if (!prev || prev.deletedAt) return false
  const now = Date.now()
  const def: ComponentDef = {
    ...prev,
    version: prev.version + 1,
    updatedAt: now,
    updatedBy: actor.name,
    deletedAt: now,
  }
  store.putComponent(canvasId, def)
  broadcast(canvasId, { type: 'component', component: def, actor })
  logActivity(canvasId, actor, `deleted the component <${name}>`)
  touch(canvasId, actor)
  return true
}

/* Per-process memory of which agents have read a canvas's design docs —
   worst case after a restart is one extra nudge, same trade-off as the
   task log's announce tracking. */
const guidelinesSeen = new Set<string>()

export function markGuidelinesSeen(canvasId: string, agentName: string) {
  guidelinesSeen.add(`${canvasId}:${agentName}`)
}

export function hasSeenGuidelines(canvasId: string, agentName: string): boolean {
  return guidelinesSeen.has(`${canvasId}:${agentName}`)
}

/* same trade-off for the canvas theme and components: an agent that never saw
   them tends to paste a whole design system into each frame */
const designSystemSeen = new Set<string>()

export function markDesignSystemSeen(canvasId: string, agentName: string) {
  designSystemSeen.add(`${canvasId}:${agentName}`)
}

export function hasSeenDesignSystem(canvasId: string, agentName: string): boolean {
  return designSystemSeen.has(`${canvasId}:${agentName}`)
}

/* ------------------------------------------------------------------ */
/* Canvas theme: tokens, fonts and shared CSS every frame inherits.    */
/* ------------------------------------------------------------------ */

export interface ThemePatch {
  tokens?: { list: ThemeTokenInput[]; mode: 'merge' | 'replace' }
  css?: string
  fonts?: string[]
  utilities?: 'tailwind' | 'none'
}

/** Apply a partial theme write. Returns the new theme, undefined when the
 *  canvas is missing; throws on invalid input with a caller-facing message.
 *  Last write wins per field: everything is validated and the fonts fetched
 *  BEFORE the current theme is read, so a slow font fetch never clobbers a
 *  token write that landed while it was in flight. */
export async function setTheme(canvasId: string, patch: ThemePatch, actor: Actor): Promise<CanvasTheme | undefined> {
  if (!store.getCanvas(canvasId)) return undefined
  patch.tokens?.list.forEach(normalizeToken)
  const css = patch.css === undefined ? undefined : normalizeThemeCss(patch.css)
  const fonts = patch.fonts && normalizeFontSpecs(patch.fonts)
  const resolved = fonts && (await resolveFonts(fonts))

  const c = store.getCanvas(canvasId)
  if (!c) return undefined
  const prev = c.theme
  const unresolved = resolved ? resolved.unresolved : (prev?.unresolvedFonts ?? [])
  const utilities =
    patch.utilities === undefined ? prev?.utilities : patch.utilities === 'tailwind' ? 'tailwind' : undefined
  const theme: CanvasTheme = {
    tokens: patch.tokens ? mergeTokens(prev?.tokens ?? [], patch.tokens.list, patch.tokens.mode) : (prev?.tokens ?? []),
    css: css ?? prev?.css ?? '',
    fonts: fonts ?? prev?.fonts ?? [],
    fontFaces: resolved ? resolved.fontFaces : (prev?.fontFaces ?? ''),
    ...(unresolved.length ? { unresolvedFonts: unresolved } : {}),
    ...(utilities ? { utilities } : {}),
    version: (prev?.version ?? 0) + 1,
    updatedAt: Date.now(),
    updatedBy: actor.name,
  }
  store.setTheme(canvasId, theme)
  broadcast(canvasId, { type: 'theme', theme, actor })
  const changed = [
    ...(patch.tokens ? [`${patch.tokens.list.length} token${patch.tokens.list.length === 1 ? '' : 's'}`] : []),
    ...(css !== undefined ? ['its CSS'] : []),
    ...(fonts ? ['its fonts'] : []),
    ...(patch.utilities ? [patch.utilities === 'tailwind' ? 'Tailwind utilities on' : 'Tailwind utilities off'] : []),
  ]
  logActivity(canvasId, actor, `updated the canvas theme (${changed.join(', ') || 'no changes'})`)
  touch(canvasId, actor)
  return theme
}

/* ------------------------------------------------------------------ */
/* Design memory: pinned reference frames (exemplars) and captured     */
/* decisions (resolved agent requests, and what agents report from     */
/* their own chat). The guides above are the curated layer.            */
/* ------------------------------------------------------------------ */

export const MAX_REFERENCES = 12

const decisionLog = new Map<string, DesignDecision[]>() // canvasId -> newest first

export function getDecisions(canvasId: string): DesignDecision[] {
  return decisionLog.get(canvasId) ?? []
}

/** Record a settled design decision. Deterministic and silent in the
 *  activity feed — the client toasts "Saved to Memory" instead. */
function captureDecision(
  canvasId: string,
  input: { text: string; source: DesignDecision['source']; frameId?: string; from: string; agentName?: string },
): DesignDecision {
  const decision: DesignDecision = {
    id: nanoid(8),
    text: input.text,
    source: input.source,
    ...(input.frameId ? { frameId: input.frameId } : {}),
    from: input.from,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    at: Date.now(),
  }
  const list = decisionLog.get(canvasId) ?? []
  list.unshift(decision)
  if (list.length > 100) list.length = 100
  decisionLog.set(canvasId, list)
  persist.saveDecision(canvasId, decision)
  broadcast(canvasId, { type: 'decision', decision })
  return decision
}

export const MAX_DECISION_CHARS = 500

/** A connected agent reports a design decision its human made in conversation
 *  (the save_decision MCP tool) — the only party that hears that channel is
 *  the agent, so it is the reporter. Throws on bad input; returns undefined
 *  when the canvas is missing, null when it was a duplicate re-report. */
export function recordChatDecision(canvasId: string, text: string, actor: Actor): DesignDecision | null | undefined {
  if (!store.getCanvas(canvasId)) return undefined
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('decision text is empty')
  if (clean.length > MAX_DECISION_CHARS)
    throw new Error(
      `decision is ${clean.length} chars — keep it under ${MAX_DECISION_CHARS} (the human's words, not an essay)`,
    )
  /* agents re-tell things; the same words land in Memory once */
  if (getDecisions(canvasId).some((d) => d.text === clean)) return null
  return captureDecision(canvasId, {
    text: clean,
    source: 'chat',
    from: actor.owner ?? actor.name,
    agentName: actor.name,
  })
}

/** Pin a frame to Memory as a style reference. Throws with a caller-facing
 *  message on limits; returns undefined when canvas/frame are missing. */
export function pinReference(canvasId: string, frameId: string, actor: Actor): MemoryReference | undefined {
  const frame = store.getFrame(frameId)
  if (!frame || frame.canvasId !== canvasId) return undefined
  const existing = store.getReferences(canvasId)
  if (existing.some((r) => r.frameId === frameId && r.html === frame.html)) {
    throw new Error('this frame is already pinned to Memory in its current state')
  }
  if (existing.length >= MAX_REFERENCES)
    throw new Error(`Memory already holds ${MAX_REFERENCES} references — unpin one first`)
  const ref = store.addReference(canvasId, frame, actor.name)
  if (!ref) return undefined
  broadcast(canvasId, { type: 'reference', id: ref.id, reference: ref, actor })
  logActivity(canvasId, actor, `pinned “${frame.name}” to Memory as a style reference`, frameId)
  return ref
}

export function unpinReference(canvasId: string, id: string, actor: Actor): boolean {
  const ref = store.deleteReference(canvasId, id)
  if (!ref) return false
  broadcast(canvasId, { type: 'reference', id, reference: null, actor })
  logActivity(canvasId, actor, `unpinned the reference “${ref.title}” from Memory`)
  return true
}
