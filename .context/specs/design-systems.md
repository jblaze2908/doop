# Design systems across canvases

Status: first cut shipped 2026-09-28 (`88345d6`, `9099a82`); hierarchy redesign the same day.
Code: `server/designSystems.ts`, `shared/designSystem.ts`, `src/pages/DesignSystemPage.tsx`,
`src/components/DesignPanel.tsx`.

## Problem

A canvas owned its theme, components and style guides; reuse meant copying (`duplicateCanvas`,
`apply_kit`). The first cut shared them, but a system was a flag on a canvas: it lived in that
canvas's Memory panel, pointed at another canvas, copied its workspace once at create (a canvas
move then drifted it), and a theme edit on a consumer silently became a local override.

## Hierarchy

```
Workspace (or a person's personal space)
├── Design systems   /s/<id>   tokens · fonts · CSS · components · rules · specimens · versions
└── Canvases         /c/<id>
    └── canvas ──uses──▶ one system @latest | @vN, plus explicit overrides
```

- A system belongs to one scope: a workspace, or its owner's personal space.
  `design_systems.workspace_id` is the only record of it.
- A canvas uses at most one system, and only one from its own scope (`inScope`): a workspace
  canvas uses that workspace's systems; a personal canvas uses its owner's personal systems.
- A workspace can name a default system (`workspaces.default_design_system_id`). Canvases created
  in the workspace start on it; `design_system_id: null` on `create_canvas` opts out.

## Decisions (Jai, 2026-09-28)

- Draft → publish → consumers follow. Editing never reaches consumers until someone publishes; a
  publish reaches every following canvas live. A canvas can pin a version; rollback republishes an
  old version as a new one. Industry scan in the plan note: zeroheight's draft/release split
  without Figma's per-file accept.
- Any member of the scope uses a system; only its owner and workspace admins publish, rename,
  delete it or make it the workspace default.
- A consumer keeps a local layer, made explicit: inherited items show read-only with Override; an
  override shows Reset.
- No use across workspaces.

## Storage

- The draft lives on a hidden **source canvas**, so every editor, MCP write tool and render path
  works on it unchanged; its frames are the system's specimens. It is never listed as a canvas
  (`store.hiddenFromLists`: dashboard, `list_canvases`, home feed, workspace counts). The system
  page's "Edit draft" opens it. It cannot be moved or deleted as a canvas.
- `design_systems`: id, name, source canvas, workspace, owner, `published_version` (0 = never),
  `published_stamp` (the draft stamp at the last publish, so "draft has changes" is a compare).
- `design_system_versions`: `(system_id, version)` → snapshot `{ theme, components, guidelines }`.
  Only the latest and pinned snapshots load at boot.
- `canvases.design_system_id` + `canvases.design_system_pin` (null = follow latest).
- `workspaces.default_design_system_id` (migration 0022).

## Lifecycle

- Create: a new source canvas in the chosen scope, optionally from a kit.
- Create from a canvas: extraction, not promotion. The canvas's theme, live components and rules
  are copied to a new source canvas and published as v1. The canvas is linked to the new system
  and its own layer cleared, so it renders the same and stays a canvas.
- Stop using: detaches with a copy. The version the canvas rendered is flattened into its own
  layer, so its frames keep rendering (components included). `keepCopy: false` unlinks bare.
- Forced detach, always with a copy: a canvas moved out of its system's scope, and a workspace
  deleted (its systems become personal to their owners; consumers owned by anyone else detach).
- Delete: refused while canvases use the system. Deletes the source canvas and versions, and
  clears a workspace default that pointed at it.
- Boot: a system's workspace is reconciled to its source canvas's (the first cut let a canvas move
  drift them). Links made before the redesign that break scope are left alone; scope is checked
  on writes.

## Effective design

`shared/designSystem.ts` merges snapshot and local layer; server and client use the same code.

- Tokens by name (local value wins, system order kept), fonts unioned, `fontFaces` and CSS
  concatenated system-first (local CSS later wins), `utilities` local ?? system.
- Components by name: a live local definition wins; a local tombstone does not hide the system's.
- Style guides by name, local wins.
- `originOf` labels each token, component and guide `system`, `override` or `local` for the UI.
- Merges are memoized per (snapshot, local theme) object pair. Render caches key on
  `designKey` = `system@version|local theme version`, never on `theme.version` alone (two systems
  can share a version number).

## Surfaces

- Dashboard: Home shows the scope's design systems above its canvases; `/s/<id>` is the system
  page (status, Publish, Edit draft, versions with Restore, canvases using it, workspace default,
  rename, delete).
- Canvas side panel: a **Design** tab (the system, Theme, Components, Rules) apart from **Memory**
  (References, Decisions). On a source canvas the Design tab edits the draft and a top-bar chip
  links the system page.
- MCP: `list_design_systems` (marks the workspace default), `create_design_system` (new, or
  `canvas_id` to extract), `publish_design_system` (`from_version` = rollback),
  `use_design_system` (link, pin, stop with `keep_copy`), `create_canvas({ design_system_id })`
  (default applies when omitted). `list_canvases` hides source canvases. Guide topic
  `design-systems`.
- REST: `GET/POST /api/design-systems`, `GET/PATCH/DELETE /api/design-systems/:id`,
  `POST /api/design-systems/:id/publish`, `PUT /api/canvases/:id/design-system`,
  `PUT /api/workspaces/:id/default-design-system`.
- WS: `init.system` (link + snapshot), `init.systemSource` (on the source canvas); `system`
  pushes a new link to consumer rooms on publish, pin or unlink.

## Cost

- Publish: one snapshot write, then per following canvas one room broadcast, one coalesced home-feed
  row and one debounced Tailwind rebuild.
- Per render: the merge is memoized; `designKey` is string concatenation.
- `inScope`: two field compares per link write. `hiddenFromLists`: one Map lookup per canvas per
  listing, which is O(canvases) already.
- Extract and detach: one write and broadcast per component and rule, user-triggered only.
  Workspace delete: one scan of the canvases.

## Deliberately not done

- Moving a system to another workspace.
- More than one system per canvas.
- A personal default system.
