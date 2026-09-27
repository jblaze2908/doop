import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const api = {
  updateFrame: vi.fn(async (_id: string, _patch: object) => ({})),
  deleteFrame: vi.fn(async () => ({})),
  createFrame: vi.fn(async () => ({})),
}
vi.mock('../src/lib/api', () => ({ api }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const history = await import('../src/lib/history')

const frame = (html: string): Frame =>
  ({ id: 'f', canvasId: 'c1', name: 'f', html, x: 0, y: 0, width: 100, height: 100 }) as Frame

beforeEach(() => {
  useStore.getState().setCanvas({ id: 'c1', name: 'c', frames: [frame('<p>a</p>')] } as unknown as Canvas)
  history.clearHistory()
  vi.clearAllMocks()
})

/* a local html edit, as the element panel and layer edits record it */
function localEdit(before: string, after: string) {
  history.recordUpdate('f', { html: before }, { html: after })
  useStore.getState().patchFrameLocal('f', { html: after })
}

describe('html undo with collaborators', () => {
  it('undoes a local edit when nobody touched the frame since', async () => {
    localEdit('<p>a</p>', '<p>b</p>')
    await history.undo()
    expect(api.updateFrame).toHaveBeenCalledWith('f', { html: '<p>a</p>' })
    expect(useStore.getState().canvas!.frames[0]!.html).toBe('<p>a</p>')
  })

  it('refuses to undo over a remote change, and says why', async () => {
    const told: string[] = []
    const off = history.onHistoryConflict((m) => told.push(m))
    localEdit('<p>a</p>', '<p>b</p>')
    /* an agent rewrote the frame after our edit */
    useStore.getState().upsertFrame(frame('<p>agent</p>'))
    await history.undo()
    off()
    expect(api.updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe('<p>agent</p>')
    expect(told).toEqual(['Can’t undo — someone else changed this frame since'])
  })

  it('still undoes geometry over a remote html change', async () => {
    history.recordUpdate('f', { x: 0 }, { x: 40 })
    useStore.getState().patchFrameLocal('f', { x: 40 })
    useStore.getState().upsertFrame({ ...frame('<p>agent</p>'), x: 40 })
    await history.undo()
    expect(api.updateFrame).toHaveBeenCalledWith('f', { x: 0 })
  })
})
