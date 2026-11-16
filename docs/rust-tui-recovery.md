# Rust terminal recovery review

## Accepted baseline

The user accepted the reply-history behavior at `e9aa899`, whose source tree
matches original commit `16ac966`. The branch
`recovery/rust-tui-history-accepted` preserves that point. Continue on
`recovery/rust-tui-staged`, one reviewed batch followed by a user live test.
The original later implementation remains on
`fix/daemon-lifecycle-and-ci-guards`.

Preserve the accepted transcript and history rendering. Do not wholesale
reapply the later renderer or change the default Node CLI as part of a
Rust feature backport. Selective inline recovery and startup changes are
recorded in the later batch sections below. Shared host changes need specific review and Node
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
| `3e16f9e` | Historical-interaction isolation remains separate. Inline exit-output suppression was adapted when the inline viewport was restored; full-screen retains its accepted exit behavior. |

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
Ctrl+Q remains unused in live Rust. The initial batch added only the return
path; the next reviewed batch below adds reopening. The later Rust
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

## Reviewed batch: reopen full-screen and share the brand palette

From the default Node prompt, `/tui fullscreen` or `/tui full screen` opens
Rust in the same process-owned session. `/tui default` (or bare `/tui` inside
Rust) returns to Node. The launch path is reusable, with one renderer owning
the terminal at a time. Node's existing command catalog gains `/tui`; no
existing business command handler or default appearance changes.

Resume replay items now track the number of messages represented by that
replay. Reopening appends subsequent conversation messages to the saved
prefix without duplicating it, and `/new` and `/clear` reset that bookkeeping.
New live tool-detail cards are not reconstructed by this message append;
complete event replay across view switches remains a separate review item.

The later renderer still had independent blue/gray values. Instead of copying
them, the Node host passes the canonical dark/light tokens from
`src/ui/palette.mjs` and its existing resolved color depth to Rust. This keeps
brand, text, status and agent colors aligned without modifying Node's palette.
Rust uses exact token values at truecolor/256/16 depths and downgrades its
remaining panel colors to the selected depth. Standalone offline replay retains
its fallback palettes; high-contrast retains its dedicated palette.

Launch theme follows Node's existing `BAHULAM_THEME` / `COLORFGBG` selection.
`/theme dark`, `/theme light`, `/theme high-contrast` and `/theme ansi` remain
available in Rust; these local changes apply to that renderer instance.
Empty `NO_COLOR` no longer disables Rust colors. Nonempty `NO_COLOR`, disabled
color capability and `FORCE_COLOR=0`/`false` suppress colors. OSC background
probing and persistent interactive theme selection are not added here.

Validation covers 18 Rust tests, protocol/request invariance, popup/mouse PTY
tests, and command-catalog checks. The real CLI tests include repeated
Node-to-Rust-to-Node switches, both full-screen spellings, restored history,
new-session clearing and quitting. The palette assertion inspects Rust's own
alternate-screen bytes for canonical dark/light RGB values. Snapshot regression
coverage includes 80 resumed messages plus new turns and repeated reopening.
All six command/snapshot cases and the unchanged default Node startup-resume
regression pass. The Rust cache was cleared and the client rebuilt for live
testing before this batch was committed.

## Next selective backports, after live acceptance

1. Resume transcript formatting and historical-interaction isolation from
   `3e16f9e`: old approval events must not become live approval prompts.
2. Scoped approvals and model-picker behavior from `5c04734` through the shared
   Node handlers; retain existing policy checks.
3. Job status, tool timing and check results from `377dd2d`.
4. Split clipboard, editor/history, background promotion and recovery work from
   `b37c586` / `7cd8933` into individual batches. Their inline renderer rewrites
   remain excluded from this recovery branch.

This queue is not a claim that all later commits or complete Rust parity have
been merged. Each batch needs its own review and live acceptance.

## Live-event audit after `659e6b7`

Run `node scripts/audit-tui-events.mjs` after building Rust. This uses synthetic
events through the real Node projection and Rust plain replay, with an isolated
temporary home and no model calls. It checks event visibility, not interactive
rendering, pixel parity, live provider behavior or approval policy correctness.
At this checkpoint, 12 of 31 representative cases render, 17 are dropped by
the bridge, and 2 reach Rust without a display handler. These counts are not a
percentage of feature completion.

| Surface | Recovery behavior | Outstanding work |
| --- | --- | --- |
| Assistant text | Stream/final events update a message card; full text retained | Compact previews added below; provider/live-turn acceptance still needed |
| Normal tools | Request/running/done/failed cards correlate when call IDs match; preview plus details | Gateway loop completion shape is incomplete; elapsed live timer not backported |
| Shell output | Renderer handles `tool_output_delta` | No emitter found in current `src` outside the tap itself; streaming shell output is not end-to-end wired |
| Agents | Spawn/status/finish, reports, attributed text and sidebar navigation exist | Sub-agent tool progress metadata is dropped; graph/node attribution needs correction |
| Thinking and checks | `thinking_delta` / `test_result` are projected | Model has no display cases for either |
| Plans, diffs, errors, usage | Protocol/model paths exist; fixtures cover the core paths | Not all producer shapes or display metadata are covered |
| Status/phases/delegation | Node has display handlers | Bridge drops `status`, `phase_start/update/summary`, `delegation` |
| Other notices | Node handles local stagnation, compaction, changes, goals, follow-ups, cancellation/pause/resume | Bridge drops these events; some have display/state side effects only in Node |
| Approvals | Rust has allow-once/deny and details loading | Scope choices, multiple pending approvals and historical/live isolation are not backported |
| Jobs | Base registry exists | `377dd2d` job/check/status UI wiring is absent |

Two reproducible identity defects need priority over visual polish:

- `src/core/loop.mjs` emits gateway `tool_done` with only tool name and duration,
  unlike `src/core/local-agent.mjs`, which includes `call_id`, output and success.
  The audit reproduces a still-running original tool plus a separate completed
  `Tool unattributed:…` card. It also loses the tool failure/result on this route.
- `src/orchestration/events.mjs` can attribute events with `graph_run_id`,
  `node_id`, `sub_agent` and `internal`, without a dedicated `run_id`. The tap
  does not use graph/node identity and generates a new unattributed agent ID
  per event, so a single tool lifecycle can split across agent lanes.

The snapshot code also applies historical approval/control events through the
live model. The isolation part of `3e16f9e` remains necessary. Full result
availability has limits: with disk logging off, the transient payload store
retains up to 128 entries / 64 MiB, and unregistering the last live subscriber
clears it. Reopening currently restores messages, not every new tool payload.
“Show details” cannot promise unlimited historical tool retention yet.

At that audit checkpoint, most missing SSE mappings also remained missing in the original later branch.
Cherry-picking its remaining commits alone will not establish display parity.
Keep producer identity, event projection, Rust model handling, and details
retention as separate checks in each recovered feature.

### Remaining original commits: current disposition

| Original commit | Recovered | Still pending/excluded |
| --- | --- | --- |
| `8112157` | Protocol fixtures and host/cache checks | Disconnect notices/lifecycle review |
| `5c04734` | Opt-in wheel navigation | Scoped approvals, model-control messages, capability diagnostics |
| `7e81afb` | Rust session reset now works through existing `/new` | Its Node redraw/scrollback changes deliberately excluded |
| `377dd2d` | Check-result rendering now implemented independently | Job subscriptions/status and live tool timing |
| `b37c586` | Inline viewport/switching adapted narrowly in the batch below | Clipboard/editor/history, background promotion, recovery; wholesale renderer rewrite excluded |
| `7cd8933` | Popup sizing and session-ID correction adapted | Composer, question routing and remaining input integrations; renderer rewrite excluded |
| `3e16f9e` | Inline exit-output suppression, historical control isolation and resume progress cleanup adapted | Remaining differences require review |

### Compact preview direction

The user requested compact previews with a visible Show details action in both
views. Existing Rust tool/command cards already show short previews and load
full payloads via Enter. The default Node renderer already has tool previews
and F2 / `/last` / `/expand`, but assistant messages stream in full.

The Rust-only change folds long assistant/agent replies to six preview
rows, retaining full text in the model and details view. Streaming previews
show the newest rows; completed previews show the beginning. Short replies
and user prompts retain their normal display. The existing keyboard action
is Tab to transcript, select the card, Enter for details, Esc to return.
These are keyboard actions; mouse-click buttons are not implemented here.

A regression renders a 200-line reply, opens its final lines in details,
restores the exact preview/draft, and checks streaming tails and long wrapped
paragraphs. The user clarified that the two target views are Rust inline and
Rust full-screen. Node's existing rendering must remain unchanged.

### Reviewed batch: Rust inline plus shared compact previews

Adapted the later renderer's bounded inline viewport and view transitions,
without importing its composer/renderer rewrite. Inline and full-screen use
the same model, compact card rendering, input handlers, picker and details
code. Inline omits the agent/plan panels and transcript frame, using a
16-row viewport on the normal screen. Full-screen keeps the accepted workspace
layout. Full history is navigated with the existing keyboard controls; this
batch does not append every Rust event permanently into native scrollback.

- `/tui inline` opens Rust inline from Node, or switches a running Rust view.
- `/tui fullscreen` (also `/tui full screen`) selects Rust full-screen.
- `/tui default` returns to Node. Bare `/tui` inside Rust retains its accepted
  return-to-Node alias; this does not mean switching to Rust inline.
- `BAHULAM_TUI=rust BAHULAM_TUI_MODE=inline` starts directly in inline. Recovery
  startup was full-screen at this batch; the startup/performance correction
  below now defaults Rust launches to inline.
- Inline requires a terminal cursor-position reply; unsupported terminals
  fall back to full-screen. Mouse capture remains disabled in inline for native
  text selection. Existing opt-in wheel navigation remains full-screen only.
- Inline exit does not dump its transcript a second time. Alternate-screen
  restoration only runs if this process actually entered that screen.

The real Rust/host PTY test (`npm run test:tui:inline`) verifies a folded reply,
Enter/End to the last detail line, Esc back to the unchanged draft, switching
inline/full-screen/inline, subsequent prompt handoff, terminal-mode restoration,
and no duplicate transcript dump. `/tui inline` adds only a view-launch option
to Node's existing dispatcher/catalog; no Node rendering code is changed.

Validation passed: 19 Rust tests, seven command/snapshot cases including
repeated Node/inline handoffs, inline details/resize/layout switching, popup
and mouse PTY tests, 13 command-catalog checks, and the original Node
startup/resume regression. The cache was cleared and Rust rebuilt. Tests use
fixtures; live model/provider acceptance and the audited event gaps remain.

The live-event, identity and historical-control gaps from that checkpoint are
addressed in the following batch. Remaining job/approval features stay separate.


## Reviewed batch: event parity and historical control isolation

This batch changes shared event production/projection and Rust presentation.
It does not change Node rendering, slash-command implementations, model request
assembly, or the default renderer. Both Rust layouts consume the same model.

- Gateway tool completions retain call ID, arguments, complete output, success,
  exit code and measured duration. Thrown executor errors remain failed results.
- Graph/node identity is stable across start, inner events and completion, and
  distinct across graph runs. Explicit agent/run IDs remain authoritative.
  Child completion does not end the main turn. Background tool results retain
  their originating turn after the main turn ends. Events with no usable
  identity remain explicitly unattributed; identity cannot be inferred reliably.
- Status, phases, delegation, sub-agent tool metadata, compaction, changes,
  goals, follow-up acknowledgements, pause/resume/cancel, graph lifecycle and
  approval decisions now cross the bridge. Progress updates coalesce by turn,
  agent and category; failures remain separate. Thinking and check results
  render compactly and retain full detail. Sub-agent internals remain in their
  agent view, with final reports in the main conversation.
- Cancelled turns close their unfinished tool/message cards; missing results at
  normal completion are marked incomplete, never fabricated as successful.
  A main turn ending does not close background agents' tools.
- Historical approval requests/decisions are inactive display data. Saved
  pickers, catalogs, session-state updates, detail responses and nested snapshots
  cannot take control. Historical and live tool/message/approval keys are
  separate, even when IDs match. Snapshot chunks preserve the live sequence
  and produce one header. Saved resume progress bars are removed from command
  previews/details while the recovered conversation remains intact.
- Projection deep-copies payloads before handing them to display subscribers,
  including when persistent logging is disabled, protecting canonical arguments.

Verification: 24 Rust tests; five focused producer/bridge regressions; 34 asserted
projection-to-Rust replay cases; generated protocol and cache/request invariance;
real CLI command/handoff tests (7 cases); inline and resume-popup PTY tests;
13 slash-catalog checks; unchanged Node startup/resume regression. Cell-buffer
checks exercise thinking, check results, tools and code diffs in both layouts,
including details and draft preservation. PTY tests exercise scrolling details,
resize and clean terminal restoration. No paid model session was used.

### Release requirements reviewed against both PRDs

Sources: PRD-121 sections 4–7 and its acceptance order, plus the terminal UI/UX
guide's tool cards, approvals, agent tree, thinking/progress, end-of-turn summary
and phased acceptance sections. Later-branch implementation claims in those
files are not proof that a feature exists on recovery.

| Requirement | Recovery status / next reviewed batch |
| --- | --- |
| Tool/result and agent correlation; missing event display; historical isolation | Implemented and tested in this batch; live acceptance still required |
| Full history, compact details, scrolling, view switching | Fixture/PTY coverage passes. Inline uses a bounded pane, not an unlimited native scrollback transcript. Full-screen retains the agent panel/drilldown. |
| Approval scopes, multiple pending approvals, hold, model control | Selective backport and live tests still required; historical isolation alone does not close this gate |
| Shell output while a command runs, jobs/background controls and elapsed time | Still requires producer/integration work; the audit tests output deltas only when emitted |
| Tool preview limits/read grouping, timed thinking, richer turn summaries | Guide refinements remain; current compact cards are not complete visual-spec parity |
| Full tool-detail retention across renderer detachment and long sessions | Still pending; transient payload eviction and message-only reopening must be addressed |
| Bounded transcript memory, incremental Markdown, 1,000-tool latency/memory/flicker | Still pending implementation/measurement; passing functional tests is not performance evidence |
| Clipboard/editor/notifications, mouse click actions, capability probes | Remaining selective integration work and OS/terminal acceptance |
| Crash/signals/pipe closure, hostile output, real provider-cache readings | Automated coverage is partial; live acceptance matrix remains open |
| VS Code/iTerm2/Ghostty/Windows Terminal, SSH/tmux | Live matrix remains open; local PTYs do not establish cross-platform acceptance |
| Rich artifacts/browser workspace, retiring Node/default flip | Deferred until the earlier gates close; Rust remains opt-in |

Live test this batch in Rust inline and full-screen: resume a transcript with
old approvals; submit a prompt that reads and edits a fixture file and runs a
failing check; inspect compact results and their final detail lines; interrupt
a running tool; switch views and submit another prompt. Old approvals must
never reopen, results must remain attached to their tools, and only the intended
agent should receive each event. Review one subsequent feature batch at a time.

## Recovery correction: shared session identity and real history scrolling

Live testing exposed failures beyond the earlier fixture checks. The first
prompt was saved under a local UUID, then `session_info` changed the writer to
a backend UUID. Resume could therefore find a prompt-only transcript while the
reply/tools existed in another file. Rust additionally replayed `turn_started`
as a second copy of the saved prompt, and replayed prior `/resume` output.

The shared reader now follows explicit durable backend links and JSONL
`parentUuid` relationships. It merges records in timestamp/order sequence,
deduplicates UUIDs and bounds/cycle-checks link traversal. Picker identity comes
from the actual filename; linked fragments are not listed as duplicate sessions. It does not rewrite
or repair the original files. All views read this same recovered conversation.
Future turns keep a stable local transcript identity while backend transport
identity is tracked separately. The JSONL record format is unchanged.

The resume context estimate counts canonical message payload bytes, excluding
replay telemetry and repeated resume metadata. It is an approximate transcript
size, not a provider-measured total including system prompts/tool schemas.
Repeated resumes no longer inflate this estimate merely by appending metadata.

Rust always includes saved assistant replies, even with sparse replay events.
Within each turn it removes already represented text events, duplicated prompts,
and past view/resume commands. Successful resume replaces the transcript without
adding an empty command-result card. Saved thinking is inactive. Node's visual
renderer and command implementations remain unchanged.

Mouse/trackpad capture now defaults on in both Rust views. Scrolling uses painted
rows rather than guessed card counts and respects the actual inline viewport.
The complete saved history remains reachable; Ctrl+N/P still focus cards and
Enter opens details. PageUp/PageDown work from the composer without losing the
draft. `BAHULAM_TUI_MOUSE=0` explicitly restores native terminal wheel behavior;
native text selection while capture is enabled uses the emulator's override
(often Shift-drag). Inline still uses a bounded viewport, not an unlimited native
scrollback copy. An empty inline block title was also removed because it reserved
a row and hid the last Show details action.

Validation includes 24 Rust tests; replay/analytics/context regressions; real
mouse tests reaching oldest/newest history in both layouts; inline details,
resize and view handoff; and seven real CLI command/handoff cases. The new
`scripts/test-tui-resume-stability.mjs --session ID` copies an explicitly selected
session and its linked files into an isolated home, then resumes repeatedly in
inline, full-screen and Node. Both reported sessions passed with stable picker
estimates and byte-identical reconstructed agent histories. No model call or
original-file mutation is involved. One showed a rounded 2k transcript estimate,
the other 11k; neither is a measurement of complete runtime/provider context.

### Next full-screen direction, after live acceptance

The local OpenTab and CodeBurn references demonstrate a read-only session model
with tree navigation and drill-down panels. Adapt that interaction pattern while
keeping Bahulam's conversation renderer and command/agent handoff shared:

- Center: existing chronological messages, compact tool results, diffs and details.
- Agent tree: stable parent/child rows, activity, current tool, elapsed time and
  usage; selecting a row filters its transcript without replacing the session.
- Inspectors: Tools, Changes, Context and Usage, opened on demand so they do not
  compete with conversation space. Label measured usage versus estimates.
- Same composer, approvals and pending instructions across layouts; switching
  panels or views never modifies messages, context or JSONL.

This is the next design direction, not a completed dashboard backport. Keep the
session/resume correction as a separately live-tested recovery batch.


## Startup and performance correction (current review batch)

`BAHULAM_TUI=rust TARANG_ENV=local node src/terminal/main.mjs` now starts
Rust inline. `/tui fullscreen` explicitly selects the workspace; `/tui inline`
returns to the compact Rust view. `/tui default` still returns to the original
Node view. Without the Rust opt-in, startup remains Node. Explicit
`BAHULAM_TUI_MODE=fullscreen` still overrides the Rust startup default. Inline's
existing cursor-position fallback remains: terminals that cannot report their
cursor position use full-screen.

The startup ownership correction suppresses both the early Node dock mount and
the later initial Node prompt paint when a Rust handoff is known. Detach or a
missing Rust binary restores Node's dock and prompt. Plugin/MCP initialization
still belongs to Node; no Rust command or plugin reimplementation was added.
The existing raw-paste fix from `7cd8933` was adapted: strip one trailing Enter
before classifying a chunk as multiline. Buffered `/help`, `/resume`, and ordinary
single-line submissions must execute; actual multiline and bracketed pastes
remain editable. Node's visual renderer is unchanged.

Two measured sources of full-screen slowness were corrected:

- The live loop rebuilt a frame every 50 ms without any changes. It now paints
  after input, resize, focus restoration, or an incoming event. A separate render
  revision covers control frames and snapshots that reuse/reset protocol seq.
  Follow mode finds its last matching card without allocating the entire index
  list. Polling for new core events retains the existing 50 ms maximum interval.
- After scrolling, every key rebuilt Markdown and wrapped all preceding cards.
  A bounded measurement cache now skips off-screen cards by their row heights.
  It stores hashes and counts only (at most 65,536 entries), not duplicate text.
  Card contents, details, width and expansion participate in its identity.
  Visible rows retain the same renderer and formatting.

`scripts/test-tui-idle.mjs` uses the real debug binary and host in a synthetic
140×40 PTY with 1,000 messages of 31 lines each. Local observations:

| Check | Before correction | After correction |
| --- | --- | --- |
| Idle terminal writes over two seconds | 962 bytes | 0 bytes |
| First page back | 405 ms | 155 ms |
| Subsequent page back with cached measurements | Not measured | 18 ms |
| Command/popup response while scrolled back | 1,484 ms | 117 ms |

These are local observations, not release performance guarantees or a real
terminal matrix. First-time measurements, very large expanded cards, details
rendering and replay-file watch still have additional optimization opportunities.
The regression test also sends a control frame with a reused seq. Tests cover
cache invalidation after streaming, resize, folding and replacement, plus its
fixed size limit. Actual CLI checks now send Node commands in whole chunks;
they no longer pace keystrokes to conceal the paste bug. The startup checks
assert no Node prompt precedes Rust, and cover implicit inline startup.

Validation completed: 26 Rust tests; input/paste, request-invariance and resume
unit checks; actual CLI command/startup/Node-fallback paths; inline details,
popup resize and mouse navigation PTYs. The reported session
`0064bd09-e1bf-4b83-9fa3-ce53e328fbde` was copied into an isolated test home:
repeated inline/full-screen/Node resumes preserved canonical messages and its
1,818-token transcript estimate (picker: 2k). Original session files were not
modified, and no model request was sent. Live terminal acceptance remains next.

### Remaining backports against the PRD and experience spec

The audit describes features from the original later branch. Recovery deliberately
started earlier and has not wholesale imported `b37c586`/`7cd8933`. Missing
clipboard/capability/open-target modules are deferred backports; their original
source remains preserved on `fix/daemon-lifecycle-and-ci-guards`. The PRD's earlier
implementation checkmarks do not establish completion on this recovery branch.

After live acceptance of this batch, review capability detection and diagnostics
as the next foundation, then clipboard/editor handoffs, file/OSC 8 opening and
notifications as separate functional batches. Preserve Node command ownership,
historical approval isolation, session identity and the shared transcript reader
through each merge. Scoped approvals and remaining lifecycle controls still need
review. Image protocols, bounded transcript retention/incremental Markdown, richer
agent navigation and the real VS Code/iTerm2/Ghostty/Windows Terminal/tmux matrix
remain release work. No parity or release-ready claim is made by this batch.


## Approval handoff and full assistant messages (next reviewed batch)

The screenshot exposed a backend `approval_required` frame using `tool` and
`tool_id`, while the renderer expected `name` and a local `apr_id`. Such a frame
is now normalized for display but cannot become an actionable Rust prompt without
its local approval handle. More seriously, Rust's old remote-only interception
bypassed `ApprovalManager.check()`. This unnecessarily asked about read-only
`bahulam_info`, which Node already auto-approves, and bypassed other shared policy
checks. Rust now replaces only the manager's prompt presentation. The same Node
manager still classifies tools, enforces plan/safety restrictions, checks trust,
applies decisions and records audit history. Node's own prompt renderer is unchanged.

The Rust adapter serializes concurrent prompts, uses the existing pending-approval registry and
rejects stale IDs or unoffered scopes. Socket/mobile/timeout decisions still
resolve the same pending request as the Rust keys. Its composer panel shows tool, risk,
working directory, argument preview and reason. `[1]` allows once, `[2]` denies;
additional numbered actions mirror the choices Node offers (similar shell calls
for this session, or this tool for this session). It does not invent a project
trust option when Node doesn't offer one. Inspect the approval card using Tab and
Enter; Escape from details returns to approval controls. Missing stored arguments
must be loaded before approval. Cancellation/renderer closure denies pending
choices; historical approval frames remain inactive. Large-argument metadata
retains the allowed scopes when the full payload is stored separately.

Per the user's updated rendering requirement, full user/assistant messages and
sub-agent messages/reports stay in the conversation in both Rust layouts. The
six-line assistant preview is removed. Scrolling reveals the complete reply;
Enter no longer opens a separate details overlay for a message. Tool/command,
check, diff and other operational cards retain compact previews and details.
Stored assistant payloads hydrate automatically instead of requiring a click.
The existing 2 MiB loaded-detail display cap still applies. Inline remains a
bounded viewport with history navigation, not a duplicate native scrollback dump.

Validation: 27 Rust tests, Node's existing 17 approval tests, seven new policy/queue/
request-identity regressions, the existing socket approval relay test, generated-protocol checks and request-invariance
checks. A real Rust/Node PTY test exercises read-only auto-approval, scoped approval,
denial and automatic assistant hydration in both views. CLI command, resume and
handoff tests pass, as do command details, mouse and popup/resize tests. No actual
tool executes and no model call is made in the new approval fixture. Full-message
cell tests reach every line of a 200-line reply, both streaming and finalized.
The larger 1,000-message fixture now measures full rather than folded assistant
messages: zero idle writes, about 466 ms first measurement, 18 ms subsequent
page-back and 122 ms command/popup response locally. This is a changed workload;
it is not directly comparable to the preceding folded-message measurements.

This batch addresses approvals and conversation rendering. Capability/clipboard/
editor/OS/image integrations and real-terminal acceptance remain separate work.
