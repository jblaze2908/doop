# draft - specs Index

Complete record of `.context/specs/`. This file is NOT @-imported by CLAUDE.md; it is reached by
link from [../INDEX.md](../INDEX.md), so it costs nothing until someone opens it, which is why it
lists every file in this folder.

## Active

- [canvas-theme.md](canvas-theme.md) - Canvas theme: tokens, Google Fonts and shared CSS every
  frame inherits; injection order, render-cache stamp, MCP/REST/WS surfaces.
- [code-export.md](code-export.md) - Frame → React files (components, theme CSS, page) or one
  self-contained HTML document.
- [element-inspector.md](element-inspector.md) - Element panel: token pickers, class chips, component
  props and swap, extra spacing/type controls, save-race and undo-conflict fixes.
- [lean-reads.md](lean-reads.md) - Frame outline, section read and section replace for agents,
  backed by an offset-preserving HTML parser.
- [linked-components.md](linked-components.md) - Linked components: custom elements with shadow DOM
  templates shared by every frame; runtime, cascade trap, tombstones, surfaces.
- [performance.md](performance.md) - Measured memory/CPU work: streaming deltas, broadcast and
  persistence coalescing, with before/after numbers.
- [workspaces.md](workspaces.md) - Shared workspaces (org-level canvas access with roles): data
  model, access rules, invites.
