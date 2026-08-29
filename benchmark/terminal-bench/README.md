# Terminal-Bench Evaluation

## Overview

Terminal-Bench evaluates AI agents on 89 terminal tasks across:
- Software engineering
- Machine learning
- Security
- Data science
- System administration

Website: https://www.tbench.ai
GitHub: https://github.com/laude-institute/terminal-bench

## Setup (Azure VM)

```bash
ssh azureuser@20.9.77.9
./setup-terminal-bench.sh
```

## Kepler Benchmark Adapter

This folder is for Terminal-Bench only. It is intentionally separate from the
production CLI flow so you can re-use the benchmark harness in another
environment without changing the actual Kepler app.

What it tests:

- Kepler backend execution over the SSE/callback loop
- Kepler tool routing inside Terminal-Bench task containers
- Provider caching under the benchmark workload
- Backend isolation on its own port and virtual environment

What it does not test:

- The raw Terminus/LiteLLM baseline
- The production `kepler` CLI entrypoint

## Layout

- `kepler_agent.py` is the custom Terminal-Bench agent.
- `setup-kepler-backend.sh` creates the isolated backend venv.
- `run-kepler-backend.sh` starts the dedicated backend on port `8001`.
- `run-kepler-benchmark.sh` runs `tb` with `--agent-import-path kepler_agent:KeplerAgent`.

## Reusable Setup

Set these variables before running on a different machine:

- `BACKEND_DIR`
- `FRAMEWORK_DIR`
- `VENV_DIR`
- `TB_VENV`
- `TARANG_NPM_DIR`
- `ENV_FILE`
- `BACKEND_URL`
- `PORT`
- `MODEL`
- `DATASET`
- `CONCURRENCY`

Create a benchmark env file with the backend auth and provider credentials:

```bash
cat > .tarang-tbench.env <<'EOF'
AGENT_FRAMEWORK_TOKEN=...
OPENROUTER_API_KEY=...
LICENSE_KEY=...
SKIP_QUOTA=1
TARANG_ENV=local
EOF
chmod 600 .tarang-tbench.env
```

Run the isolated backend:

```bash
benchmark/terminal-bench/setup-kepler-backend.sh
benchmark/terminal-bench/run-kepler-backend.sh
```

Run a smoke test:

```bash
benchmark/terminal-bench/run-kepler-benchmark.sh --task-id hello-world --n-tasks 1
```

Run the full dataset:

```bash
benchmark/terminal-bench/run-kepler-benchmark.sh
```

## Notes

- The benchmark adapter maps Terminal-Bench task paths into a per-trial
  workspace alias so memory does not leak between runs.
- If a task returns `0` input tokens, the adapter never reached the backend.
  Check the benchmark event log first, then the backend auth/URL.

## Raw Model Baseline

```bash
# Using Terminus agent with our model (via OpenRouter)
tb run --agent terminus --model deepseek/deepseek-v4-flash \
  --dataset terminal-bench-core==0.1.1

# Or quick run without cloning
uvx terminal-bench run -d terminal-bench-core==0.1.1 \
  -a terminus -m deepseek/deepseek-v4-flash
```

## Leaderboard Submission

Email results to:
- mikeam@cs.stanford.edu
- alex@laude.org

Must use: `terminal-bench-core@0.1.1` with default timeouts.

## Results

Results saved to: `benchmark/results/terminal-bench/`
