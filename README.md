# @bahulamai/code

**Bahulam Code** is Bahulam's AI coding agent for terminal-first software work.
It inspects a repo, plans changes, runs tools, asks for human approval, resumes
prior sessions, and keeps local project context in `~/.bahulam/`.

- 65.6% SWE-bench Verified
- CLI-first, reliability-first
- Sub-agents, skills, workflows, and MCP support
- Bring your own model (40+ supported)

## Install

```bash
npm install -g @bahulamai/code@latest
```

Run without global install:

```bash
npx @bahulamai/code@latest
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

## 2.6.1 Highlights

- Published under both `@bahulam/code` and `@bahulamai/code` scopes.
- Full removal of legacy `b0` references from CLI help, error messages,
  analytics headers, and internal comments.

## 2.6.0 Highlights

- Rebrand: `@bahulamai/b0` → `@bahulamai/code`; binary `b0` → `bahulam-code`.
- Redesigned fixed input dock — labeled "Bahulam Code" identity, colored
  border, horizontal and vertical margins, meta row showing project, git
  branch, turn count, and token usage.
- Extended session-context meta line under the input dock.

## Development

```bash
npm test
npm pack --dry-run
```

See [RELEASE.md](./RELEASE.md) for the merge, PR, and npm publish checklist.

## Links

- Website: https://bahulam.ai
- Company: https://axplusb.tech
- Repository: https://github.com/raviakasapu/codekepler-npm

## License

MIT
