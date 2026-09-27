import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { Client, startServer } from './harness.ts'

const PORT = 4991

type Msg = { type: string; patch?: Record<string, unknown>; frame?: { html: string }; updatedAt?: number }

function viewer(cookie: string, canvasId: string): Promise<{ msgs: Msg[]; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie } })
    const msgs: Msg[] = []
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg
      msgs.push(m)
      if (m.type === 'init') resolve({ msgs, ws })
    })
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'v', name: 'v', kind: 'user' })))
  })
}

const settle = () => new Promise((r) => setTimeout(r, 200))

it('sends a move as a slim patch that leaves the render stamp alone', async () => {
  const server = await startServer(PORT)
  try {
    const owner = new Client(server)
    await owner.signUp('patched@test.dev', 'Patcher')
    const canvas = await (await owner.post('/api/canvases', { name: 'P' })).json()
    const frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'F', html: '<p>hi</p>' })).json()
    const v = await viewer(owner.header(), canvas.id)
    const patchFrame = async (body: Record<string, unknown>) =>
      (await owner.req(`/api/frames/${frame.id}`, { method: 'PATCH', body: JSON.stringify(body) })).json()

    /* a drag's drop sends every rect field, unchanged size included */
    const moved = await patchFrame({ x: 50, y: 60, width: frame.width, height: frame.height })
    await settle()
    const patched = v.msgs.filter((m) => m.type === 'frame:patched')
    expect(patched).toHaveLength(1)
    expect(patched[0]!.patch).toEqual({ x: 50, y: 60, width: frame.width, height: frame.height })
    expect(JSON.stringify(patched[0])).not.toContain('<p>hi</p>')
    expect(moved.updatedAt).toBe(frame.updatedAt)

    const resized = await patchFrame({ width: frame.width + 10 })
    expect(resized.updatedAt).toBeGreaterThan(frame.updatedAt)

    await patchFrame({ html: '<p>changed</p>' })
    await settle()
    const updated = v.msgs.filter((m) => m.type === 'frame:updated')
    expect(updated.at(-1)!.frame!.html).toBe('<p>changed</p>')
    v.ws.close()
  } finally {
    server.stop()
  }
}, 90_000)
