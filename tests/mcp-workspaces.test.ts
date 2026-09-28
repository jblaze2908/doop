import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

/* Real store, workspaces and MCP server; persistence stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveActivity: () => {},
  saveCanvas: () => {},
  saveCanvasSoon: () => {},
  saveCanvasTheme: () => {},
  saveFrame: () => {},
  saveDesignSystem: () => {},
}))
/* workspace writes go to the DB; a chain that resolves to nothing keeps them off disk */
vi.mock('../server/db/index.ts', () => {
  const chain: object = new Proxy(() => {}, {
    get: (_t, p) => (p === 'then' ? (resolve: (v: unknown) => void) => resolve(undefined) : chain),
    apply: () => chain,
  })
  return { db: chain }
})

const { buildMcpServer } = await import('../server/mcp.ts')
const workspaces = await import('../server/workspaces.ts')

async function connect(ownerId: string | undefined) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'draft-ws-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: { agent_name: 'Claude', ...args } })) as unknown as {
      content: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    const text = r.content[0]?.text ?? ''
    return r.isError
      ? { error: text, json: {} as Record<string, unknown> }
      : { error: undefined, json: JSON.parse(text) }
  }
  return { call, close: () => Promise.all([client.close(), server.close()]) }
}

type Row = { id: string; name: string; role: string; canvases: number }

describe('workspaces over MCP', () => {
  it('lists every workspace the user belongs to, empty ones included, and creates new ones', async () => {
    const empty = workspaces.createWorkspace('Personal', 'ws-agent-owner')
    const owner = await connect('ws-agent-owner')
    const stranger = await connect('ws-agent-stranger')
    try {
      const before = (await owner.call('list_canvases')).json as { workspaces: Row[]; canvases: unknown[] }
      expect(before.workspaces).toEqual([expect.objectContaining({ id: empty.id, name: 'Personal', canvases: 0 })])

      const made = await owner.call('create_workspace', { name: '  Studio  ' })
      const studio = (made.json.workspace as Row).id
      expect(made.json.workspace).toMatchObject({ name: 'Studio', role: 'owner', canvases: 0 })
      const canvas = await owner.call('create_canvas', { name: 'In studio', workspace_id: studio })
      expect(canvas.error).toBeUndefined()

      const after = (await owner.call('list_canvases')).json as {
        workspaces: Row[]
        canvases: { id: string; workspace_id?: string }[]
      }
      expect(after.workspaces.map((w) => [w.name, w.canvases])).toEqual([
        ['Personal', 0],
        ['Studio', 1],
      ])
      expect(after.canvases.find((c) => c.id === canvas.json.id)?.workspace_id).toBe(studio)

      expect(((await stranger.call('list_canvases')).json as { workspaces: Row[] }).workspaces).toEqual([])
      expect((await owner.call('create_workspace', { name: '   ' })).error).toContain('name is required')
    } finally {
      await owner.close()
      await stranger.close()
    }
  })

  it('refuses to create a workspace without a signed-in account', async () => {
    const anon = await connect(undefined)
    try {
      expect((await anon.call('create_workspace', { name: 'X' })).error).toContain('signed-in')
    } finally {
      await anon.close()
    }
  })
})
