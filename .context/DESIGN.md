# DESIGN - draft

Design tokens live in `src/styles.css` as CSS custom properties, mapped into Tailwind 4 via
`@theme`. shadcn is configured with style `radix-nova`, base color `neutral`, CSS variables on,
icon library `lucide` (`components.json`). Generate new shadcn components with the shadcn CLI
rather than hand-rolling primitives; it writes into `src/components/ui` per the aliases below.

## Palette

- `--paper` `#fdfdfc` / `--paper-deep` `#f1efea` - page background layers.
- `--surface` `#ffffff` - card/panel surfaces.
- `--ink` `#111110`, `--ink-soft`, `--ink-faint` - text, in descending emphasis.
- `--line`, `--line-soft` - borders/dividers.
- `--brand` `#2743ee` - cursor blue, the one accent (selection, presence, the live-agent signal).
  `--accent-ink` `#d0341f` only means "something failed".
- `--on-ink` (text on ink surfaces) and `--ok` (success text) - see Dark mode.
- Full shadcn semantic set also present: `--primary`, `--secondary`, `--muted`, `--accent`,
  `--destructive`, `--border`, `--input`, `--ring`, `--card`, `--popover`, `--sidebar-*`,
  `--chart-1` through `--chart-5`.

## Dark mode

- `.dark` on `<html>` swaps the base tokens above (paper, surface, ink, line, brand, dot, shadows);
  the shadcn tokens derive from them, so components need no `dark:` variants. The choice (Auto /
  Light / Dark, in the account menu) is per browser: `src/lib/colorScheme.ts`, applied before
  first paint by the inline script in `index.html`.
- Text on an ink surface uses `text-on-ink`, never `text-white` (ink turns light in dark mode).
  Success text uses `text-ok`. `bg-white` is only for frame content: frames are people's designs
  and keep their own colours in both modes.

## Typography

- `--font-ui` and `--font-display`: `'Instrument Sans', sans-serif` - the chrome is one quiet sans
  (`--font-sans` / `--font-heading` aliases).
- `--font-serif`: `'Instrument Serif'` - opt-in per element for page-level headlines only.
- `--font-mono`: `'IBM Plex Mono', ui-monospace, monospace`.

## Shape and depth

- `--radius`: `0.5rem`, with `--radius-sm` through `--radius-4xl` derived from it
  (`calc(var(--radius) * N)`) - use the scale, not one-off radius values.
- `--shadow-card` / `--shadow-pop` - two-layer soft shadows (ambient + key) for cards and popped
  elements respectively.

## Aliases (`components.json`)

- `@/components` -> `src/components`, `@/components/ui` -> `src/components/ui`,
  `@/lib` -> `src/lib`, `@/hooks` -> `src/hooks`, `@/lib/utils` -> `src/lib/utils`.

## Breakpoints

- `--breakpoint-xs`: `30rem`, `--breakpoint-md`: `56.25rem` - custom additions on top of
  Tailwind's defaults.
