# @bahulamai/b0

b0 is Bahulam's AI coding agent for terminal-first software work. It can inspect a
repo, plan changes, run tools, ask for human approval, resume prior sessions, and
keep local project context in `.bahulam/`.

The npm package uses [B0-README.md](./B0-README.md) as the published
README. Keep that file as the canonical npm-facing documentation.

## Install

```bash
npm install -g @bahulamai/b0@latest
```

Run without global install:

```bash
npx @bahulamai/b0@latest
```

## Quick Start

```bash
b0 login
b0
b0 "fix the failing auth test"
```

## Common Commands

```text
b0                    Start interactive REPL
b0 "instruction"      Run a single instruction and exit
b0 login              Sign in through the browser
b0 dashboard          Open local analytics dashboard
b0 sessions           List recent local sessions
b0 stats              Aggregate local session stats
b0 history            Show recent prompt history
b0 version            Show installed version
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
env NPM_CONFIG_CACHE=/private/tmp/b0-npm-cache npm pack --dry-run
```

See [RELEASE.md](./RELEASE.md) for the merge, PR, and npm publish checklist.

## Links

- Website: https://getb0.ai
- Company: https://axplusb.tech
- Repository: https://github.com/raviakasapu/codekepler-npm

## License

MIT
