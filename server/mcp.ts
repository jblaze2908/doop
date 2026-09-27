import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { z } from 'zod'
import { store } from './store.ts'
import * as actions from './actions.ts'
import { canAccessCanvas } from './access.ts'
import * as workspaces from './workspaces.ts'
import { auth, getUserName, isBanned, PUBLIC_ORIGIN } from './auth.ts'
import { capture, captureThrottled } from './analytics.ts'
import { renderFrame } from './screenshot.ts'
import { DOOP_GUIDE, GUIDE_TOPICS } from './guide.ts'
import { describeInspiration, fetchThumb, INSPIRATION_USAGE_NOTE, searchInspiration } from './inspiration.ts'
import { ESCAPED_HTML_NOTE, looksEscapedHtml } from './escapedHtml.ts'
import { describeSyncFlow, getSyncFlow } from './ingest.ts'
import * as assets from './assets.ts'
import * as backgrounds from './backgrounds.ts'
import { viewWebsite } from './website.ts'
import { createImportedWebpageFrame } from './webpageImport.ts'
import { normalizeImportUrl } from './importer.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'
import { findText, outlineOf, outlinePath, parseHtml, replaceSource, resolveOne, sourceOf } from './htmlTree.ts'
import { exportFrameCode } from './exportCode.ts'
import {
  isThemeEmpty,
  MAX_THEME_CSS_CHARS,
  MAX_THEME_FONTS,
  MAX_THEME_TOKENS,
  THEME_TOKEN_TYPES,
  type CanvasTheme,
} from '../shared/theme.ts'
import {
  componentUsages,
  liveComponents,
  MAX_COMPONENT_CSS_CHARS,
  MAX_COMPONENT_HTML_CHARS,
  templateSlots,
  type ComponentDef,
} from '../shared/components.ts'

const INSTRUCTIONS = `Doop is a shared multiplayer design canvas: humans and AI agents design together in real time. Canvases contain frames — artboards that render complete HTML documents live for everyone viewing.

You MUST call get_guide({ topic: "doop-instructions" }) once before using other Doop tools. Call it again if a long conversation may have compressed or dropped the guide text.

- Context first: call get_canvas before adding or editing frames.
- Identity: pick an agent_name and reuse the SAME name on every call — your presence and edits are attributed live.
- Narrate: call set_status with a one-line summary when you start a task and whenever your focus shifts — people watching the canvas see it live next to your name.
- Creating: create_frame, then stream the design with append_frame_html one complete section at a time (~1–4 KB chunks; start=true on the first, done=true on the last). Each chunk renders the moment it arrives — viewers watch you work.
- Review: after every create or significant edit you MUST call get_frame_screenshot and fix what looks wrong before moving on.
- Small edits: edit_frame_html (exact find/replace — the change morphs into the rendered frame in place). Full redesigns: set_frame_html or a new stream. Rename/move/resize: update_frame.
- Lean reads: get_frame returns the whole document. For copy edits ("change X everywhere") call find_in_canvas — it returns each element containing the text with its source, ready for edit_frame_html. To change part of an existing frame, call get_frame_outline (one line per element, with @path locators), read the part with get_frame_section, and change it with edit_frame_html or replace_frame_section — never re-read or resend a whole document for a local edit.
- Images: real imagery makes designs. list_backgrounds shows a page of curated hero/section/bento backgrounds (glows, grainy meshes, aurora, painterly scenes) as thumbnails — browse it when a section wants atmosphere rather than defaulting to a flat CSS gradient, judge by eye whether one fits the frame, and draw your own when none does. upload_asset stores your own file (remote file → source_url; local file → local_file=true, returns a curl command) and returns a permanent URL — use it for photos, icons and real company logos you sourced yourself, and never ship a placeholder tile, "LOGO" text or an invented wordmark instead. Never inline images as data: URIs.
- Websites: when a request names an existing site or URL — a redesign of it, or "like acme.com" — call import_webpage FIRST so an editable HTML snapshot lands on the canvas. Leave that source frame unchanged and design in a separate frame. view_website is only for read-only inspection when the page should not be added. If Doop cannot capture the site, do not retry with view_website because it uses the same capture path. Use your own browser or web tool and work only from content you actually observe; if that is unavailable, ask the user for screenshots or an HTML export rather than inventing content.
- Feedback: humans reply to your tasks; their notes arrive inside your tool results as HUMAN FEEDBACK blocks — address them before continuing.
- Comments: call get_comments to read element-pinned comments and replies on a canvas, optionally filtered by frame; reply_to_comment answers a thread and resolve_comment closes it. Reading does not claim feedback or comments. A comment that @mentions an agent role (@doop, @ux …) is a request for an agent: forAgent and targetAgent are set on it.
- Theme: a canvas can carry a theme — design tokens, Google Fonts and shared CSS injected into EVERY frame. get_canvas shows it; read it with get_theme and build frames from its classes and var(--…) tokens, never pasting it into a frame. Put a design system's shared CSS in the theme (set_theme_tokens / set_theme_css / set_theme_fonts), not in each frame.
- Components: a canvas can carry linked components — custom elements (<ds-stat label="…">…</ds-stat>) whose template and CSS live on the canvas. get_canvas lists them; use instances instead of rewriting their markup, and create reusable pieces with set_component so a change updates every frame.
- Guidelines: canvases can carry named style guides (brand rules, style recipes). get_canvas lists them with one-line summaries — read the relevant ones with get_guidelines BEFORE designing and follow them.
- Memory: canvases can also carry pinned style references — exemplar designs humans marked as "more like this". get_canvas lists them; read the relevant one with get_reference and match its look. When your human gives you design feedback in conversation and you address it, record it with save_decision so the canvas remembers their taste.`

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

/** Result payload plus a workflow nudge the agent reads at its decision point. */
function textWithNudge(data: unknown, nudge: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
      { type: 'text' as const, text: nudge },
    ],
  }
}

const THEME_NOTE =
  'This canvas has a theme: every frame inherits its tokens (var(--…)), fonts and CSS classes automatically. Read it with get_theme and build frames from it — never paste the theme into a frame.'

const COMPONENTS_NOTE =
  'This canvas has linked components. Use them in frames as custom elements — <name attr="…">slot content</name>, always with a closing tag — instead of rewriting their markup; editing a component then updates every instance. Read one with get_component.'

/** One line per component: what an agent needs to instantiate it. */
function componentSummary(d: ComponentDef) {
  return { name: d.name, props: d.props.map((p) => p.name), slots: templateSlots(d.html) }
}

function themeSummary(theme: CanvasTheme) {
  return {
    tokens: theme.tokens.length,
    cssBytes: theme.css.length,
    fonts: theme.fonts,
    version: theme.version,
  }
}

const REVIEW_NUDGE =
  'You have not seen this design yet. Call get_frame_screenshot on it now, judge it against the review checkpoints (fit, spacing, hierarchy, contrast, alignment, realism), and fix any issues before moving on.'

import type { Actor } from '../shared/types.ts'

/** Reaches agents whose session predates set_status (or who skipped the guide). */
function withStatusNudge<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  if (actions.hasAnnouncedTask(canvasId, actor)) return result
  result.content.push({
    type: 'text' as const,
    text: 'You have not announced what you are working on. Call set_status with a one-line, present-tense summary (e.g. "Designing a pricing page, dark editorial style") — it shows live next to your name and builds your task history in the panel. Update it when your focus shifts; clear it with "" when done.',
  })
  return result
}

/** Tells an agent its markup arrived escaped — actions.ts already decoded it. */
function withEscapeNote<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  sent: string,
): T {
  if (looksEscapedHtml(sent)) result.content.push({ type: 'text' as const, text: ESCAPED_HTML_NOTE })
  return result
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

/** Reaches agents that start designing without having read the canvas's style guides. */
function withGuidelinesNudge<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  const canvas = store.getCanvas(canvasId)
  if (!actions.hasSeenDesignSystem(canvasId, actor.name)) {
    actions.markDesignSystemSeen(canvasId, actor.name) // one nudge is enough
    if (!isThemeEmpty(canvas?.theme)) result.content.push({ type: 'text' as const, text: THEME_NOTE })
    const live = liveComponents(canvas?.components)
    if (live.length)
      result.content.push({
        type: 'text' as const,
        text: `${COMPONENTS_NOTE} Components here: ${live.map((d) => `<${d.name}>`).join(', ')}.`,
      })
  }
  const docs = store.getGuidelines(canvasId)
  if (docs.length === 0 || actions.hasSeenGuidelines(canvasId, actor.name)) return result
  result.content.push({
    type: 'text' as const,
    text: `This canvas has style guides you have not read: ${docs.map((d) => d.name).join(', ')}. Call get_guidelines({ canvas_id, name }) for each relevant one NOW and make your design follow them.`,
  })
  return result
}

/** Append any undelivered human feedback for this agent to a tool result.
 *  MCP is pull-based, so this is the channel through which humans steer agents. */
function withFeedback<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  const pending = actions.takeFeedbackFor(canvasId, actor.name)
  if (pending.length === 0) return result
  const tasks = actions.getTasks(canvasId)
  const lines = pending.map((f) => {
    const task = tasks.find((t) => t.id === f.taskId)
    const mine = task && task.agentName === actor.name
    const about = task ? ` (about ${mine ? 'your' : `${task.agentName}’s`} work: “${task.status}”)` : ''
    return `- ${f.from}${about}: ${f.text}`
  })
  result.content.push({
    type: 'text' as const,
    text: `HUMAN FEEDBACK — open request(s) on this canvas, now assigned to YOU:\n${lines.join('\n')}\nAddress this NOW, before continuing your plan: locate the frame in question (get_canvas / get_frame), make the change, and review with get_frame_screenshot. If it concerns another agent's frame, edit it anyway — a human request overrides the don't-touch-others'-frames etiquette. Update your set_status to say what you're picking up.`,
  })
  return result
}

/* upload rate limit per connecting user, mirroring the page-import route */
const uploadHits = new Map<string, number[]>()
const UPLOADS_PER_MIN = 15

/* inspiration search and website views call out to third-party services —
   keep a burst of retries from hammering them */
const searchHits = new Map<string, number[]>()
const SEARCHES_PER_MIN = 12

/* importing writes a potentially large HTML frame, so keep it at the same
   conservative per-user rate as the browser UI's import endpoint */
const importHits = new Map<string, number[]>()
const IMPORTS_PER_MIN = 5

const agentName = z
  .string()
  .describe(
    'Your display name, shown live to everyone on the canvas (e.g. "Claude", "Codex"). Reuse the SAME name on every call so your work is attributed consistently.',
  )

function frameSummary(f: {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  updatedAt: number
  updatedBy: string
  html: string
  demo?: boolean
}) {
  return {
    id: f.id,
    name: f.name,
    ...(f.demo ? { demo: true } : {}),
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    updatedAt: new Date(f.updatedAt).toISOString(),
    updatedBy: f.updatedBy,
    htmlBytes: f.html.length,
    /* public render of the CURRENT design — downloadable/hotlinkable
       (append &download, or .jpg?quality=90 for JPEG) */
    image_url: `${PUBLIC_ORIGIN}/i/${f.id}.png?scale=2`,
  }
}

/** owner is the connecting user's display name (for attribution); ownerId is
 *  their user id — canvases the agent creates or lists are scoped to it, the
 *  same isolation the web UI gets. */
export function buildMcpServer(owner?: string, ownerId?: string): McpServer {
  const actorFrom = (agent_name?: string) => actions.resolveActor({ name: agent_name, kind: 'agent', owner })
  /* Canvas access for agents mirrors the web UI: the OAuth user's id runs
     through the same canAccessCanvas gate as browser sessions. Every tool
     that takes a canvas or frame id resolves it through these. */
  const canvasFor = (canvasId: string) => {
    const c = store.getCanvas(canvasId)
    return c && canAccessCanvas(ownerId, c) ? c : undefined
  }
  const frameFor = (frameId: string) => {
    const f = store.getFrame(frameId)
    if (!f) return undefined
    return canvasFor(f.canvasId) ? f : undefined
  }
  const noCanvas = (id: string) => err(`no canvas with id ${id} accessible to this account`)
  const noFrame = (id: string) => err(`no frame with id ${id} accessible to this account`)
  const noComment = (id: string) => err(`no comment with id ${id} on this canvas`)
  /* Reads count as arrival: presence (and with it every "your agent is
     connected" confirmation in the UI) must appear on an agent's FIRST
     canvas-scoped call, not only once it mutates something. */
  const arrive = (canvasId: string, agent_name?: string) => {
    if (agent_name) actions.heartbeatAgent(canvasId, actorFrom(agent_name))
  }
  const server = new McpServer({ name: 'doop-canvas', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'get_guide',
    {
      description:
        'Read the Doop agent guide: mandatory review checkpoints, the streaming workflow, frame sizing, design-quality doctrine, and multiplayer etiquette. Call with topic "doop-instructions" ONCE before using other Doop tools; call again if a long conversation may have compressed earlier context.',
      inputSchema: {
        topic: z.enum(GUIDE_TOPICS).describe('Guide topic to load'),
      },
    },
    async () => text(DOOP_GUIDE),
  )

  server.registerTool(
    'search_inspiration',
    {
      title: 'Search design inspiration',
      description:
        'Search a curated gallery of real, well-designed live websites by category and SEE thumbnails of each, with pre-distilled style facts (one-line mood north star, named palette, fonts). Call it FIRST when writing a design brief — it is the required inspiration step, especially for landing pages: query the page archetype plus the register you want ("law firm landing page, editorial", "dark fintech dashboard"), not just the product noun. Study the thumbnails, pick the ONE exemplar that fits the brief best and follow it — do not blend several — and name it in the brief. Do not embed these screenshots in a frame.',
      inputSchema: {
        query: z
          .string()
          .describe('Page archetype + register, e.g. "grocery delivery landing page, warm", "dark fintech dashboard"'),
        count: z.number().min(1).max(6).optional().describe('Exemplars to return, default 4'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, count, canvas_id, agent_name }) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const results = await searchInspiration(query, count ?? 4)
        if (results.length === 0)
          return text({ ok: true, results: [], note: `No inspiration for "${query}" — try a broader category.` })
        const thumbs = await Promise.all(results.map((r) => fetchThumb(r.thumb_url)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [
          {
            type: 'text' as const,
            text: `${results.length} exemplar(s) for "${query}" — study each thumbnail with its style facts:`,
          },
        ]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: describeInspiration(r, i) })
        })
        content.push({ type: 'text' as const, text: INSPIRATION_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'inspiration search failed')
      }
    },
  )

  server.registerTool(
    'list_canvases',
    {
      description:
        "List the connected user's design canvases with their ids, names and frame counts — personal ones, ones shared with them, and every canvas in their workspaces (workspace_id / workspace_name set).",
      inputSchema: {},
    },
    /* '' matches no ownerId: a session without a user sees nothing */
    async () =>
      text(
        workspaces.canvasesFor(ownerId ?? '').map((m) => ({
          ...m,
          ...(m.workspaceId
            ? { workspace_id: m.workspaceId, workspace_name: workspaces.getWorkspace(m.workspaceId)?.name }
            : {}),
          /* count what get_canvas will actually return — demo frames are hidden from agents */
          frameCount: store.getCanvas(m.id)?.frames.filter((f) => !f.demo).length ?? m.frameCount,
          guidelinesCount: store.getGuidelines(m.id).length,
        })),
      ),
  )

  server.registerTool(
    'create_canvas',
    {
      description:
        'Create a new design canvas. Returns the canvas id, which is part of the shareable URL (/c/<id>). Pass workspace_id (from list_canvases) to create it inside a shared workspace so every member can open it.',
      inputSchema: {
        name: z.string().describe('Canvas name'),
        workspace_id: z.string().optional().describe('Create inside this shared workspace'),
        agent_name: agentName.optional(),
      },
    },
    async ({ name, workspace_id }) => {
      if (workspace_id) {
        const ws = workspaces.getWorkspace(workspace_id)
        if (!ws || !workspaces.isWorkspaceMember(ws.id, ownerId)) return err(`no workspace with id ${workspace_id}`)
      }
      /* owned by the connecting user — an ownerless canvas would be invisible
         on every dashboard (and was once visible on all of them) */
      const canvas = store.createCanvas(name, ownerId, workspace_id)
      return text({ id: canvas.id, name: canvas.name, url: `/c/${canvas.id}` })
    },
  )

  server.registerTool(
    'get_canvas',
    {
      description:
        'Get a canvas: its name and every frame with position, size and metadata (not the HTML — use get_frame for that). Use this to see the current layout before adding or editing frames. Pass your agent_name so any human feedback waiting for you is delivered with the result.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const docs = store.getGuidelines(canvas_id)
      const refs = store.getReferences(canvas_id)
      /* design-synced canvases carry a flow map: real user navigation between
         the synced screens — context a redesign must respect */
      const flow = describeSyncFlow(await getSyncFlow(c), c.frames)
      const theme = isThemeEmpty(c.theme) ? undefined : c.theme
      const components = liveComponents(c.components)
      if (agent_name) actions.markDesignSystemSeen(canvas_id, actorFrom(agent_name).name)
      const notes = [
        ...(flow.length
          ? [
              'This canvas is synced from a live app and `flow` shows how its screens connect — including how often real users take each path. Do not bury or weaken elements that carry heavy navigation.',
            ]
          : []),
        ...(docs.length
          ? [
              'This canvas has style guides. Call get_guidelines for each relevant one BEFORE designing — every frame must follow them.',
            ]
          : []),
        ...(refs.length
          ? [
              'This canvas has pinned style references — exemplar designs humans marked as "more like this". Call get_reference on the relevant one and match its look (palette, type, spacing) in what you design.',
            ]
          : []),
        ...(theme ? [THEME_NOTE] : []),
        ...(components.length ? [COMPONENTS_NOTE] : []),
      ]
      return withFeedback(
        text({
          id: c.id,
          name: c.name,
          /* demo frames (the Doop welcome show, seeded examples) are product
             content, not user work — hidden so agents never mistake them for
             the canvas's established style */
          frames: c.frames.filter((f) => !f.demo).map(frameSummary),
          guidelines: docs.map((d) => ({
            name: d.name,
            title: actions.guidelineTitle(d),
            summary: actions.guidelineSummary(d),
            bytes: d.markdown.length,
          })),
          references: refs.map((r) => ({
            id: r.id,
            title: r.title,
            size: `${Math.round(r.width)}x${Math.round(r.height)}`,
            htmlBytes: r.html.length,
            pinnedBy: r.pinnedBy,
          })),
          ...(theme ? { theme: themeSummary(theme) } : {}),
          ...(components.length ? { components: components.map(componentSummary) } : {}),
          ...(flow.length ? { flow } : {}),
          ...(notes.length ? { note: notes.join(' ') } : {}),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'list_guidelines',
    {
      description:
        "List a canvas's style guides (named markdown guidelines — brand rules, style recipes) with one-line summaries. Fetch the full text of the relevant ones with get_guidelines before designing.",
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (agent_name) actions.markGuidelinesSeen(canvas_id, actorFrom(agent_name).name)
      const docs = store.getGuidelines(canvas_id)
      if (docs.length === 0)
        return text({
          guidelines: [],
          note: 'No style guides on this canvas yet. Set one with set_guidelines when a human hands you brand or style rules.',
        })
      return withFeedback(
        text({
          guidelines: docs.map((d) => ({
            name: d.name,
            title: actions.guidelineTitle(d),
            summary: actions.guidelineSummary(d),
            bytes: d.markdown.length,
            updatedAt: new Date(d.updatedAt).toISOString(),
            updatedBy: d.updatedBy,
          })),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'get_guidelines',
    {
      description:
        "Read one of the canvas's style guides in full: the style rules (palettes, fonts, layout recipes, asset URLs) every frame must follow. If get_canvas listed style guides, read the relevant ones with this BEFORE creating or restyling frames.",
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc name from get_canvas / list_guidelines, e.g. "feature-image"'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, name, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const doc = store.getGuidelines(canvas_id).find((d) => d.name === name.trim().toLowerCase())
      if (!doc) {
        const names = store.getGuidelines(canvas_id).map((d) => d.name)
        return err(
          names.length
            ? `no style guide named “${name}” — this canvas has: ${names.join(', ')}`
            : `no style guides on this canvas yet`,
        )
      }
      if (agent_name) actions.markGuidelinesSeen(canvas_id, actorFrom(agent_name).name)
      return withFeedback(text(doc.markdown), canvas_id, agent_name ? actorFrom(agent_name) : undefined)
    },
  )

  server.registerTool(
    'set_guidelines',
    {
      description:
        "Create, replace or delete a named style guide on a canvas (markdown, max 24,000 chars; empty string deletes). Write rules other designers and agents can execute directly: palette hexes, font <link>s, ready-to-paste <style> blocks, logo asset URLs (upload files with upload_asset first and reference the returned URLs), layout recipes, do/don't lists.",
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc slug, e.g. "feature-image" (a-z, 0-9, hyphens)'),
        markdown: z
          .string()
          .max(actions.MAX_GUIDELINE_CHARS)
          .describe('Full replacement markdown for this doc; empty string deletes it'),
        title: z
          .string()
          .max(actions.MAX_GUIDELINE_TITLE_CHARS)
          .optional()
          .describe('Pretty display name shown to humans, e.g. "Featured Images"; omit to keep the current one'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, markdown, title, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        const doc = actions.setGuideline(canvas_id, name, markdown, actor, undefined, title)
        actions.markGuidelinesSeen(canvas_id, actor.name)
        return withFeedback(
          text(
            doc
              ? { ok: true, name: doc.name, title: actions.guidelineTitle(doc), bytes: doc.markdown.length }
              : { ok: true, deleted: true },
          ),
          canvas_id,
          actor,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid guideline doc')
      }
    },
  )

  server.registerTool(
    'get_theme',
    {
      description:
        'Read the canvas theme: design tokens (CSS custom properties on :root), Google Fonts and shared CSS that EVERY frame on the canvas inherits automatically. Frames use its classes and var(--…) tokens directly — never paste the theme into a frame.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      if (agent_name) actions.markDesignSystemSeen(canvas_id, actorFrom(agent_name).name)
      const theme = c.theme
      if (!theme || isThemeEmpty(theme))
        return text({
          theme: null,
          note: 'No theme yet. Put a design system here (set_theme_tokens, set_theme_css, set_theme_fonts) so every frame shares one stylesheet.',
        })
      const described = theme.tokens.filter((t) => t.description)
      return withFeedback(
        text({
          version: theme.version,
          tokens: Object.fromEntries(theme.tokens.map((t) => [t.name, t.value])),
          ...(described.length
            ? { descriptions: Object.fromEntries(described.map((t) => [t.name, t.description])) }
            : {}),
          fonts: theme.fonts,
          ...(theme.unresolvedFonts?.length ? { unresolvedFonts: theme.unresolvedFonts } : {}),
          css: theme.css,
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  const themeWrite = async (
    canvas_id: string,
    agent_name: string,
    patch: actions.ThemePatch,
    summarize: (theme: CanvasTheme) => Record<string, unknown>,
  ) => {
    if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
    const actor = actorFrom(agent_name)
    actions.markDesignSystemSeen(canvas_id, actor.name)
    try {
      const theme = await actions.setTheme(canvas_id, patch, actor)
      if (!theme) return noCanvas(canvas_id)
      return withFeedback(text({ ok: true, version: theme.version, ...summarize(theme) }), canvas_id, actor)
    } catch (e) {
      return err(e instanceof Error ? e.message : 'invalid theme')
    }
  }

  server.registerTool(
    'set_theme_tokens',
    {
      description: `Write design tokens into the canvas theme. Each token is a CSS custom property on :root that every frame inherits — use var(--name) in frames. mode "merge" (default) upserts by name and an empty value deletes that token; "replace" makes this list the whole token set. Max ${MAX_THEME_TOKENS} tokens.`,
      inputSchema: {
        canvas_id: z.string(),
        tokens: z
          .array(
            z.object({
              name: z.string().describe('Custom property name, e.g. "--color-ink" (lowercase a-z, 0-9, hyphens)'),
              value: z
                .string()
                .describe('CSS value, e.g. "#17171b", "16px", "\'Inter\', sans-serif"; "" deletes in merge mode'),
              type: z.enum(THEME_TOKEN_TYPES).optional().describe('inferred from the value when omitted'),
              description: z.string().optional(),
            }),
          )
          .max(MAX_THEME_TOKENS),
        mode: z.enum(['merge', 'replace']).default('merge'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, tokens, mode, agent_name }) =>
      themeWrite(canvas_id, agent_name, { tokens: { list: tokens, mode } }, (t) => ({ tokens: t.tokens.length })),
  )

  server.registerTool(
    'set_theme_css',
    {
      description: `Replace the canvas theme's shared CSS (max ${MAX_THEME_CSS_CHARS.toLocaleString('en-US')} chars; empty string clears it). It is injected into EVERY frame ahead of the frame's own <style>, so frames only carry what is unique to them. Put the design system here: resets, type scale, component classes (.btn, .card …). Use var(--…) from set_theme_tokens; no @import (fonts go through set_theme_fonts).`,
      inputSchema: {
        canvas_id: z.string(),
        css: z.string().max(MAX_THEME_CSS_CHARS),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, css, agent_name }) =>
      themeWrite(canvas_id, agent_name, { css }, (t) => ({ cssBytes: t.css.length })),
  )

  server.registerTool(
    'set_theme_fonts',
    {
      description: `Set the canvas theme's Google Fonts (replaces the list; max ${MAX_THEME_FONTS} families). Every frame can then use them in font-family without its own <link>. Pass css2 family specs: "Geist", "Inter:wght@400;600;700", "Fraunces:ital,wght@0,400;1,400".`,
      inputSchema: {
        canvas_id: z.string(),
        families: z.array(z.string()).max(MAX_THEME_FONTS),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, families, agent_name }) =>
      themeWrite(canvas_id, agent_name, { fonts: families }, (t) => ({
        fonts: t.fonts,
        ...(t.unresolvedFonts?.length
          ? {
              unresolved: t.unresolvedFonts,
              note: "Doop could not fetch these from Google Fonts (a typo, or the server is offline). Check the names; if they are right, add a <link> for them in each frame's <head> instead.",
            }
          : {}),
      })),
  )

  const noComponent = (canvasId: string, name: string) => {
    const names = liveComponents(store.getComponents(canvasId)).map((d) => d.name)
    return err(
      names.length
        ? `no component named <${name}> — this canvas has: ${names.join(', ')}`
        : 'this canvas has no components yet — create one with set_component',
    )
  }

  server.registerTool(
    'list_components',
    {
      description:
        "List the canvas's linked components: custom elements every frame can use, with their props (attributes) and slots. Instances stay linked — editing a component updates every frame that uses it.",
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      if (agent_name) actions.markDesignSystemSeen(canvas_id, actorFrom(agent_name).name)
      const live = liveComponents(c.components)
      return withFeedback(
        text({
          components: live.map((d) => ({
            ...componentSummary(d),
            ...(d.description ? { description: d.description } : {}),
            usedIn: componentUsages(c.frames, d.name).length,
          })),
          ...(live.length ? {} : { note: 'No components yet. Create one with set_component.' }),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'get_component',
    {
      description:
        'Read one linked component in full: its shadow template, scoped CSS, props with defaults, and slots.',
      inputSchema: { canvas_id: z.string(), name: z.string(), agent_name: agentName.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ canvas_id, name, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const d = liveComponents(c.components).find((x) => x.name === name.trim().toLowerCase())
      if (!d) return noComponent(canvas_id, name)
      return withFeedback(
        text({
          name: d.name,
          ...(d.description ? { description: d.description } : {}),
          props: d.props,
          slots: templateSlots(d.html),
          html: d.html,
          css: d.css,
          version: d.version,
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'set_component',
    {
      description: `Create or replace a linked component: a custom element frames use as <name attr="…">content</name> (always with a closing tag). \`html\` is its shadow template (max ${MAX_COMPONENT_HTML_CHARS.toLocaleString('en-US')} chars): <slot></slot> takes the instance's children, <slot name="x"> takes children with slot="x", {{prop}} inserts an attribute value (escaped). \`css\` is scoped to the component (max ${MAX_COMPONENT_CSS_CHARS.toLocaleString('en-US')} chars): style the element itself with :host (display and layout; padding/margin go on an inner element, since a theme's * reset outranks :host), variants with :host([variant="primary"]). Theme tokens (var(--…)) and theme classes work inside. Frame CSS cannot reach inside a component — expose variation as props. Every instance on every frame updates when you change it.`,
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Custom element tag with a hyphen, e.g. "ds-stat"'),
        html: z.string().max(MAX_COMPONENT_HTML_CHARS),
        css: z.string().max(MAX_COMPONENT_CSS_CHARS).optional(),
        props: z
          .array(z.object({ name: z.string(), default: z.string().optional(), description: z.string().optional() }))
          .optional()
          .describe('Attributes the component reads; {{placeholders}} in html are added automatically'),
        description: z.string().optional(),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, agent_name, ...input }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      actions.markDesignSystemSeen(canvas_id, actor.name)
      try {
        const d = actions.setComponent(canvas_id, input, actor)
        if (!d) return noCanvas(canvas_id)
        const warnings = actions.componentWarnings(canvas_id, d)
        return withFeedback(
          text({
            ok: true,
            ...componentSummary(d),
            version: d.version,
            usedIn: componentUsages(c.frames, d.name).length,
            ...(warnings.length ? { warnings } : {}),
          }),
          canvas_id,
          actor,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid component')
      }
    },
  )

  server.registerTool(
    'delete_component',
    {
      description:
        'Delete a linked component. Frames keep their instance markup, which then renders as a visible "missing component" box until you replace it or recreate the component.',
      inputSchema: { canvas_id: z.string(), name: z.string(), agent_name: agentName },
    },
    async ({ canvas_id, name, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        if (!actions.deleteComponent(canvas_id, name, actor)) return noComponent(canvas_id, name)
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid component name')
      }
      const used = componentUsages(c.frames, name.trim().toLowerCase())
      return withFeedback(
        text({ ok: true, deleted: name.trim().toLowerCase(), stillUsedIn: used.map((u) => u.frameId) }),
        canvas_id,
        actor,
      )
    },
  )

  server.registerTool(
    'component_usages',
    {
      description: 'Which frames use a component, and how many instances each holds.',
      inputSchema: { canvas_id: z.string(), name: z.string(), agent_name: agentName.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ canvas_id, name, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const used = componentUsages(c.frames, name.trim().toLowerCase())
      return withFeedback(
        text({ frames: used.map((u) => ({ frame_id: u.frameId, name: u.frameName, instances: u.count })) }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'get_reference',
    {
      description:
        'Read a pinned style reference in full: the HTML of a design a human marked as an exemplar ("more designs like this"). References are listed by get_canvas. Match its palette, typography and spacing when designing on this canvas — it is the ground truth for the canvas\'s style.',
      inputSchema: {
        canvas_id: z.string(),
        reference_id: z.string().describe('Reference id from get_canvas'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, reference_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const ref = store.getReferences(canvas_id).find((r) => r.id === reference_id)
      if (!ref) {
        const ids = store.getReferences(canvas_id).map((r) => `${r.id} (“${r.title}”)`)
        return err(
          ids.length
            ? `no reference with id ${reference_id} — this canvas has: ${ids.join(', ')}`
            : 'no style references pinned on this canvas yet',
        )
      }
      return withFeedback(
        text({
          id: ref.id,
          title: ref.title,
          width: ref.width,
          height: ref.height,
          pinnedBy: ref.pinnedBy,
          html: ref.html,
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'save_decision',
    {
      description:
        'Record a design decision your human made while talking to YOU — style feedback you carried out ("rounder corners", "less purple, more white and blue", "stop using italic serif"). Doop\'s UI feedback is captured automatically, but you are the only one who hears your own conversation, so report it with this tool AFTER you have addressed it. It lands in the canvas\'s Memory; recurring preferences become suggested style rules. Record design taste only — not one-off content edits like typo fixes or copy changes.',
      inputSchema: {
        canvas_id: z.string(),
        decision: z
          .string()
          .max(actions.MAX_DECISION_CHARS)
          .describe('The feedback in the human\'s own words, e.g. "make it less claude-esque, more white and blue"'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, decision, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        const saved = actions.recordChatDecision(canvas_id, decision, actor)
        if (saved === undefined) return err(`no canvas with id ${canvas_id}`)
        return withFeedback(
          text(
            saved
              ? { ok: true, note: 'Saved to the canvas Memory. Recurring preferences become suggested style rules.' }
              : { ok: true, note: 'Already in Memory — this exact decision was recorded before.' },
          ),
          canvas_id,
          actor,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid decision')
      }
    },
  )

  server.registerTool(
    'set_status',
    {
      description:
        'Broadcast a one-line status of what you are working on right now — everyone viewing the canvas sees it live next to your name (e.g. "Sketching a mobile onboarding flow", "Fixing contrast on the pricing table"). Set it when you START a task, update it whenever your focus shifts to something new, and clear it with an empty string when you are done. Keep it under ~80 characters, present tense, specific.',
      inputSchema: {
        canvas_id: z.string(),
        status: z
          .string()
          .max(140)
          .describe('What you are working on, one line, present tense. Empty string clears your status.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, status, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      actions.setAgentStatus(canvas_id, actorFrom(agent_name), status)
      return withFeedback(text({ ok: true, status: status.trim() || null }), canvas_id, actorFrom(agent_name))
    },
  )

  server.registerTool(
    'get_comments',
    {
      description:
        'Read element-pinned comments and replies on a canvas, newest first, including author, text, frame, CSS selector, HTML snippet, parentId thread links, and claim/failure/resolution metadata. Includes resolved comments by default so complete conversations remain readable; set include_resolved to false for unresolved comments only. Returns the retained comment history (up to 100 entries per canvas), not an archive. Reading does not claim feedback or comments, or mark them resolved.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string().optional().describe('Only comments on this frame; it must belong to the canvas.'),
        include_resolved: z.boolean().default(true).describe('Include resolved comments and replies. Default true.'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, frame_id, include_resolved, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (frame_id !== undefined) {
        const frame = frameFor(frame_id)
        if (!frame || frame.canvasId !== canvas_id) return noFrame(frame_id)
      }
      arrive(canvas_id, agent_name)
      const comments = actions
        .getComments(canvas_id)
        .filter((comment) => frame_id === undefined || comment.frameId === frame_id)
        .filter((comment) => include_resolved || comment.resolvedAt === undefined)
      // Deliberately omit withFeedback: inspecting comments must not claim work.
      return text(comments)
    },
  )

  server.registerTool(
    'reply_to_comment',
    {
      description:
        'Reply inside an element-comment thread on a canvas. The reply inherits the root comment’s element anchor, so the thread keeps pointing at the element the conversation is about. Writing does not resolve the thread — read the request with get_comments, make the change, then close it with resolve_comment.',
      inputSchema: {
        canvas_id: z.string(),
        comment_id: z.string().describe('The root comment or any reply in the thread (from get_comments)'),
        text: z.string().describe('The reply text. Trimmed; empty replies are rejected.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, comment_id, text: body, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const found = actions.findComment(comment_id)
      if (!found || found.canvasId !== canvas_id) return noComment(comment_id)
      if (!body.trim() || !actions.openThread(comment_id)) return err('thread resolved or empty text')
      const actor = actorFrom(agent_name)
      arrive(canvas_id, agent_name)
      const reply = actions.replyToComment(comment_id, body, actor.name, 'agent')
      if (!reply) return err('thread resolved or empty text')
      return withFeedback(text(reply), canvas_id, actor)
    },
  )

  server.registerTool(
    'resolve_comment',
    {
      description:
        'Resolve an element-comment thread on a canvas, marking the request addressed. Resolving a root comment closes its whole thread; resolving a reply closes only that reply. When the thread @mentioned an agent role (@doop, @ux …), resolving it also records the exchange as a design decision in the canvas Memory (plain human-to-human notes are not). Like every mutating tool, the result also carries any pending task feedback addressed to you; get_feedback is for polling it on its own.',
      inputSchema: {
        canvas_id: z.string(),
        comment_id: z.string().describe('The root comment or a reply (from get_comments)'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, comment_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const found = actions.findComment(comment_id)
      if (!found || found.canvasId !== canvas_id) return noComment(comment_id)
      const actor = actorFrom(agent_name)
      arrive(canvas_id, agent_name)
      const alreadyResolved = found.resolvedAt !== undefined
      const resolved = actions.resolveComment(comment_id, actor.name)
      if (!resolved) return noComment(comment_id)
      return withFeedback(
        text({
          ok: true,
          id: resolved.id,
          alreadyResolved,
          resolvedBy: resolved.resolvedBy,
          resolvedAt: resolved.resolvedAt ? new Date(resolved.resolvedAt).toISOString() : undefined,
        }),
        canvas_id,
        actor,
      )
    },
  )

  server.registerTool(
    'get_feedback',
    {
      description:
        'Fetch and claim any open human feedback requests on a canvas. Feedback normally arrives automatically inside your other tool results, so you rarely need this — use it when you are specifically checking for feedback, e.g. an agent whose job is to poll the canvas every few minutes and address whatever humans have requested. Claiming assigns the requests to you: address each one, then review with get_frame_screenshot.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const fbs = actions.takeFeedbackFor(canvas_id, actorFrom(agent_name).name)
      if (fbs.length === 0) return text({ feedback: [], note: 'No open feedback requests right now.' })
      const tasks = actions.getTasks(canvas_id)
      return text({
        feedback: fbs.map((f) => {
          const task = tasks.find((t) => t.id === f.taskId)
          return {
            from: f.from,
            text: f.text,
            about: task ? `${task.agentName}: “${task.status}”` : undefined,
            at: new Date(f.at).toISOString(),
          }
        }),
        note: "These requests are now assigned to you. Address each one (a human request overrides the don't-touch-others'-frames etiquette), review with get_frame_screenshot, and update your set_status.",
      })
    },
  )

  server.registerTool(
    'create_frame',
    {
      description:
        'Create a new frame on a canvas with an HTML design. A frame is a rectangular artboard that renders a full HTML document (inline <style> and <script> allowed, no external network access needed). If x/y are omitted the frame is auto-placed to the right of existing frames. Everyone viewing the canvas sees it appear live.',
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Frame title, e.g. "Landing hero" or "Pricing card"'),
        html: z
          .string()
          .describe(
            'Complete HTML for the frame body (a full document or a fragment; it is rendered in a sandboxed iframe).',
          ),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional().describe('Default 640'),
        height: z.number().optional().describe('Default 480'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, html, x, y, width, height, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const frame = actions.createFrame(canvas_id, { name, html, x, y, width, height }, actorFrom(agent_name))
      if (!frame) return noCanvas(canvas_id)
      const result = withEscapeNote(
        frame.html.length > 0
          ? textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE)
          : text({ ok: true, frame: frameSummary(frame) }),
        html,
      )
      return withGuidelinesNudge(
        withStatusNudge(withFeedback(result, canvas_id, actorFrom(agent_name)), canvas_id, actorFrom(agent_name)),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'get_frame',
    {
      description:
        'Get a frame including its full HTML content — thousands of tokens on a real page. To find text use find_in_canvas; to read or change one part use get_frame_outline and get_frame_section.',
      inputSchema: { frame_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      return withFeedback(
        text({ ...frameSummary(f), html: f.html }),
        f.canvasId,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'set_frame_html',
    {
      description:
        'Replace the HTML design of a frame in one shot. The change renders live for everyone viewing the canvas. For new or heavily reworked designs, prefer append_frame_html so viewers can watch the design stream in.',
      inputSchema: { frame_id: z.string(), html: z.string(), agent_name: agentName },
    },
    async ({ frame_id, html, agent_name }) => {
      if (!frameFor(frame_id)) return noFrame(frame_id)
      const frame = actions.updateFrame(frame_id, { html }, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return withGuidelinesNudge(
        withStatusNudge(
          withFeedback(
            withEscapeNote(textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE), html),
            frame.canvasId,
            actorFrom(agent_name),
          ),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'export_frame',
    {
      title: 'Export frame as image',
      description:
        "Get public image URLs (PNG/JPG) rendering the frame's CURRENT design — for publishing it elsewhere: download the URL and upload to a CMS media library, social post, or use directly as og:image. The URL re-renders when the frame changes.",
      inputSchema: {
        frame_id: z.string(),
        format: z.enum(['png', 'jpg']).optional().describe('default png'),
        quality: z.number().min(1).max(100).optional().describe('jpg only, default 90'),
      },
    },
    async ({ frame_id, format, quality }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const ext = format === 'jpg' ? 'jpg' : 'png'
      const q = ext === 'jpg' ? `&quality=${quality ?? 90}` : ''
      return text({
        image_url: `${PUBLIC_ORIGIN}/i/${frame_id}.${ext}?scale=2${q}`,
        download_url: `${PUBLIC_ORIGIN}/i/${frame_id}.${ext}?scale=2${q}&download`,
        width: f.width * 2,
        height: f.height * 2,
        note: 'Public URL, no auth needed. To publish: fetch the URL and upload the bytes to the target platform (e.g. WordPress POST /wp/v2/media), or hotlink it directly — it always shows the current design.',
      })
    },
  )

  server.registerTool(
    'export_frame_code',
    {
      title: 'Export frame as code',
      description:
        'Export a frame as source files. target "react" (default): a page component (<Frame>.tsx, default export) that imports one components/<Name>.tsx per linked component it uses, the canvas theme as styles/tokens.css and styles/theme.css, and the frame\'s own CSS — plain CSS, no framework. target "html": one self-contained index.html, exactly what doop renders. Write the files into the project as they are; warnings list anything that could not be carried over (scripts, inline event handlers).',
      inputSchema: {
        frame_id: z.string(),
        target: z.enum(['react', 'html']).optional().describe('default react'),
        agent_name: agentName.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ frame_id, target, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const c = store.getCanvas(f.canvasId)
      if (!c) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      return text(exportFrameCode(f, c, target ?? 'react'))
    },
  )

  server.registerTool(
    'upload_asset',
    {
      title: 'Upload an image asset',
      description:
        'Upload an image (png/jpg/webp/gif/svg, max 5 MB) and get back a permanent public URL to reference in frame HTML (<img src>, CSS background) — use this instead of inlining data: URIs. Pick ONE input by where the file lives: (1) remote — pass source_url and the server fetches it; (2) LOCAL FILE — pass local_file=true to receive a one-time upload URL and a ready-to-run curl command, run it in your shell, and the curl response JSON contains the permanent url. (3) data — base64, LAST RESORT for tiny files (under ~100 KB) when you cannot run shell commands; larger base64 payloads are slow and corrupt easily.',
      inputSchema: {
        source_url: z.string().optional().describe('Public http(s) URL to fetch the file from (remote files)'),
        local_file: z
          .boolean()
          .optional()
          .describe('true = the file is on YOUR machine: returns a one-time upload URL + curl command to run'),
        data: z
          .string()
          .optional()
          .describe('The file as base64 (raw base64 or a data: URL). Last resort, tiny files only.'),
        canvas_id: z.string().describe('The canvas this asset belongs to'),
        agent_name: agentName,
      },
    },
    async ({ data, source_url, local_file, canvas_id, agent_name }) => {
      const provided = [data, source_url, local_file].filter(Boolean).length
      if (provided !== 1)
        return err(
          'provide exactly one of: source_url (remote file), local_file=true (local file — returns a curl command), or data (small base64)',
        )
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (uploadHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= UPLOADS_PER_MIN) return err('upload rate limit — wait a minute')
      hits.push(now)
      uploadHits.set(limitKey, hits)
      if (local_file) {
        const { token, expiresAt } = assets.createUploadTicket({
          canvasId: canvas_id,
          ownerId,
          uploadedBy: agent_name,
        })
        const upload_url = `${PUBLIC_ORIGIN}/u/${token}`
        return withFeedback(
          text({
            ok: true,
            upload_url,
            command: `curl -sS -T "<path-to-your-file>" ${upload_url}`,
            expires_at: new Date(expiresAt).toISOString(),
            note: 'One-time upload URL (single use, 15 min). Run the curl command in your shell with your real file path — its JSON response contains the permanent public url to use in frame HTML. Request a fresh ticket for each file.',
          }),
          canvas_id,
          actorFrom(agent_name),
        )
      }
      try {
        const buf = data
          ? Buffer.from(data.replace(/^data:[^,]*;base64,/, ''), 'base64')
          : await assets.fetchRemote(source_url!)
        const asset = await assets.createAsset(buf, { canvasId: canvas_id, ownerId, uploadedBy: agent_name })
        const url = `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`
        const result = text({
          ok: true,
          url,
          mime: asset.mime,
          size_bytes: asset.size,
          usage: `<img src="${url}" alt="">`,
          note: 'Permanent public URL — safe to reference in any frame on any canvas.',
        })
        return withFeedback(result, canvas_id, actorFrom(agent_name))
      } catch (e) {
        return err(e instanceof Error ? e.message : 'upload failed')
      }
    },
  )

  server.registerTool(
    'list_backgrounds',
    {
      title: 'List backgrounds',
      description:
        'Browse a curated library of premium backgrounds for hero sections, section bands and bento tiles — soft glows, grainy meshes, aurora ribbons, neon, painterly landscapes — as a page of thumbnails you look at, each with palette hexes and a ready-to-paste CSS line that includes a legibility scrim. Reach for it when a hero or full-bleed section wants atmosphere, depth or a focal glow; a quiet typographic design can stay flat, but a default two-stop gradient is rarely right. Filter by tone (light/dark — match your copy color), slot and style; an optional query ("warm sunset", "dark teal") only reorders. Then decide like a designer: does one of these genuinely fit the frame\'s style and palette? If yes, use it and put the copy in its text_zone. If not, call again with a different filter, or draw the background yourself.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Mood / palette words to put first, e.g. "warm sunset glow" — reorders, never filters'),
        tone: z
          .enum(backgrounds.BACKGROUND_TONES)
          .optional()
          .describe('light = dark copy on it, dark = light copy on it'),
        style: z.enum(backgrounds.BACKGROUND_STYLES).optional().describe('Restrict to one look'),
        slot: z
          .enum(backgrounds.BACKGROUND_SLOTS)
          .optional()
          .describe('Where it goes: hero, section band, or card/bento tile'),
        count: z.number().min(1).max(24).optional().describe('Thumbnails to return, default 12'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, tone, style, slot, count, canvas_id, agent_name }) => {
      if (!backgrounds.backgroundsEnabled())
        return err(
          'the background library is empty on this server — draw the background as CSS (layered radial-gradients with a grain overlay) instead',
        )
      try {
        const listing = backgrounds.browseBackgrounds({ query, tone, style, slot, count }, PUBLIC_ORIGIN)
        const { results } = listing
        if (results.length === 0)
          return text({
            ok: true,
            backgrounds: [],
            note: 'No backgrounds match the tone/style/slot filters you set — drop one and call again.',
          })
        const thumbs = await Promise.all(results.map((r) => backgrounds.fetchThumb(r.id)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [{ type: 'text' as const, text: backgrounds.listHeadline(listing, query) }]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: backgrounds.describeBackground(r, i) })
        })
        content.push({ type: 'text' as const, text: backgrounds.BACKGROUND_USAGE_NOTE })
        const result = { content }
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err(e instanceof Error ? e.message : 'background search failed')
      }
    },
  )

  server.registerTool(
    'view_website',
    {
      title: 'View a website',
      description:
        'Read-only inspection of a public web page: acquires its current HTML and returns a locally rendered desktop screenshot plus visible text without changing the canvas. Use it to study real copy, structure and branding. When the page should appear on the canvas as an editable source frame, use import_webpage instead.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        agent_name: agentName,
      },
    },
    async ({ url, agent_name }) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const site = await viewWebsite(url)
        const result = {
          content: [
            { type: 'image' as const, data: site.screenshot.toString('base64'), mimeType: 'image/jpeg' },
            {
              type: 'text' as const,
              text:
                `${site.title || site.finalUrl} — ${site.finalUrl}` +
                (site.description ? `\nMeta description: ${site.description}` : '') +
                (site.shotCropped
                  ? `\nNote: the page is ${site.pageHeight}px tall — the screenshot shows only the top portion.`
                  : '') +
                `\n\nVisible page text${site.textTruncated ? ' (truncated)' : ''}:\n${site.text}`,
            },
          ],
        }
        return result
      } catch (e) {
        return err(
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'website view failed'),
        )
      }
    },
  )

  server.registerTool(
    'import_webpage',
    {
      title: 'Import an editable webpage',
      description:
        'Import ONE public webpage into a canvas as an editable HTML snapshot. The rendered DOM is captured, scripts/iframes are removed, stylesheets are inlined, and the resulting source frame appears on the canvas for comparison or editing. Use this when a referenced or redesign-target page should be visible to everyone; leave the imported source frame unchanged and make the new design in a separate frame. For inspection without changing the canvas, use view_website.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        canvas_id: z.string().describe('Canvas that should receive the imported source frame'),
        agent_name: agentName,
      },
    },
    async ({ url, canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      let normalizedUrl: string
      try {
        normalizedUrl = normalizeImportUrl(url).href
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid webpage URL')
      }
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (importHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= IMPORTS_PER_MIN) return err('webpage import rate limit — wait a minute')
      hits.push(now)
      importHits.set(limitKey, hits)
      try {
        const actor = actorFrom(agent_name)
        const { imported, frame } = await createImportedWebpageFrame({
          canvasId: canvas_id,
          url: normalizedUrl,
          actor,
          includePreview: true,
        })
        if (!frame) return noCanvas(canvas_id)

        const preview = imported.preview
        const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = []
        if (preview) {
          content.push({ type: 'image', data: preview.screenshot.toString('base64'), mimeType: 'image/jpeg' })
        }
        content.push({
          type: 'text',
          text:
            JSON.stringify(
              {
                ok: true,
                frame: frameSummary(frame),
                source_url: preview?.finalUrl ?? normalizedUrl,
                snapshot: 'editable HTML; scripts, iframes and noscript content removed; linked stylesheets inlined',
              },
              null,
              2,
            ) +
            (preview?.description ? `\nMeta description: ${preview.description}` : '') +
            (preview?.shotCropped
              ? `\nThe source page is ${preview.pageHeight}px tall; the preview shows its top 4000px.`
              : '') +
            (preview ? `\n\nVisible source text${preview.textTruncated ? ' (truncated)' : ''}:\n${preview.text}` : '') +
            '\n\nThe editable snapshot is now on the canvas. If it is source material for a separate design, leave it unchanged; if the import itself is the requested deliverable, it is ready to use or edit.',
        })
        const result = { content }
        return withStatusNudge(withFeedback(result, canvas_id, actor), canvas_id, actor)
      } catch (e) {
        return err(
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'webpage import failed'),
        )
      }
    },
  )

  server.registerTool(
    'get_frame_screenshot',
    {
      description:
        'Render a frame and return a PNG screenshot of it — this is how you SEE your design. Always review your work with this after creating or updating a frame, then fix what looks wrong (spacing, overflow, contrast, alignment) and check again. Iterate until it actually looks good, not just until the HTML seems right.',
      inputSchema: {
        frame_id: z.string(),
        scale: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('Device scale factor: 1 (default) or 2 for a retina-resolution image'),
        agent_name: agentName.optional(),
      },
    },
    async ({ frame_id, scale, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      try {
        const png = await renderFrame(f, scale ?? 1)
        return withFeedback(
          {
            content: [
              { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text' as const,
                text: `Screenshot of “${f.name}” (${f.width}×${f.height}@${scale ?? 1}x, html ${f.html.length} bytes)`,
              },
            ],
          },
          f.canvasId,
          agent_name ? actorFrom(agent_name) : undefined,
        )
      } catch (e) {
        return err(`screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'append_frame_html',
    {
      description:
        'Stream a design into a frame section by section — every chunk renders for viewers the moment it arrives, so they watch the design build up live. Prefer this over set_frame_html when creating or reworking a whole design. Send the HTML in document order, ONE complete section per call (head+styles first, then the hero, then each following section), roughly 1–4 KB per chunk. Set start=true on the FIRST chunk (replaces any existing content and shows a live "designing…" badge) and done=true on the LAST chunk. End chunks at element boundaries — partial HTML is healed, but a complete section paints cleanly.',
      inputSchema: {
        frame_id: z.string(),
        html_chunk: z
          .string()
          .describe('The next piece of HTML, appended to what has been sent so far. Raw markup — never escaped.'),
        start: z.boolean().optional().describe('true on the first chunk — clears the frame and starts the live stream'),
        done: z.boolean().optional().describe('true on the final chunk — ends the live stream'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, html_chunk, start, done, agent_name }) => {
      if (!frameFor(frame_id)) return noFrame(frame_id)
      const frame = actions.appendFrameHtml(frame_id, html_chunk, actorFrom(agent_name), { start, done })
      if (!frame) return noFrame(frame_id)
      const result = done
        ? textWithNudge(
            { ok: true, streaming: false, htmlBytes: frame.html.length },
            `Stream complete. ${REVIEW_NUDGE}`,
          )
        : text({ ok: true, streaming: true, htmlBytes: frame.html.length })
      /* nudge only on the first chunk — mid-stream results should stay lean.
         The escape check rides along: the opening chunk decides the stream. */
      const nudged = start
        ? withGuidelinesNudge(withEscapeNote(result, html_chunk), frame.canvasId, actorFrom(agent_name))
        : result
      return withStatusNudge(
        withFeedback(nudged, frame.canvasId, actorFrom(agent_name)),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'edit_frame_html',
    {
      description:
        'Make a targeted edit to a frame: exact find-and-replace in its HTML. Use this for small tweaks (copy, a color, spacing, one element) instead of resending the whole document — the change morphs into the rendered frame in place. old_str must appear EXACTLY ONCE in the current HTML (call get_frame first if unsure); include enough surrounding context to make it unique.',
      inputSchema: {
        frame_id: z.string(),
        old_str: z.string().describe('Exact text to find in the frame HTML — must occur exactly once'),
        new_str: z.string().describe('Replacement text'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, old_str, new_str, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const count = f.html.split(old_str).length - 1
      if (count === 0) return err('old_str not found in the frame HTML. Call get_frame to see the current content.')
      if (count > 1)
        return err(`old_str occurs ${count} times — include more surrounding context so it matches exactly once.`)
      /* a function replacement: a string one would expand $& / $1 inside new_str */
      const frame = actions.updateFrame(
        frame_id,
        { html: f.html.replace(old_str, () => new_str) },
        actorFrom(agent_name),
      )!
      return withStatusNudge(
        withFeedback(
          textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'get_frame_outline',
    {
      description:
        "A compact outline of a frame's element tree — one line per element with an @path locator (e.g. @2.1), tag, #id, .classes and a text snippet — instead of the whole document. Read one element with get_frame_section and change it with replace_frame_section. [N] marks children hidden by depth; pass from to expand one of them.",
      inputSchema: {
        frame_id: z.string(),
        depth: z.number().int().min(1).max(12).optional().describe('element levels to list, default 3'),
        from: z.string().optional().describe('@path or CSS selector of the element to outline from'),
        agent_name: agentName.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ frame_id, depth, from, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      const root = parseHtml(f.html)
      try {
        const start = from ? resolveOne(root, from) : undefined
        const outline = outlineOf(root, { depth: depth ?? 3, ...(start ? { from: start } : {}) })
        const head = `${f.name} · ${Math.round(f.width)}×${Math.round(f.height)} · ${f.html.length.toLocaleString('en-US')} chars of HTML`
        return withFeedback(
          text(`${head}\n${outline || '(empty body)'}`),
          f.canvasId,
          agent_name ? actorFrom(agent_name) : undefined,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'bad locator')
      }
    },
  )

  server.registerTool(
    'find_in_canvas',
    {
      description:
        'Find every element whose text or attribute values contain a string, across all frames of a canvas (or one frame): frame id, the element\'s @path and its source, trimmed. Use it for copy edits ("change X everywhere") instead of reading whole frames; then edit with edit_frame_html using the exact source shown.',
      inputSchema: {
        canvas_id: z.string(),
        text: z.string().min(1).describe('Exact, case-sensitive text to look for'),
        frame_id: z.string().optional().describe('Limit the search to one frame'),
        agent_name: agentName.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ canvas_id, text: query, frame_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const frames = c.frames.filter((f) => !f.demo && (!frame_id || f.id === frame_id))
      const hits = findText(frames, query, 60)
      return withFeedback(
        text({
          matches: hits.length,
          ...(hits.length
            ? { results: hits }
            : { note: `“${query}” does not appear in ${frame_id ? 'that frame' : 'any frame'}` }),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  server.registerTool(
    'get_frame_section',
    {
      description:
        'The exact source of ONE element in a frame (its outerHTML as stored), located by an outline @path ("@2.1") or a CSS selector that matches exactly one element. Far cheaper than get_frame for reading the part you are about to change.',
      inputSchema: {
        frame_id: z.string(),
        selector: z.string().describe('@path from get_frame_outline, or a CSS selector matching one element'),
        agent_name: agentName.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ frame_id, selector, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      try {
        const el = resolveOne(parseHtml(f.html), selector)
        let at = ''
        try {
          at = `@${outlinePath(el)} `
        } catch {
          /* head elements have no outline path */
        }
        return withFeedback(
          text(`${at}<${el.tag}>\n${sourceOf(f.html, el)}`),
          f.canvasId,
          agent_name ? actorFrom(agent_name) : undefined,
        )
      } catch (e) {
        return err(e instanceof Error ? e.message : 'bad locator')
      }
    },
  )

  server.registerTool(
    'replace_frame_section',
    {
      description:
        'Replace ONE element of a frame (its whole outerHTML) with new HTML, located like get_frame_section. Every other byte of the document is kept, and the change morphs into the rendered frame in place. Use it for edits bigger than a find/replace but smaller than a rewrite; pass an empty html to delete the element.',
      inputSchema: {
        frame_id: z.string(),
        selector: z.string().describe('@path from get_frame_outline, or a CSS selector matching one element'),
        html: z.string().describe('Replacement outerHTML for that element ("" deletes it)'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, selector, html, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      let next: string
      let where: string
      try {
        const el = resolveOne(parseHtml(f.html), selector)
        if (el.implied)
          return err(`<${el.tag}> is implied by the parser, not written in the source — replace one of its children`)
        where = `<${el.tag}>`
        try {
          where = `@${outlinePath(el)} ${where}`
        } catch {
          /* head elements have no outline path */
        }
        next = replaceSource(f.html, el, html)
      } catch (e) {
        return err(e instanceof Error ? e.message : 'bad locator')
      }
      const frame = actions.updateFrame(frame_id, { html: next }, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return withStatusNudge(
        withFeedback(
          textWithNudge({ ok: true, replaced: where, htmlChars: frame.html.length }, REVIEW_NUDGE),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  server.registerTool(
    'update_frame',
    {
      description: 'Update frame metadata: rename it or move/resize it on the canvas.',
      inputSchema: {
        frame_id: z.string(),
        name: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        agent_name: agentName,
      },
    },
    async ({ frame_id, agent_name, ...patch }) => {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      if (!Object.keys(clean).length) return err('nothing to update')
      if (!frameFor(frame_id)) return noFrame(frame_id)
      const frame = actions.updateFrame(frame_id, clean, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return withFeedback(text({ ok: true, frame: frameSummary(frame) }), frame.canvasId, actorFrom(agent_name))
    },
  )

  server.registerTool(
    'delete_frame',
    {
      description: 'Delete a frame from its canvas.',
      inputSchema: { frame_id: z.string(), agent_name: agentName },
    },
    async ({ frame_id, agent_name }) => {
      if (!frameFor(frame_id)) return noFrame(frame_id)
      const frame = actions.deleteFrame(frame_id, actorFrom(agent_name))
      if (!frame) return noFrame(frame_id)
      return text({ ok: true, deleted: frame.name })
    },
  )

  return server
}

/** Stateless streamable-HTTP MCP endpoint. */
export async function handleMcpRequest(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; use POST.' },
      id: null,
    })
    return
  }
  /* OAuth gate: the 401 + WWW-Authenticate header is what triggers the
     browser approval flow in MCP clients (RFC 9728 discovery). */
  const session = await auth.api.getMcpSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  if (!session) {
    const origin = `${req.protocol}://${req.get('host')}`
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer realm="doop", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      )
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: this MCP server requires OAuth' },
        id: null,
      })
    return
  }
  /* banning revokes browser sessions, but an already-issued MCP token keeps
     validating until it expires — refuse it here so a ban is total */
  if (session.userId && (await isBanned(session.userId))) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32003, message: 'This account has been disabled on this server.' },
      id: null,
    })
    return
  }
  /* A custom (bring-your-own) agent talking to us is the behavior we want to
     grow — instrument it. `initialize` marks a fresh client session (and is
     the only message carrying the client's name); tool calls mark actual use,
     throttled because one design task is dozens of calls. */
  if (session.userId) {
    const msgs = Array.isArray(req.body) ? req.body : [req.body]
    for (const msg of msgs) {
      if (msg?.method === 'initialize') {
        capture(session.userId, 'custom_agent_connected', {
          agent_client: msg.params?.clientInfo?.name,
          agent_client_version: msg.params?.clientInfo?.version,
        })
      } else if (msg?.method === 'tools/call') {
        captureThrottled(session.userId, 'custom_agent_used', { first_tool: msg.params?.name })
      }
    }
  }
  const owner = session.userId ? await getUserName(session.userId) : undefined
  const server = buildMcpServer(owner, session.userId ?? undefined)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    /* the client is gone; there is nobody left to report a close failure to */
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('mcp error', e)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
}
