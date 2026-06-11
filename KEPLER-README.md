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

### Running SWE-bench

Benchmarks run on an Azure VM (`swebench-eval-vm`, D8s_v3) with a local backend + CLI.

**Setup (one-time):**

```bash
# Deploy backend + CLI + harness to VM
./benchmark/vm-setup.sh
```

**Run benchmark:**

```bash
# SSH into VM
ssh azureuser@20.9.77.9

# Start backend
source ~/.tarang-benchmark.env
cd ~/tarang-backend
source ~/backend-env/bin/activate
uvicorn app.main:app --port 8000 &

# Run all 300 instances (3 parallel workers, skip already-done)
source ~/swebench-env/bin/activate
cd ~/tarang-npm
python3 benchmark/swe-bench/harness.py \
    --dataset lite \
    --model deepseek/deepseek-v4-flash \
    --parallel 3 \
    --skip-done \
    --timeout 600
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--dataset lite\|verified\|full` | SWE-bench split (default: lite, 300 instances) |
| `--model <id>` | OpenRouter model ID |
| `--parallel <n>` | Number of parallel workers (default: 1) |
| `--skip-done` | Skip instances already in the output file |
| `--timeout <s>` | Per-instance timeout in seconds (default: 600) |
| `--limit <n>` | Only run first N instances |
| `--instance <id>` | Run a single instance by ID |
| `--gen-only` | Generate patches only (skip test evaluation) |
| `--output <path>` | Custom output file path |

**Results** are saved incrementally to `benchmark/results/<model>_<dataset>.json` — no data loss on kill.

**Convenience scripts on VM:**

```bash
# Watchdog (auto-restarts on crash)
tmux new-session -d -s bench "bash /tmp/start-parallel.sh"

# Check progress
tmux capture-pane -t bench -p | tail -20

# Or use the pre-built start script
./start-benchmark.sh deepseek/deepseek-v4-flash
```

## Terminal-Bench

Use the benchmark-only adapter under `benchmark/terminal-bench/` when you want to
evaluate Kepler in Terminal-Bench without touching the production CLI.

It runs with:

- a separate backend venv
- a separate backend port (`8001` by default)
- a custom `--agent-import-path kepler_agent:KeplerAgent`
- per-trial workspace isolation so memory does not leak across tasks

Reusable entrypoints:

```bash
benchmark/terminal-bench/setup-kepler-backend.sh
benchmark/terminal-bench/run-kepler-backend.sh
benchmark/terminal-bench/run-kepler-benchmark.sh --task-id hello-world
```

Environment variables that can be overridden in another machine or CI setup:

`BACKEND_DIR`, `FRAMEWORK_DIR`, `VENV_DIR`, `TB_VENV`, `TARANG_NPM_DIR`,
`ENV_FILE`, `BACKEND_URL`, `PORT`, `MODEL`, `DATASET`, `CONCURRENCY`.

Create a local `.tarang-tbench.env` with the benchmark credentials and backend
auth token, then point `ENV_FILE` at it if needed.

## Links

- Website: [codekepler.ai](https://codekepler.ai)
- Company: [axplusb.tech](https://axplusb.tech)

## License

MIT
