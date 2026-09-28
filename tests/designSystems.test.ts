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
      const sourceId = (created.json.sourceCanvas as { id: string }).id
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

      expect(designSystems.beforeCanvasDelete(sourceId)).toContain('1 canvas use')
      await call('use_design_system', { canvas_id: pageId, system_id: null })
      expect(renderableHtml(frame)).toContain('--accent: #123456')
      expect(renderableHtml(frame)).not.toContain('--surface')
      expect(designSystems.beforeCanvasDelete(sourceId)).toBeUndefined()
      expect(designSystems.getSystem(systemId)).toBeUndefined()
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
