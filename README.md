# @axplusb/kepler

Kepler is an AI coding agent for terminal-first software work. It can inspect a
repo, plan changes, run tools, ask for human approval, resume prior sessions, and
keep local project context in `.kepler/`.

The npm package uses [KEPLER-README.md](./KEPLER-README.md) as the published
README. Keep that file as the canonical npm-facing documentation.

## Install

```bash
npm install -g @axplusb/kepler@latest
```

Run without global install:

```bash
npx @axplusb/kepler@latest
```

## Quick Start

```bash
kepler login
kepler
kepler "fix the failing auth test"
```

## Common Commands

```text
kepler                    Start interactive REPL
kepler "instruction"      Run a single instruction and exit
kepler login              Sign in through the browser
kepler dashboard          Open Kepler Pulse analytics dashboard
kepler sessions           List recent local sessions
kepler stats              Aggregate local session stats
kepler history            Show recent prompt history
kepler version            Show installed version
```

## 2.2.0 Highlights

- Checkpointed `/resume` summaries with summary-only and summary-plus-tail modes.
- One approval prompt model for shell, sensitive reads, destructive actions, and
  backend/framework HITL.
- Redacted local approval logs.
- Wrapped full shell command display.
- Long-running shell command tail capture.

## Development

```bash
npm test
env NPM_CONFIG_CACHE=/private/tmp/kepler-npm-cache npm pack --dry-run
```

See [RELEASE.md](./RELEASE.md) for the merge, PR, and npm publish checklist.

## Links

- Website: https://codekepler.ai
- Company: https://axplusb.tech
- Repository: https://github.com/raviakasapu/codekepler-npm

## License

MIT
