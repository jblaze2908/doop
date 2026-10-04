import fs from 'node:fs'
import type { Page } from 'puppeteer-core'
import { fontFamilyOf, type CanvasTheme } from '../shared/theme.ts'
import type { DesignFinding, Frame, FrameAudit, ServerMessage } from '../shared/types.ts'

/**
 * Design check: Impeccable's anti-pattern detector (server/vendor/impeccable,
 * 61 rules in a WASM core) run inside an already-loaded frame page, so it reads
 * computed styles — Tailwind classes and theme tokens resolved.
 */

const VENDOR = new URL('./vendor/impeccable/', import.meta.url)

/* 2.1 MB; read on the first check, not at boot */
let detectorJs: string | undefined
const detectorSource = () => (detectorJs ??= fs.readFileSync(new URL('detect-antipatterns-browser.js', VENDOR), 'utf8'))

export interface AuditRule {
  id: string
  name: string
  category: 'slop' | 'quality'
  description: string
}

let catalog: Map<string, AuditRule> | undefined
export function auditRules(): Map<string, AuditRule> {
  if (!catalog) {
    const rules = JSON.parse(fs.readFileSync(new URL('antipatterns.json', VENDOR), 'utf8')) as AuditRule[]
    catalog = new Map(rules.map((r) => [r.id, r]))
  }
  return catalog
}

/** Tokens the detector's design-system rules allow; raw CSS values, resolved in the page. */
export interface DesignSystemInput {
  colors: string[]
  radii: string[]
  fonts: string[]
}

const RADIUS_TOKEN = /radius|rounded/

export function designSystemInput(theme: CanvasTheme | undefined): DesignSystemInput | null {
  if (!theme) return null
  const colors = theme.tokens.filter((t) => t.type === 'color').map((t) => t.value)
  const radii = theme.tokens.filter((t) => t.type === 'size' && RADIUS_TOKEN.test(t.name)).map((t) => t.value)
  const fonts = [
    ...theme.fonts.map(fontFamilyOf),
    ...theme.tokens.filter((t) => t.type === 'font').map((t) => t.value.split(',')[0]!.trim()),
  ]
    .map((f) => f.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  return colors.length || radii.length || fonts.length ? { colors, radii, fonts } : null
}

/* Runs in the page: resolve token values through the cascade (var() refs, any colour syntax),
   then hand the detector its config before the bundle loads. autoScan off: no overlay paint. */
function configureDetector(input: DesignSystemInput | null) {
  if (!input) {
    ;(window as unknown as { __IMPECCABLE_CONFIG__: unknown }).__IMPECCABLE_CONFIG__ = { autoScan: false }
    return
  }
  const probe = document.createElement('div')
  document.body.append(probe)
  const rgb = (value: string) => {
    probe.style.color = ''
    probe.style.color = value
    if (!probe.style.color) return null
    const [r, g, b] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(Number)
    return r === undefined || g === undefined || b === undefined ? null : { r, g, b }
  }
  const px = (value: string) => {
    probe.style.borderTopLeftRadius = ''
    probe.style.borderTopLeftRadius = value
    const v = getComputedStyle(probe).borderTopLeftRadius
    return v.endsWith('px') ? parseFloat(v) : NaN
  }
  const allowedColors = input.colors.map(rgb).filter(Boolean)
  const allowedRadii = input.radii.map(px).filter((n) => Number.isFinite(n))
  probe.remove()
  ;(window as unknown as { __IMPECCABLE_CONFIG__: unknown }).__IMPECCABLE_CONFIG__ = {
    autoScan: false,
    designSystem: {
      present: true,
      hasColors: allowedColors.length > 0,
      allowedColors,
      hasRadii: allowedRadii.length > 0,
      allowedRadii,
      hasPillRadius: allowedRadii.some((r) => r >= 999),
      hasFonts: input.fonts.length > 0,
      allowedFonts: input.fonts,
    },
  }
}

/* Runs in the page. A blob src, not inline: the bundle resolves its own script URL
   against location, and a setContent page is about:blank. */
function loadDetector(source: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('design check failed to load'))
    document.head.append(script)
  })
}

interface RawGroup {
  selector?: string
  findings?: Array<{ type?: string; category?: string; severity?: string; advisory?: boolean; detail?: string }>
}

/* each finding is ~100 bytes on the wire and in every viewer's store */
const MAX_FINDINGS = 100

export function flattenFindings(groups: RawGroup[]): { findings: DesignFinding[]; truncated?: number } {
  const all: DesignFinding[] = []
  for (const g of groups)
    for (const f of g.findings ?? []) {
      if (!f.type) continue
      all.push({
        rule: f.type,
        category: f.category === 'slop' ? 'slop' : 'quality',
        severity: f.severity === 'error' ? 'error' : 'warning',
        ...(f.advisory ? { advisory: true as const } : {}),
        selector: g.selector || 'body',
        detail: f.detail ?? '',
      })
    }
  const findings = all.slice(0, MAX_FINDINGS)
  return all.length > MAX_FINDINGS ? { findings, truncated: all.length - MAX_FINDINGS } : { findings }
}

/* Its own cap inside the frame page's deadline, so a stuck check never costs the screenshot it rides on. */
const CHECK_DEADLINE_MS = 5000

/** Check a frame page that is already loaded. Adds a median ~190 ms to a 1280×900 review
 *  screenshot (measured, n=8); callers run it on a page they opened anyway. */
export async function auditPage(
  page: Page,
  frame: Pick<Frame, 'id' | 'updatedAt'>,
  theme: CanvasTheme | undefined,
): Promise<FrameAudit> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('design check timed out')), CHECK_DEADLINE_MS)
  })
  try {
    const groups = await Promise.race([detect(page, theme), deadline])
    return { frameId: frame.id, frameUpdatedAt: frame.updatedAt, at: Date.now(), ...flattenFindings(groups) }
  } finally {
    clearTimeout(timer)
  }
}

async function detect(page: Page, theme: CanvasTheme | undefined): Promise<RawGroup[]> {
  /* same loader shim as inspectFrame in screenshot.ts: tsx wraps nested functions in __name */
  await page.evaluate('globalThis.__name = (target) => target')
  await page.evaluate(configureDetector, designSystemInput(theme))
  await page.evaluate(loadDetector, detectorSource())
  return page.evaluate(() =>
    (window as unknown as { impeccableDetectAsync: () => Promise<RawGroup[]> }).impeccableDetectAsync(),
  )
}

/* ---- latest result per frame, shared with every viewer ---- */

/* oldest evicted first; results are recomputable, so losing one only costs a re-check */
const MAX_CACHED = 2000
const latest = new Map<string, FrameAudit>()

let broadcast: (canvasId: string, msg: ServerMessage) => void = () => {}
export function wireAudits(send: typeof broadcast) {
  broadcast = send
}

export function recordAudit(canvasId: string, audit: FrameAudit) {
  latest.delete(audit.frameId)
  latest.set(audit.frameId, audit)
  if (latest.size > MAX_CACHED) latest.delete(latest.keys().next().value!)
  broadcast(canvasId, { type: 'frame:audit', audit })
}

/** The cached check of each frame whose html has not changed since. */
export function auditsFor(frames: readonly Pick<Frame, 'id' | 'updatedAt'>[]): FrameAudit[] {
  return frames.flatMap((f) => {
    const a = latest.get(f.id)
    return a && a.frameUpdatedAt === f.updatedAt ? [a] : []
  })
}

/* ---- agent-facing text ---- */

/** Findings grouped by rule, one line each — what rides along a screenshot. */
export function auditSummary(audit: FrameAudit, maxRules = 12): string {
  if (audit.findings.length === 0) return 'Design check (Impeccable): no anti-patterns found.'
  const byRule = new Map<string, DesignFinding[]>()
  for (const f of audit.findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f])
  const total = audit.findings.length + (audit.truncated ?? 0)
  const lines = [...byRule].slice(0, maxRules).map(([rule, fs]) => {
    const where = [...new Set(fs.map((f) => f.selector))].slice(0, 3).join(', ')
    const more = fs.length > 1 ? ` ×${fs.length}` : ''
    return `- ${rule}${more} @ ${where}: ${fs[0]!.detail}`
  })
  const hidden = byRule.size > maxRules ? `\n…and ${byRule.size - maxRules} more rules (audit_frame lists all).` : ''
  return (
    `Design check (Impeccable): ${total} finding${total === 1 ? '' : 's'} across ${byRule.size} rule${byRule.size === 1 ? '' : 's'}. ` +
    `Fix them, or keep one only when it is deliberate (get_guide({ topic: "design-review" }) has the fix per rule).\n` +
    lines.join('\n') +
    hidden
  )
}

/** The full report audit_frame returns: findings grouped by rule, with each rule's description. */
export function auditReport(audit: FrameAudit) {
  const rules = auditRules()
  const byRule = new Map<string, DesignFinding[]>()
  for (const f of audit.findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f])
  return {
    findings: audit.findings.length + (audit.truncated ?? 0),
    rules: [...byRule].map(([id, fs]) => ({
      rule: id,
      name: rules.get(id)?.name ?? id,
      category: fs[0]!.category,
      severity: fs[0]!.severity,
      ...(fs[0]!.advisory ? { advisory: true } : {}),
      why: rules.get(id)?.description ?? '',
      at: fs.map((f) => ({ selector: f.selector, detail: f.detail })),
    })),
    ...(audit.truncated ? { note: `${audit.truncated} more findings were left out; fix these and re-run.` } : {}),
  }
}
