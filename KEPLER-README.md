# @axplusb/kepler

AI coding agent that plans, builds, tests, and ships. 30.7% on SWE-bench Lite.

## Install

```bash
npm install -g @axplusb/kepler
```

## Quick Start

```bash
kepler login                        # Sign in via browser (GitHub/Google)
kepler                              # Start interactive REPL
kepler "fix the auth bug"           # Run a single instruction
```

## Commands

```
kepler                    Start interactive REPL
kepler "instruction"      Run a single instruction and exit
kepler login              Sign in via browser
kepler dashboard          Open Kepler Pulse analytics dashboard
kepler sessions           List recent local sessions
kepler stats              Aggregate session stats (tokens, cost, tools)
kepler history            Recent prompt history
kepler version            Show version
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

Settings are managed via the web dashboard at [codekepler.ai/dashboard/settings](https://codekepler.ai/dashboard/settings) and synced to the CLI automatically.

- **API Key**: Add your OpenRouter/Anthropic/OpenAI key in Settings
- **Model**: Choose your preferred model (40+ supported)
- **Gateway**: Select provider (OpenRouter, Anthropic, OpenAI, Bedrock, Google AI, etc.)
- **Config directory**: `~/.kepler/`

## Models

Works with 13 providers and 40+ models:

| Provider | Models |
|----------|--------|
| DeepSeek | V4 Flash, V4 Pro, R1 |
| Anthropic | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 |
| Google | Gemini 2.5 Pro, Flash |
| OpenAI | GPT-4.1, O3, Codex |
| Meta | Llama 4 Maverick, Scout |
| Mistral | Devstral, Codestral |
| xAI | Grok 3 |
| Qwen | Qwen3 Coder |
| + | AWS Bedrock, Azure OpenAI, Databricks, Moonshot, Custom |

Platform default included free. Bring your own API key for unlimited.

## SWE-bench

| Model | Score | Cost |
|-------|-------|------|
| DeepSeek V4 Flash | 30.7% (92/300) | $0.03/fix |
| DeepSeek V4 Pro | 50% (14/28 sample) | $0.48/fix |

## Links

- Website: [codekepler.ai](https://codekepler.ai)
- Company: [axplusb.tech](https://axplusb.tech)

## License

MIT
