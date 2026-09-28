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
  saveComponent: () => {},
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

async function connectRaw() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'draft-effort-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

async function connect() {
  const { client, close } = await connectRaw()
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: { agent_name: 'Claude', ...args } }, undefined, {
      timeout: 60_000,
    })) as unknown as CallResult
    return { texts: r.content.filter((b) => b.type === 'text').map((b) => b.text ?? ''), isError: r.isError }
  }
  return { call, close }
}

function frame(html: string, width = 1200, height = 900): Frame {
  return store.createFrame(canvasId, { name: 'F', x: 0, y: 0, width, height, html }, 'Jai')!
}

/** PNG width/height from the IHDR chunk. */
const pngSize = (buf: Buffer) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })

/** JPEG width/height from the first baseline/progressive frame header. */
function jpegSize(buf: Buffer) {
  for (let i = 2; i < buf.length; i += 2 + buf.readUInt16BE(i + 2)) {
    const marker = buf[i + 1]
    if (marker === 0xc0 || marker === 0xc2) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
  }
  throw new Error('no JPEG frame header')
}

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
    expect(core.length).toBeLessThan(11_000)
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

describe('batch', () => {
  it('runs independent writes in one call, in order, through each tool’s own validation', async () => {
    const f = frame('<h1>Old</h1>')
    const { call, close } = await connect()
    try {
      const res = await call('batch', {
        ops: [
          {
            tool: 'set_component',
            args: {
              canvas_id: canvasId,
              name: 'ds-chip',
              html: '<span><slot></slot></span>',
              css: ':host{display:inline-block}',
            },
          },
          { tool: 'edit_frame_html', args: { frame_id: f.id, old_str: 'Old', new_str: 'New' } },
          { tool: 'create_frame', args: { canvas_id: canvasId, name: 'Second', html: '<p>2</p>' } },
        ],
      })
      expect(res.isError, res.texts[0]).toBeFalsy()
      const out = JSON.parse(res.texts[0] ?? '{}') as { results: { op: number; tool: string }[] }
      expect(out.results.map((r) => r.tool)).toEqual(['set_component', 'edit_frame_html', 'create_frame'])
      expect(store.getFrame(f.id)!.html).toBe('<h1>New</h1>')
      expect(store.getCanvas(canvasId)!.frames.map((x) => x.name)).toContain('Second')
    } finally {
      await close()
    }
  })

  it('stops at the first failing op and says which ran', async () => {
    const f = frame('<h1>Old</h1>')
    const { call, close } = await connect()
    try {
      const res = await call('batch', {
        ops: [
          { tool: 'edit_frame_html', args: { frame_id: f.id, old_str: 'Old', new_str: 'New' } },
          { tool: 'edit_frame_html', args: { frame_id: f.id, old_str: 'missing', new_str: 'x' } },
          { tool: 'create_frame', args: { canvas_id: canvasId, name: 'Never', html: '<p/>' } },
        ],
      })
      expect(res.isError).toBe(true)
      expect(res.texts[0]).toContain('op 2 (edit_frame_html) failed')
      expect(res.texts[0]).toContain('Ops 1–1 were applied')
      expect(store.getCanvas(canvasId)!.frames.map((x) => x.name)).not.toContain('Never')
      const bad = await call('batch', { ops: [{ tool: 'create_frame', args: { canvas_id: canvasId } }] })
      expect(bad.texts[0]).toContain('op 1 (create_frame): invalid args')
    } finally {
      await close()
    }
  })

  it('keeps streaming and screenshots out of batches', async () => {
    const { call, close } = await connect()
    try {
      const res = await call('batch', { ops: [{ tool: 'append_frame_html', args: {} }] })
      expect(res.isError).toBe(true)
    } finally {
      await close()
    }
  })
})

describe.skipIf(!findBrowserPath())('fit and crop (real Chrome)', () => {
  it('caps a review screenshot at 1024 wide, and a tall page at 1568 high', async () => {
    const { client, close } = await connectRaw()
    try {
      const size = async (f: Frame, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool(
          { name: 'get_frame_screenshot', arguments: { frame_id: f.id, ...args } },
          undefined,
          {
            timeout: 60_000,
          },
        )) as unknown as { content: Array<{ type: string; data?: string; mimeType?: string }> }
        const img = r.content.find((b) => b.type === 'image')!
        return { mime: img.mimeType, ...jpegSize(Buffer.from(img.data ?? '', 'base64')) }
      }
      expect(await size(frame('<div style="height:900px"></div>', 1440, 900))).toEqual({
        mime: 'image/jpeg',
        width: 1024,
        height: 640,
      })
      const tall = await size(frame('<div style="height:5000px"></div>', 1440, 5000))
      expect(tall.height).toBe(1568)
      expect(tall.width).toBeGreaterThan(440)
    } finally {
      await close()
    }
  }, 60_000)

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
