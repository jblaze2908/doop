import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* Real action layer and store; only persistence and the agent side effects are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveCanvasSoon: () => {},
  saveCanvasTheme: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const OWNER_ID = 'owner-1'

const canvas = (id: string): Canvas => ({
  id,
  name: 'Theme',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [
    {
      id: `${id}-f`,
      canvasId: id,
      name: 'Hero',
      html: '<h1>Hi</h1>',
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

beforeAll(() => store.init(['c1', 'c2', 'c3', 'c4', 'c5'].map(canvas)))
afterEach(() => vi.unstubAllGlobals())

async function connect(ownerId = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'doop-theme-test', version: '1.0.0' })
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

describe('theme MCP tools', () => {
  it('registers the four theme tools with get_theme read-only', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((t) => [t.name, t]))
      for (const name of ['get_theme', 'set_theme_tokens', 'set_theme_css', 'set_theme_fonts'])
        expect(byName.has(name), name).toBe(true)
      expect(byName.get('get_theme')!.annotations?.readOnlyHint).toBe(true)
      const schema = byName.get('set_theme_tokens')!.inputSchema as { required?: string[] }
      expect(schema.required).toEqual(expect.arrayContaining(['canvas_id', 'tokens', 'agent_name']))
    } finally {
      await close()
    }
  })

  it('merges, deletes and replaces tokens, and get_theme reads them back tersely', async () => {
    const { call, close } = await connect()
    try {
      expect((await call('get_theme', { canvas_id: 'c1' })).json.theme).toBeNull()
      const set = await call('set_theme_tokens', {
        canvas_id: 'c1',
        agent_name: 'Claude',
        tokens: [
          { name: '--color-ink', value: '#17171b', description: 'body text' },
          { name: 'space-4', value: '16px' },
        ],
      })
      expect(set.json).toEqual({ ok: true, version: 1, tokens: 2 })
      await call('set_theme_tokens', {
        canvas_id: 'c1',
        agent_name: 'Claude',
        tokens: [{ name: '--space-4', value: '' }],
      })
      const read = await call('get_theme', { canvas_id: 'c1' })
      expect(read.json).toMatchObject({
        version: 2,
        tokens: { '--color-ink': '#17171b' },
        descriptions: { '--color-ink': 'body text' },
        css: '',
      })
      const replaced = await call('set_theme_tokens', {
        canvas_id: 'c1',
        agent_name: 'Claude',
        mode: 'replace',
        tokens: [{ name: '--brand', value: '#e5533c' }],
      })
      expect(replaced.json).toEqual({ ok: true, version: 3, tokens: 1 })
      expect(store.getCanvas('c1')!.theme!.tokens.map((t) => t.name)).toEqual(['--brand'])
    } finally {
      await close()
    }
  })

  it('reports validation errors without changing the theme', async () => {
    const { call, close } = await connect()
    try {
      const bad = await call('set_theme_tokens', {
        canvas_id: 'c2',
        agent_name: 'Claude',
        tokens: [{ name: '--Bad Name', value: '1px' }],
      })
      expect(bad.isError).toBe(true)
      expect(bad.texts[0]).toMatch(/invalid token name/)
      const css = await call('set_theme_css', { canvas_id: 'c2', agent_name: 'Claude', css: '@import url(a.css);' })
      expect(css.isError).toBe(true)
      expect(css.texts[0]).toMatch(/@import/)
      expect(store.getCanvas('c2')!.theme).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('denies accounts without access to the canvas', async () => {
    const { call, close } = await connect('intruder')
    try {
      for (const [name, args] of [
        ['get_theme', {}],
        ['set_theme_css', { css: '.a{}', agent_name: 'X' }],
      ] as const) {
        const res = await call(name, { canvas_id: 'c3', ...args })
        expect(res.isError, name).toBe(true)
        expect(res.texts[0]).toMatch(/no canvas with id c3 accessible/)
      }
      expect(store.getCanvas('c3')!.theme).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('reports fonts Google cannot serve with a <link> fallback note', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const { call, close } = await connect()
    try {
      const res = await call('set_theme_fonts', { canvas_id: 'c4', agent_name: 'Claude', families: ['Geist'] })
      expect(res.json).toMatchObject({ ok: true, fonts: ['Geist'], unresolved: ['Geist'] })
      expect(String(res.json.note)).toMatch(/<link>/)
    } finally {
      await close()
    }
  })

  it('summarizes the theme in get_canvas and nudges a frame writer who never saw it, once', async () => {
    const { call, close } = await connect()
    try {
      await call('set_theme_css', { canvas_id: 'c5', agent_name: 'Owner', css: '.btn{color:red}' })
      const summary = await call('get_canvas', { canvas_id: 'c5' })
      expect(summary.json.theme).toEqual({ tokens: 0, cssBytes: 15, fonts: [], version: 1 })
      expect(String(summary.json.note)).toMatch(/never paste the theme/)

      const nudge = /This canvas has a theme/
      const first = await call('set_frame_html', { frame_id: 'c5-f', agent_name: 'Newcomer', html: '<p>a</p>' })
      expect(first.texts.filter((t) => nudge.test(t))).toHaveLength(1)
      const second = await call('set_frame_html', { frame_id: 'c5-f', agent_name: 'Newcomer', html: '<p>b</p>' })
      expect(second.texts.some((t) => nudge.test(t))).toBe(false)
    } finally {
      await close()
    }
  })
})
