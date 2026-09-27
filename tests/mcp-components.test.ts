import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveCanvasSoon: () => {},
  saveComponent: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const OWNER_ID = 'owner-1'
const canvas = (id: string, html = '<p>plain</p>'): Canvas => ({
  id,
  name: 'Components',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [
    {
      id: `${id}-f`,
      canvasId: id,
      name: 'Home',
      html,
      x: 0,
      y: 0,
      width: 640,
      height: 480,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'alice',
    },
  ],
})

beforeAll(() =>
  store.init([
    canvas('k1', '<ds-stat label="a">1</ds-stat><ds-stat label="b">2</ds-stat>'),
    canvas('k2'),
    canvas('k3'),
  ]),
)

async function connect(ownerId = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'doop-components-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[]
      isError?: boolean
    }
    const texts = result.content.map((c) => c.text ?? '')
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(texts[0] ?? '')
    } catch {
      /* error strings are not JSON */
    }
    return { json, texts, isError: result.isError }
  }
  return { client, call, close: () => Promise.all([client.close(), server.close()]) }
}

const STAT = {
  name: 'ds-stat',
  html: '<span class="label">{{label}}</span><slot></slot>',
  css: ':host{display:block}',
  agent_name: 'Claude',
}

describe('component MCP tools', () => {
  it('registers the tools, read-only where they only read', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((t) => [t.name, t]))
      for (const n of ['list_components', 'get_component', 'set_component', 'delete_component', 'component_usages'])
        expect(byName.has(n), n).toBe(true)
      for (const n of ['list_components', 'get_component', 'component_usages'])
        expect(byName.get(n)!.annotations?.readOnlyHint, n).toBe(true)
    } finally {
      await close()
    }
  })

  it('creates, lists, reads, counts usages, and versions a component', async () => {
    const { call, close } = await connect()
    try {
      const set = await call('set_component', { canvas_id: 'k1', ...STAT })
      expect(set.json).toEqual({
        ok: true,
        name: 'ds-stat',
        props: ['label'],
        slots: ['default'],
        version: 1,
        usedIn: 1,
      })
      expect((await call('list_components', { canvas_id: 'k1' })).json).toEqual({
        components: [{ name: 'ds-stat', props: ['label'], slots: ['default'], usedIn: 1 }],
      })
      expect((await call('get_component', { canvas_id: 'k1', name: 'DS-STAT' })).json).toMatchObject({
        html: STAT.html,
        css: STAT.css,
        props: [{ name: 'label' }],
      })
      expect((await call('component_usages', { canvas_id: 'k1', name: 'ds-stat' })).json).toEqual({
        frames: [{ frame_id: 'k1-f', name: 'Home', instances: 2 }],
      })
      const again = await call('set_component', { canvas_id: 'k1', ...STAT, html: '<b>{{label}}</b><slot></slot>' })
      expect(again.json.version).toBe(2)
    } finally {
      await close()
    }
  })

  it('tombstones on delete and reports where instances remain', async () => {
    const { call, close } = await connect()
    try {
      await call('set_component', { canvas_id: 'k2', ...STAT })
      const del = await call('delete_component', { canvas_id: 'k2', name: 'ds-stat', agent_name: 'Claude' })
      expect(del.json).toEqual({ ok: true, deleted: 'ds-stat', stillUsedIn: [] })
      expect(store.getComponents('k2')[0]).toMatchObject({ name: 'ds-stat', version: 2 })
      expect(store.getComponents('k2')[0]!.deletedAt).toBeGreaterThan(0)
      const gone = await call('get_component', { canvas_id: 'k2', name: 'ds-stat' })
      expect(gone.isError).toBe(true)
      expect(gone.texts[0]).toMatch(/no components yet/)
      const recreated = await call('set_component', { canvas_id: 'k2', ...STAT })
      expect(recreated.json.version).toBe(3)
    } finally {
      await close()
    }
  })

  it('rejects invalid definitions and accounts without access', async () => {
    const { call, close } = await connect()
    try {
      const bad = await call('set_component', { canvas_id: 'k3', ...STAT, name: 'stat' })
      expect(bad.isError).toBe(true)
      expect(bad.texts[0]).toMatch(/invalid component name/)
    } finally {
      await close()
    }
    const intruder = await connect('intruder')
    try {
      const res = await intruder.call('set_component', { canvas_id: 'k3', ...STAT })
      expect(res.isError).toBe(true)
      expect(res.texts[0]).toMatch(/no canvas with id k3 accessible/)
      expect(store.getComponents('k3')).toEqual([])
    } finally {
      await intruder.close()
    }
  })

  it('lists components in get_canvas and nudges a frame writer who never saw them', async () => {
    const { call, close } = await connect()
    try {
      await call('set_component', { canvas_id: 'k3', ...STAT, agent_name: 'Owner' })
      const summary = await call('get_canvas', { canvas_id: 'k3' })
      expect(summary.json.components).toEqual([{ name: 'ds-stat', props: ['label'], slots: ['default'] }])
      expect(String(summary.json.note)).toMatch(/linked components/)
      const first = await call('set_frame_html', { frame_id: 'k3-f', agent_name: 'Newcomer', html: '<p>a</p>' })
      expect(first.texts.some((t) => t.includes('Components here: <ds-stat>'))).toBe(true)
    } finally {
      await close()
    }
  })
})
