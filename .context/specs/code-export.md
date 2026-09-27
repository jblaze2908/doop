# Code export

Status: shipped on the `tijori/design-system` fork, 2026-09-27. Code: `server/exportCode.ts`,
`server/jsx.ts`, the `export_frame_code` MCP tool, `GET /api/frames/:id/export?target=react|html`.

## Shape

- `react`: `<Page>.tsx` (default export) + `<Page>.css` (the frame's `<style>`s, `<link>`
  stylesheets as `@import`), `styles/tokens.css` (tokens + resolved `@font-face`),
  `styles/theme.css`, and `components/<Name>.tsx|.css` for every linked component the page uses,
  transitively.
- Components become functions rendering a `div.<tag>` wrapper: attributes are string props,
  `{{prop}}` becomes an expression (defaults applied), `<slot>` becomes `children`, a named
  slot a `ReactNode` prop, slot fallback content `?? <>…</>`. Shadow CSS is scoped to the
  wrapper class (`:host` → `.tag`, `:host([a])` → `.tag[data-a]`, `::slotted(x)` → descendant),
  and the wrapper restates the custom element's default `display:inline`. Page CSS type
  selectors that name a component become its class.
- HTML → JSX: attribute renames (including SVG case the parser folds), inline style objects
  (custom properties cast to `CSSProperties`), HTML whitespace collapsing preserved with string
  expressions, `value`/`checked` → `defaultValue`/`defaultChecked`, textarea content →
  `defaultValue`. Inline event handlers and `<script>` are dropped with a warning; unknown
  custom elements become `div`s with a warning. Implied html/head/body are transparent.
- `html`: `prepareFrameHtml` output — theme and component runtime inlined.

## Measured (2026-09-27)

The native landing frame (6 components, 16 instances) exported to 16 files that pass Tijori
web's `tsc --noEmit` (TypeScript 7, strict, `noUnusedLocals`, `verbatimModuleSyntax`) and
`vite build`, and render 100.000% pixel-identical to draft's render at 1440×2629.
