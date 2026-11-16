# Rust terminal recovery review

## Accepted baseline

The user accepted the reply-history behavior at `e9aa899`, whose source tree
matches original commit `16ac966`. The branch
`recovery/rust-tui-history-accepted` preserves that point. Continue on
`recovery/rust-tui-staged`, one reviewed batch followed by a user live test.
The original later implementation remains on
`fix/daemon-lifecycle-and-ci-guards`.

Preserve the accepted full-screen transcript and history rendering. Do not
reapply the later inline renderer or change the default Node CLI as part of a
Rust feature backport. Shared host changes need specific review and Node
regression checks. Automated checks supplement the user's terminal tests;
they do not establish visual acceptance.

## Review of later changes

| Original commit | Review disposition |
| --- | --- |
| `8112157` | Bring forward protocol fixtures and host/request-invariance tests first. Defer runtime disconnect notices: the Node notice suggests reopening with `/tui fullscreen`, which needs verification against this baseline's host lifecycle. |
| `5c04734` | Review model commands, scoped approvals and optional mouse as separate features. Preserve policy checks and verify historical approvals cannot become live prompts. Avoid importing unrelated Node command behavior. |
| `7e81afb` | Hold wholesale application: this changes the Node `/new` display, including terminal scrollback clearing. Review Rust session-reset requirements separately. |
| `377dd2d` | Candidate later batch: job status, tool timing and check results. Validate lifecycle events without changing history order or saved replies. |
| `b37c586` | Split into individual features. It combines clipboard, editor/history, capabilities, background promotion and host recovery with a change to default inline rendering and redraw scheduling. Do not copy its renderer as a feature dependency. |
| `7cd8933` | Extract specific fixes only. It mixes session-ID delivery, picker sizing, editing and question routing with a large renderer rewrite and startup dock changes. The latter interacted with captured resume progress. |
| `3e16f9e` | Review historical-interaction isolation separately. Its inline exit-output suppression is not directly applicable to the accepted full-screen renderer, which restores the alternate screen on exit. |

## Batch 1: validation foundation

- Import only the two golden protocol fixtures and the host/request-invariance
  test from `8112157`; include the host with disk logging disabled as well.
- Cover all 80 saved messages across 32-item snapshot chunks, individual scroll
  positions and 120/80/40-column resizes at 24 or more rows.
- Cover a complete 200-line saved reply, replacement of an older session, and
  reconciliation of the next streamed reply without duplicating it.
- No runtime source changes in this batch.

The new checks exposed a baseline limitation at 40 columns by 16 rows: fixed
panels can leave only a card header visible. The existing tiny-window check
covers rendering without a panic, not transcript readability at that height.
Keep this separate from restoring history data or changing the accepted layout.

An adversarial subscriber check also exposed a baseline issue with disk logging
disabled: a callback mutating nested tool arguments can mutate the source event.
The real Rust host serializes events without mutating them; its request-invariance
check passes with logging on and off. The deliberate mutation check remains
covered with logging enabled only. A separate event-isolation fix and regression
test are needed before claiming all subscribers preserve inputs without logging.

## Reviewed feature: resume popup

The user requested the recent `/resume` session-selection popup. Adapted the
height-aware option window and single-row labels from `7cd8933` to the accepted
renderer. The draft cursor stays hidden while the modal is open, and the short
footer fits a 40-column terminal. This shared popup also serves the existing
model/history-mode choices. No Node runtime, input event handling, transcript
model, main layout or startup behavior changed.

Validation:

- Rust: 14 tests pass, including selected first/middle/last entries with 30 long
  Unicode labels at 120x36, 80x24 and 40x16. Closing the popup restores the exact
  pre-popup buffer and leaves saved history unchanged.
- `npm run test:protocol`: golden fixtures and request/cache invariance pass.
- `npm run test:tui:roundtrip`: Node producer to compiled Rust replay passes.
- `npm run test:tui:popup`: compiled Rust through the Node host in a Unix PTY
  selects session 30, resizes, restores a saved reply, cancels another picker,
  and submits a subsequent prompt. This uses fixture sessions and a valid
  protocol session ID, not the real REPL's startup/session-discovery path.

User live acceptance is still required for this popup batch before adding the
next feature. Keep the known baseline limitations above separate from this
popup change.
