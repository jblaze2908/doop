import { describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({}))

const { FramePageTimeout, findBrowserPath, renderFrame } = await import('../server/screenshot.ts')

const frame = (html: string): Frame => ({
  id: 'deadline-frame',
  canvasId: 'deadline-canvas',
  name: 'F',
  x: 0,
  y: 0,
  width: 320,
  height: 200,
  html,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 't',
})

describe.skipIf(!findBrowserPath())('frame page deadline', () => {
  it('stops a render whose page never yields, and the next render still works', { timeout: 30_000 }, async () => {
    const started = Date.now()
    await expect(
      renderFrame(frame('<!doctype html><html><body><script>while (true) {}</script></body></html>'), 1, {
        deadlineMs: 3000,
      }),
    ).rejects.toBeInstanceOf(FramePageTimeout)
    expect(Date.now() - started).toBeLessThan(6000)

    const png = await renderFrame(frame('<!doctype html><html><body><p>fine</p></body></html>'))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  })
})
