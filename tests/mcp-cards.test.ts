import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, ServerMessage } from '../shared/types.ts'

/* Real action layer, persistence stubbed: the board's state is read back
 * from the task log the Board view renders. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
}))

const OWNER_ID = 'owner-1'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

let canvas: Canvas
let sent: ServerMessage[]
let n = 0

async function connect(ownerId = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'draft-cards-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
    const texts = result.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')
    let data: unknown = texts[0]
    try {
      data = JSON.parse(texts[0] ?? '')
    } catch {
      /* error strings are not JSON */
    }
    return { data, texts, isError: result.isError }
  }
  return {
    client,
    call,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  /* a fresh canvas id per test keeps the per-process queue notices apart */
  canvas = { id: `cards-${++n}`, name: 'Board', ownerId: OWNER_ID, createdAt: 0, updatedAt: 0, frames: [] }
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === canvas.id ? canvas : undefined))
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
})

describe('board card MCP tools', () => {
  it('lists get_cards as read-only next to claim_card and finish_card', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((t) => [t.name, t]))
      expect(byName.get('get_cards')?.annotations?.readOnlyHint).toBe(true)
      expect(byName.has('claim_card')).toBe(true)
      expect(byName.has('finish_card')).toBe(true)
    } finally {
      await close()
    }
  })

  it('lists queued cards oldest first and moves a claimed one to inProgress', async () => {
    const first = actions.addQueuedCard(canvas.id, 'Design a pricing page', 'alice')!
    const second = actions.addQueuedCard(canvas.id, 'Tighten the hero copy', 'bob')!
    const { call, close } = await connect()
    try {
      const before = (await call('get_cards', { canvas_id: canvas.id })).data as {
        queued: { id: string; text: string; from: string }[]
      }
      expect(before.queued.map((c) => c.id)).toEqual([first.id, second.id])
      expect(before.queued[0]).toMatchObject({ text: 'Design a pricing page', from: 'alice' })

      const claim = await call('claim_card', { canvas_id: canvas.id, card_id: first.id, agent_name: 'Claude' })
      expect(claim.isError).toBeFalsy()
      expect(claim.data).toMatchObject({ ok: true, id: first.id, text: 'Design a pricing page' })

      const after = (await call('get_cards', { canvas_id: canvas.id })).data as {
        queued: { id: string }[]
        inProgress: { id: string; agent: string; claimedAt: string }[]
      }
      expect(after.queued.map((c) => c.id)).toEqual([second.id])
      expect(after.inProgress).toEqual([expect.objectContaining({ id: first.id, agent: 'Claude' })])
      expect(sent).toContainEqual({
        type: 'task',
        task: expect.objectContaining({ id: first.id, agentName: 'Claude' }),
      })
    } finally {
      await close()
    }
  })

  it('keeps a claim exclusive and lets only the claimant finish it', async () => {
    const card = actions.addQueuedCard(canvas.id, 'Add a footer', 'alice')!
    const { call, close } = await connect()
    try {
      await call('claim_card', { canvas_id: canvas.id, card_id: card.id, agent_name: 'Claude' })
      const stolen = await call('claim_card', { canvas_id: canvas.id, card_id: card.id, agent_name: 'Codex' })
      expect(stolen.isError).toBe(true)
      expect(stolen.texts[0]).toContain('Claude already claimed it')

      const again = await call('claim_card', { canvas_id: canvas.id, card_id: card.id, agent_name: 'Claude' })
      expect(again.isError).toBeFalsy()

      const wrong = await call('finish_card', {
        canvas_id: canvas.id,
        card_id: card.id,
        outcome: 'done',
        agent_name: 'Codex',
      })
      expect(wrong.isError).toBe(true)
      expect(actions.holdsCard(canvas.id, 'Claude')).toBe(true)

      const done = await call('finish_card', {
        canvas_id: canvas.id,
        card_id: card.id,
        outcome: 'done',
        agent_name: 'Claude',
      })
      expect(done.data).toMatchObject({ ok: true, outcome: 'done' })
      expect(actions.getTasks(canvas.id).find((t) => t.id === card.id)?.endedAt).toBeTypeOf('number')
      expect(actions.holdsCard(canvas.id, 'Claude')).toBe(false)
      expect(actions.openCards(canvas.id)).toEqual([])
    } finally {
      await close()
    }
  })

  it('parks a failed card with its reason until a human retries it', async () => {
    const card = actions.addQueuedCard(canvas.id, 'Match the brand deck', 'alice')!
    const { call, close } = await connect()
    try {
      const early = await call('finish_card', {
        canvas_id: canvas.id,
        card_id: card.id,
        outcome: 'failed',
        agent_name: 'Claude',
      })
      expect(early.isError).toBe(true)
      expect(early.texts[0]).toContain('claim it with claim_card first')

      await call('claim_card', { canvas_id: canvas.id, card_id: card.id, agent_name: 'Claude' })
      const failed = await call('finish_card', {
        canvas_id: canvas.id,
        card_id: card.id,
        outcome: 'failed',
        reason: `No brand deck is attached. ${'x'.repeat(900)}`,
        agent_name: 'Claude',
      })
      expect(failed.data).toMatchObject({ ok: true, outcome: 'failed' })
      const board = (await call('get_cards', { canvas_id: canvas.id })).data as {
        failed: { id: string; reason: string }[]
      }
      expect(board.failed[0]?.id).toBe(card.id)
      expect(board.failed[0]?.reason.startsWith('No brand deck is attached.')).toBe(true)
      expect(board.failed[0]?.reason.length).toBe(500)

      const blocked = await call('claim_card', { canvas_id: canvas.id, card_id: card.id, agent_name: 'Codex' })
      expect(blocked.isError).toBe(true)

      actions.retryCard(canvas.id, card.id, 'alice')
      const retried = await call('claim_card', { canvas_id: canvas.id, card_id: card.id, agent_name: 'Codex' })
      expect(retried.isError).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('tells each agent about waiting cards once per change to the queue', async () => {
    const { call, close } = await connect()
    const board = (texts: string[]) => texts.filter((t) => t.startsWith('BOARD'))
    try {
      expect(
        board((await call('set_status', { canvas_id: canvas.id, status: 'Warming up', agent_name: 'Claude' })).texts),
      ).toEqual([])

      const card = actions.addQueuedCard(canvas.id, 'Design a pricing page', 'alice')!
      const told = board(
        (await call('set_status', { canvas_id: canvas.id, status: 'Looking', agent_name: 'Claude' })).texts,
      )
      expect(told).toHaveLength(1)
      expect(told[0]).toContain(card.id)
      expect(told[0]).toContain('Design a pricing page')

      expect(
        board((await call('set_status', { canvas_id: canvas.id, status: 'Still', agent_name: 'Claude' })).texts),
      ).toEqual([])
      /* a second agent hears about the same queue on its own first call */
      expect(
        board((await call('set_status', { canvas_id: canvas.id, status: 'Hi', agent_name: 'Codex' })).texts),
      ).toHaveLength(1)

      actions.addQueuedCard(canvas.id, 'Tighten the hero copy', 'bob')
      await call('get_cards', { canvas_id: canvas.id, agent_name: 'Claude' })
      expect(
        board((await call('set_status', { canvas_id: canvas.id, status: 'Next', agent_name: 'Claude' })).texts),
      ).toEqual([])
    } finally {
      await close()
    }
  })

  it('refuses cards on canvases the account cannot open', async () => {
    const card = actions.addQueuedCard(canvas.id, 'Secret work', 'alice')!
    const { call, close } = await connect('someone-else')
    try {
      const read = await call('get_cards', { canvas_id: canvas.id })
      expect(read.isError).toBe(true)
      const claim = await call('claim_card', { canvas_id: canvas.id, card_id: card.id, agent_name: 'Claude' })
      expect(claim.isError).toBe(true)
      expect(actions.openCards(canvas.id)[0]?.agentName).toBe('')
    } finally {
      await close()
    }
  })
})
