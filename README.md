# @devtarang/orca

Orca (Orchestration of Composable Agents) — AI coding agent CLI with hybrid local/remote multi-agent orchestration. Powered by the Tarang platform.

## Install

```bash
npm install -g @devtarang/orca
```

Or run without installing:

```bash
npx @devtarang/orca "add user authentication"
```

## Quick Start

```bash
orca login
orca config --openrouter-key YOUR_KEY
orca "add user authentication"
```

## Configuration

Config stored at `~/.orca/config.json`.

```bash
orca config --show
orca config --openrouter-key KEY
orca config --mode local|remote|auto
```

## License

MIT
