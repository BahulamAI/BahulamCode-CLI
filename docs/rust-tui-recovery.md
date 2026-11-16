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

The user confirmed `f0ed045` working as expected before requesting the next
functionality. Keep the known baseline limitations above separate from this
popup change.

## Reviewed feature: opt-in mouse wheel navigation

Adapted only mouse wheel navigation from `5c04734`. Enable it with
`BAHULAM_TUI_MOUSE=1` (also `true` or `scroll`); leaving it unset preserves native
terminal selection. In capture mode, use the terminal's selection override
(commonly Shift-drag) when selecting text.

- Wheel over conversation history or an open detail view to scroll. Scrolling
  the conversation keeps a draft editable and follows new output again when
  returning to the bottom.
- Wheel over the visible agent sidebar to select an agent; Enter opens its
  transcript. Existing Esc/Tab keyboard navigation remains available.
- Wheel input over borders, plan, composer and status rows does nothing.
  Pickers and approvals block mouse navigation behind them.
- Capture is disabled during terminal restoration. No click, clipboard,
  capability-probe, approval-policy or Node CLI changes are included.

Review corrections: the original code estimated panel boundaries and started
scrolling from stale offset zero. Hit detection now shares the existing layout
calculation with rendering, including multiline prompts and compact widths.
Initial wheel-up uses the existing Ctrl+Up history anchor. The actual layout,
transcript formatting and replay model remain unchanged.

Validation: 16 Rust tests pass, including hit regions after resize, compact
layouts, multiline drafts, modal isolation and bounded tail navigation.
`npm run test:tui:mouse` exercises the compiled client through the Node host
with capture unset/enabled, history scrolling, agent navigation, draft
submission, and exact terminal-mode restoration. `npm run test:tui:popup`
also passes with capture enabled. User live acceptance remains pending for
this mouse batch before another functionality is added.

## Recovery correction: shared command handoff and quit

Live testing exposed an adapter bug, not missing command implementations:
`JsonlWriter.ensureSessionId()` initializes a property and returns no value.
The Rust adapter used its return value, sending startup command catalogs and
post-`/new` snapshots without a valid session ID. It now reads the current
writer's `sessionId`, including after the existing `/new` handler replaces it.
No default Node handlers or writer APIs changed.

Both views use the same instruction queue and `_handleLine` in the Node REPL.
Rust forwards submitted text through its `prompt` message; ordinary text then
uses the existing agent client, and slash commands use `handleCommand`.
There is no separate Rust agent or command implementation in this correction.

Ctrl+C twice within two seconds now exits the CLI, including from a picker.
Rust restores its terminal before Node calls the existing `/exit` handler;
Node also releases its inherited raw mode. An unexpected renderer exit still
falls back to the Node prompt. Ctrl+Q is no longer a live shortcut, and the
footer advertises Ctrl+C twice. Offline replay retains its existing shortcuts.

Validation adds `npm run test:tui:commands`, using the actual CLI in an isolated
PTY from both fresh startup and `--resume`. It exercises slash completion,
session selection, `/new`, `/help`, `/model status`, `/clear`, cancellation,
resume by ID, and Ctrl+C twice while a picker is open. It checks that Ctrl+Q
does not close the picker, saved messages remain unchanged, the process exits
through `/exit`, and terminal settings are restored (excluding macOS's
transient PENDIN flag). A small VT cell reader checks redraws instead of
assuming every frame prints unchanged text again.

Rust tests, protocol checks, popup/mouse PTY tests, slash-command tests, and
the default Node startup-resume regression passed during this correction.
The Rust build cache was cleared and the binary rebuilt for live testing.
These checks do not establish full parity or a live model response in both
views. Resume command-card formatting and historical interaction isolation
remain separate review items; this batch does not change transcript formatting.

## Recovery correction: return to the default view

Use `/tui default` (or its `/tui` alias) in the Rust full-screen composer to return to the existing
Node view without ending the session. This is a renderer control, advertised
in the Rust command suggestions and footer; it does not replace a shared
business command. Rust sends `detach`, restores the terminal, and exits
normally. Node resumes readline, restores bracketed-paste reporting, and
remounts its original input dock and metadata timer when enabled. Session,
history, agent client and command dispatch remain in the same Node process.

Ctrl+C once still interrupts; twice within two seconds exits the entire CLI.
Ctrl+Q remains unused in live Rust. This batch adds only the return path:
reopening Rust from the Node prompt is not yet included. The later Rust
`/tui inline` renderer is not the Node default view and remains deferred.

The real CLI PTY test now includes returning to Node after resume, checking
the same session ID with `/status`, reading the saved reply with `/history`,
and exiting with `/exit`. It checks alternate-screen release, preserved saved
messages and restored terminal settings. Node commands are typed with Enter
as a separate input event so the test does not accidentally trigger its
existing paste-detection behavior. Live acceptance of this handoff comes
before the next selective backport.

Validation: all 16 Rust tests pass after the clean rebuild. The existing two
real CLI command/quit cases pass, and the added return-to-default case passes
with the dock restored, the same session ID and saved reply, and a clean exit.
The bare `/tui` alias has the same PTY coverage; previously it reached Node's
dispatcher and printed `Unknown: /tui`, while only `/tui default` was handled.

## Pending review: palette parity

The recovery renderer has dark/light/high-contrast/ANSI palettes, but its
separately defined blue/gray values do not match Node's Bahulam brand tokens
in `src/ui/palette.mjs`. Rust defaults to dark without background detection;
`/theme light` or `BAHULAM_THEME=light` can explicitly select light. Its current
NO_COLOR presence check also disables colors for an empty value, unlike Node.
Review token alignment, theme selection and color capability handling as a
separate batch; do not change the existing Node palette as a side effect.
