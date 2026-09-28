# Design systems across canvases

A canvas owned its theme, components and style guides; reuse meant copying (`duplicateCanvas`,
`apply_kit`). A design system is defined once and used by many canvases.

## Decisions (Jai, 2026-09-28)

- Draft → publish → consumers follow. Editing never reaches consumers until someone publishes; a
  publish reaches every following canvas live. A canvas can pin a version; rollback republishes an
  old version as a new one. Industry scan (Figma, Sketch, Penpot, Webflow, zeroheight, npm) in the
  plan note: this is zeroheight's draft/release split without Figma's per-file accept.
- Owned by a workspace (or a user, for personal canvases). Any member uses it; only the owner and
  workspace admins publish.
- A canvas that uses a system keeps a local layer: its own tokens, CSS, components and style guides
  override the system's on that canvas only.

## Model

- **Source canvas**: a system is backed by one canvas whose theme, components and style guides ARE
  the draft, so every existing editor (theme tools, components, style guides, the Memory panel)
  edits it unchanged. Its frames are the system's specimen pages. A source canvas cannot itself use
  a system, and cannot be deleted while other canvases use the system.
- `design_systems`: id, name, source canvas, workspace, owner, `published_version` (0 = never),
  `published_stamp` (the draft stamp at the last publish, so "draft has changes" is a compare).
- `design_system_versions`: `(system_id, version)` → snapshot `{ theme, components, guidelines }`.
  Only the latest and pinned snapshots load at boot.
- `canvases.design_system_id` + `canvases.design_system_pin` (null = follow latest).

## Effective design

`shared/designSystem.ts` merges snapshot and local layer; server and client use the same code.

- Tokens by name (local value wins, system order kept), fonts unioned, `fontFaces` and CSS
  concatenated system-first (local CSS later wins), `utilities` local ?? system.
- Components by name: a live local definition wins; a local tombstone does not hide the system's.
- Style guides by name, local wins.
- Merges are memoized per (snapshot, local theme) object pair. Render caches key on
  `designKey` = `system@version|local theme version`, never on `theme.version` alone (two systems
  can share a version number).

## Surfaces

- MCP: `list_design_systems`, `create_design_system` (promote a canvas, or a new source canvas,
  optionally from a kit), `publish_design_system` (optional `from_version` = rollback),
  `use_design_system` (link, pin, unlink), `create_canvas({ design_system_id })`. `get_canvas` and
  `get_theme` say which values come from the system; theme writes on a consumer say they are local
  overrides. Guide topic `design-systems`.
- REST: `GET/POST /api/design-systems`, `POST /api/design-systems/:id/publish`,
  `GET /api/design-systems/:id/versions`, `PUT /api/canvases/:id/design-system`.
- WS: `init.system` (link + snapshot) and `init.systemSource` (for the source canvas);
  `system` pushes a new link to consumer rooms on publish, pin or unlink.

## Cost

- Publish: one snapshot write, then per following canvas one room broadcast, one coalesced home-feed
  row and one debounced Tailwind rebuild.
- Per render: the merge is memoized; `designKey` is string concatenation.
