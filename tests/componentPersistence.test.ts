import sharp from 'sharp'
import { expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'

const PORT = 4967

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
  'renders component instances server-side, re-renders on a definition change, and keeps components across a restart',
  async () => {
    let server: Server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
    try {
      const owner = new Client(server)
      await owner.signUp('components@test.dev', 'Component Owner')
      const canvas = await (await owner.post('/api/canvases', { name: 'Linked' })).json()
      const put = (css: string) =>
        owner.req(`/api/canvases/${canvas.id}/components/ds-swatch`, {
          method: 'PUT',
          body: JSON.stringify({ html: '<slot></slot>', css }),
        })
      const first = await put(':host{display:block;height:40px;background:#ff0000}')
      expect(first.status, await first.clone().text()).toBe(200)
      expect(
        (await owner.req(`/api/canvases/${canvas.id}/components/nohyphen`, { method: 'PUT', body: '{"html":"x"}' }))
          .status,
      ).toBe(400)

      const frame = await (
        await owner.post(`/api/canvases/${canvas.id}/frames`, {
          name: 'Swatch',
          width: 40,
          height: 40,
          html: '<!doctype html><html><head></head><body style="margin:0"><ds-swatch></ds-swatch></body></html>',
        })
      ).json()
      expect(await centerPixel(await fetch(`${server.base}/i/${frame.id}.png`))).toEqual([255, 0, 0])

      /* the frame never changed: only the definition did */
      await put(':host{display:block;height:40px;background:#0000ff}')
      expect(await centerPixel(await fetch(`${server.base}/i/${frame.id}.png`))).toEqual([0, 0, 255])

      const copy = await (await owner.post(`/api/canvases/${canvas.id}/duplicate`)).json()
      expect((await owner.delete(`/api/canvases/${copy.id}/components/ds-swatch`)).status).toBe(200)

      const dataDir = server.dataDir
      server.stop({ keepData: true })
      await server.stopped
      server = await startServer(PORT + 1, { BETTER_AUTH_URL: `http://localhost:${PORT + 1}` }, dataDir)

      const back = new Client(server)
      await back.post('/api/auth/sign-in/email', { email: 'components@test.dev', password: 'password12345' })
      const restored = await (await back.get(`/api/canvases/${canvas.id}`)).json()
      expect(restored.components).toMatchObject([
        { name: 'ds-swatch', version: 2, css: ':host{display:block;height:40px;background:#0000ff}' },
      ])
      expect(restored.components[0].deletedAt).toBeUndefined()
      const copied = await (await back.get(`/api/canvases/${copy.id}`)).json()
      expect(copied.components).toMatchObject([{ name: 'ds-swatch', version: 3 }])
      expect(copied.components[0].deletedAt).toBeGreaterThan(0)
    } finally {
      server.stop()
    }
  },
  120_000,
)
