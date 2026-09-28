import {
  pgTable,
  text,
  doublePrecision,
  bigint,
  boolean,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  jsonb,
} from 'drizzle-orm/pg-core'
import type { CanvasTheme } from '../../shared/theme.ts'
import type { ComponentProp } from '../../shared/components.ts'
import type { DesignSnapshot } from '../../shared/designSystem.ts'

/**
 * One Postgres-dialect schema for every environment: PGlite (embedded, file
 * in ./data) during development, a managed Postgres via DATABASE_URL in
 * production. Timestamps are epoch-ms bigints to match the in-memory types.
 * No FK constraints — memory is the source of truth and writes are async
 * fire-and-forget, so we don't want ordering between them to matter.
 */

export const canvases = pgTable('canvases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id'),
  /** 'edit' | 'none'; null = 'none' (private — link sharing is opt-in) */
  linkAccess: text('link_access'),
  /** the shared workspace this canvas lives in; null = the owner's personal
   *  space. Every workspace member can open a workspace canvas. */
  workspaceId: text('workspace_id'),
  /** tokens, fonts and CSS every frame inherits; null = no theme. Written on
   *  its own (saveCanvasTheme), never by the per-edit canvas upsert. */
  theme: jsonb('theme').$type<CanvasTheme>(),
  /** the design system this canvas uses; its own theme/components/guidelines override it */
  designSystemId: text('design_system_id'),
  /** a pinned published version; null = follow the latest publish */
  designSystemPin: integer('design_system_pin'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

/** A design system shared across canvases. Its draft IS its source canvas's
 *  theme, components and guidelines; consumers see only published versions. */
export const designSystems = pgTable('design_systems', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sourceCanvasId: text('source_canvas_id').notNull().unique(),
  /** null = the owner's personal system */
  workspaceId: text('workspace_id'),
  ownerId: text('owner_id').notNull(),
  /** 0 = never published */
  publishedVersion: integer('published_version').notNull(),
  /** the source canvas's draft stamp at the last publish ("draft has changes" = differs) */
  publishedStamp: text('published_stamp'),
  publishedAt: bigint('published_at', { mode: 'number' }),
  publishedBy: text('published_by'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

/** Immutable published snapshots; a rollback republishes an old one as a new version. */
export const designSystemVersions = pgTable(
  'design_system_versions',
  {
    systemId: text('system_id').notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<DesignSnapshot>().notNull(),
    note: text('note'),
    publishedAt: bigint('published_at', { mode: 'number' }).notNull(),
    publishedBy: text('published_by').notNull(),
  },
  (t) => [primaryKey({ columns: [t.systemId, t.version] })],
)

/** A shared workspace: a team's home for canvases. Membership (below) grants
 *  access to every canvas inside it, so a workspace is the org-level unit
 *  the per-canvas invite model never had. */
export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

/** Who is in a workspace, and as what. The owner IS listed here (role
 *  'owner'), unlike canvas_members. */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    /** 'owner' | 'admin' | 'member' */
    role: text('role').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('workspace_members_user_idx').on(t.userId)],
)

/** An invitation to someone who has no draft account yet. Accepted
 *  automatically the moment an account with that email is created. */
export const workspaceInvites = pgTable(
  'workspace_invites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    invitedBy: text('invited_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('workspace_invites_workspace_email_idx').on(t.workspaceId, t.email),
    index('workspace_invites_email_idx').on(t.email),
  ],
)

/** Users invited to collaborate on a canvas (the owner is not listed).
 *  Access = owner ∪ members ∪ (everyone, when link_access = 'edit'). */
export const canvasMembers = pgTable(
  'canvas_members',
  {
    canvasId: text('canvas_id').notNull(),
    userId: text('user_id').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.userId] })],
)

export const frames = pgTable(
  'frames',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    html: text('html').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    /** product-made onboarding/example content; null = a real user frame */
    demo: boolean('demo'),
  },
  (t) => [index('frames_canvas_idx').on(t.canvasId)],
)

/** Design-sync keys: the write-only capability behind the /ingest endpoint.
 *  An app embeds the draft-sync snippet with a key's secret, and its live
 *  screens land on ONE canvas as frames — the secret grants no reads and no
 *  other writes, so shipping it in an internal app's bundle is safe. `id` is
 *  the public handle (stamped into synced frame HTML to match page → frame);
 *  the secret never appears in canvas content. Cold path: read per ingest
 *  request, no in-memory mirror. Revocation = row deletion. */
export const syncKeys = pgTable(
  'sync_keys',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    canvasId: text('canvas_id').notNull(),
    /** label shown in the share modal and used as the frames' actor name */
    name: text('name').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => [index('sync_keys_canvas_idx').on(t.canvasId), index('sync_keys_secret_idx').on(t.secret)],
)

/** Link hotspots a synced page declares: where each same-app link sits in the
 *  snapshot and which page it leads to. Replaced wholesale on every capture
 *  of that page — the set mirrors the CURRENT design, it is not history. */
export const syncLinks = pgTable(
  'sync_links',
  {
    keyId: text('key_id').notNull(),
    page: text('page').notNull(),
    toPage: text('to_page').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    label: text('label'),
  },
  (t) => [index('sync_links_page_idx').on(t.keyId, t.page)],
)

/** Navigations users actually made in the synced app, accumulated per route
 *  pair — the traffic weights on top of the declared link map. */
export const syncEdges = pgTable(
  'sync_edges',
  {
    keyId: text('key_id').notNull(),
    fromPage: text('from_page').notNull(),
    toPage: text('to_page').notNull(),
    count: integer('count').notNull().default(0),
    lastAt: bigint('last_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.fromPage, t.toPage] })],
)

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    agentName: text('agent_name').notNull(),
    owner: text('owner'),
    color: text('color').notNull(),
    status: text('status').notNull(),
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
    endedAt: bigint('ended_at', { mode: 'number' }),
    auto: boolean('auto').notNull().default(false),
    queuedBy: text('queued_by'),
    claimedAt: bigint('claimed_at', { mode: 'number' }),
    failedAt: bigint('failed_at', { mode: 'number' }),
    failureReason: text('failure_reason'),
    /** comma-joined ids of the frames edited while the task was open, most recent last */
    frameIds: text('frame_ids'),
  },
  (t) => [index('tasks_canvas_idx').on(t.canvasId)],
)

export const feedback = pgTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    canvasId: text('canvas_id').notNull(),
    agentName: text('agent_name').notNull(),
    fromName: text('from_name').notNull(),
    text: text('text').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    deliveredAt: bigint('delivered_at', { mode: 'number' }),
    claimedBy: text('claimed_by'),
    completedAt: bigint('completed_at', { mode: 'number' }),
    failedAt: bigint('failed_at', { mode: 'number' }),
    failureReason: text('failure_reason'),
  },
  (t) => [index('feedback_canvas_idx').on(t.canvasId)],
)

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    frameId: text('frame_id').notNull(),
    selector: text('selector').notNull(),
    snippet: text('snippet').notNull(),
    fromName: text('from_name').notNull(),
    text: text('text').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    forAgent: boolean('for_agent').notNull().default(false),
    targetAgent: text('target_agent'),
    claimedBy: text('claimed_by'),
    claimedAt: bigint('claimed_at', { mode: 'number' }),
    failedAt: bigint('failed_at', { mode: 'number' }),
    failureReason: text('failure_reason'),
    resolvedBy: text('resolved_by'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
    parentId: text('parent_id'),
  },
  (t) => [index('comments_canvas_idx').on(t.canvasId)],
)

/** Uploaded image assets: metadata only — bytes live in object storage (or
 *  ./data/assets in dev). canvas_id is a housekeeping hint, not ownership:
 *  liveness comes from asset_refs, so a URL copied to another canvas keeps
 *  its asset alive. */
export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id'),
    ownerId: text('owner_id'),
    mime: text('mime').notNull(),
    ext: text('ext').notNull(),
    size: integer('size').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('assets_canvas_idx').on(t.canvasId)],
)

/** Which frames reference which assets — a projection of frame HTML, synced
 *  on every durable frame write (recomputed from the frame's full HTML, so
 *  it cannot drift like a counter would) and rebuilt at boot. GC is then an
 *  indexed anti-join here instead of a scan over all HTML. */
export const assetRefs = pgTable(
  'asset_refs',
  {
    assetId: text('asset_id').notNull(),
    frameId: text('frame_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.frameId] }), index('asset_refs_frame_idx').on(t.frameId)],
)

/** Named design docs per canvas (brand rules, style recipes) — markdown
 *  written mostly for agents. Small and cold-path; hydrated with the canvas. */
export const guidelines = pgTable(
  'guidelines',
  {
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    markdown: text('markdown').notNull(),
    /* pretty display name; null = show the slug */
    title: text('title'),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    /* world position of the card on the canvas; null = auto-placed */
    x: doublePrecision('x'),
    y: doublePrecision('y'),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.name] })],
)

/** Linked component definitions per canvas. A deletion keeps the row as a
 *  tombstone (deleted_at) so old instances render a visible fallback. */
export const components = pgTable(
  'components',
  {
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    html: text('html').notNull(),
    css: text('css').notNull(),
    props: jsonb('props').$type<ComponentProp[]>().notNull(),
    description: text('description'),
    version: integer('version').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.name] })],
)

/** Append-only history of guideline docs: one snapshot per save, an empty
 *  markdown marks a deletion. Capped per doc at write time; read on demand
 *  (cold path — no in-memory mirror). */
export const guidelineVersions = pgTable(
  'guideline_versions',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    markdown: text('markdown').notNull(),
    savedAt: bigint('saved_at', { mode: 'number' }).notNull(),
    savedBy: text('saved_by').notNull(),
  },
  (t) => [index('guideline_versions_doc_idx').on(t.canvasId, t.name)],
)

/** Frames pinned to Memory as style exemplars: the HTML is a snapshot taken
 *  at pin time, deliberately decoupled from the (mutable, deletable) frame. */
export const memoryReferences = pgTable(
  'memory_references',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    frameId: text('frame_id').notNull(),
    title: text('title').notNull(),
    html: text('html').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    pinnedBy: text('pinned_by').notNull(),
    pinnedAt: bigint('pinned_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('memory_references_canvas_idx').on(t.canvasId)],
)

/** Resolved design decisions captured from addressed requests and agent
 *  reports. summary and distilled_at were the removed distiller's; nothing
 *  writes them any more. */
export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    text: text('text').notNull(),
    summary: text('summary'),
    source: text('source').notNull(),
    frameId: text('frame_id'),
    fromName: text('from_name').notNull(),
    agentName: text('agent_name'),
    at: bigint('at', { mode: 'number' }).notNull(),
    distilledAt: bigint('distilled_at', { mode: 'number' }),
  },
  (t) => [index('decisions_canvas_idx').on(t.canvasId)],
)

export const activity = pgTable(
  'activity',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    actorName: text('actor_name').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorColor: text('actor_color').notNull(),
    message: text('message').notNull(),
    frameId: text('frame_id'),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => [index('activity_canvas_idx').on(t.canvasId)],
)

/* The curated background library behind search_backgrounds
   (server/backgrounds.ts). Bytes live in object storage under bg/<id>.webp
   and bg/<id>-t.webp; this row is everything the search ranks on. */
export const backgrounds = pgTable('backgrounds', {
  id: text('id').primaryKey(),
  /** sha1 of the uploaded source file — re-uploads of the same image are skipped */
  source: text('source').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  tone: text('tone').notNull(),
  style: text('style').notNull(),
  avgColor: text('avg_color').notNull(),
  palette: jsonb('palette').$type<string[]>().notNull(),
  tags: jsonb('tags').$type<string[]>().notNull(),
  slots: jsonb('slots').$type<string[]>().notNull(),
  textZone: text('text_zone').notNull(),
  description: text('description').notNull(),
  /** off = kept but hidden from search; new uploads without tags start off */
  enabled: boolean('enabled').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})
