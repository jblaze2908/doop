import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor, Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/identity', () => ({ getIdentity: () => ({ clientId: 'me', name: 'Me' }) }))
const { useStore } = await import('../src/lib/store')
const { handle } = await import('../src/lib/ws')

const actor: Actor = { name: 'Agent', kind: 'agent', color: '#000', clientId: 'agent:Agent' }
const frame = (html: string): Frame =>
  ({
    id: 'f',
    canvasId: 'c',
    name: 'f',
    html,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    updatedAt: 0,
    updatedBy: 'a',
  }) as Frame
const html = () => useStore.getState().canvas!.frames[0]!.html
const append = (at: number, chunk: string) =>
  handle({ type: 'frame:append', frameId: 'f', at, chunk, updatedAt: at + 1, updatedBy: 'Agent', actor })

beforeEach(() => {
  useStore.getState().setCanvas({ id: 'c', name: 'c', frames: [frame('')] } as unknown as Canvas)
  handle({ type: 'frame:updated', frame: frame(''), actor }) // clears any raw buffer
})

describe('streamed frame deltas', () => {
  it('accumulates raw chunks and renders the healed prefix', () => {
    append(0, '<style>p{color:red}')
    expect(html()).toBe('<style>p{color:red}</style>')
    append(19, '</style><p>Hi</p><di')
    expect(html()).toBe('<style>p{color:red}</style><p>Hi</p>')
    expect(useStore.getState().canvas!.frames[0]!.updatedAt).toBe(20)
  })

  it('ignores a delta that does not line up, and resyncs on the whole frame', () => {
    append(0, '<p>a</p>')
    append(99, '<p>lost</p>')
    expect(html()).toBe('<p>a</p>')
    handle({ type: 'frame:updated', frame: frame('<p>a</p><p>b</p>'), actor })
    expect(html()).toBe('<p>a</p><p>b</p>')
    append(0, '<p>new</p>')
    expect(html()).toBe('<p>new</p>')
  })

  it('continues from the raw snapshot a mid-stream join received', () => {
    useStore.getState().setCanvas({ id: 'c', name: 'c', frames: [frame('<p>so far')] } as unknown as Canvas)
    handle({
      type: 'init',
      canvas: useStore.getState().canvas!,
      presences: [],
      activity: [],
      tasks: [],
      feedback: [],
      comments: [],
      decisions: [],
      selfColor: '#000',
      serverBuild: 'dev',
    })
    append(9, '</p>')
    expect(html()).toBe('<p>so far</p>')
  })
})
