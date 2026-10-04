import { describe, expect, it } from 'vitest'
import { auditReport, auditRules, auditSummary, designSystemInput, flattenFindings } from '../server/designAudit.ts'
import { auditFrame, findBrowserPath, getBrowser } from '../server/screenshot.ts'
import { auditPage } from '../server/designAudit.ts'
import type { CanvasTheme } from '../shared/theme.ts'
import type { Frame, FrameAudit } from '../shared/types.ts'

const frame = (html: string): Frame => ({
  id: 'f-audit',
  canvasId: 'c-none',
  name: 'Hero',
  html,
  x: 0,
  y: 0,
  width: 1280,
  height: 900,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'test',
})

const SLOP = `<!doctype html><html><head><style>
  body { margin: 0; font-family: sans-serif }
  .hero { padding: 80px; background: linear-gradient(135deg, #7c3aed, #ec4899) }
  h1 { font-size: 64px; background: linear-gradient(90deg, #a855f7, #06b6d4); -webkit-background-clip: text; color: transparent }
  p { color: #999; background: #7c3aed }
</style></head><body><section class="hero"><h1>Unlock the future</h1><p>Supercharge your workflow</p></section></body></html>`

describe('design check helpers', () => {
  it('ships the full rule catalog', () => {
    expect(auditRules().size).toBe(61)
    expect(auditRules().get('gradient-text')?.category).toBe('slop')
  })

  it('flattens detector groups and caps the list', () => {
    const group = { selector: 'h1', findings: [{ type: 'gradient-text', category: 'slop', severity: 'warning' }] }
    expect(flattenFindings([group, { findings: [{ detail: 'no type' }] }]).findings).toEqual([
      { rule: 'gradient-text', category: 'slop', severity: 'warning', selector: 'h1', detail: '' },
    ])
    const many = flattenFindings(Array.from({ length: 130 }, () => group))
    expect(many.findings).toHaveLength(100)
    expect(many.truncated).toBe(30)
  })

  it('maps theme tokens to the design-system config, or none without tokens', () => {
    const theme = {
      tokens: [
        { name: '--ink', type: 'color', value: '#111' },
        { name: '--radius-md', type: 'size', value: '8px' },
        { name: '--gap', type: 'size', value: '16px' },
        { name: '--display', type: 'font', value: "'Geist', sans-serif" },
      ],
      fonts: ['Inter:wght@400;600'],
    } as CanvasTheme
    expect(designSystemInput(theme)).toEqual({ colors: ['#111'], radii: ['8px'], fonts: ['Inter', 'Geist'] })
    expect(designSystemInput({ tokens: [], fonts: [] } as unknown as CanvasTheme)).toBeNull()
    expect(designSystemInput(undefined)).toBeNull()
  })

  it('summarises by rule for agents', () => {
    const audit: FrameAudit = {
      frameId: 'f',
      frameUpdatedAt: 1,
      at: 1,
      findings: [
        { rule: 'tiny-text', category: 'quality', severity: 'warning', selector: 'p', detail: '10px' },
        { rule: 'tiny-text', category: 'quality', severity: 'warning', selector: 'small', detail: '9px' },
      ],
    }
    expect(auditSummary(audit)).toContain('- tiny-text ×2 @ p, small: 10px')
    expect(auditSummary({ ...audit, findings: [] })).toContain('no anti-patterns found')
    expect(auditReport(audit).rules[0]).toMatchObject({ rule: 'tiny-text', name: 'Tiny body text' })
  })
})

describe.skipIf(!findBrowserPath())('design check in a rendered frame', () => {
  it('finds AI tells and quality issues', async () => {
    const audit = await auditFrame(frame(SLOP))
    const rules = new Set(audit.findings.map((f) => f.rule))
    for (const rule of ['gradient-text', 'ai-color-palette', 'low-contrast']) expect(rules.has(rule)).toBe(true)
    expect(audit.frameUpdatedAt).toBe(1)
  }, 60_000)

  it('flags colours outside the theme tokens', async () => {
    const browser = await getBrowser()
    const page = await browser.newPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><style>:root { --ink: #111110 } body { margin: 0; font-family: sans-serif }</style></head>
         <body><main style="padding:48px"><p style="color: var(--ink)">On theme</p><p style="color: #0f766e">Off theme</p></main></body></html>`,
      )
      const theme = {
        tokens: [{ name: '--ink', type: 'color', value: 'var(--ink)' }],
        fonts: [],
      } as unknown as CanvasTheme
      const audit = await auditPage(page, frame(''), theme)
      const off = audit.findings.filter((f) => f.rule === 'design-system-color')
      expect(off.map((f) => f.detail).join(' ')).toMatch(/0f766e|15, 118, 110/i)
      expect(off.some((f) => /111110|17, 17, 16/.test(f.detail))).toBe(false)
    } finally {
      await page.close()
    }
  }, 60_000)
})
