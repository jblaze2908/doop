import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* Real store, action layer and (where Chrome exists) renderer; persistence stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveCanvas: () => {},
  saveCanvasSoon: () => {},
  saveFrame: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { GUIDE_DOCS, GUIDE_TOPICS } = await import('../server/guide.ts')
const { findBrowserPath, measureFrameHeight, renderFrame } = await import('../server/screenshot.ts')

const OWNER_ID = 'owner-effort'
let canvasId: string

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'draft-effort-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: { agent_name: 'Claude', ...args } }, undefined, {
      timeout: 60_000,
    })) as unknown as CallResult
    return { texts: r.content.filter((b) => b.type === 'text').map((b) => b.text ?? ''), isError: r.isError }
  }
  return {
    call,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function frame(html: string, width = 1200, height = 900): Frame {
  return store.createFrame(canvasId, { name: 'F', x: 0, y: 0, width, height, html }, 'Jai')!
}

/** PNG width/height from the IHDR chunk. */
const pngSize = (buf: Buffer) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('effort', OWNER_ID).id
})

describe('agent guide', () => {
  it('keeps the core small and indexes every topic it leaves out', () => {
    const core = GUIDE_DOCS['draft-instructions']
    expect(core.length).toBeLessThan(10_000)
    for (const topic of GUIDE_TOPICS) {
      expect(GUIDE_DOCS[topic].length).toBeGreaterThan(0)
      if (topic !== 'draft-instructions') expect(core).toContain(`"${topic}"`)
    }
  })

  it('serves a topic through get_guide', async () => {
    const { call, close } = await connect()
    try {
      const res = await call('get_guide', { topic: 'collaboration' })
      expect(res.texts[0]).toContain('## Board cards')
    } finally {
      await close()
    }
  })
})

describe('quieter results', () => {
  it('does not repeat the review nudge after a small edit', async () => {
    const f = frame('<h1>Hi</h1>')
    const { call, close } = await connect()
    try {
      const res = await call('edit_frame_html', { frame_id: f.id, old_str: 'Hi', new_str: 'Hello' })
      expect(res.isError).toBeFalsy()
      expect(res.texts.join('\n')).not.toContain('You have not seen this design yet')
    } finally {
      await close()
    }
  })
})

describe.skipIf(!findBrowserPath())('fit and crop (real Chrome)', () => {
  it('measures a page taller than its frame, and one shorter, so fitting grows and shrinks', async () => {
    expect(await measureFrameHeight(frame('<div style="height:2400px"></div>'))).toBeGreaterThanOrEqual(2400)
    const short = await measureFrameHeight(
      frame('<style>*{margin:0}</style><div style="height:200px"></div>', 1200, 900),
    )
    expect(short).toBeGreaterThanOrEqual(200)
    expect(short).toBeLessThan(260)
  }, 60_000)

  it('crops a screenshot to one element, and names a selector that misses', async () => {
    const f = frame(
      '<style>*{margin:0}</style><header style="height:100px"></header><section class="pricing" style="height:300px;width:600px"></section>',
    )
    expect(pngSize(await renderFrame(f, 1, { selector: 'section.pricing' }))).toEqual({ width: 600, height: 300 })
    await expect(renderFrame(f, 1, { selector: '.nope' })).rejects.toThrow('no element matches ".nope"')
  }, 60_000)

  it('sizes a frame created with height "fit" to its document', async () => {
    const { call, close } = await connect()
    try {
      const res = await call('create_frame', {
        canvas_id: canvasId,
        name: 'Landing',
        width: 1200,
        height: 'fit',
        html: '<style>*{margin:0}</style><main style="height:3100px"></main>',
      })
      expect(res.isError).toBeFalsy()
      const id = (JSON.parse(res.texts[0] ?? '{}') as { frame: { id: string } }).frame.id
      expect(store.getFrame(id)!.height).toBeGreaterThanOrEqual(3100)
      expect(store.getFrame(id)!.height).toBeLessThan(3200)
    } finally {
      await close()
    }
  }, 60_000)
})
