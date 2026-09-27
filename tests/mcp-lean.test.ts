import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const HTML = `<!doctype html><html><head><style>.hero{padding:8px}</style></head><body>
<header class="nav"><a class="brand">Tijori</a></header>
<section class="hero" id="hero">
  <h1 class="t-display">Every rupee you own</h1>
  <p class="lead">Price: $5</p>
  <a class="btn">Get early access</a>
</section>
</body></html>`

const canvas = (): Canvas => ({
  id: 'lean',
  name: 'Lean',
  ownerId: 'owner-1',
  createdAt: 0,
  updatedAt: 0,
  frames: [
    {
      id: 'lp',
      canvasId: 'lean',
      name: 'Landing',
      html: HTML,
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'a',
    },
  ],
})

beforeEach(() => {
  store.canvases.clear()
  store.init([canvas()])
})

async function connect() {
  const server = buildMcpServer('Test Owner', 'owner-1')
  const client = new Client({ name: 'lean-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[]
      isError?: boolean
    }
    return { text: r.content[0]?.text ?? '', isError: r.isError }
  }
  return { call, close: () => Promise.all([client.close(), server.close()]) }
}

describe('lean frame reads', () => {
  it('outlines the body with @paths, terse and depth-limited', async () => {
    const { call, close } = await connect()
    try {
      const { text } = await call('get_frame_outline', { frame_id: 'lp', depth: 1 })
      expect(text.split('\n')).toEqual([
        `Landing · 1440×900 · ${HTML.length} chars of HTML`,
        '1 header.nav [1]',
        '2 section#hero.hero [3]',
      ])
      const deeper = await call('get_frame_outline', { frame_id: 'lp', from: '#hero' })
      expect(deeper.text).toContain('2.1 h1.t-display "Every rupee you own"')
    } finally {
      await close()
    }
  })

  it('reads one element by @path or unique selector, and explains ambiguity', async () => {
    const { call, close } = await connect()
    try {
      const byPath = await call('get_frame_section', { frame_id: 'lp', selector: '@2.1' })
      expect(byPath.text).toBe('@2.1 <h1>\n<h1 class="t-display">Every rupee you own</h1>')
      const bySelector = await call('get_frame_section', { frame_id: 'lp', selector: '#hero > .btn' })
      expect(bySelector.text).toContain('<a class="btn">Get early access</a>')
      const many = await call('get_frame_section', { frame_id: 'lp', selector: 'a' })
      expect(many.isError).toBe(true)
      expect(many.text).toMatch(/matches 2 elements.*@1\.1, @2\.3/)
    } finally {
      await close()
    }
  })

  it('replaces exactly one element and keeps every other byte', async () => {
    const { call, close } = await connect()
    try {
      const res = await call('replace_frame_section', {
        frame_id: 'lp',
        selector: '@2.1',
        html: '<h1 class="t-display">Your ledger</h1>',
        agent_name: 'Claude',
      })
      expect(JSON.parse(res.text)).toMatchObject({ ok: true, replaced: '@2.1 <h1>' })
      expect(store.getFrame('lp')!.html).toBe(HTML.replace('Every rupee you own', 'Your ledger'))
      const implied = await call('replace_frame_section', {
        frame_id: 'lp',
        selector: 'head',
        html: '',
        agent_name: 'Claude',
      })
      expect(implied.isError).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('finds text and attribute values across frames with the source to edit', async () => {
    const { call, close } = await connect()
    try {
      const found = JSON.parse((await call('find_in_canvas', { canvas_id: 'lean', text: 'Get early access' })).text)
      expect(found).toEqual({
        matches: 1,
        results: [{ frame_id: 'lp', frame: 'Landing', path: '@2.3', source: '<a class="btn">Get early access</a>' }],
      })
      const attr = JSON.parse((await call('find_in_canvas', { canvas_id: 'lean', text: 'hero' })).text)
      expect(attr.results.map((r: { path: string }) => r.path)).toEqual(['@2'])
      const none = JSON.parse((await call('find_in_canvas', { canvas_id: 'lean', text: 'Nope' })).text)
      expect(none).toMatchObject({ matches: 0 })
    } finally {
      await close()
    }
  })

  it('keeps $ patterns literal in edit_frame_html replacements', async () => {
    const { call, close } = await connect()
    try {
      await call('edit_frame_html', {
        frame_id: 'lp',
        old_str: 'Price: $5',
        new_str: 'Price: $& and $1',
        agent_name: 'Claude',
      })
      expect(store.getFrame('lp')!.html).toContain('<p class="lead">Price: $& and $1</p>')
    } finally {
      await close()
    }
  })
})
