# NOTICE: Impeccable-derived agent guide topics

Draft's agent guide includes text adapted from Impeccable by Paul Bakaus, licensed under the
Apache License 2.0 (see `LICENSE` in this directory): https://github.com/pbakaus/impeccable at
commit `e103efe779e2dd01274dabae83531fef00bf2563`.

The text was condensed and rewritten for Draft's agents (frames, theme tokens, Tailwind
utilities, `get_frame_screenshot`, `audit_frame`). References to Impeccable's CLI, hooks, live
mode, browser extension and project files were removed. The adapted text lives in
`server/guideImpeccable.ts` and is served by `get_guide`:

| Draft guide topic | Derived from (Impeccable)                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `design-review`   | `crates/live/assets/antipatterns.json` (rule descriptions), `skill/reference/craft-floor.md` |
| `critique`        | `skill/reference/critique.md`, `skill/reference/audit.md`                                    |
| `typeset`         | `skill/reference/typeset.md`, `skill/reference/craft-floor.md`                               |
| `layout`          | `skill/reference/layout.md`, `skill/reference/craft-floor.md`                                |
| `colorize`        | `skill/reference/colorize.md`, `skill/reference/craft-floor.md`                              |
| `polish`          | `skill/reference/polish.md`, `skill/reference/craft-floor.md`                                |

The pointer to `design-review` in the core guide (`server/guide.ts`, `DRAFT_GUIDE`) is Draft's
own text.
