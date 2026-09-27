# Live dashboards

Canvas pages were realtime through their per-canvas WebSocket room. The dashboard was not: a canvas
an agent created over MCP, a rename, new frames or a delete only showed after a reload.

## Design

- A dashboard page opens the same `/ws` endpoint and sends `{ type: 'home' }`. The server checks the
  session (4401 without one) and files the socket under the user (`server/homeFeed.ts`).
- The store is the choke point: `createCanvas`, `duplicateCanvas`, `claimCanvas`, `renameCanvas`,
  `setWorkspace`, `addMember`, `removeMember`, `deleteCanvas` and the frame create/update/delete
  calls fire hooks the feed sets. `broadcast` forwards the two canvas events the store never sees:
  `task` (which agents worked there) and `activity` (the live feed).
- Recipients use the same rule as `store.listCanvases`: owner, invited members, and members of the
  canvas's workspace. Nobody else hears about a canvas.
- Messages: `home:canvas` (a full dashboard row, upserted), `home:canvas:removed` (delete, or the
  viewer lost access), `home:activity`, and `home:refresh` for workspace and access changes a row
  cannot express (the page refetches its lists). A reconnect also refetches.
- Rows coalesce per canvas: the first change after a quiet period flushes at once, later ones at
  most every 500 ms. A streaming agent touches a canvas per chunk; a dashboard needs about two rows
  a second.
- Tile thumbnails: rows carry `previewAt` (the preview frame's render stamp). The image URL follows
  it only after 2 s of quiet, or every 10 s during a long stream, because each new URL is a server
  render.

## Cost

A store write with no dashboard open anywhere returns after one `Map.size` check. With dashboards
open it adds the canvas id to a set. A flush builds one row per recipient socket: O(frames + tasks)
per row.

## Verified

`tests/homeFeed.test.ts` (real server, three users): create, coalesced edits, invite, activity,
uninvite, delete, and a stranger who receives nothing; a socket without a session is closed 4401.
A headless-Chrome check on the dev stack: create appears in 9–25 ms, edits and renames in about
0.5 s, a delete in 2–3 ms, all without a reload.
