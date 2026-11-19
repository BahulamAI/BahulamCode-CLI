# Rust terminal recovery review

## Backport completion checkpoint — 2026-11-17

The selective backport pass from `16ac966..3e16f9e` is complete on
`recovery/rust-tui-staged`; the runtime checkpoint is `db4ae50`. Every original
commit has a disposition below. There are no unreviewed commits left in that
range to cherry-pick. The following PRD work is separate from this source-commit
queue, and Rust is **not release-ready**.

The existing TypeScript release remains live. Package version stays `0.2.1`;
no publication or version bump was performed. Node still owns commands, agent
execution, tools, approvals and sessions. Rust owns terminal presentation.
Shared adapters were backported; the existing Node visual renderer was preserved.

| Original source | Final disposition |
| --- | --- |
| `8112157` | Protocol/golden fixtures and request/cache invariance retained; bounded-pipe and process recovery tests now restored. |
| `5c04734` | Shared model commands, policy-owned approvals, mouse and diagnostics adapted. Recovery's stronger approval bridge supersedes the original duplicate trust path. |
| `7e81afb` | Shared `/new` and `/clear` behavior retained. The original Node redraw/scrollback rewrite is intentionally excluded under the user's Node-renderer constraint. |
| `377dd2d` | Background job state/subscriptions, same-process shell promotion, live timing and check results restored. Historical tools do not acquire live timers or control handles. |
| `b37c586` | Clipboard/copy picker, history/search/editor, settings/setup/completions, file/link opening, notification/focus/shell integrations, Windows pipe adapter, recovery/backpressure, status customization, bounded Markdown/tool previews and artifact metadata adapted. Renderer replacement and read-only-tool coalescing are superseded by accepted individual cards, spacing, ordering and inline details. |
| `7cd8933` | Startup ownership, paste classification, stable session identity, resume picker, shared questions/free text/cancel, slash dropdown, caret placement/navigation, paste chips and attachment references restored. Recovery viewport geometry remains authoritative. |
| `3e16f9e` | Historical controls remain inert; accepted resume reconstruction, message ordering and inline exit-output suppression retained. This source did not solve retention across detach; that remains PRD work. |

Additional intentional adaptations:

- Typed commands retain their exact text through the shared `prompt` handoff;
  `run_slash` and `switch_model` adapters are also available. The original
  whitespace-splitting command rewrite is not required for command parity.
- Queued follow-ups use a status count. They become transcript messages only
  when the core starts their turn, preserving the final-answer ordering fix.
- File lookup runs on explicit Alt+O/Alt+L actions away from the input loop;
  automatic filesystem scanning on every frame was not restored.
- Protocol names such as `set_mode`, `rewind` and `open_item` did not have working
  host implementations in the original source. They are not missing backports;
  any expanded control contract must be specified and validated in PRD work.
- Environment/profile capability hints and overrides were restored. They are
  not active capability probes or evidence of native terminal acceptance.

Completed recovery commits in this pass:

| Commit | Batch |
| --- | --- |
| `a647228` | Shared questions and picker ownership |
| `524a28e` | Renderer crash recovery, bounded pipes and process lifecycle |
| `fee2480` | Background jobs and live tool timing |
| `462f522` | Strict Rust lint gate |
| `99843b6` | Composer completion, navigation, paste chips and attachments |
| `cd126bb` | Presentation settings, completions and terminal setup |
| `ca85fa1` | OS integrations, copy picker and status controls |
| `268ca1b` | Display-copy isolation and stable session identity |
| `db4ae50` | Remaining render/status/stream refinements |

Validation at this checkpoint:

- 54 Rust tests pass, including cell-buffer/replay, ordering, Unicode geometry,
  complete assistant hydration, historical approval isolation, streaming limits,
  artifact metadata, queued follow-ups and cache state/palette isolation.
- Formatting, strict Clippy, generated-protocol checks, request/cache invariance,
  capability reporting and Node-to-Rust round trips pass.
- Ten real CLI cases pass: startup, resume, diagnostics, missing-binary fallback,
  return to Node, and re-entry into either Rust view.
- Unix PTY suites cover both Rust views, resize, scrolling, inline expansion and
  collapse, input recovery, approvals, questions, clipboard/editor, resume popup,
  fake OS helpers and idle writes. CI now runs these on Linux/macOS; Windows
  retains compile/replay/capability checks pending native live acceptance.
- The full Node runner reports **86 passing files, two failing files, eight
  explicitly skipped files**. The failures are `test-terminal-rendering.mjs:275`
  (shell preview ellipsis) and `test-code-cards.mjs:93` (scoped command/cwd text).
  Both reproduce with the same assertions in an isolated `ef58ed2` checkout.
  They were not hidden, skipped, or fixed by changing the Node renderer. Thus the
  full CI suite is not green, despite the Rust/backport gates passing.
- The new CI workflow has been added locally; a remote CI run and real emulator
  acceptance have not been claimed.

## Palette preview after checkpoint `9c0def8`

The current fixes are committed at `9c0def8`. The next visual preview lightens
dark-theme accents: tool names `#94AFFF`, links/code `#80D8FF`, success ticks
`#70FFAD`, failures `#FF8597`, warnings `#FFDD80`, and details actions `#CED6E0`.
Success ticks remain plain, with no background box. Light, ANSI, high-contrast
and NO_COLOR behavior retain their existing contrast/fallback rules. This palette
preview changes no interaction, resume or expansion behavior.

Agent-message emphasis uses context-specific color in dark mode: headings
`#00BFFF` (neon blue), sentence emphasis `#32CD32` (green), bullet/numbered-list
emphasis `#FF9F1C` (orange), and italics `#DAA6BB` (muted rose).
Markdown strong emphasis uses color without bold weight; headings remain bold.
Body text remains neutral; inline code keeps ice blue. Light mode uses darker
equivalents, and limited-color/NO_COLOR rules still apply. Bullet items now use
inline bold, italic and code formatting; numbered lists preserve their markers.
List markers are inset four spaces from prose. Wrapped rows align with the item
text after the marker, preserving emphasis/code styles and recalculating the
hanging indent at the current viewport width.

The following composer adjustment uses two editable rows at rest in both Rust
views. Typed newlines and soft wraps grow it to six rows, subject to terminal
height; longer drafts scroll internally to keep the caret visible. Ctrl+J inserts
a newline and Enter submits. Existing paste chips summarize pastes over 20 lines;
Ctrl+O expands them, while submission restores the complete content. Both-view
PTY tests now verify a 1,000-line paste reaches the prompt handler intact in
collapsed and expanded form, and cell-buffer tests cover its caret after resize.

## Checkpoint: links, viewport anchoring and palette

The user confirmed resume/history and mouse expansion/collapse at the backport
checkpoint. This batch preserves those routes and addresses the subsequent
viewport jump: expansion previously moved the selected card to the top. Mouse,
Enter, Esc and expand-all now retain the top visible card/row and expand below.
If collapse removes that exact row, the collapsed card becomes the anchor.

Rust tool names use the requested workspace primary `#303BA0`; browser links
and inline code retain light blue. Show details/Show less use lighter grey
without bold emphasis. Success checkmarks have no background box or redundant
`done` label. Denied/rejected states use `#FFB0B6`, and failed/error statuses use
`#AD363F`. Exact RGB applies to true-color normal themes; limited color terminals
use approximations, and high-contrast/NO_COLOR remain supported. Shared Node
tokens do not override these Rust roles; Node rendering stays unchanged.

At the user's request, the previous tool-details presentation is restored:
compact saved previews, with Show details whenever a separate/full stored result,
extra lines or truncated text is available. Expansion shows the complete readable
result inline; Show less/Esc collapses it without jumping the viewport. The
subsequent actual-result normalization and three-changed-line diff preview were
reverted. Commands such as `/status` and assistant replies remain fully displayed.
Completed tools still clear prior argument details before loading result payloads.
Older JSONL `tool_done`/`tool_result` records also preserve string or structured
`result` values as full output. They must not be reduced to a string-only summary,
which can make a resumed result look empty and remove its Show details action.
Repeated-resume tests exercise both result/output shapes in both Rust views.

Resume listing now passes the current working folder into the shared session
reader. Directory discovery is scoped before parsing JSONL; recorded cwd is
checked too because different paths can produce the same directory slug. Child
folders and other folders with the same name are excluded. Empty folders return
an empty list instead of falling back globally. Linked transcript fragments
within the project remain merged. This applies to both Rust views and the shared
command path; the Node visual renderer is unchanged.

The earlier global scan measured 293 sessions across 34 project paths in 8,342 ms.
After filtering, a local measurement returned 25 current-folder sessions in
1,326 ms. These are single-run measurements, not startup latency guarantees.
Tests cover cross-folder exclusion before transcript reads, slug collisions,
linked fragments, limits, trailing separators, cwd changes and empty folders.

Dragging within either Rust conversation highlights the painted text in black
on white and copies the selected range on release through the existing clipboard route (native on
macOS/Windows/Linux when available). The selection freezes its frame while core
events continue. The highlight remains after release; Esc, a new click, typing,
scrolling or resizing clears it. The footer reports the copy result. A drag never opens a
browser link. Selection is limited to the visible conversation, excluding the
composer and agent sidebar. Alt+M remains available for native terminal selection.
Markdown browser links render as an underlined label and destination, without
raw Markdown punctuation. Both this text and bare URLs are click targets; wrapped
pieces retain the correct destination, including repeated labels. These clicks
do not require OSC8 support, so the same route works in macOS Terminal and VS Code.
Same-cell held-button motion remains a click; crossing a character cell starts
selection and cancels link activation. URLs in inline code and emphasized text
also retain their click targets. Immediate browser-opener failures are reported
in the footer rather than silently treated as successful launches.

Browser decoration now uses SGR 4:4 dotted underlines on target text only, with
no underline on action prefixes or trailing cells. Terminals control how unsupported
underline styles fall back. Hover emphasizes the target without opening it;
OSC22 hand pointers are enabled for Kitty/Ghostty (CSS names) and iTerm2 (X11
names), with resets on leave/handoff/exit. Other profiles, including macOS Terminal
and VS Code, retain their native mouse shape and use the visual hover cue.
Repeated motion over the same target does not request another redraw.

Thinking cards now represent chronological phases per agent and turn. Tool or
assistant activity ends the current phase; subsequent thinking starts after it.
Iteration-only processing notices replace the previous iteration in that phase;
actual reasoning chunks remain intact and separate. Completing or cancelling a
turn closes the active indicator without rewriting earlier completed phases.

Alt+M enters native text-selection mode: release mouse capture, show the mode
hint, and pause screen repainting while incoming events continue updating the
model. Alt+M again or another key restores live controls, preserving the draft.
Resize repaints the selection view to fit the terminal. Automated PTYs verify
capture release/restore and zero writes while selected; actual mouse highlighting
and copying remain terminal-emulator acceptance checks.

Assistant messages and expanded tool results expose separate browser Open rows,
with deduplicated HTTP(S) destinations and per-frame hit regions. Alt+L selects
among the focused card's links; Alt+O retains its file/first-link behavior. Source
message/copy text stays complete. Mouse activation requires a press and release
on the same current target; dragging, resize and modal ownership invalidate it.
Supported/configured terminals also receive OSC8 hyperlinks, with full source
URLs and keyboard selection available as fallbacks. OS open runs off the input
loop with a literal argument, never a shell command.

Validation includes Rust replay/cell-buffer checks for clipped/wrapped targets,
resizes, transcript replacement and modal isolation; both-view PTYs cover pinned
expansion/collapse, draft handoff, browser clicks, selection drags and Alt+L with
OSC8 enabled/disabled. Browser tests use fake OS helpers. Actual desktop browser
delivery and emulator acceptance remain live checks. The first active capability
batch is implemented below; profile hints are still distinguished from measured
replies. Graphics and Windows-native query handling remain separate work.

### Active capability batch: terminal modes and diagnostics

Rust now sends one CSI/OSC query batch on direct Unix terminals, ending with DA1,
with a shared 200 ms deadline. It queries synchronized output (2026), focus (1004),
SGR mouse (1006), bracketed paste (2004), Kitty keyboard support, cell/window pixel
geometry, OSC11 background color, and DA1's advertised Sixel flag. This detects support; it does not add
image rendering. No clipboard contents are queried.

The existing input reader owns replies and keyboard events. Startup keys, Unicode,
arrow edits and bracketed pastes are queued for the composer; late replies cannot
become draft text. Query packets are bounded separately from pasted content.
Explicit negative mode replies beat profile hints. A silent terminal leaves the
unanswered capabilities unknown and keeps sync/extended keyboard disabled.
Config overrides still take precedence. Resolved modes are reused across both
Rust views and editor handoff, instead of being inferred again on each entry.

The Node Rust-host adapter caches completed probe results in memory for five
minutes, keyed by terminal identity/version and transport. The cache holds at
most eight entries, never stores terminal addresses in reports or session JSONL,
does not cache timeouts, and drops pixel geometry on reattachment. OSC11 background
color is refreshed on reattachment, in a background-only batch ending with DA1;
stable mode queries reuse the cache. Theme/view/resize reports do not renew the
cache lifetime. The original
Node CLI renderer and command implementations are unchanged.

`/tui doctor` reports measured support, overrides, requested/enabled modes,
fallback sources, completion and elapsed query time. Standalone `--doctor [--json]`
remains read-only/passive and identifies that probing has not run. Non-TTY/plain
output does not query; `TERM=dumb`, tmux/screen and the Windows console backend
skip this active batch. Existing explicit/profile fallbacks remain available.
Set `tui.capabilities.active_probes=false` (or the equivalent
`BAHULAM_TUI_CAPABILITIES` JSON property) to opt out of the startup batch.

Crossterm 0.29.0 needs a small opt-in input-reader extension because its public API
hides these replies and its built-in keyboard helper waits up to two seconds.
The source, MIT license, upstream archive checksum and exact patch rationale are
preserved in `rust/vendor/crossterm/BAHULAM-PATCH.md`. The Windows reader is unchanged.

Validation: Rust tests and Clippy; `npm run test:tui:capabilities` exercises both
Rust views with simulated positive/negative, fragmented, late and oversized
replies, silence/deadline, input preservation, overrides, disabled/dumb/transport
fallbacks, cached reattachment and raw-mode cleanup. Existing inline, presentation,
browser, Node-host and protocol regression checks remain required. These PTYs are
not native emulator acceptance evidence.

### Background detection and explicit theme choices

OSC11 shares the original 200 ms total startup budget. Its bounded decoder uses
the same input reader as CSI replies and supports BEL/ST terminators and replies
split across reads. It preserves ordinary Escape/Alt+] input with a 25 ms prefix
timeout; oversized packets are discarded and torn packets cannot hold the reader
indefinitely. Existing key/mouse sequences and bracketed paste bypass OSC framing
once their packet has begun. No terminal colors are changed by the query.
Readiness is checked before every additional tty read: an incomplete reply must
not turn the inherited blocking stdin into an unbounded wait. Partial CSI replies
also expire and yield to control keys. PTYs cover incomplete OSC/CSI packets
without a sentinel, standalone Esc selection/detail controls, and OSC-looking
text inside a paste (the existing composer control-byte stripping still applies).

Automatic themes use the reported RGB background to choose dark or light text
for contrast. `BAHULAM_THEME` or `tui.theme` choices of `dark`, `light`,
`high-contrast` or `ansi` remain authoritative; `auto` selects detection. The host
marks its inferred appearance separately from explicit configuration. `/theme`
changes the current Rust view immediately and remains authoritative when switching
views; `/tui doctor` reports the current theme, source and observed background.
Missing/invalid responses preserve the host's appearance hint or the dark default.
`tui.capabilities.background_color=false` disables this query; `NO_COLOR` still
disables styling regardless of the selected theme.

Validation adds both-view white/dark detection, explicit-theme precedence,
background opt-out, fragmented prefixes and terminators, invalid/oversized/torn
replies, late replies, theme/view switching and changed background on reattachment.
The query format follows the [OSC11 dynamic-color protocol](https://ghostty.org/docs/vt/osc/1x).
Real emulator acceptance remains required.

Still pending: Kitty/iTerm image negotiation,
Windows-native and multiplexer probing, and real Mac Terminal/VS Code/Ghostty/
iTerm2/Windows Terminal acceptance. OSC8/OSC52 remain explicit/profile decisions
where reliable support queries are unavailable. Rich output and long-session
performance are the following workstreams; no release is claimed by this batch.

### Browser link authoring and presentation

Agents use ordinary message text: `[Open dashboard](http://localhost:3000)` or
a bare absolute HTTP(S) URL. Markdown labels become the Open action's label;
bare URLs use the destination itself. No Rust-specific prompt, tool call or
terminal escape sequence is required. The renderer extracts destinations from
the same stored message, so both Rust views use the same presentation path.
An existing `artifact_created` event can also carry `open_url` for a structured
artifact destination; ordinary reply links do not require artifact events.

For example, the message `[Open dashboard](http://localhost:3000)` gains an action
row `↗ Open 1 · Open dashboard · http://localhost:3000`. Clicking it opens the
system browser; Alt+L offers destinations from the focused card. Tool results
expose link actions when fully visible or expanded. Rendering a link never opens it
automatically or verifies that its server is running. Agent/model instructions,
commands and canonical JSONL messages stay unchanged.

## Sub-agent presentation and navigation batch

Both Rust views now show a stable agent list with parent depth, task, status,
current tool, elapsed time and reported token/cost values. Inline automatically
shows active workers; Alt+A opens the list after completion or resume. Up/Down
and Enter, or a normal row click, open the worker transcript. Esc returns to the
main conversation's saved scroll anchor and draft. Rows retain start order;
overflow uses a bounded window with earlier/more counts. Resize recalculates
row hit targets from the painted frame.

Worker internals stay in their own transcript. Final reports remain full messages
in the main conversation and are also available inside that worker's transcript.
Large reports automatically hydrate their complete payload. Failed reports retain
the reported error and last tool; missing tool results become incomplete rather
than fabricated failures or successes. Historical approvals remain informational,
and resumed worker clocks do not start running again.

The shared event projection now preserves available duration and scalar token
counts even when a large report uses a payload reference. Status-only updates no
longer erase previous usage. Worker usage does not overwrite session totals.
The approval adapter forwards supplied worker/parent identity through its existing
queue and decision registry. Stream-client and ApprovalManager changes only carry
that identity to the Rust prompt adapter; Node rendering, policy and execution
remain unchanged. An approval arriving during worker inspection takes input focus.

Validation: Rust model/render tests cover interleaved workers, reused tool IDs,
concurrent calls within one worker, complete reports, usage updates, nested replay
identity and historical approval isolation. `npm run test:tui:agents` exercises five
workers in real Unix PTYs in both views, including row click, keyboard navigation,
resize, saved main anchor/draft, worker approval IDs, success/failure reports and
resume. Protocol/cache-invariance and real approval-policy tests cover the shared
bridge changes. Native terminal acceptance still needs the user's live run;
producer coverage and agent-summary UX remain release work.

## Next batch: end-of-turn summary foundation

Rust now adds an operational summary for turns with successful edit operations,
reported diffs, or more than five tool calls. It lists observed file targets,
check results and unresolved tool calls, and suggests `/diff` after edits.
Absent check evidence is explicitly reported rather than treated as verification.
Short successful turns produce no empty completion card; producer-supplied
completion text remains available. This changes Rust presentation only.

This is the summary foundation, not full summary acceptance: exact aggregate
line changes, per-turn/per-agent token deltas, complete multi-file patch target
metadata and editor-opening actions still need a separate reviewed batch.

## Rich output batch 1: document/artifact metadata

Document cards now show readable formats, supplied page counts and file sizes,
and validated `pages_read` ranges. Missing reading progress is labeled unknown;
an empty reported list means no pages read. Image metadata can show supplied pixel
dimensions. These are metadata cards, not terminal image thumbnails.

A supplied web target uses the existing clickable browser action; local targets
advertise Alt+O and Alt+L. Missing targets no longer claim they can be opened.
Office documents, slides and spreadsheets use the system viewer instead of the
configured code editor. No files are opened or fetched during redraw.

The existing artifact event contract accepts optional pages_read/width/height.
Producers must supply reading metadata; the renderer does not infer it from prose
or claim the agent read a document solely because an artifact exists. Real native
viewer validation remains part of the OS matrix. Next rich-output batches cover
thumbnail decoding/layout, graphics transport and diagram rendering.

## Rich output batch 2: portable image and flowchart previews

`npm run tui:rich-demo` opens a local, model-free fixture containing a PNG,
a PDF card and a Mermaid flowchart. `/tui inline` and `/tui fullscreen` switch
layouts; normal scroll, resize, draft input and Ctrl+C twice apply.

PNG/JPEG/WebP artifact paths decode off the UI thread, one at a time, with a
16 MiB input limit, 4096-pixel dimension limits and an 80 MiB decoder allocation
budget. Each card retains a small thumbnail; at most 64 decoded previews remain.
Eight reserved transcript rows avoid loading-time shifts. Half-block colored
cells follow ordinary terminal scrolling/clearing; color depth is reduced for
256/16-color profiles and NO_COLOR uses monochrome shading. This is the portable
fallback, not Kitty/Sixel/iTerm graphics transport. Remote images are not fetched.

Closed Mermaid fences support a conservative flowchart subset: named nodes,
chains, branches and edge labels, drawn as box/arrow relationships with original
source retained above. Unsupported syntax stays as source. Diagram parsing is
bounded and cached across redraws. Sequence diagrams, SVG/raster layout, native
graphics transport, pasted-image chip expansion, artifact producer coverage and
higher-resolution previews remain separate acceptance work.

`npm run test:tui:rich` exercises all three content types together in both layouts,
including narrow/tall resize, scroll cleanup and draft preservation. Native visual
acceptance still belongs to the user's terminal run.

## Rich output batch 3: sequence diagrams

Mermaid sequence fences now share the cached cell-preview path. The supported
subset includes explicit/implicit participants, actor declarations, aliases,
plain autonumber, solid `->>` calls, dashed `-->>` replies and self-calls.
Participant columns preserve declaration/first-appearance order. Rendering is
bounded to six participants and 64 messages; narrow layouts or unsupported
constructs retain the complete source without an inaccurate partial preview.
Loops/alternatives, activation bars, notes and additional arrow types still
require further Mermaid work. No browser or external Mermaid process runs.

The model-free rich demo and combined PTY test now include a sequence diagram.

## Sequence continuation: notes and activations

Sequence previews now recognize `activate`/`deactivate`, nested activation depth,
and arrow `+`/`-` shortcuts (start the recipient, finish the sender). Active
lifelines use a thick stroke. Notes are boxed annotations explicitly labeled
with their participant names and placement; their placement is described rather
than reproducing Mermaid's pixel layout. Notes do not consume message numbers.
Invalid activation transitions and unsupported/narrow note layouts retain source.
The combined rich demo now includes a read-only tool note and nested agent/tool
activation lifetimes. Loops/alternatives and native graphics remain pending.

## Sequence continuation: decision and repetition blocks

Sequence cell previews now show nested `alt`/`else`, `opt` and `loop` groups
with explicit labels and boundaries. A fixed group gutter keeps participant
lifelines aligned across nesting. Notes and activation markers remain inside
their group, and only messages consume automatic numbering.

Nesting is capped at eight levels. Unclosed/orphan blocks, `else` outside an
`alt`, narrow layouts and activation changes that escape a branch/block fall
back to complete source. This conservative subset does not claim parallel
blocks or complete Mermaid semantics. The combined demo now includes a cache
alternative and nested retry loop alongside its document and image cards.

## PRD work after backports

This table supersedes older pending tables below. The historical batch sections
record intermediate states; they are not the current pending-commit list.

| Workstream | Remaining acceptance/work |
| --- | --- |
| Capability detection | CSI mode/keyboard/geometry/DA1 and OSC11 background probing implemented. Graphics, Windows/multiplexer handling and actual per-terminal validation remain. |
| Rich output | Kitty/Sixel/iTerm2 encoders, bounded higher-resolution images, visible-image loading and pasted-image handoff implemented. Sequence previews add parallel/critical/break groups. Real emulator acceptance and unsupported Mermaid constructs remain. |
| Long sessions | Private retained payload cache, cold-text archive, usize scrolling and indexed viewport measurement implemented. Total metadata/RSS is not bounded; cold layout and the 2 MiB detail-view limit remain open. |
| Runtime parity | End-to-end producer/route coverage, including background promotion outside the stream-client route; lifecycle, question routing and support/agent-summary UX acceptance against the PRD. |
| Native integrations | Real clipboard, external editor, file/link opening, desktop notification, focus/keyboard and signal checks on supported OS/emulators; fake helpers establish routing only. |
| Distribution | Platform binaries/packages, release resolution instead of a debug build, protocol/version compatibility, clean-install/upgrade checks and signing where needed. The local npm preview includes native macOS and Linux ARM64 binaries. The manual packaging workflow assembles builds for five targets. |
| Release gates | Resolve the two pre-existing Node test failures without regressing the live renderer; run macOS/Linux/Windows and VS Code/iTerm2/Ghostty/Windows Terminal/SSH/tmux acceptance. |

The external specs' November 15 implementation notes describe the original
branch, not release acceptance for this recovery branch. Start the next phase
from this verified backport inventory rather than importing the old combined
renderer again.

## November 18 completion work: implementation and measured limits

The canonical JSONL remains authoritative and unchanged. A separate private Rust
presentation cache retains large results across detach/reopen (256 MiB disk,
14-day TTL). Reopened truncated events resolve through a session-scoped index;
ambiguous matches are refused. Expired/evicted results are explicitly unavailable.
The cache can be disabled with `BAHULAM_TUI_RETAIN_DETAILS=0`.

Cold completed card text is spooled to a private temporary archive, with a
16 MiB in-memory text target checked periodically. Rendering, copying and late
tool updates read it back. This is **not a hard process memory limit**: active
cards, metadata, indexes and transient detail/copy buffers consume additional
memory. The archive is disposable; canonical history is never rewritten.

Native image encoding uses Kitty, Sixel or iTerm2 where selected, with cell
fallback for unsupported, clipped or narrow views. Automatic selection does not
claim real-terminal verification. `BAHULAM_TUI_GRAPHICS=cells` forces fallback.
Images are loaded on visibility, with at most 64 ready previews and a 16 MiB
pixel target; encoded protocol storage is additional. Ctrl+Shift+V uses the
existing Node `/attach clipboard` handoff and preserves the current draft.

On macOS arm64, the release synthetic benchmark with 100,000 tools / 220,000
events / 120,000 cards measured 2.54 seconds ingestion after replacing the
completion-time transcript scan with a pending-tool index (103 seconds before).
Warm frame p95 was 0.69 ms inline and 0.62 ms fullscreen over 100 frames per view.
Cold layout remained 2.38 / 2.31 seconds. The workload archived 87,602 cards and
retained about 16.0 MiB of body/detail text. These are synthetic TestBackend
measurements, not emulator latency or a peak-RSS guarantee. Reproduce with:

```sh
npm run tui:benchmark -- 100000
```

Protocol/cache-invariance checks prove unchanged Node context/history bytes.
Replay tests cover retained-result precedence and interleaved agent-summary
isolation. Headless Linux Docker testing uses Rust 1.95 and read-only source
mounts; it does not certify native clipboard, graphics or Windows behavior.
Release builds use the tested Rust 1.95 toolchain.

Run `npm run tui:native-validation` in each real terminal to exercise the
model-free rich demo and record explicit pass/fail/unsupported/not-run evidence.
Reports include OS, terminal, Git revision and actual worktree dirty state.
SSH to Linux validates the local terminal's rendering, not a remote desktop.
Windows Terminal and desktop integration acceptance remain outstanding until
those environments run the checks. No release/version bump is authorized here.

## November 19 runtime build and performance measurements

Run `npm run tui:build:runtime` on a build host to stage its release binary
under `native/<platform>-<arch>/`. The npm file list includes this directory.
The host accepts an explicit binary override, uses a debug binary when present
in a checkout, and otherwise loads the bundled executable. The manual
`Package Rust terminal` workflow collects macOS ARM64/x64, Linux ARM64/x64
and Windows x64 builds into a single npm tarball. Local ARM64 Linux builds
used Debian Bookworm. The other platforms still require native runner results.

On macOS ARM64 the 120,000-card workload measured about 1.4 seconds for
first layout after skipping grapheme wrapping on lines that fit. Peak RSS
was 127,434,752 bytes in a separate run using `/usr/bin/time -l`.
This includes both views, caches and indexes. Total resident memory still
depends on card count. A child turn now updates the child agent's lifecycle
independently of its parent. Superseded Rust resume snapshots stop sending
chunks when a newer snapshot takes over, including within the same session.

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

## Inline screen sizing and resize correction

Live testing exposed the old 16-row inline viewport: on a tall terminal it left
the composer midway down the screen and showed only a few conversation rows.
Inline now uses the whole normal screen. Startup output scrolls into the terminal's
scrollback before drawing, and the composer no longer repeats the Bahulam heading.
The message input, status and hints remain at the bottom; conversation content uses
the space above them. No alternate screen is entered for inline mode.

This replaces the cursor-anchored `Viewport::Inline(16)` geometry with Ratatui's
full-terminal geometry on the normal screen. Alternate-screen ownership remains
an explicit, separate action for `/tui fullscreen`. Inline consequently no longer
needs a cursor-position query or falls back to the workspace when that query fails.
Resize updates geometry in place, follows the tail when following output, and
otherwise anchors the visible card plus its row offset (clamped when the new
screen has more room). It retains the input draft. Inline input uses its actual
single top border for cursor/wrapping calculations; narrow footer hints shorten
to keep the exit key visible.

The new normal-screen PTY regression visits 120×40, 150×56, 60×20 and 100×36,
checks that more than 40 reply lines become visible in the tall layout, scrolls
to the oldest/newest content around resizes, preserves the draft, and verifies
the input/footer remain at the bottom and startup heading leaves the screen.
Existing command, approval, mouse, details, popup and view-handoff checks also
pass. This remains application history navigation with a pinned composer;
it does not print a second full transcript into native scrollback.

## Terminal capability diagnostics backport

Adapted the environment/profile reporting portion of preserved commit `5c04734`.
`/tui doctor` runs through the existing Node command dispatcher and displays the
active Rust renderer's report as a command card, with the complete report in
details. Rust sends this information using the existing protocol `hello` command
at attachment, view changes and resize. Returning to Node clears the report so
it cannot describe a renderer that has already exited. Node's visual renderer and
agent/tool command execution remain unchanged.

`rust/target/debug/bahulam-tui --doctor [--json]` also reports diagnostics without
entering raw mode or taking over the terminal. Reports include terminal/profile
hints, locale, transport/multiplexer flags, color selection and, when attached,
view, viewport dimensions, mouse capture and bracketed paste. Hosted rendering
retains Node's canonical color selection and palette; standalone replay uses the
same resolved color level as its diagnostics. Explicit color/mouse opt-outs are
preserved. Only allowlisted environment fields are read; SSH addresses, tmux
socket paths and unrelated environment values are not included.

These are environment/profile hints, not active capability probes. Reports say
this explicitly and distinguish enabled renderer features from pending links,
clipboard, images and notifications. Active queries, response routing/timeouts,
profile overrides and persistent capability caching remain future work. This
batch does not certify support in any real terminal emulator.

Validation: 30 Rust tests; standalone diagnostic CLI tests; protocol and request
invariance checks; real CLI diagnostics/command/view-handoff tests; and existing
inline details, four-size layout, approval and full-assistant-message PTY tests.
The inline round-trip test also checks updated capability reports after resize
and switching views. The 1,000-message benchmark still produces zero idle writes
(approximately 461 ms first page-back, 18 ms warm page-back and 121 ms command
response locally). The debug binary was rebuilt for live acceptance.

Live check: run `/tui doctor` in inline, inspect its details with Tab/Enter, resize,
and run it again. Repeat in `/tui fullscreen`; the report should show that view
and its current dimensions. Use `/tui default` to return to Node. Clipboard/editor
handoffs and OS integrations remain separate reviewed batches after acceptance.

## Usage footer, spacing, palette and clickable details

Checkpoint `f12e67b` preserves the capability-diagnostics batch. This follow-up
fixes the footer's missing connection to Node accounting: Rust receives absolute
usage snapshots at attachment, transcript replacement, model/session changes and
turn completion. Input/output and cost come from the existing Node counters.
On resume, the shared JSONL reader's saved totals form a presentation-only baseline;
subsequent core-accounted usage is added once. Repeated resume/view changes do not
accumulate replay events, and `/new` resets the display. Child-agent usage cannot
overwrite the main session footer. Unavailable fields show a dash, not a false zero.

`ctx ~…%` is explicitly an estimate of the current agent history (UTF-8 bytes / 4)
against the backend model limit or existing CLI fallback. It excludes unsent
system/tool-definition overhead and is not a provider-reported context measurement.
Cumulative input usage, which may include many tool-loop requests, is never used
as context size. Estimated local cost has a `~` prefix. Billing, request content,
JSONL format and the Node visual renderer are unchanged.

Both Rust layouts now have a one-column horizontal content inset in conversation
and input, plus a blank line between cards. Layout measurement, cursor placement
and click coordinates use the same inset. Ordinary text uses the selected palette's
text color; operational metadata remains muted and statuses keep their semantic
colors. Markdown list bullets no longer get mistaken for red diff removals.
Diff cards and fenced diff/patch blocks retain addition/removal coloring.

The details overlay and stored-payload loading already worked with Enter; mouse
clicks were missing. The painted `Show details` label now opens that same overlay
in inline and fullscreen, including while inspecting a pending approval. It
does not approve anything. Escape returns to the conversation with the draft
preserved. Picker modals retain input ownership. Assistant messages stay full;
only operational cards expose details. Mouse capture must be enabled for clicks.

Validation includes Rust model/palette/cell hit-testing, Node usage-baseline tests,
real CLI saved-usage and `/new` reset checks, mouse-click details in both views,
approval/full-message, four-size resize, scrolling and picker PTY regressions.
Protocol generation and request/cache invariance checks pass. Idle rendering still
produces zero writes (approximately 481 ms first page-back, 18 ms warm page-back,
119 ms command response locally). Live emulator acceptance remains required.

### Details return hint and palette follow-up

Details now end with `Esc to return to the conversation`, including empty/loading
results, and retain an always-visible Esc hint in the bottom shortcut row. Agent
reply gutters retain their indentation but no longer draw a vertical bar. The
accepted spacing between cards and around input remains unchanged.

Rust now uses neutral text for Markdown headings, plan/picker titles and code
identifiers; muted bullets; cyan for details actions, inline code and code
keywords; green for strings/success, amber for literals/warnings, and red for
errors/removals. Purple remains on branding and focus/selection accents rather
than coloring most code and headings. This reassigns Rust's use of existing
shared light/dark tokens; Node's palette and renderer are unchanged. Existing
color-depth conversion and no-color behavior remain in place.

Sent user messages, including resumed history, now use the composer's background
tint on their heading and content rows in both Rust layouts. The tint fills the
conversation's content width, including wrapped lines. Existing margins and the
blank separator between cards remain unchanged; assistant/tool cards are untinted.

## Clipboard, editor and prompt-history input batch

Adapted input-only pieces from preserved `b37c586`/`7cd8933` and their later
corrections. No wholesale renderer replacement or changes to Node's commands,
visual renderer, transcript format or agent requests are included.

- `Ctrl+V`: read native clipboard text at the caret. Native reads/writes run off
  the UI loop with a two-second timeout and 5 MiB limit. Changing the draft,
  entering the editor/search, submitting, cancelling, or replacing the transcript
  invalidates a pending paste. Empty/failed reads are reported; they do not
  silently turn into image attachments. `/attach clipboard` and `@clipboard`
  continue to use the existing Node attachment route.
- `Ctrl+Y`: copy the draft when input is focused, or the selected card/details
  when history is focused. Missing full payloads are requested first; the hint
  asks the user to press Ctrl+Y again after loading. Copy never silently takes
  only the compact preview. Markdown/code text is preserved.
- `BAHULAM_CLIPBOARD=auto|native|osc52|file`: auto uses a native helper locally,
  refuses native reads over SSH, and uses a private text file for remote copying
  or when no native writer exists. OSC 52 copying is explicit, with tmux wrapping
  and a 100 KB escape-payload threshold; larger copies use a private file.
  File mode writes an intentional copy artifact with mode 0600 on Unix. Settings
  file overrides are not yet backported; use the environment variable for now.
- `Ctrl+G`: edit with `$VISUAL`, then `$EDITOR`, falling back to vi/notepad.
  Arguments are parsed without shell evaluation. Terminal raw/mouse/paste modes
  are released while the editor owns the terminal, then restored to the same
  Rust view. Successful edits remain drafts; nonzero exit or launch/read failure
  preserves the original. Temporary files are private and removed on return.
  GUI editors need their wait flag, for example `VISUAL='code --wait'`.
- `Up/Down`: recall prompts from the same history.jsonl written by Node and
  restore the current draft/cursor when returning past the newest prompt. Loading
  reads at most the final 5 MiB and keeps 100 entries; Rust does not rewrite it.
  Prompts/commands submitted during this attachment also enter its local history.
- `Ctrl+R`: reverse search; type to filter, Ctrl+R cycles matches, Enter selects
  without submitting, Esc restores the original draft. Existing read-line edits
  now include Ctrl+A/E/U/K/W, Delete, and Alt/Ctrl word movement/deletion.
  Modal questions and approvals retain input ownership. Ordinary approval-time
  typing can no longer change or submit the preserved draft.

The editor return path avoids Ratatui clear's cursor-position query, which timed
out in a real PTY. This correction is limited to the new editor handoff; other
lifecycle/capability query paths remain on the review queue. `/tui doctor` now
reports the restored clipboard/editor/history routes without claiming native
backend or terminal-emulator acceptance.

Validation uses fake clipboard/editor executables with the real Rust/Node PTY
host in both views: prompt recall/search/cancel, no implicit submit, editor raw
mode release, quoted arguments, file permissions/cleanup, failure draft recovery,
full stored-result copying, late-paste cancellation, oversize reads and timeout.
Existing command, resume, approval, scrolling, resize, details, capability and
request/cache-invariance checks remain part of this batch's validation. Native
OS helpers, GUI editors and remote clipboard behavior still need live acceptance.


## Composer geometry, in-conversation details and message ordering

This cleanup supersedes the earlier dedicated-details default. Both Rust views
now expand tool/command/status results in the conversation on **Show details**
click or history-focused Enter. **Show less**, Enter again, or Esc collapses the
selected result. The action and Esc hint appear after its full content; the
footer also explains collapse while expanded. Large stored results use the
existing show_details request and remain scrollable. Alt+Enter retains the
separate detail view as an optional inspection route. Assistant/user messages
remain fully displayed and do not become expandable tool cards.

Structured tool JSON is displayed as labeled fields/lists with readable
multiline strings. This presentation does not rewrite stored payloads or the
raw text copied by Ctrl+Y. A distinct full result remains expandable even when
its compact JSON fits on a single line. Input has a lower border; a single
grapheme/cell layout now drives both painting and cursor position. Spaces,
indentation, tabs, Unicode and physical wrapping survive resizing without the
old mismatch between word-wrapped text and fixed-column cursor arithmetic.

An ordering regression came from keeping one streaming card per agent/turn:
text after tool calls, including the final answer, was appended to or replaced
that earlier card. Rust now ends that segment at the agent's next new tool
card and starts subsequent text after the tool activity. A cumulative final
message contributes only its unseen suffix, preserving commentary without
repeating it. This applies to live events and event replay, including stored
final payloads hydrated after turn completion. Tool completion updates its
original card; concurrent agents retain separate streams. No Node production
code, JSONL contents, agent requests, command behavior or billing is changed.

Validation: 43 Rust tests, real PTY expansion/collapse in both layouts, full
200-line results, draft preservation and resize/view handoff; clipboard/editor
and approval regressions; mouse navigation; ten real CLI command/resume/handoff
checks; and the actual Node event producer → JSONL/sidecar → Rust consumer.
The latter asserts unchanged JSONL bytes and commentary → tool → final reply
order. The large-history idle check still records zero idle terminal writes.
Live terminal acceptance is still needed before the next backport batch.


The user's resume screenshot exposed another presentation mismatch: saved
`tool_done` records contain `success: true, error: null`, but historical
normalization treated the mere presence of `error` as failure. Resume now checks
its value, and tool status follows the live tap's error/is_error, explicit
ok/success and exit-code semantics. Regression cases cover null/false/empty
errors, real errors, nonzero exits and duplicate completion aliases.
An isolated copy of session `9fe4bd85-582b-478b-98c7-55aea1bb1d3d` passed through
the actual Node resume builder and compiled Rust replay: the inspected
list_files/grep/read_file/shell cards show 37 successful and one genuinely failed
operation, rather than all failures. Original JSONL bytes were verified unchanged.


Mouse/trackpad scrolling now defaults to one display line per event (previously
three). `BAHULAM_TUI_SCROLL_LINES=1..20` calibrates conversation and optional
separate-details scrolling in both Rust views; invalid values use one. The
setting is read at renderer startup and reported in `/tui doctor`. Agent-list
wheel navigation and keyboard/PageUp/PageDown behavior retain their existing
steps. The PTY mouse check measures the actual row displacement for the default
and a three-line override, alongside resize, draft and terminal restoration.
Terminal/OS trackpad acceleration can still determine how many events arrive.

## Follow-up: details must release composer focus

Live testing exposed a focus trap: expanding selected the transcript, collapsing
kept that focus, and clicks in the composer were ignored. The earlier PTY flow
hid the problem by pressing Tab before typing. Collapse via Show less, Enter or
Esc now returns directly to the composer, including Esc from separate details.
Clicking the composer restores its focus. Ordinary typing or bracketed paste
from history resumes the preserved draft without losing the first character;
questions, approvals and separate details retain their input ownership.

The dedicated `scripts/test-tui-detail-focus.mjs` uses both real Rust views and
the Node host to assert exact prompt submissions after composer clicks, mouse
collapse, Esc, keyboard collapse, direct typing and paste while expanded.
The existing details/view-roundtrip and CLI diagnostics tests now type directly
after collapse, with no compensating Tab presses. Node production code and
transcript storage remain unchanged.

## Backport: attached questions and picker lifecycle

Adapted `7cd8933`'s `ask_user` routing and free-text picker, retaining Node's
original form when no Rust renderer is attached. Rust handles choices, Other,
Unicode editing/paste, Esc back/cancel and matching host cancellation. The
Node interaction bridge queues concurrent questions, clears timed-out popups,
rejects stale/invalid selections and resolves pending requests on interrupt or
detach. No new stdin owner is installed while Rust is attached. Drafts survive.

Validation: queued/timeout/failure/close unit cases; real Rust/Node PTY questions
in both views with option and free-text answers, paste, cancellation, timeout
and subsequent draft submission; protocol/request invariance; existing resume,
approval and details-focus regressions. Native Node form code below the adapter
is unchanged. This closes the question-transport slice, not the other backports
or the separate PRD acceptance gates.

## Backport: renderer process recovery and transport

Adapted `b37c586` / `3e16f9e`: bounded broadcast and snapshot pipes, failure
callbacks, a bounded sanitized recovery transcript, saved terminal-mode restore,
renderer terminal-ownership reporting, Unix termination cleanup, and the original
Windows inherited-pipe adapter. Shared `/exit`, `/tui default`, approval and agent
question ownership remain intact. Unexpected renderer exit returns to the existing
Node session. No npm version or publishing changes.

Validated the stalled pipe, direct snapshot budget, SIGKILL/stty recovery, protocol
request invariance, 43 Rust tests, both-view approval and details/composer PTYs.
Native Windows execution remains a real-platform acceptance requirement.

## Backport: background jobs and live timers

Adapted `377dd2d` and the background-process portion of `b37c586`. Rust receives
job-count changes, shows elapsed time for live tools/agents, and Ctrl+B promotes
a focused running shell (or the only running shell) through Node's existing tool
executor. `/jobs`, `/jobs show <id>`, and `/jobs kill <id>` use the shared registry.
The original child is adopted rather than restarted; foreground cancellation and
timeout ownership end on promotion. Historical cards have no live promotion ID
or clock. Completed turns clear clocks and promotion handles.

Validation: 44 Rust tests, shared request/cache invariance, process-identity and
output continuity, single completion on kill, and output-log failure recovery.
Idle redraw and JSONL round-trip tests remain part of the regression checks.

## Backport: composer completion, paste and caret controls

Adapted `7cd8933` composer behavior to the accepted viewport and focus model:
selectable slash suggestions (arrows, Tab, Enter; Esc dismisses), Unicode wrapped
row navigation, click-to-place caret, large-paste chips with Ctrl+O expansion,
file-drop `@path` references, and explicit Ctrl+Shift+V image references. Submission,
history, copying and the external editor receive expanded content, not chip markers.
Shared clipboard-image loading includes bounded Wayland/X11 reads and optional
BMP/TIFF conversion from `b37c586`; Node presentation remains unchanged.

Validation: strict Clippy, 45 Rust tests, both-view clipboard/editor/focus PTYs,
including exact large-paste submission before/after expansion and slash selection;
shared attachment tests use fake clipboard helpers, including Wayland/X11 fallback.

## Backport: settings and terminal setup

Restored the `b37c586` shell completion generators and `/terminal-setup` helpers.
Setup only writes editor bindings when explicitly invoked with `install`; JSONC,
unrelated bindings and conflicts are preserved. Rust reads user/project/local
presentation settings when attaching, with environment overrides taking priority.
The accepted inline/full-mouse defaults are retained; these values are passed only
to the Rust child. Settings, completion and JSONC merge tests pass. Capability and
custom-status settings are consumed by the following OS/status backport slice.

## Backport: OS integration, copy picker and status

Adapted `b37c586` file/link targets, native/OSC approval notifications, focus and
keyboard reporting, synchronized output, CWD/title/shell/progress hints, copy
picker and configurable status segments/command. Alt+O opens the selected target;
Alt+L exposes its terminal hyperlink. File arguments remain literal, path searches
are bounded, and helpers run away from the input loop. Copy loads required stored
payloads before using the bounded clipboard worker. Notifications occur once per
pending approval while unfocused; historical approvals remain inert. Status
commands use a restricted environment, output cap and timeout.

Also restored the full slash dropdown above the composer and the host's existing
`run_slash` / `switch_model` protocol adapters. Core commands still use the shared
Node dispatcher. Crash cleanup covers the additional terminal modes.

Validation: strict Clippy, 48 Rust tests; both-view fake-OS PTYs cover copy picker,
code extraction, literal file paths, OSC8 and one unfocused-approval notification.
Question/focus and protocol/cache-invariance suites pass. Idle writes remain zero.
Native desktop delivery and emulator behavior still need the release matrix;
profile/config choices are explicitly not active capability probes.

## Backport: display-copy safeguards and stable session IDs

Restored the original display sanitizer for the live event tap and saved display
events. It clones before redacting sensitive fields/config contents and removing
terminal controls; execution arguments and canonical model history stay intact.
`ensureSessionId()` now returns the same stable ID it initializes, while the
accepted host still reads the writer's current identity after session changes.

Validation: display-copy immutability, four JSONL writer tests, nineteen approval
tests (including hold/deny timeout), protocol/request invariance and the Node to
Rust replay round trip pass. Resume display stability is now registered in the
standard unit runner rather than remaining an orphan test.

## Backport: remaining render and streaming refinements

Restored bounded Markdown row caching (512 entries, 2 KiB lines, bounded fence
state) while preserving accepted prose, code and diff colors. Running tool output
keeps a 20-line/12-KiB tail; completed results and loaded details remain complete.
Artifacts show MIME/type, page count, size and open targets. Model mode and BYOK
route are delivered through the display protocol and shown with the model label.
The original ASCII status-marker fallback is available through `BAHULAM_ASCII`.

Queued follow-ups appear as a status count, acknowledged by subsequent live main
turns. They do not insert future prompts above the current answer. Historical
replay cannot consume that count, and changing sessions clears it. Node remains
the instruction queue owner. This intentionally replaces the source commit's
in-place conversion of early queued cards, which conflicted with accepted order.

Validation: 54 Rust tests, strict Clippy, protocol/request invariance and replay
round trips pass. Tests cover cache/fence/palette isolation, bounded streamed tool
previews followed by complete results, artifact metadata, model labels and queued
prompt ordering. The both-view focus PTY also checks live queue acknowledgement.
