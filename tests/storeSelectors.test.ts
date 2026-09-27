import { describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { frameById, frameIdsOf, sameFrameButPosition, useStore } from '../src/lib/store'

const frame = (id: string, x = 0): Frame =>
  ({ id, canvasId: 'c1', name: id, html: '<p/>', x, y: 0, width: 100, height: 80, updatedAt: 1 }) as Frame

function load(frames: Frame[]) {
  useStore.getState().setCanvas({ id: 'c1', name: 'c', frames } as unknown as Canvas)
}

describe('frame selectors', () => {
  it('looks frames up by id and follows updates', () => {
    load([frame('a'), frame('b')])
    expect(frameById(useStore.getState(), 'b')?.id).toBe('b')
    expect(frameById(useStore.getState(), 'zz')).toBeUndefined()
    expect(frameById(useStore.getState(), null)).toBeUndefined()
    useStore.getState().patchFrameLocal('b', { x: 50 })
    expect(frameById(useStore.getState(), 'b')?.x).toBe(50)
  })

  it('keeps one id list per frames array, equal in content after a move', () => {
    load([frame('a'), frame('b')])
    const ids = frameIdsOf(useStore.getState())
    expect(frameIdsOf(useStore.getState())).toBe(ids)
    useStore.getState().patchFrameLocal('a', { x: 9 })
    expect(frameIdsOf(useStore.getState())).toEqual(['a', 'b'])
  })

  it('treats a move as the same frame, and any other change as different', () => {
    const a = frame('a')
    expect(sameFrameButPosition(a, { ...a, x: 10, y: 20 })).toBe(true)
    expect(sameFrameButPosition(a, { ...a, width: 101 })).toBe(false)
    expect(sameFrameButPosition(a, { ...a, html: '<b/>' })).toBe(false)
    expect(sameFrameButPosition(a, undefined)).toBe(false)
  })
})
