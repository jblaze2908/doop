import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { Client, startServer } from './harness.ts'

const PORT = 4968

type Msg = {
  type: string
  at?: number
  chunk?: string
  frame?: { html: string }
  canvas?: { frames: { id: string; html: string }[] }
}

function viewer(port: number, cookie: string, canvasId: string, id: string): Promise<{ msgs: Msg[]; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
    const msgs: Msg[] = []
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg
      msgs.push(m)
      if (m.type === 'init') resolve({ msgs, ws })
    })
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', canvasId, clientId: id, name: id, kind: 'user' })))
  })
}

const settle = () => new Promise((r) => setTimeout(r, 150))

it('streams frame deltas to viewers and ends with the whole frame', async () => {
  const server = await startServer(PORT)
  try {
    const owner = new Client(server)
    await owner.signUp('stream@test.dev', 'Streamer')
    const canvas = await (await owner.post('/api/canvases', { name: 'Stream' })).json()
    const frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'F' })).json()
    const first = await viewer(PORT, owner.header(), canvas.id, 'v1')
    const chunk = (html_chunk: string, opts: { start?: boolean; done?: boolean } = {}) =>
      owner.post(`/api/frames/${frame.id}/append`, { html_chunk, ...opts })

    await chunk('<main><h1>Tij', { start: true })
    await chunk('ori</h1>')
    await settle()
    /* a viewer joining mid-stream gets the raw html so far, which the next delta extends */
    const late = await viewer(PORT, owner.header(), canvas.id, 'v2')
    const snapshot = late.msgs[0]!.canvas!.frames.find((f) => f.id === frame.id)!.html
    expect(snapshot).toBe('<main><h1>Tijori</h1>')
    await chunk('<p>ledger</p></main>', { done: true })
    await settle()

    const stream = first.msgs.filter((m) => m.type === 'frame:append' || m.type === 'frame:updated')
    expect(stream.map((m) => [m.type, m.at, m.chunk])).toEqual([
      ['frame:append', 0, '<main><h1>Tij'],
      ['frame:append', 13, 'ori</h1>'],
      ['frame:updated', undefined, undefined],
    ])
    expect(stream[2]!.frame!.html).toBe('<main><h1>Tijori</h1><p>ledger</p></main>')
    const lateStream = late.msgs.filter((m) => m.type === 'frame:updated')
    expect(lateStream).toHaveLength(1)
    first.ws.close()
    late.ws.close()
  } finally {
    server.stop()
  }
}, 90_000)
