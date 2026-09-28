import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

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
/* applying a kit resolves Google Fonts; keep the test offline */
vi.mock('../server/theme.ts', async (original) => ({
  ...(await original<typeof import('../server/theme.ts')>()),
  resolveFonts: async () => ({ fontFaces: '', unresolved: [] }),
}))

const { KIT_NAMES, KITS, kitTheme } = await import('../server/kits.ts')
const { GUIDE_DOCS } = await import('../server/guide.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')

/** WCAG 2 relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('starter kits', () => {
  it.each(KIT_NAMES)('%s reads: body 7:1, muted text and accent buttons 4.5:1', (name) => {
    const c = KITS[name].colors
    expect(contrast(c.ink, c.surface)).toBeGreaterThanOrEqual(7)
    expect(contrast(c['ink-3'], c.surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(c['on-accent'], c.accent)).toBeGreaterThanOrEqual(4.5)
  })

  it('recipes use only token classes every kit defines, never a fixed palette colour', () => {
    const recipes = GUIDE_DOCS.recipes
    const tokenNames = new Set(
      kitTheme('editorial').tokens.list.map((t) => t.name.slice(2).replace(/^(font|radius|shadow)-/, '')),
    )
    const used = [
      ...recipes.matchAll(
        /\b(?:bg|text|border|font|rounded|shadow)-(surface-2|surface|ink-3|ink-2|ink|line|on-accent|accent|display|body|card)\b/g,
      ),
    ].map((m) => m[1]!)
    expect(used.length).toBeGreaterThan(20)
    for (const t of used) expect(tokenNames).toContain(t)
    expect(recipes).not.toMatch(
      /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/,
    )
    for (const name of KIT_NAMES)
      expect(kitTheme(name).tokens.list.map((t) => t.name)).toEqual(
        kitTheme('editorial').tokens.list.map((t) => t.name),
      )
  })

  it('apply_kit writes the whole theme with utilities on', async () => {
    const canvasId = store.createCanvas('kit', 'owner-kit').id
    const server = buildMcpServer('Owner', 'owner-kit')
    const client = new Client({ name: 'draft-kits-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const r = (await client.callTool({
        name: 'apply_kit',
        arguments: { canvas_id: canvasId, kit: 'mineral', agent_name: 'Claude' },
      })) as { isError?: boolean }
      expect(r.isError).toBeFalsy()
      const theme = store.getCanvas(canvasId)!.theme!
      expect(theme.utilities).toBe('tailwind')
      expect(theme.tokens.find((t) => t.name === '--accent')?.value).toBe('#0B6E4F')
      expect(theme.css).toContain('var(--font-body)')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
