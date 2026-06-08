# @devtarang/orca

Orca — AI coding agent that plans, builds, and ships software from your terminal. Multi-agent orchestration with explore, review, and architect sub-agents.

## Install

```bash
npm install -g @devtarang/orca
```

## Quick Start

```bash
orca login                          # Sign in via browser (GitHub/Google)
orca                                # Start interactive REPL
orca "add user authentication"      # Run a single instruction
```

## Commands

```
orca                    Start interactive REPL
orca "instruction"      Run a single instruction and exit
orca login              Sign in via browser
orca dashboard          Open Orca Pulse analytics dashboard
orca sessions           List recent local sessions
orca stats              Aggregate session stats (tokens, cost, tools)
orca history            Recent prompt history
orca version            Show version
```

## REPL Commands

```
/help                   Show available commands
/stats                  Session metrics (tokens, cost, tools)
/cost                   Detailed cost breakdown by model
/history                Conversation history
/clear                  Clear conversation history
/explore <query>        Spawn read-only codebase explorer
/review <query>         Spawn code review agent
/architect <query>      Spawn architecture planning agent
/safety                 Show safety guardrail status
/revoke                 Revoke auto-approvals
/exit                   Exit the REPL
```

## Keyboard

```
Esc                     Cancel current execution
Space                   Pause / resume execution
Ctrl+C                  Exit
```

## Configuration

Settings are managed via the web dashboard at [devtarang.ai/dashboard/settings](https://devtarang.ai/dashboard/settings) and synced to the CLI automatically.

- **API Key**: Add your OpenRouter/Anthropic/OpenAI key in Settings
- **Model**: Choose your preferred model (40+ supported)
- **Gateway**: Select provider (OpenRouter, Anthropic, OpenAI, Bedrock, Google AI, etc.)

Config directory: `~/.orca/`

## Environment Variables

```
TARANG_ENV              Set backend (local, development, production)
ANTHROPIC_API_KEY       Direct Anthropic API key
OPENROUTER_API_KEY      OpenRouter API key
ORCA_CONFIG_DIR         Override config directory (default: ~/.orca)
```

## Links

- [Tarang Platform](https://devtarang.ai)
- [Documentation](https://devtarang.ai/docs)

## License

MIT
