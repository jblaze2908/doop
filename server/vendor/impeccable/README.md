# Impeccable detector (vendored)

Draft's design check runs [Impeccable](https://github.com/pbakaus/impeccable)'s anti-pattern detector, © Paul
Bakaus, Apache-2.0 (`LICENSE`). These files are copied unmodified from commit
`e103efe779e2dd01274dabae83531fef00bf2563`:

| File                             | Upstream path                                       | SHA-256                                                            |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `detect-antipatterns-browser.js` | `crates/live/assets/detect-antipatterns-browser.js` | `aed2977c33016bfa2582afea1915f32c5d6494b1d1f378f78af383c69f0c4635` |
| `antipatterns.json`              | `crates/live/assets/antipatterns.json`              | `8ba1b09c715882ccf2b08d75e6d946e22ad34a8fba6e8cd3ce475a88ffbb0c79` |
| `LICENSE`                        | `LICENSE`                                           | `02bb8c3b4e70190e3986c0404ad2fd8d639b4f534252d82379cc1b502b6d1812` |

The bundle is generated upstream (`cargo xtask bundle`): the 61 rules compiled to WebAssembly plus the page-side probe.
`server/designAudit.ts` loads it into frame pages the server already renders and calls `window.impeccableDetectAsync()`.
It makes no network requests of its own, and frame pages block outbound requests anyway (`guardPublicPageRequests`).

To update: `scripts/vendor-impeccable.sh <commit>`, then update the commit and checksums above, and run
`tests/designAudit.test.ts`.
