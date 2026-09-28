import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignSnapshot } from '../shared/designSystem.ts'
import type { ServerMessage } from '../shared/types.ts'

/* Real store, registry and MCP server; persistence stubbed. Versions live in
   `versions` so a pin or rollback of an evicted snapshot reloads from "disk". */
const versions = new Map<string, DesignSnapshot>()
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveCanvas: () => {},
  saveCanvasSoon: () => {},
  saveCanvasTheme: () => {},
  saveFrame: () => {},
  saveComponent: () => {},
  saveGuideline: () => {},
  saveGuidelineVersion: () => {},
  deleteGuideline: () => {},
  deleteCanvas: () => {},
  saveDesignSystem: () => {},
  deleteDesignSystem: () => {},
  saveDesignSystemVersion: async (v: { systemId: string; version: number; snapshot: DesignSnapshot }) => {
    versions.set(`${v.systemId}@${v.version}`, v.snapshot)
  },
  loadDesignSystemSnapshot: async (id: string, v: number) => versions.get(`${id}@${v}`),
  listDesignSystemVersions: async () => [],
}))
/* workspace writes go to the DB; a chain that resolves to nothing keeps them off disk */
vi.mock('../server/db/index.ts', () => {
  const chain: object = new Proxy(() => {}, {
    get: (_t, p) => (p === 'then' ? (resolve: (v: unknown) => void) => resolve(undefined) : chain),
    apply: () => chain,
  })
  return { db: chain }
})

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const designSystems = await import('../server/designSystems.ts')
const systemOps = await import('../server/designSystemOps.ts')
const workspaces = await import('../server/workspaces.ts')
const { renderableHtml, renderStamp } = await import('../server/theme.ts')
const { mergeComponents, mergeTheme } = await import('../shared/designSystem.ts')

const OWNER = 'ds-owner'
let sent: { canvasId: string; msg: ServerMessage }[]

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect(ownerId = OWNER) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'draft-ds-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: { agent_name: 'Claude', ...args } })) as unknown as CallResult
    const text = r.content.find((c) => c.type === 'text')?.text ?? ''
    if (r.isError) return { error: text, json: {} as Record<string, unknown> }
    return { error: undefined, json: JSON.parse(text) as Record<string, unknown> }
  }
  return {
    call,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

beforeEach(() => {
  sent = []
  actions.wire(
    () => {},
    () => {},
  )
  designSystems.wireDesignSystems((canvasId, msg) => sent.push({ canvasId, msg }))
})

const theme = (tokens: Record<string, string>, css = '', version = 1) => ({
  tokens: Object.entries(tokens).map(([name, value]) => ({ name, value, type: 'color' as const })),
  css,
  fonts: [],
  fontFaces: '',
  version,
  updatedAt: 1,
  updatedBy: 't',
})
const def = (name: string, html: string, deletedAt?: number) => ({
  name,
  html,
  css: '',
  props: [],
  version: 1,
  updatedAt: 1,
  updatedBy: 't',
  ...(deletedAt ? { deletedAt } : {}),
})

describe('merge rules', () => {
  it('lets local tokens and CSS win while keeping system order, and memoizes per pair', () => {
    const sys = theme({ '--ink': '#000', '--accent': '#00f' }, '.a{color:red}')
    const local = theme({ '--accent': '#f00', '--extra': '#0f0' }, '.a{color:blue}')
    const m = mergeTheme(sys, local)!
    expect(m.tokens.map((t) => `${t.name}=${t.value}`)).toEqual(['--ink=#000', '--accent=#f00', '--extra=#0f0'])
    expect(m.css).toBe('.a{color:red}\n.a{color:blue}')
    expect(mergeTheme(sys, local)).toBe(m)
  })

  it('does not let a local tombstone hide a system component', () => {
    const merged = mergeComponents(
      [def('ds-a', 'sys'), def('ds-b', 'sys')],
      [def('ds-a', 'local'), def('ds-b', '', 5), def('ds-c', 'local')],
    )
    expect(merged.map((d) => `${d.name}:${d.html}`)).toEqual(['ds-a:local', 'ds-b:sys', 'ds-c:local'])
  })
})

describe('draft → publish → follow', () => {
  it('reaches following canvases only on publish, keeps pins, and restores old versions', async () => {
    const { call, close } = await connect()
    try {
      const created = await call('create_design_system', { name: 'Ledger', kit: 'mineral' })
      expect(created.error).toBeUndefined()
      const systemId = (created.json.designSystem as { id: string }).id
      const sourceId = (created.json.draftCanvas as { id: string }).id
      expect((await call('create_canvas', { name: 'Too early', design_system_id: systemId })).error).toContain(
        'not been published',
      )

      await call('set_component', { canvas_id: sourceId, name: 'ds-pill', html: '<b class="p-2"><slot></slot></b>' })
      expect((await call('publish_design_system', { system_id: systemId, note: 'first' })).json.version).toBe(1)

      const page = await call('create_canvas', { name: 'Landing', design_system_id: systemId })
      const pageId = page.json.id as string
      const read = await call('get_canvas', { canvas_id: pageId })
      expect((read.json.designSystem as { version: number }).version).toBe(1)
      expect((read.json.components as { name: string }[]).map((c) => c.name)).toContain('ds-pill')
      const frame = store.createFrame(
        pageId,
        { name: 'F', x: 0, y: 0, width: 400, height: 300, html: '<ds-pill>x</ds-pill>' },
        'Jai',
      )!
      expect(renderableHtml(frame)).toContain('--accent: #0B6E4F')

      /* a local override stays on the page; the system is untouched */
      const override = await call('set_theme_tokens', {
        canvas_id: pageId,
        tokens: [{ name: '--accent', value: '#123456' }],
      })
      expect(override.json.note).toContain('local overrides')
      expect(renderableHtml(frame)).toContain('--accent: #123456')
      expect(renderableHtml(frame)).not.toContain('--accent: #0B6E4F')

      /* a draft edit changes nothing for followers until it is published */
      const stampBefore = renderStamp(frame)
      await call('set_theme_tokens', { canvas_id: sourceId, tokens: [{ name: '--surface', value: '#ABCDEF' }] })
      expect(renderableHtml(frame)).not.toContain('#ABCDEF')
      expect((await call('get_canvas', { canvas_id: sourceId })).json.designSystem).toMatchObject({
        draftChanged: true,
      })
      sent = []
      expect((await call('publish_design_system', { system_id: systemId })).json).toMatchObject({
        version: 2,
        canvasesUpdated: 1,
      })
      expect(renderableHtml(frame)).toContain('--surface: #ABCDEF')
      expect(renderStamp(frame)).not.toBe(stampBefore)
      expect(sent.some((s) => s.canvasId === pageId && s.msg.type === 'system')).toBe(true)

      /* a pinned canvas stays put through later publishes */
      expect(
        (await call('use_design_system', { canvas_id: pageId, system_id: systemId, pin: 1 })).error,
      ).toBeUndefined()
      expect(renderableHtml(frame)).not.toContain('#ABCDEF')
      await call('publish_design_system', { system_id: systemId })
      expect(renderableHtml(frame)).not.toContain('#ABCDEF')

      /* rollback: version 1 republished as version 4, followers get it */
      await call('use_design_system', { canvas_id: pageId, system_id: systemId, pin: null })
      expect(renderableHtml(frame)).toContain('#ABCDEF')
      expect((await call('publish_design_system', { system_id: systemId, from_version: 1 })).json.version).toBe(4)
      expect(renderableHtml(frame)).not.toContain('#ABCDEF')

      /* the draft goes only with its system, and a used system cannot go */
      expect(designSystems.sourceGuard(sourceId)).toContain('draft of the design system')
      expect(systemOps.deleteDesignSystem(systemId)).toMatchObject({ ok: false, status: 409 })
      await call('use_design_system', { canvas_id: pageId, system_id: null, keep_copy: false })
      expect(renderableHtml(frame)).toContain('--accent: #123456')
      expect(renderableHtml(frame)).not.toContain('--surface')
      expect(systemOps.deleteDesignSystem(systemId)).toMatchObject({ ok: true })
      expect(designSystems.getSystem(systemId)).toBeUndefined()
      expect(store.getCanvas(sourceId)).toBeUndefined()
    } finally {
      await close()
    }
  })
})

describe('who may use and publish', () => {
  it('keeps personal systems private and publishing to owners and workspace admins', async () => {
    const owner = await connect()
    const ws = workspaces.createWorkspace('Studio', OWNER)
    workspaces.addMember(ws.id, 'ds-member', 'member', OWNER)
    const member = await connect('ds-member')
    const stranger = await connect('ds-stranger')
    try {
      const personal = await owner.call('create_design_system', { name: 'Mine' })
      const shared = await owner.call('create_design_system', { name: 'Team', workspace_id: ws.id })
      const personalId = (personal.json.designSystem as { id: string }).id
      const sharedId = (shared.json.designSystem as { id: string }).id

      const seen = (r: { json: Record<string, unknown> }) => (r.json.designSystems as { id: string }[]).map((s) => s.id)
      expect(seen(await member.call('list_design_systems', {}))).toEqual([sharedId])
      expect(seen(await stranger.call('list_design_systems', {}))).toEqual([])
      expect((await stranger.call('publish_design_system', { system_id: personalId })).error).toContain(
        'no design system',
      )
      expect((await member.call('publish_design_system', { system_id: sharedId })).error).toContain('workspace admin')
      workspaces.setRole(ws.id, 'ds-member', 'admin')
      expect((await member.call('publish_design_system', { system_id: sharedId })).json.version).toBe(1)
    } finally {
      await owner.close()
      await member.close()
      await stranger.close()
    }
  })
})

const idOf = (r: { json: Record<string, unknown> }, key = 'designSystem') => (r.json[key] as { id: string }).id
const user = actions.resolveActor({ name: 'Jai', kind: 'user' })
const localTokens = (canvasId: string) => (store.getCanvas(canvasId)?.theme?.tokens ?? []).map((t) => t.name)

describe('hierarchy', () => {
  it('keeps draft canvases off canvas lists and systems inside their own workspace', async () => {
    const owner = await connect()
    const ws = workspaces.createWorkspace('Hier', OWNER)
    const other = workspaces.createWorkspace('Elsewhere', OWNER)
    try {
      const team = await owner.call('create_design_system', { name: 'Team', workspace_id: ws.id })
      const mine = await owner.call('create_design_system', { name: 'Mine' })
      const draftId = idOf(team, 'draftCanvas')
      await owner.call('publish_design_system', { system_id: idOf(team) })
      await owner.call('publish_design_system', { system_id: idOf(mine) })

      const listed = (await owner.call('list_canvases', {})).json as unknown as { id: string }[]
      expect(listed.map((c) => c.id)).not.toContain(draftId)
      expect(workspaces.summaryFor(workspaces.getWorkspace(ws.id)!, OWNER).canvasCount).toBe(0)
      expect(store.getCanvas(draftId)?.workspaceId).toBe(ws.id)

      const elsewhere = await owner.call('create_canvas', { name: 'E', workspace_id: other.id })
      const personal = await owner.call('create_canvas', { name: 'P' })
      const own = (r: { json: Record<string, unknown> }) => r.json.id as string
      expect(
        (await owner.call('use_design_system', { canvas_id: own(elsewhere), system_id: idOf(team) })).error,
      ).toContain('own workspace')
      expect(
        (await owner.call('use_design_system', { canvas_id: own(personal), system_id: idOf(team) })).error,
      ).toContain('own workspace')
      expect(
        (await owner.call('create_canvas', { name: 'X', workspace_id: ws.id, design_system_id: idOf(mine) })).error,
      ).toContain('another workspace')
      expect(
        (await owner.call('use_design_system', { canvas_id: own(personal), system_id: idOf(mine) })).error,
      ).toBeUndefined()
    } finally {
      await owner.close()
    }
  })

  it('starts new workspace canvases on the default system unless told otherwise', async () => {
    const owner = await connect()
    const ws = workspaces.createWorkspace('Defaults', OWNER)
    try {
      const team = await owner.call('create_design_system', { name: 'House', workspace_id: ws.id, kit: 'mineral' })
      await owner.call('publish_design_system', { system_id: idOf(team) })
      workspaces.setDefaultDesignSystem(ws.id, idOf(team))
      const listed = (await owner.call('list_design_systems', {})).json.designSystems as {
        workspaceDefault?: boolean
      }[]
      expect(listed.some((s) => s.workspaceDefault)).toBe(true)

      const on = await owner.call('create_canvas', { name: 'On', workspace_id: ws.id })
      expect((on.json.designSystem as { id: string }).id).toBe(idOf(team))
      const off = await owner.call('create_canvas', { name: 'Off', workspace_id: ws.id, design_system_id: null })
      expect(off.json.designSystem).toBeUndefined()
      const outside = await owner.call('create_canvas', { name: 'Personal' })
      expect(outside.json.designSystem).toBeUndefined()

      /* deleting the default clears it */
      await owner.call('use_design_system', { canvas_id: on.json.id, system_id: null, keep_copy: false })
      expect(systemOps.deleteDesignSystem(idOf(team))).toMatchObject({ ok: true })
      expect(workspaces.getWorkspace(ws.id)?.defaultDesignSystemId).toBeUndefined()
    } finally {
      await owner.close()
    }
  })

  it('extracts a system from a canvas that then renders the same, and stopping keeps a copy', async () => {
    const owner = await connect()
    try {
      const page = await owner.call('create_canvas', { name: 'Landing' })
      const pageId = page.json.id as string
      await actions.setTheme(pageId, { tokens: { list: [{ name: '--brand', value: '#2743ee' }], mode: 'merge' } }, user)
      actions.setComponent(pageId, { name: 'ds-chip', html: '<span><slot></slot></span>', css: '', props: [] }, user)
      actions.setGuideline(pageId, 'voice', '# Voice\n\nPlain words.', user)
      const frame = store.createFrame(
        pageId,
        { name: 'F', x: 0, y: 0, width: 400, height: 300, html: '<ds-chip>x</ds-chip>' },
        'Jai',
      )!
      const before = renderableHtml(frame)

      const made = await owner.call('create_design_system', { name: 'Landing DS', canvas_id: pageId })
      expect(made.error).toBeUndefined()
      const systemId = idOf(made)
      expect(made.json.canvas).toMatchObject({ id: pageId, usesVersion: 1 })
      /* the design moved: nothing local left, same render */
      expect(localTokens(pageId)).toEqual([])
      expect(store.getGuidelines(pageId)).toEqual([])
      expect(store.getComponents(pageId).every((d) => d.deletedAt)).toBe(true)
      expect(renderableHtml(frame)).toBe(before)
      const read = await owner.call('get_canvas', { canvas_id: pageId })
      expect((read.json.designSystem as { id: string }).id).toBe(systemId)

      /* extracting again, or from the draft, is refused */
      expect((await owner.call('create_design_system', { name: 'Again', canvas_id: pageId })).error).toContain(
        'stop using it',
      )

      const stopped = await owner.call('use_design_system', { canvas_id: pageId, system_id: null })
      expect(stopped.json.keptCopy).toBe(true)
      expect(store.getCanvas(pageId)?.designSystemId).toBeUndefined()
      expect(localTokens(pageId)).toContain('--brand')
      expect(store.getGuidelines(pageId).map((d) => d.name)).toEqual(['voice'])
      expect(renderableHtml(frame)).toContain('--brand: #2743ee')
      expect(renderableHtml(frame)).toContain('ds-chip')
    } finally {
      await owner.close()
    }
  })

  it('detaches with a copy when a canvas leaves its system’s workspace or the workspace is deleted', async () => {
    const owner = await connect()
    const ws = workspaces.createWorkspace('Moving', OWNER)
    workspaces.addMember(ws.id, 'ds-mover', 'member', OWNER)
    const member = await connect('ds-mover')
    try {
      const team = await owner.call('create_design_system', { name: 'Moving DS', workspace_id: ws.id, kit: 'mineral' })
      await owner.call('publish_design_system', { system_id: idOf(team) })
      const sid = idOf(team)
      const a = await owner.call('create_canvas', { name: 'A', workspace_id: ws.id, design_system_id: sid })
      const b = await owner.call('create_canvas', { name: 'B', workspace_id: ws.id, design_system_id: sid })
      const theirs = await member.call('create_canvas', { name: 'Theirs', workspace_id: ws.id, design_system_id: sid })

      const moved = store.getCanvas(a.json.id as string)!
      store.setWorkspace(moved.id, undefined)
      expect(await systemOps.afterMove(moved, user)).toBe('Moving DS')
      expect(moved.designSystemId).toBeUndefined()
      expect(localTokens(moved.id)).toContain('--accent')

      await workspaces.deleteWorkspace(ws.id)
      await new Promise((r) => setTimeout(r, 0))
      expect(designSystems.getSystem(sid)?.workspaceId).toBeUndefined()
      /* the owner's canvas is still in the (now personal) system's scope; the member's is not */
      expect(store.getCanvas(b.json.id as string)?.designSystemId).toBe(sid)
      const detached = store.getCanvas(theirs.json.id as string)!
      expect(detached.designSystemId).toBeUndefined()
      expect(localTokens(detached.id)).toContain('--accent')
    } finally {
      await owner.close()
      await member.close()
    }
  })
})

describe('agent nudges on a system’s canvases', () => {
  it('counts the system’s style guides as read once read or written on its draft', async () => {
    const author = await connect()
    try {
      const made = await author.call('create_design_system', { name: 'Guided' })
      const draftId = (made.json.draftCanvas as { id: string }).id
      await author.call('set_guidelines', { canvas_id: draftId, name: 'brand', markdown: '# Brand' })
      await author.call('publish_design_system', { system_id: (made.json.designSystem as { id: string }).id })
      const page = await author.call('create_canvas', {
        name: 'Page',
        design_system_id: (made.json.designSystem as { id: string }).id,
      })
      const pageId = page.json.id as string

      const raw = async (agent: string) => {
        const server = buildMcpServer('Test Owner', OWNER)
        const client = new Client({ name: 'nudge', version: '1' })
        const [a, b] = InMemoryTransport.createLinkedPair()
        await server.connect(b)
        await client.connect(a)
        const r = (await client.callTool({
          name: 'create_frame',
          arguments: {
            canvas_id: pageId,
            name: agent,
            width: 400,
            height: 300,
            html: '<div></div>',
            agent_name: agent,
          },
        })) as unknown as CallResult
        await client.close()
        await server.close()
        return r.content.map((c) => c.text ?? '').join('\n')
      }
      /* the author wrote the guide on the draft; another agent has read nothing */
      expect(await raw('Claude')).not.toContain('style guides you have not read')
      expect(await raw('Other')).toContain('style guides you have not read: brand')
    } finally {
      await author.close()
    }
  })
})
