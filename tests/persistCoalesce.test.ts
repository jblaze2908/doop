import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types.ts'

/* a fake drizzle: every insert chain resolves, and is counted */
const writes: string[] = []
vi.mock('../server/db/index.ts', () => {
  const chain = (id: string) => ({
    values: () => ({ onConflictDoUpdate: () => (writes.push(id), Promise.resolve()) }),
  })
  return { db: { insert: () => chain('canvas') } }
})

const persist = await import('../server/db/persist.ts')
const canvas = { id: 'c', name: 'c', createdAt: 0, updatedAt: 0, frames: [] } as unknown as Canvas

afterEach(() => {
  vi.useRealTimers()
  writes.length = 0
})

describe('canvas writes on the frame-edit hot path', () => {
  it('coalesce a burst of chunks into one upsert', async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 40; i++) persist.saveCanvasSoon({ ...canvas, updatedAt: i })
    expect(writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(writes).toHaveLength(1)
  })

  it('are written by the shutdown flush when still pending', async () => {
    vi.useFakeTimers()
    persist.saveCanvasSoon(canvas)
    await persist.flush(() => undefined)
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(writes).toHaveLength(1)
  })
})
