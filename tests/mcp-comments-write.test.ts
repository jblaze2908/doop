import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, ElementComment, Frame } from '../shared/types.ts'

/* One file, two levels of isolation. The contract/guard tests spy the
 * action seams so they can force branches; the real-state tests below let the
 * action layer run and mock only persistence, so they can read the stored
 * comment/activity/decision logs back. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
}))

const OWNER_ID = 'owner-1'

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Comments',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}

const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<h1>Hi</h1>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

function comment(overrides: Partial<ElementComment> & { id: string }): ElementComment {
  return {
    canvasId: CANVAS.id,
    frameId: FRAME.id,
    selector: '.hero h1',
    snippet: '<h1>Hi</h1>',
    from: 'alice',
    text: 'note',
    at: 1,
    ...overrides,
  }
}

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect(ownerId: string | undefined = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'draft-comment-write-test', version: '1.0.0' })
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

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: unknown; raw: string; isError?: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* error strings and multi-block results are not JSON — keep the raw text */
  }
  return { parsed, raw, isError: result.isError }
}

function stubCanvas(canvas: Canvas) {
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === canvas.id ? canvas : undefined))
}

function seedRoot(text: string) {
  const root = actions.addElementComment(FRAME.id, { selector: '.hero h1', snippet: '<h1>Hi</h1>', text }, 'alice')
  if (!root) throw new Error('failed to seed a root comment')
  return root
}

beforeEach(() => {
  vi.restoreAllMocks()
  stubCanvas(CANVAS)
  /* writes always announce presence — keep it off the presence map */
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
})

describe('element-comment write MCP tools', () => {
  it('registers reply_to_comment and resolve_comment as mutating tools', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const reply = tools.find((t) => t.name === 'reply_to_comment')
      const resolve = tools.find((t) => t.name === 'resolve_comment')
      expect(reply).toBeDefined()
      expect(resolve).toBeDefined()
      expect(reply!.annotations?.readOnlyHint).not.toBe(true)
      expect(resolve!.annotations?.readOnlyHint).not.toBe(true)

      const replySchema = reply!.inputSchema as { required?: string[] }
      expect(new Set(replySchema.required)).toEqual(new Set(['canvas_id', 'comment_id', 'text', 'agent_name']))
      const resolveSchema = resolve!.inputSchema as { required?: string[] }
      expect(new Set(resolveSchema.required)).toEqual(new Set(['canvas_id', 'comment_id', 'agent_name']))
    } finally {
      await close()
    }
  })

  it('replies in a thread, attributes it to the agent, and announces presence', async () => {
    const root = comment({ id: 'm1' })
    const reply = comment({ id: 'm2', parentId: 'm1', from: 'Claude', text: 'Done' })
    vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'openThread').mockReturnValue({ root, frame: FRAME })
    const replySpy = vi.spyOn(actions, 'replyToComment').mockReturnValue(reply)
    const heartbeat = vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '  Done  ',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toEqual(reply)
      /* the 4th arg is the actor kind: an agent reply must not log as a human */
      expect(replySpy).toHaveBeenCalledWith('m1', '  Done  ', 'Claude', 'agent')
      expect(heartbeat).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })

  it('rejects empty text and resolved threads', async () => {
    vi.spyOn(actions, 'findComment').mockReturnValue(comment({ id: 'm1' }))
    const openThread = vi.spyOn(actions, 'openThread').mockReturnValue(undefined)
    const replySpy = vi.spyOn(actions, 'replyToComment')
    const { client, close } = await connect()
    try {
      const blank = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '   ',
        agent_name: 'Claude',
      })
      expect(blank.isError).toBe(true)
      expect(blank.raw).toContain('thread resolved or empty text')

      const closed = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(closed.isError).toBe(true)
      expect(closed.raw).toContain('thread resolved or empty text')
      expect(openThread).toHaveBeenCalled()
      expect(replySpy).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('posts an @mention reply as-is and errors when the thread closes mid-write', async () => {
    const root = comment({ id: 'm1' })
    vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'openThread').mockReturnValue({ root, frame: FRAME })
    const replySpy = vi.spyOn(actions, 'replyToComment').mockReturnValue(comment({ id: 'm2', parentId: 'm1' }))
    const { client, close } = await connect()
    try {
      const ok = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '@Draft please tighten the hero',
        agent_name: 'Claude',
      })
      expect(ok.isError).toBeFalsy()
      expect(replySpy).toHaveBeenCalledWith('m1', '@Draft please tighten the hero', 'Claude', 'agent')

      replySpy.mockReturnValue(undefined)
      const failed = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '@Draft again',
        agent_name: 'Claude',
      })
      expect(failed.isError).toBe(true)
      expect(failed.raw).toContain('thread resolved or empty text')
    } finally {
      await close()
    }
  })

  it('rejects unknown/foreign comments and inaccessible canvases on reply', async () => {
    const find = vi.spyOn(actions, 'findComment').mockReturnValue(undefined)
    const replySpy = vi.spyOn(actions, 'replyToComment')
    const { client, close } = await connect()
    try {
      const unknown = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'nope',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(unknown.isError).toBe(true)
      expect(unknown.raw).toContain('no comment with id nope')

      find.mockReturnValue(comment({ id: 'm9', canvasId: 'c2' }))
      const foreign = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm9',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(foreign.isError).toBe(true)
      expect(foreign.raw).toContain('no comment with id m9')

      stubCanvas({ ...CANVAS, ownerId: 'someone-else' })
      const denied = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(denied.isError).toBe(true)
      expect(denied.raw).toContain('no canvas')
      expect(replySpy).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('resolves a thread and reports the already-resolved state', async () => {
    const root = comment({ id: 'm1' })
    const find = vi.spyOn(actions, 'findComment').mockReturnValue(root)
    const resolvedAt = Date.UTC(2026, 0, 1)
    const resolveSpy = vi
      .spyOn(actions, 'resolveComment')
      .mockReturnValue({ ...root, resolvedBy: 'Claude', resolvedAt })
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toMatchObject({ ok: true, id: 'm1', alreadyResolved: false, resolvedBy: 'Claude' })
      expect(resolveSpy).toHaveBeenCalledWith('m1', 'Claude')

      find.mockReturnValue({ ...root, resolvedAt, resolvedBy: 'alice' })
      const again = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        agent_name: 'Claude',
      })
      expect(again.parsed).toMatchObject({ ok: true, alreadyResolved: true })
    } finally {
      await close()
    }
  })

  it('allows link-edit access and rejects unknown comments on resolve', async () => {
    stubCanvas({ ...CANVAS, ownerId: 'someone-else', memberIds: [], linkAccess: 'edit' })
    const root = comment({ id: 'm1' })
    const find = vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'resolveComment').mockReturnValue({ ...root, resolvedBy: 'Claude', resolvedAt: 1 })
    const { client, close } = await connect()
    try {
      const allowed = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        agent_name: 'Claude',
      })
      expect(allowed.isError).toBeFalsy()

      find.mockReturnValue(undefined)
      const unknown = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'nope',
        agent_name: 'Claude',
      })
      expect(unknown.isError).toBe(true)
      expect(unknown.raw).toContain('no comment with id nope')
    } finally {
      await close()
    }
  })

  it('delivers pending human feedback alongside the reply', async () => {
    const root = comment({ id: 'm1' })
    vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'openThread').mockReturnValue({ root, frame: FRAME })
    vi.spyOn(actions, 'replyToComment').mockReturnValue(comment({ id: 'm2', parentId: 'm1' }))
    vi.spyOn(actions, 'takeFeedbackFor').mockReturnValue([
      {
        id: 'fb1',
        taskId: 't1',
        canvasId: CANVAS.id,
        agentName: 'Claude',
        from: 'alice',
        text: 'make the accent warmer',
        at: 1,
      },
    ])
    vi.spyOn(actions, 'getTasks').mockReturnValue([])
    const { client, close } = await connect()
    try {
      const { raw } = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: 'done',
        agent_name: 'Claude',
      })
      expect(raw).toContain('HUMAN FEEDBACK')
      expect(raw).toContain('make the accent warmer')
    } finally {
      await close()
    }
  })
})

describe('MCP comment write tools over real action state', () => {
  beforeEach(() => {
    actions.wire(
      () => {},
      () => {},
    )
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map([[CANVAS.id, []]]),
      activity: new Map([[CANVAS.id, []]]),
      decisions: new Map([[CANVAS.id, []]]),
    })
    vi.spyOn(store, 'getFrame').mockImplementation((id: string) => (id === FRAME.id ? FRAME : undefined))
  })

  it('stores an agent reply and logs it as an agent action', async () => {
    const root = seedRoot('Too small')
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: root.id,
        text: 'Done — bumped to 48px',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toMatchObject({ from: 'Claude', parentId: root.id, text: 'Done — bumped to 48px' })

      const comments = actions.getComments(CANVAS.id)
      expect(comments).toHaveLength(2)
      expect(comments[0]).toMatchObject({ from: 'Claude', parentId: root.id })

      const newest = actions.getActivity(CANVAS.id)[0]!
      expect(newest).toMatchObject({ actorName: 'Claude', actorKind: 'agent' })
      expect(newest.message).toContain('replied to a comment')
    } finally {
      await close()
    }
  })

  it('captures exactly one decision when a thread is resolved twice', async () => {
    const root = seedRoot('@Draft make it 48px')
    expect(root.forAgent).toBe(true)
    const { client, close } = await connect()
    try {
      const first = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: root.id,
        agent_name: 'Claude',
      })
      expect(first.isError).toBeFalsy()
      expect(first.parsed).toMatchObject({ ok: true, id: root.id, alreadyResolved: false, resolvedBy: 'Claude' })

      const decisions = actions.getDecisions(CANVAS.id)
      expect(decisions).toHaveLength(1)
      expect(decisions[0]).toMatchObject({
        text: '@Draft make it 48px',
        source: 'comment',
        from: 'alice',
        agentName: 'Claude',
      })
      const resolvedAt = actions.findComment(root.id)?.resolvedAt
      expect(resolvedAt).toBeDefined()

      const second = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: root.id,
        agent_name: 'Claude',
      })
      expect(second.parsed).toMatchObject({ ok: true, alreadyResolved: true })
      expect(actions.getDecisions(CANVAS.id)).toHaveLength(1)
      expect(actions.findComment(root.id)?.resolvedAt).toBe(resolvedAt)
    } finally {
      await close()
    }
  })

  it('records no decision for a plain human thread', async () => {
    const root = seedRoot('Nit: align the icon')
    const { client, close } = await connect()
    try {
      const { isError } = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: root.id,
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(actions.getDecisions(CANVAS.id)).toEqual([])
    } finally {
      await close()
    }
  })
})
