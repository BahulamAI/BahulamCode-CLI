# Changelog

All notable changes to `@bahulam/code` will be documented in this file.

## [0.1.28] - 2026-09-23

### Added

- Manifest-declared plugin settings with typed validation, defaults, required-field status, and authenticated local configuration endpoints.
- Opt-in workplane update tools for persistent metrics, charts, tables, alerts, and bounded declarative 3D bar scenes.
- Trusted plugin handlers can read settings through `state.getConfig()` and `state.getAllConfig()` across all executor paths.

### Fixed

- Mask credential values and defaults in settings responses; keep existing secrets when a form submits a blank or masked value, and clear them only on explicit null.
- Protect reserved configuration state from generic browser state operations and direct key/value SQL queries, and exclude it from automatic context summaries.
- Provide synchronous state handles consistently to plugin handlers, including the classic tool registry.
- Normalize workplane identifiers and validate complete widget batches before persisting updates.

### Tested

- Settings persistence, defaults, validation, credential masking, plugin isolation, executor compatibility, and authenticated local HTTP routes with SQLite and JSON fallback storage.

## [0.1.27] - 2026-09-20

### Fixed

- Save running-turn follow-ups before sending; distinguish acceptance from delivery and promote undelivered instructions after normal completion, including late acknowledgements.
- Recover safely queued follow-ups from local transcripts; retain interrupted/uncertain work for review instead of automatically repeating it.
- Keep follow-ups as separate user messages rather than appending instructions to tool output.
- Skip the fresh-session intro on resume and discover shared sign-in changes across open CLI sessions.

### Changed

- Preserve syntax-colored code on green addition/red removal backgrounds, with stronger changed-word shading and theme-aware contrast.
- Separate transcript sections with quiet dividers and use a softer teal, lavender, and amber accent palette.

### Tested

- Raw-terminal follow-up races against an isolated SSE server, durable transcript recovery, and intervention request deadlines.
- Light/dark diff syntax and backgrounds in actual xterm cells at narrow and wide widths.

## [0.1.7] - 2026-08-28

### Added
- Agent tracking dashboard (PRD-092): `/watch` command, HTTP dashboard subcommand, headless daemon hooks
- `analyze_image` tool — ask a vision model about local image files
- `generate_image` tool — create images directly from the REPL
- `/attach` command — attach images from clipboard or file path
- `bahulam workspace open` — localhost browser workspace with file tree, diffs, and session context
- DeepSeek vision model added to the catalog
- Daemon sessions survive disconnect — reattach from any terminal
- Shared project-aware lint resolver for TS/TSX, JS/JSX, MDX, Python, Go, and Rust

### Changed
- Full shell output preserved for the agent while terminal cards stay compact
- Aligned CLI model role labels

### Fixed
- Redis keepalive and set_json failure surfacing to caller
- Redis relay for cross-replica approval_callback
- CLI auto commands during live turns

## [0.1.6] - 2026-08-15

### Added
- Multi-agent orchestration support
- Supabase workspace-scoped MCP servers
- Chat summarize flag migration

### Changed
- BYOK count enforcement relaxed

## [0.1.5] - 2026-08-01

### Added
- Local workspace browser relay
- Workspace stop control
- Bahulam chat cancel and reconnect handling

## [0.1.4] - 2026-07-20

### Changed
- Condensed stagnation notice

## [0.1.3] - 2026-07-15

### Added
- Sub-agent support (explore, plan, review, refactor, debug)
- Agent skills and workflows
- MCP server integration

## [0.1.2] - 2026-07-01

### Added
- Session resume and history
- Project context loading from `~/.bahulam/`
- Tool approval system with risk tiers

## [0.1.1] - 2026-06-15

### Added
- Initial CLI release
- Interactive REPL
- Basic tool execution (read_file, write_file, shell, search)
- Multi-model support (Claude, GPT, Gemini, DeepSeek)
