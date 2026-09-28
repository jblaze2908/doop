import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../shared/types.ts'
import type { CanvasTheme } from '../shared/theme.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveCanvas: () => {},
  saveCanvasSoon: () => {},
  saveCanvasTheme: () => {},
  saveFrame: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { canvasTouched, utilitiesFor, wireUtilities } = await import('../server/utilities.ts')
const { findBrowserPath, measureFrameHeight } = await import('../server/screenshot.ts')

const OWNER_ID = 'owner-utilities'
let canvasId: string
let version = 0

function theme(patch: Partial<CanvasTheme> = {}): CanvasTheme {
  return {
    tokens: [
      { name: '--vellum', value: '#f2f1ec', type: 'color' },
      { name: '--font-display', value: "'Instrument Serif', serif", type: 'font' },
      { name: '--radius-card', value: '14px', type: 'size' },
    ],
    css: '* { margin: 0; padding: 0; }',
    fonts: [],
    fontFaces: '',
    utilities: 'tailwind',
    version: ++version,
    updatedAt: Date.now(),
    updatedBy: 'test',
    ...patch,
  }
}

const frame = (html: string) =>
  store.createFrame(canvasId, { name: 'F', x: 0, y: 0, width: 800, height: 600, html }, 'Jai')!

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('utilities', OWNER_ID).id
})

describe('canvas Tailwind utilities', () => {
  it('generates nothing for a canvas that has not opted in', async () => {
    frame('<div class="flex p-4"></div>')
    expect(await utilitiesFor(canvasId)).toBe('')
  })

  it('maps tokens to classes without circular variables, utilities unlayered', async () => {
    store.setTheme(canvasId, theme())
    frame('<div class="flex p-4 bg-vellum font-display rounded-card"></div>')
    const css = await utilitiesFor(canvasId)
    expect(css).toContain('display: flex')
    expect(css).toMatch(/\.bg-vellum\s*\{\s*background-color: var\(--vellum\)/)
    expect(css).toMatch(/\.font-display\s*\{\s*font-family: var\(--font-display\)/)
    expect(css).toMatch(/\.rounded-card\s*\{\s*border-radius: var\(--radius-card\)/)
    expect(css).not.toContain('--font-display: var(--font-display)')
    expect(css).toContain('@layer theme, base;')
    expect(css).not.toContain('@layer utilities')
  })

  it('grows as frames add classes and starts over when the theme changes', async () => {
    store.setTheme(canvasId, theme())
    const f = frame('<div class="p-4"></div>')
    expect(await utilitiesFor(canvasId)).not.toContain('gap-7')
    frame('<div class="gap-7"></div>')
    const grown = await utilitiesFor(canvasId)
    expect(grown).toContain('.gap-7')
    expect(grown).toContain('.p-4')
    store.updateFrame(f.id, { html: '<div class="m-3"></div>' }, 'Jai')
    store.setTheme(canvasId, theme())
    const fresh = await utilitiesFor(canvasId)
    expect(fresh).toContain('.m-3')
    expect(fresh).not.toContain('.p-4')
  })

  it('pushes a changed sheet to viewers', async () => {
    const sent: ServerMessage[] = []
    wireUtilities((_id, msg) => sent.push(msg))
    store.setTheme(canvasId, theme())
    frame('<div class="grid-cols-5"></div>')
    canvasTouched(canvasId)
    await new Promise((r) => setTimeout(r, 150))
    expect(sent.some((m) => m.type === 'utilities' && m.css.includes('grid-cols-5'))).toBe(true)
  })

  it('turns utilities on for canvases agents create', async () => {
    const server = buildMcpServer('Test Owner', OWNER_ID)
    const client = new Client({ name: 'draft-utilities-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const r = (await client.callTool({
        name: 'create_canvas',
        arguments: { name: 'New', agent_name: 'Claude' },
      })) as {
        content: { text: string }[]
      }
      const id = (JSON.parse(r.content[0]!.text) as { id: string }).id
      expect(store.getCanvas(id)?.theme?.utilities).toBe('tailwind')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it.skipIf(!findBrowserPath())(
    'applies in real renders, even over an unlayered * { padding: 0 } reset',
    async () => {
      store.setTheme(canvasId, theme())
      const f = frame(
        '<!doctype html><html><body><div class="pb-[50px]"><div class="h-[321px]"></div></div></body></html>',
      )
      expect(await measureFrameHeight(f)).toBeGreaterThanOrEqual(371)
    },
    60_000,
  )

  it.skipIf(!findBrowserPath())(
    "beats the frame's own reset for :where() utilities, and brings preflight",
    async () => {
      store.setTheme(canvasId, theme({ css: '' }))
      const spaced = frame(
        '<!doctype html><html><head><style>*{margin:0}</style></head><body><div class="space-y-[40px]"><div class="h-[10px]"></div><div class="h-[10px]"></div></div></body></html>',
      )
      expect(await measureFrameHeight(spaced)).toBeGreaterThanOrEqual(60)
      /* no reset of its own: preflight zeroes the body and h1 margins */
      const bare = frame('<!doctype html><html><body><h1 class="text-[20px] leading-[20px]">x</h1></body></html>')
      expect(await measureFrameHeight(bare)).toBeLessThan(30)
    },
    60_000,
  )
})
