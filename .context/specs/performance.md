# Performance notes

Status: living document for the `tijori/design-system` fork's M6 (memory/CPU) work. Numbers are
measured with `.tools/bench/scripts/.eval-perf.mjs` (not in the repo): a throwaway account builds a
canvas with a theme, 6 components and 6 frames, 7 WebSocket viewers plus one headless-Chrome client
join, and an MCP agent streams a landing frame in 40 chunks, 150 ms apart.

## Streaming (2026-09-27)

- Mid-stream the server sends `frame:append {frameId, at, chunk}` instead of the whole healed
  frame per chunk (O(n²) bytes per viewer before). The last chunk still sends the whole frame,
  which resyncs any viewer that missed a delta; clients heal the raw text they accumulate
  (`shared/stream.ts`). One-shot reveal playback uses the same deltas.
- `broadcast` serializes once per message, not once per viewer.
- An agent's `editing` presence is broadcast only when its frame changes, not on every chunk.
- `store.updateFrame` coalesces the canvas upsert (`saveCanvasSoon`, 400 ms, flushed on shutdown)
  like it already did frame writes.
- Component runtime defs and the server-render `<script>` are memoized per definitions array.

| per stream, 7 viewers, 40 chunks | 7.4 KB frame, before → after | 23 KB frame, before → after |
| -------------------------------- | ---------------------------- | --------------------------- |
| bytes per viewer                 | 169.6 KB → 23.9 KB           | 506.4 KB → 56.4 KB          |
| messages per viewer              | 86 → 47                      | 86 → 47                     |
| browser script time              | 0.53–0.60 s → 0.29–0.32 s    | 0.61 s → 0.36–0.40 s        |
| browser task time                | 0.81–0.91 s → 0.51–0.61 s    | 0.94 s → 0.69–0.74 s        |

Server CPU moved from 0.63–0.81 s to 0.41–0.71 s: inside run-to-run noise, not claimed.

## Client bundle (2026-09-27)

- The PostHog SDK (with replay, exception capture, web vitals and conversations compiled in) was
  586 KB of rendered code in the only chunk. `src/lib/posthog.ts` is now a queueing facade; the
  SDK (`src/lib/posthogBoot.ts`) loads with a dynamic import only when `VITE_POSTHOG_KEY` is set,
  once the page is idle. Keyless builds drop it entirely.
- Every page is its own chunk (`React.lazy` in `App.tsx`); the canvas chunk is prefetched while
  idle. Inside the canvas, Board, Inspector, ElementPanel, Onboarding, PresentMode, ConnectModal,
  ShareModal and the Memory tab load when first shown.

| production build, keyless   | before                            | after                  |
| --------------------------- | --------------------------------- | ---------------------- |
| JS a canvas visit downloads | 1,420 KB (435 KB gzip), one chunk | ~590 KB (~182 KB gzip) |
| canvas page chunk           | (inside the one chunk)            | 163 KB (50 KB gzip)    |

## Page load and frame fonts (2026-09-27)

- The Google Fonts stylesheet in `index.html` was render-blocking and cross-origin (1.17 s on a cold
  load while the app's own JS and CSS took 16 ms). The UI fonts are self-hosted hashed assets
  (`src/assets/fonts`, SIL OFL), the Latin Instrument Sans file is preloaded, and `/c/` routes
  modulepreload the canvas chunks (`bootPreloads` in `vite.config.ts`).
- Built text assets ship brotli and gzip copies; the prod server serves them from an allowlist read
  at boot with `Cache-Control: immutable`. A miss under `/assets` is a 404, not the SPA shell.
- Frame iframes are sandboxed srcdoc documents with opaque origins, so their requests never share
  the HTTP cache: every frame re-downloaded every theme font on every load. The page now fetches
  each theme font once (`src/lib/frameFonts.ts`, `fonts.gstatic.com` only, no credentials) and
  posts it to each frame as a lazy `data:` url FontFace; live frames get the theme CSS without
  `@font-face`. Screenshots and exports keep the rules.

| prod build, same harness, `f91a2be` → now | 6 frames                    | 24 frames                   |
| ----------------------------------------- | --------------------------- | --------------------------- |
| network, cold                             | 2,046 KB → 422 KB           | 3,227 KB → 422 KB           |
| network, warm                             | 396 KB → 1.4 KB             | 1,577 KB → 1.4 KB           |
| first paint, cold                         | 496 ms → 36 ms              |                             |
| visible frames complete (HTML + fonts)    | 1,176–1,508 ms → 582–632 ms | 1,440–1,595 ms → 792–876 ms |

## Presence traffic (2026-09-27)

A peer's cursor, camera and drags arrive at 20 Hz each. They no longer render React:

- Peer cameras live in `peerViewports`, apart from `presences`.
- FrameView's memo ignores x/y; a store subscription writes left/top to its root node. Stage renders
  one `FrameSlot` per frame id, each selecting its own frame through `frameById` (O(1)).
- Remote cursors are positioned by a DOM subscription.
- CanvasPage and the side panels select what they draw, never the whole canvas.

| 12 frames, one peer at 20 Hz, viewer main thread | before    | after     |
| ------------------------------------------------ | --------- | --------- |
| peer panning, script                             | 89.8 ms/s | 7.9 ms/s  |
| peer frame drag, script                          | 56 ms/s   | 7.7 ms/s  |
| React commits (panning, drag, cursor)            | 19.8/s    | 0.3–0.5/s |

## Realtime server (2026-09-27)

Per-canvas rooms instead of a scan of every socket per broadcast; permessage-deflate without
context takeover (4 KB threshold: joins and whole-frame updates compress, cursor ticks and stream
deltas do not); lossy messages skipped for a viewer more than 256 KB behind, sockets 16 MB behind
closed; 30 s ping/pong; `maxPayload` 64 KB; 90 lossy messages/s per connection. A 24-frame join is
236 KB → 9.8 KB on the wire (that canvas repeats frames; distinct frames deflate about 3–4x).
