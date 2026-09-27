import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { Client, startServer } from './harness.ts'

const PORT = 4983

function viewer(cookie: string, canvasId: string, id: string): Promise<{ types: string[]; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie } })
    const types: string[] = []
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { type: string }
      types.push(m.type)
      if (m.type === 'init') resolve({ types, ws })
    })
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', canvasId, clientId: id, name: id, kind: 'user' })))
  })
}

it('negotiates compression and caps a cursor flood before it fans out', async () => {
  const server = await startServer(PORT)
  try {
    const owner = new Client(server)
    await owner.signUp('limits@test.dev', 'Limits')
    const canvas = await (await owner.post('/api/canvases', { name: 'Limits' })).json()
    const a = await viewer(owner.header(), canvas.id, 'a')
    const b = await viewer(owner.header(), canvas.id, 'b')
    expect(a.ws.extensions).toContain('permessage-deflate')

    for (let i = 0; i < 300; i++) a.ws.send(JSON.stringify({ type: 'cursor', x: i, y: i }))
    await new Promise((r) => setTimeout(r, 400))
    const cursors = b.types.filter((t) => t === 'cursor').length
    /* LOSSY_PER_SECOND in server/index.ts */
    expect(cursors).toBeGreaterThan(0)
    expect(cursors).toBeLessThanOrEqual(90)
    a.ws.close()
    b.ws.close()
  } finally {
    server.stop()
  }
}, 90_000)
