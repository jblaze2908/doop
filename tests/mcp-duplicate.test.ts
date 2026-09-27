import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../shared/types.ts'

/* Real store and action layer, persistence stubbed: the copy is read back from
 * the store the canvas renders. */
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

const OWNER_ID = 'owner-dup'
const PAGE = '<div class="site" data-theme="light"><a class="mode">moon</a><h1>Agents draft.</h1></div>'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

let canvasId: string
let sent: ServerMessage[]

async function connect(ownerId = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'draft-duplicate-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (args: Record<string, unknown>) => {
    const result = (await client.callTool({
      name: 'duplicate_frame',
      arguments: { agent_name: 'Claude', ...args },
    })) as unknown as CallResult
    const texts = result.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')
    let data: unknown = texts[0]
    try {
      data = JSON.parse(texts[0] ?? '')
    } catch {
      /* error strings are not JSON */
    }
    return { data: data as { frame?: { id: string; x: number; y: number } }, texts, isError: result.isError }
  }
  return {
    call,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function frame(name: string, x: number, width = 1440, height = 900, html = PAGE) {
  return store.createFrame(canvasId, { name, x, y: 0, width, height, html }, 'Jai')!
}

beforeEach(() => {
  sent = []
  actions.wire(
    (_canvasId, msg) => sent.push(msg),
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
  })
  canvasId = store.createCanvas('duplicate', OWNER_ID).id
})

describe('duplicate_frame', () => {
  it('copies html and size beside the source and broadcasts it whole', async () => {
    const source = frame('Landing', 0)
    const { call, close } = await connect()
    try {
      const res = await call({ frame_id: source.id })
      expect(res.isError).toBeFalsy()
      const copy = store.getFrame(res.data.frame!.id)!
      expect(copy).toMatchObject({ name: 'Landing copy', html: PAGE, width: 1440, height: 900, x: 1440 + 80, y: 0 })
      /* no reveal: viewers get the full document at once */
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'frame:created', frame: expect.objectContaining({ id: copy.id, html: PAGE }) }),
      )
      expect(actions.getActivity(canvasId)[0]?.message).toBe('duplicated “Landing” as “Landing copy”')
      /* an untouched copy is not new work to review */
      expect(res.texts.join('\n')).not.toContain('You have not seen this design yet')
    } finally {
      await close()
    }
  })

  it('applies edits to the copy only, making a variant in one call', async () => {
    const source = frame('Landing', 0)
    const { call, close } = await connect()
    try {
      const res = await call({
        frame_id: source.id,
        name: 'Landing (dark)',
        edits: [
          { old_str: 'data-theme="light"', new_str: 'data-theme="dark"' },
          { old_str: '>moon<', new_str: '>sun<' },
        ],
      })
      const copy = store.getFrame(res.data.frame!.id)!
      expect(copy.name).toBe('Landing (dark)')
      expect(copy.html).toBe('<div class="site" data-theme="dark"><a class="mode">sun</a><h1>Agents draft.</h1></div>')
      expect(store.getFrame(source.id)!.html).toBe(PAGE)
      expect(res.texts.join('\n')).toContain('You have not seen this design yet')
    } finally {
      await close()
    }
  })

  it('creates nothing when an edit misses or matches more than once', async () => {
    const source = frame('Landing', 0, 1440, 900, '<p>a</p><p>a</p>')
    const { call, close } = await connect()
    try {
      const missing = await call({ frame_id: source.id, edits: [{ old_str: '<h2>', new_str: '' }] })
      expect(missing.isError).toBe(true)
      expect(missing.texts[0]).toContain('edit 1: old_str matches 0 times')
      const twice = await call({ frame_id: source.id, edits: [{ old_str: '<p>a</p>', new_str: '' }] })
      expect(twice.texts[0]).toContain('matches 2 times')
      const empty = await call({ frame_id: source.id, edits: [{ old_str: '', new_str: 'x' }] })
      expect(empty.isError).toBe(true)
      expect(store.getCanvas(canvasId)!.frames).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('steps past frames already beside the source, and honours x/y and size overrides', async () => {
    const source = frame('Landing', 0)
    frame('Pricing', 1440 + 80, 600, 400)
    const { call, close } = await connect()
    try {
      const beside = await call({ frame_id: source.id })
      expect(beside.data.frame).toMatchObject({ x: 1440 + 80 + 600 + 80, y: 0 })
      const placed = await call({ frame_id: source.id, x: -2000, y: 300, width: 390, height: 844 })
      expect(store.getFrame(placed.data.frame!.id)).toMatchObject({ x: -2000, y: 300, width: 390, height: 844 })
    } finally {
      await close()
    }
  })

  it('refuses frames on canvases the account cannot open', async () => {
    const source = frame('Landing', 0)
    const { call, close } = await connect('someone-else')
    try {
      const res = await call({ frame_id: source.id })
      expect(res.isError).toBe(true)
      expect(store.getCanvas(canvasId)!.frames).toHaveLength(1)
    } finally {
      await close()
    }
  })
})
