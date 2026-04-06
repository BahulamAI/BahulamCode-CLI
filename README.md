# @tarang/cli

AI coding agent CLI — hybrid local/remote multi-agent orchestration.

## Install

```bash
npm install -g @tarang/cli
```

Or run without installing:

```bash
npx @tarang/cli "add user authentication"
```

## Quick Start

```bash
tarang login
tarang config --openrouter-key YOUR_KEY
tarang "add user authentication"
```

## Configuration

Config stored at `~/.tarang/config.json` (shared with Python CLI).

```bash
tarang config --show
tarang config --openrouter-key KEY
tarang config --backend-url URL
tarang config --mode local|remote|auto
```

## License

MIT
