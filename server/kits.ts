import type { ThemeTokenInput } from '../shared/theme.ts'

/**
 * Starter kits: a palette and a type pairing an agent applies in one call and
 * then adjusts to its brief. Every kit uses the same token names, so the
 * recipes (get_guide "recipes") work with any of them: bg-surface, text-ink-2,
 * border-line, bg-accent text-on-accent, font-display, rounded-card, shadow-card.
 */

export interface Kit {
  mood: string
  colors: Record<'surface' | 'surface-2' | 'ink' | 'ink-2' | 'ink-3' | 'line' | 'accent' | 'on-accent', string>
  display: { family: string; spec: string; fallback: string }
  body: { family: string; spec: string; fallback: string }
  radius: string
  shadow: string
}

export const KITS = {
  editorial: {
    mood: 'Broadsheet on uncoated paper: serif headlines, one cobalt ink for links and actions',
    colors: {
      surface: '#F4F2EC',
      'surface-2': '#FFFFFF',
      ink: '#16150F',
      'ink-2': '#55524A',
      'ink-3': '#6F6B62',
      line: '#DDD8CC',
      accent: '#1F3FD1',
      'on-accent': '#FFFFFF',
    },
    display: {
      family: 'Newsreader',
      spec: 'Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400',
      fallback: 'Georgia, serif',
    },
    body: { family: 'Geist', spec: 'Geist:wght@400;500;600', fallback: 'system-ui, sans-serif' },
    radius: '10px',
    shadow: '0 1px 2px rgba(22,21,15,.06), 0 12px 32px -16px rgba(22,21,15,.22)',
  },
  'product-dark': {
    mood: 'Instrument panel at night: graphite surfaces, a single amber signal',
    colors: {
      surface: '#0E0F12',
      'surface-2': '#16181D',
      ink: '#EDEEF0',
      'ink-2': '#A4A8B0',
      'ink-3': '#80858E',
      line: '#262930',
      accent: '#F2B544',
      'on-accent': '#1A1405',
    },
    display: { family: 'Geist', spec: 'Geist:wght@400;500;600;700', fallback: 'system-ui, sans-serif' },
    body: { family: 'Geist', spec: 'Geist:wght@400;500;600;700', fallback: 'system-ui, sans-serif' },
    radius: '12px',
    shadow: '0 0 0 1px rgba(255,255,255,.06), 0 18px 40px -18px rgba(0,0,0,.7)',
  },
  mineral: {
    mood: 'Wet slate and moss: cool stone grounds, one deep green',
    colors: {
      surface: '#EEF0EE',
      'surface-2': '#F8F9F8',
      ink: '#0F1A17',
      'ink-2': '#4B5A55',
      'ink-3': '#5F6C68',
      line: '#D3DAD7',
      accent: '#0B6E4F',
      'on-accent': '#FFFFFF',
    },
    display: { family: 'Instrument Serif', spec: 'Instrument Serif:ital@0;1', fallback: 'Georgia, serif' },
    body: { family: 'Instrument Sans', spec: 'Instrument Sans:wght@400;500;600', fallback: 'system-ui, sans-serif' },
    radius: '14px',
    shadow: '0 1px 2px rgba(15,26,23,.05), 0 16px 36px -18px rgba(15,26,23,.25)',
  },
  signage: {
    mood: 'Wayfinding signage: white field, heavy grotesk, signal orange',
    colors: {
      surface: '#FFFFFF',
      'surface-2': '#F3F3F1',
      ink: '#0A0A0A',
      'ink-2': '#4A4A4A',
      'ink-3': '#6E6E6E',
      line: '#E2E2E0',
      accent: '#FF4A1C',
      'on-accent': '#0A0A0A',
    },
    display: { family: 'Archivo', spec: 'Archivo:wght@400;500;800', fallback: 'system-ui, sans-serif' },
    body: { family: 'Archivo', spec: 'Archivo:wght@400;500;800', fallback: 'system-ui, sans-serif' },
    radius: '4px',
    shadow: '0 2px 0 #0A0A0A',
  },
  candlelit: {
    mood: 'A reading room by candlelight: dark walnut, parchment text, flame accent',
    colors: {
      surface: '#17120D',
      'surface-2': '#211A13',
      ink: '#F3E9DB',
      'ink-2': '#BFAF98',
      'ink-3': '#9A8A75',
      line: '#3A2F24',
      accent: '#E9B36A',
      'on-accent': '#1E140A',
    },
    display: {
      family: 'Cormorant Garamond',
      spec: 'Cormorant Garamond:ital,wght@0,500;0,600;1,500',
      fallback: 'Georgia, serif',
    },
    body: { family: 'DM Sans', spec: 'DM Sans:wght@400;500;600', fallback: 'system-ui, sans-serif' },
    radius: '8px',
    shadow: '0 1px 0 rgba(233,179,106,.08), 0 20px 44px -20px rgba(0,0,0,.8)',
  },
} as const satisfies Record<string, Kit>

export type KitName = keyof typeof KITS
export const KIT_NAMES = Object.keys(KITS) as [KitName, ...KitName[]]

/** The base every kit shares: reset, page ground and the two type roles. */
const KIT_CSS = `* { margin: 0; padding: 0; box-sizing: border-box; }
html { -webkit-font-smoothing: antialiased; }
body { background: var(--surface); color: var(--ink); font-family: var(--font-body); }
h1, h2, h3, h4 { font-family: var(--font-display); }`

/** A kit as a theme write: the whole token set, its fonts, the base CSS, utilities on. */
export function kitTheme(name: KitName) {
  const kit: Kit = KITS[name]
  const tokens: ThemeTokenInput[] = [
    ...Object.entries(kit.colors).map(([n, value]) => ({ name: `--${n}`, value, type: 'color' as const })),
    { name: '--font-display', value: `'${kit.display.family}', ${kit.display.fallback}`, type: 'font' },
    { name: '--font-body', value: `'${kit.body.family}', ${kit.body.fallback}`, type: 'font' },
    { name: '--radius-card', value: kit.radius, type: 'size' },
    { name: '--shadow-card', value: kit.shadow, type: 'shadow' },
  ]
  return {
    tokens: { list: tokens, mode: 'replace' as const },
    fonts: [...new Set([kit.display.spec, kit.body.spec])],
    css: KIT_CSS,
    utilities: 'tailwind' as const,
  }
}
