# Canvas theme

Status: shipped on the `tijori/design-system` fork, 2026-09-27. Code: `shared/theme.ts`,
`server/theme.ts`, `actions.setTheme`, `src/components/ThemeSection.tsx`, the `doop:theme`
handler in `src/lib/frameRuntime.ts`.

## Problem

A design system was only a guideline doc. Every frame carried its own copy of the stylesheet, a
token change meant editing every frame, and agents re-read that CSS on every `get_frame`.

## Shape

- `canvases.theme` (jsonb, migration 0018): `{ tokens[], css, fonts[], fontFaces, version }`.
  Tokens are CSS custom properties on `:root`; `css` is shared CSS (no `@import`); `fonts` are
  Google Fonts css2 specs whose `@font-face` rules are fetched once at set time into `fontFaces`.
- Compiled sheet = `:root{tokens}` + `fontFaces` + `css` (`compileTheme`, memoized per theme
  object — a theme is replaced, never mutated).
- Injection: a `<style data-doop-theme>` first in `<head>`, so the frame's own styles win the
  cascade. Browser: the runtime adds it to every parsed document before the morph and
  `serialize()` strips it. Server: `spliceTheme` in `loadFramePage`. Not an adopted sheet —
  adopted sheets cascade after the document's own styles, so the theme would beat the frame.
- Opt-out per frame: `<html data-doop-theme="off">`. Webpage imports, design-sync snapshots and
  GitHub screens get it automatically (`withoutTheme`): they ship their own complete CSS.
- Render caches (`previews.ts`, `thumbs.ts`) key on `renderStamp` = frame `updatedAt` + theme
  `version`.
- Persistence: `saveCanvasTheme`, never the `canvasColumns` upsert — `saveCanvas` runs on every
  frame edit.
- Surfaces: MCP `get_theme` / `set_theme_tokens` / `set_theme_css` / `set_theme_fonts` (and the
  same in the resident agent, whose system prompt carries the theme), `get_canvas` summary,
  REST `GET`/`PUT /api/canvases/:id/theme`, WS `{type:'theme'}`, the Theme section of Memory.
- Concurrency: last write wins per field. Fonts are fetched before the current theme is read,
  so a slow fetch never clobbers a token write that landed meanwhile.
