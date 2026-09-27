# Lean agent reads

Status: shipped on the `tijori/design-system` fork, 2026-09-27. Code: `server/htmlTree.ts`, the
`get_frame_outline` / `get_frame_section` / `replace_frame_section` tools in `server/mcp.ts`.

## Problem

`get_frame` returns the whole document. Agents re-read thousands of tokens of HTML to change one
headline, and rewrote whole documents for local edits.

## Shape

- `server/htmlTree.ts`: a tolerant, dependency-free HTML parser that keeps source offsets
  (`start`, `openEnd`, `end`). Missing html/head/body (and tbody/tr) are synthesized as
  `implied` elements, so the frame runtime's `body:nth-of-type(1) > …` selectors resolve on
  fragments. Selector subset: type, `#id`, `.class`, attribute operators, `:nth-of-type`,
  `:nth-child`, `:first/last-child`, `:first-of-type`, descendant/child/sibling combinators, lists.
  Parsing 61 KB takes 0.8 ms warm (measured by the implementing agent, median of 50).
- `get_frame_outline`: one line per element — dotted `@path`, tag, `#id`, up to three classes, a
  40-char text snippet, `[N]` for children cut off by depth. Scripts, styles, template and
  noscript are never numbered, so moving them does not shift paths.
- `get_frame_section` / `replace_frame_section`: locate by `@path` or a selector that must match
  exactly one element (the error lists the matching `@paths`); replacement splices
  `[start, end)` and keeps every other byte.
- `edit_frame_html` now uses a function replacement, so `$&` / `$1` in the new
  text stay literal.
