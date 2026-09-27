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
