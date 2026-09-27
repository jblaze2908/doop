# Element inspector: design-system aware

Status: shipped on the `tijori/design-system` fork, 2026-09-27. Code: `src/components/ElementPanel.tsx`,
`src/components/ElementSystem.tsx`, `src/lib/designTokens.ts`, the `doop:classes` / `doop:attrs`
handlers in `src/lib/frameRuntime.ts`, the conflict check in `src/lib/history.ts`.

## What changed

- Token pickers (◆) on colour and length rows write `var(--token)`; a linked value shows as a
  chip, and detaching writes the current literal back.
- Classes: removable chips plus an input suggesting the classes the theme CSS defines
  (`themeClassNames`). `doop:classes` replaces the list (invalid names dropped).
- Components: a selected instance shows its props as fields (`doop:attrs`; event handlers,
  style, class and id are refused). Any other element offers "Swap to" a component, which keeps
  its children as slot content and moves the selection to the new instance.
- More controls: margin, padding as its own row, align/justify for flex and grid, wrap for flex,
  font family (token-aware), line height, letter spacing.
- Save race: while a style/class/attr edit waits for its 250 ms save, incoming renders are
  skipped; the parent re-sends the frame after the save, so the edit is no longer morphed away.
- Undo: an html undo/redo is refused (with a toast) when the frame changed since the entry was
  recorded, instead of silently overwriting a collaborator's or an agent's work.
