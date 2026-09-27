import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { Client, startServer } from './harness.ts'
import type { ServerMessage } from '../shared/types.ts'

const PORT = 5003

/** A dashboard socket that records every home:* message it receives. */
function dashboard(cookie: string): Promise<{ msgs: ServerMessage[]; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie } })
    const msgs: ServerMessage[] = []
    ws.on('message', (d) => msgs.push(JSON.parse(String(d)) as ServerMessage))
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'home' }))
      /* the server has no ack for 'home'; give it a beat to register */
      setTimeout(() => resolve({ msgs, ws }), 150)
    })
  })
}

const settle = (ms = 1300) => new Promise((r) => setTimeout(r, ms))
const rowsFor = (msgs: ServerMessage[], canvasId: string) =>
  msgs.flatMap((m) => (m.type === 'home:canvas' && m.canvas.id === canvasId ? [m.canvas] : []))

it('pushes canvas rows live to everyone who can list the canvas, and only them', async () => {
  const server = await startServer(PORT)
  try {
    const owner = await new Client(server).signUp('home-owner@test.dev', 'Owner')
    const member = await new Client(server).signUp('home-member@test.dev', 'Member')
    const stranger = await new Client(server).signUp('home-stranger@test.dev', 'Stranger')
    const [ownerHome, memberHome, strangerHome] = await Promise.all([
      dashboard(owner.header()),
      dashboard(member.header()),
      dashboard(stranger.header()),
    ])

    /* created elsewhere (here over REST, the same store path MCP uses): shows up without a reload */
    const canvas = (await (await owner.post('/api/canvases', { name: 'Live' })).json()) as { id: string }
    await settle(300)
    expect(rowsFor(ownerHome.msgs, canvas.id)[0]).toMatchObject({ name: 'Live', frameCount: 0 })

    /* a burst of edits reaches the dashboard coalesced, ending on the latest state */
    await owner.patch(`/api/canvases/${canvas.id}`, { name: 'Live, renamed' })
    for (let i = 0; i < 5; i++)
      await owner.post(`/api/canvases/${canvas.id}/frames`, { name: `F${i}`, html: '<p>x</p>' })
    await settle()
    const rows = rowsFor(ownerHome.msgs, canvas.id)
    expect(rows.at(-1)).toMatchObject({ name: 'Live, renamed', frameCount: 5 })
    expect(rows.length).toBeLessThanOrEqual(3)

    /* invited: the member's dashboard gains the row; the stranger never hears of it */
    expect(rowsFor(memberHome.msgs, canvas.id)).toHaveLength(0)
    expect((await owner.post(`/api/canvases/${canvas.id}/members`, { email: 'home-member@test.dev' })).status).toBe(200)
    await settle()
    expect(rowsFor(memberHome.msgs, canvas.id).at(-1)).toMatchObject({ shared: true, frameCount: 5 })

    /* the live activity feed streams too (frame creation logs activity) */
    expect(ownerHome.msgs.some((m) => m.type === 'home:activity' && m.item.canvasId === canvas.id)).toBe(true)

    /* uninvited: the row leaves the member's dashboard */
    const members = (await (await owner.get(`/api/canvases/${canvas.id}/members`)).json()) as {
      userId: string
      owner: boolean
    }[]
    const memberId = members.find((m) => !m.owner)!.userId
    await owner.delete(`/api/canvases/${canvas.id}/members/${memberId}`)
    await settle(300)
    expect(memberHome.msgs).toContainEqual({ type: 'home:canvas:removed', canvasId: canvas.id })

    /* deleted: gone from the owner's dashboard */
    await owner.delete(`/api/canvases/${canvas.id}`)
    await settle(300)
    expect(ownerHome.msgs).toContainEqual({ type: 'home:canvas:removed', canvasId: canvas.id })

    expect(strangerHome.msgs.filter((m) => m.type.startsWith('home:'))).toEqual([])
    for (const h of [ownerHome, memberHome, strangerHome]) h.ws.close()
  } finally {
    server.stop()
  }
}, 90_000)

it('refuses a dashboard socket without a session', async () => {
  const server = await startServer(PORT)
  try {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
      ws.on('open', () => ws.send(JSON.stringify({ type: 'home' })))
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4401)
  } finally {
    server.stop()
  }
}, 90_000)
