# Linked components

Status: shipped on the `tijori/design-system` fork, 2026-09-27. Code: `shared/components.ts`,
`actions.setComponent` / `deleteComponent`, `src/components/ComponentsSection.tsx`, the
`doop:components` handler in `src/lib/frameRuntime.ts`.

## Problem

Repeated pieces (buttons, rows, cards) were copied into every frame. Changing one meant editing
every copy, and agents re-sent the same markup on every screen.

## Shape

- `components` table (migration 0019), hydrated into `Canvas.components`: `{ name, html, css,
props, description, version, deletedAt? }`. `name` is the custom element tag (`ds-stat`).
- Frames hold instances: `<ds-stat label="Net worth">₹18,42,300</ds-stat>`. Each renders its
  definition into an open shadow root: `<slot>`s take children, `{{prop}}` takes an attribute
  (escaped), `:host([variant="x"])` gives variants. `serialize()` only sees the light DOM, so
  frame HTML stays linked.
- One runtime (`COMPONENT_RUNTIME`) runs in both paths: embedded in the frame bootstrap, and
  injected as a `<script>` after the theme `<style>` in server renders (`prepareFrameHtml`).
  Custom elements cannot be redefined, so each tag is defined once and looks its template up in a
  registry; `doopComponents.refresh()` re-renders instances whose definition version or attributes
  changed (after each morph).
- The theme reaches shadow roots through a shared constructable sheet (document styles do not
  cross the shadow boundary; custom properties do).
- Cascade trap: a page rule on the host (a theme's `*{margin:0;padding:0}`) beats `:host` for
  normal declarations, so padding/margin belong on an element inside the template.
  `hostBoxWarning` flags it on `set_component`.
- Delete writes a tombstone: instances render a visible "missing component" box, even on a fresh
  load or a server render. Nesting deeper than 8 renders the same box (recursion guard).
- Render caches join `componentsStamp` (count + newest `updatedAt`) into `renderStamp`.
- Surfaces: MCP `list_components` / `get_component` / `set_component` / `delete_component` /
  `component_usages`, a `components` summary in `get_canvas`, REST
  `PUT`/`DELETE /api/canvases/:id/components/:name`, WS `{type:'component'}`, Memory panel
  Components section.
