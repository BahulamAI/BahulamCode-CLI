# @bahulam/code

**Bahulam Code** is Bahulam's AI coding agent for terminal-first software work.
It inspects a repo, plans changes, runs tools, asks for human approval, resumes
prior sessions, and keeps local project context in `~/.bahulam/`.

- 65.6% SWE-bench Verified
- CLI-first, reliability-first
- Sub-agents, skills, workflows, and MCP support
- Bring your own model (40+ supported)

## Appearance

The terminal and local workspace follow Bahulam's paper, ink, and indigo visual
language. The browser workspace stays light; terminal colors adapt to the
advertised background (`COLORFGBG`) and support truecolor, 256-color, basic ANSI, and
plain output.

Set `BAHULAM_THEME=light` or `BAHULAM_THEME=dark` if your terminal does not advertise its
background. Unadvertised backgrounds default to dark. `NO_COLOR=1` disables color;
`BAHULAM_PLAIN=1` also uses the ASCII startup banner. No terminal background is changed.

The compact input dock grows for multiline input. During approval, it stays in
review mode until you decide; use **PgUp/PgDn** for long command details, arrow
keys to select, **Enter** to confirm, or **Esc** to cancel. Very small windows use
the transcript fallback. Approval scopes and keyboard shortcuts are unchanged.

For terminal visual checks, run `npm run test:design:terminal` with optional
Playwright and xterm installations. `PLAYWRIGHT_MODULE` and `XTERM_MODULE` can point
to existing installations; `BROWSER_EXECUTABLE` selects a browser. The test checks
light/dark docks, streaming, paging, and resize without connecting to a backend.

### Local-first startup and resume

Startup mounts one transcript writer before printing the banner. Earlier shell
output stays in scrollback; connection checks run after the input prompt is ready.
Project paths restore without filesystem fingerprint scans, runtime probes or
search-index builds. The first search/overview initializes its index, and
concurrent requests share a single build.

Fresh starts show the original ASCII logo, infinity motif, abundance tagline and
version, with a narrow-terminal fallback. Successful `--resume` starts skip the
intro and new-session hints, showing a resume summary and two recent messages; in-session
resume previews six, without reducing the selected agent history mode. `/history` shows more. Summary/tail modes reuse local checkpoints
and local recaps; `/compact` remains the explicit backend-summary operation.
Direct `/resume <id>` filters sessions before parsing their metadata.

`npm run test:design:startup` checks populated terminals, narrow layouts, Unicode,
late output and draft preservation with the browser environment described above.

Sign-in is shared across terminals using the same `BAHULAM_HOME` (default
`~/.bahulam`), regardless of project directory. Open sessions check shared
credentials every two seconds, refreshing the profile only when credentials
change; `/whoami` explicitly verifies the account. Settings saves reread shared
config so an older session cannot restore its cached token after login/logout
elsewhere. An explicit `B0_TOKEN` overrides the saved login; a different
`BAHULAM_HOME` intentionally uses a separate credential store. Keep the backend
environment consistent between terminals as well.

Follow-ups typed while the agent is running are saved locally before sending.
An accepted instruction is shown as waiting for delivery; only a delivery
acknowledgement marks it delivered. After normal completion, undelivered
instructions run as separate turns in submission order. They remain separate
user messages, not text appended to a tool result. `/resume` recovers safely
queued work. After cancellation, disconnection, or uncertain delivery, review
`/history` before resubmitting; the CLI does not automatically retry that work.

### Change and command cards

Quiet dividers separate user messages, assistant replies, and tool activity.
Consecutive tools stay grouped, streamed text does not gain a divider per chunk,
and the assistant label repeats when a reply resumes after tools or other output.
Set `BAHULAM_BLOCK_SEPARATOR=space` for whitespace only, `dotted` for dotted rules,
or `off` to disable separators; the default is `subtle`.
Body text stays neutral, with teal code/strings, lavender keywords/links, and
soft amber numbers and verification labels. Green remains for successful outcomes
and additions. Light themes use deeper versions of these accents for contrast.
`npm run test:design:transcript` checks streaming section boundaries and accent
colors in real terminals, with and without the fixed input dock.

Live file changes, expanded details, and Markdown diffs share old/new line-number
gutters, subtle theme-aware green/red row backgrounds, and stronger shading on
changed words. Code keeps its syntax palette on top of those backgrounds:
lavender keywords, teal strings, amber literals, and neutral identifiers.
Truecolor and 256-color terminals use shaded rows; basic 16-color terminals
retain syntax colors and green/red markers, and plain/`NO_COLOR` output keeps `+`/`-` markers.
Light/dark appearance follows `BAHULAM_THEME` and the terminal's advertised theme.
Dark 256-color terminals use neutral shading with green/red markers because that
palette cannot reproduce the muted truecolor surfaces. Long lines wrap without
clipping; F2 or `/last` displays all available diff and command content.
A source-side truncation is labelled rather than presented as a complete diff.

Command cards separate the invocation, working directory, exit status, duration,
and stdout/stderr. Plugin, MCP, workflow, and agent labels appear when the event
supplies that metadata. Work summaries list changed files and reported test totals;
missing totals are not treated as passed tests.

Expanded edit/write cards include a shell-quoted `bahulam workspace open` command.
It opens that file in a **new local workspace**, not a resumed Cloud IDE session.
No browser is launched automatically and approval policy is unchanged.

Run `npm run test:design:cards` for optional light/dark, 40/80/120-column xterm
checks, using the same browser/module environment variables described above.

## About the name

**Bahulam** (बहुलम्) is Sanskrit for *abundance*. The name reflects a
philosophy: tokens are not rationed, model choice is not gated, and
intelligence is not metered per feature. The restrictions most agents
ship with are design decisions — ones we chose not to make.

## Install

```bash
npm install -g @bahulam/code@latest
```

Run without global install:

```bash
npx @bahulam/code@latest
```

## Start the CLI

After install, sign in and launch:

```bash
bahulam-code login       # one-time: sign in through the browser
bahulam-code             # start the interactive REPL
```

Or run a single instruction and exit:

```bash
bahulam-code "fix the failing auth test"
```

## Common Commands

```text
bahulam-code                    Start interactive REPL
bahulam-code "instruction"      Run a single instruction and exit
bahulam-code login              Sign in through the browser
bahulam-code configure          Open settings in your browser
bahulam-code config --show      Display local configuration
bahulam-code resume             Resume a paused or previous session
bahulam-code --version          Show installed version
bahulam-code --help             Full command reference
```

Inside the REPL, type `/help` for slash commands (models, cache, approvals,
skills, workflows, session tools).

## Plugin settings and workplanes

Plugins can declare settings under `config.config.fields` with `name`, `type`,
`default`, `required`, and optional `credential` metadata. Supported types are
`string`, `integer`, `number`, `boolean`, `password`, and `select` (with `options`).
Password fields are always treated as credentials.

The authenticated local workspace API exposes `GET /api/plugin-config/<name>`
for field metadata, masked values, and missing required fields. Save settings
with `POST` and a `{ "values": { ... } }` body. Blank or masked credential values
preserve the saved secret; explicit `null` clears it. Plugin-scoped sessions
cannot access another plugin's configuration.

Trusted local tool handlers read settings with `state.getConfig(name)` or
`state.getAllConfig()`. Settings persist locally in the plugin's state database;
they are not encrypted at rest, so protect the local account and filesystem.
Credentials are excluded from automatic state summaries and masked in settings
responses. Tool authors must not return secrets in tool results or logs.

Setting `config.workplane: true` adds a `<plugin_name>_workplane_update` tool
(hyphens become underscores). It upserts widgets by `id` into the plugin's
`workplane` state. Supported types are `metric`, `bar_chart`, `line_chart`,
`donut_chart`, `table`, `alert`, and `three_scene`. The latter accepts a bounded
`bar_landscape` scene. Widgets are declarative data; a compatible trusted client
owns rendering, and agents cannot supply executable HTML or JavaScript widgets.

## 0.1.7 Highlights

- Published as `@bahulam/code`.
- Local browser workspaces through `bahulam workspace open`.
- Image analysis and image generation tools for agent workflows.
- Shared project-aware lint resolver for TS/TSX, JS/JSX, MDX, Python, Go, and Rust.
- Full shell output is preserved for the agent while terminal cards stay compact.

## Development

```bash
npm test
npm pack --dry-run
```

See [RELEASE.md](./RELEASE.md) for the merge, PR, and npm publish checklist.

## Links

- Website: https://bahulam.ai
- Repository: https://github.com/BahulamAI/BahulamCode-CLI

## License

Apache-2.0
