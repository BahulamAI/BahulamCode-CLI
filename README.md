# @bahulam/code

**Bahulam Code** is Bahulam's AI coding agent for terminal-first software work.
It inspects a repo, plans changes, runs tools, asks for human approval, resumes
prior sessions, and keeps local project context in `~/.bahulam/`.

- 65.6% SWE-bench Verified
- CLI-first, reliability-first
- Sub-agents, skills, workflows, and MCP support
- Bring your own model (40+ supported)

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
- Repository: https://github.com/raviakasapu/codekepler-npm

## License

Apache-2.0
