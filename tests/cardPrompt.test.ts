import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The queue mirrors into Postgres and broadcasts; this test only cares about
   the text a card carries. */
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

/**
 * A card's text IS the request. It used to be cut to 200 characters on the
 * way in, so any instruction past that point was lost. These tests pin that
 * the whole prompt is kept.
 */

const filler = 'this opening is deliberately filler and carries no instruction at all, please ignore it. '
const longPrompt = `${filler.repeat(3)}the real task: create one 600x400 frame named BRIEF OK with a centered black circle.`

let canvasId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
  })
  canvasId = store.createCanvas('card prompt', 'kevin').id
})

describe('addQueuedCard', () => {
  it('keeps a prompt longer than 200 characters intact', () => {
    expect(longPrompt.length).toBeGreaterThan(200)
    const card = actions.addQueuedCard(canvasId, longPrompt, 'kevin')
    expect(card?.status).toBe(longPrompt)
    expect(actions.getTasks(canvasId)[0]?.status).toBe(longPrompt)
  })

  it('caps a pasted document at MAX_CARD_CHARS', () => {
    const card = actions.addQueuedCard(canvasId, 'x'.repeat(actions.MAX_CARD_CHARS + 1), 'kevin')
    expect(card?.status.length).toBe(actions.MAX_CARD_CHARS)
  })

  it('treats the same long prompt queued twice as one card', () => {
    const first = actions.addQueuedCard(canvasId, longPrompt, 'kevin')
    const again = actions.addQueuedCard(canvasId, ` ${longPrompt} `, 'kevin')
    expect(again?.id).toBe(first?.id)
    expect(actions.getTasks(canvasId)).toHaveLength(1)
  })

  it('does not merge two prompts that only share their first 200 characters', () => {
    const a = actions.addQueuedCard(canvasId, `${filler.repeat(3)}make it red`, 'kevin')
    const b = actions.addQueuedCard(canvasId, `${filler.repeat(3)}make it blue`, 'kevin')
    expect(b?.id).not.toBe(a?.id)
    expect(actions.getTasks(canvasId)).toHaveLength(2)
  })
})

describe('trimTaskLog', () => {
  it('drops the oldest finished tasks first and never an open card', () => {
    const now = Date.now()
    const list = Array.from({ length: 130 }, (_, i) => ({
      id: `t${i}`,
      agentName: i % 3 === 0 ? '' : 'Claude',
      color: '#000',
      status: `task ${i}`,
      startedAt: now - i,
      /* every third task is an open queued card; the rest are finished */
      ...(i % 3 === 0 ? { queuedBy: 'kevin' } : { endedAt: now }),
    }))
    const trimmed = actions.trimTaskLog(list)
    expect(trimmed).toHaveLength(100)
    expect(trimmed.filter((t) => t.queuedBy && !t.endedAt)).toHaveLength(44)
    /* newest first is preserved; the finished tasks that survive are the newest ones */
    expect(trimmed[0]!.id).toBe('t0')
    expect(trimmed.some((t) => t.id === 't128')).toBe(false)
    expect(trimmed.some((t) => t.id === 't1')).toBe(true)
  })
})
