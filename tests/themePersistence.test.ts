import sharp from 'sharp'
import { expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

const PORT = 4965

/** The RGB of the render's center pixel. */
async function centerPixel(res: Response): Promise<[number, number, number]> {
  expect(res.status).toBe(200)
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3
  return [data[at]!, data[at + 1]!, data[at + 2]!]
}

it.skipIf(!findBrowserPath())(
  'renders frames with the canvas theme, re-renders on a token change, and keeps the theme across a restart',
  async () => {
    let server: Server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
    try {
      const owner = new Client(server)
      await owner.signUp('theme@test.dev', 'Theme Owner')
      const canvas = await (await owner.post('/api/canvases', { name: 'Themed' })).json()
      const put = (body: unknown) =>
        owner.req(`/api/canvases/${canvas.id}/theme`, { method: 'PUT', body: JSON.stringify(body) })

      const first = await put({
        tokens: [{ name: '--color-x', value: '#ff0000' }],
        css: '.fill{background:var(--color-x)}',
      })
      expect(first.status, await first.clone().text()).toBe(200)
      expect((await put({ tokens: [{ name: '--Nope', value: '1' }] })).status).toBe(400)

      const frame = await (
        await owner.post(`/api/canvases/${canvas.id}/frames`, {
          name: 'Swatch',
          width: 40,
          height: 40,
          html: '<!doctype html><html><head></head><body style="margin:0"><div class="fill" style="height:40px"></div></body></html>',
        })
      ).json()
      expect(await centerPixel(await fetch(`${server.base}/i/${frame.id}.png`))).toEqual([255, 0, 0])

      /* same frame, new theme version: the image cache must not serve the old render */
      await put({ tokens: [{ name: '--color-x', value: '#0000ff' }] })
      expect(await centerPixel(await fetch(`${server.base}/i/${frame.id}.png`))).toEqual([0, 0, 255])

      const copy = await (await owner.post(`/api/canvases/${canvas.id}/duplicate`)).json()

      const dataDir = server.dataDir
      server.stop({ keepData: true })
      await server.stopped
      server = await startServer(PORT + 1, { BETTER_AUTH_URL: `http://localhost:${PORT + 1}` }, dataDir)

      const back = new Client(server)
      await back.post('/api/auth/sign-in/email', { email: 'theme@test.dev', password: 'password12345' })
      const theme = await (await back.get(`/api/canvases/${canvas.id}/theme`)).json()
      expect(theme).toMatchObject({
        version: 2,
        tokens: [{ name: '--color-x', type: 'color', value: '#0000ff' }],
        css: '.fill{background:var(--color-x)}',
        updatedBy: 'Theme Owner',
      })
      const copied = await (await back.get(`/api/canvases/${copy.id}`)).json()
      expect(copied.theme).toMatchObject({ version: 2, tokens: [{ name: '--color-x', value: '#0000ff' }] })
    } finally {
      server.stop()
    }
  },
  120_000,
)
