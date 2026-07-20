# Model Comparison Harness

Reproducible 7-question benchmark for comparing platform models on the same
Kepler workload used in `tarang orca platform docs/strategy/model-comparison.md`.

Runs each question through the CLI's headless mode with `--resume` chaining
so multi-turn context accumulates the same way an interactive session would.
Collects per-turn JSONL, aggregates metrics matching the strategy doc's matrix
schema, and writes both machine-readable + human-readable reports.

## Quick start

```bash
# Local backend on port 8150 (whatever TARANG_ENV=local resolves to)
TARANG_ENV=local node benchmark/model-comparison/run.mjs \
  --label "deepseek-layer3-2026-07-16" \
  --model deepseek/deepseek-v4-flash \
  --route platform

# Different model, same set
TARANG_ENV=local node benchmark/model-comparison/run.mjs \
  --label "glm52-primary-2026-07-16" \
  --model z-ai/glm-5.2 \
  --route platform \
  --tag "sub-agents=deepseek per PLATFORM_ROUTING; backend commit 6248e93"

# Run without a model override (backend's env-configured default)
TARANG_ENV=local node benchmark/model-comparison/run.mjs \
  --label "backend-default-2026-07-16"
```

## Prerequisites

- CLI logged in via `kepler login` for the target backend
- Backend running and healthy (`curl $BACKEND/api/models` returns 200)
- Node 18+ (the harness uses `node:child_process` + native `fetch` in the CLI)

## Output layout

Every run writes to `benchmark/model-comparison/results/<label>-<timestamp>/`:

```
q1-raw.jsonl        # complete stdout stream from turn 1
q2-raw.jsonl        # …
q7-raw.jsonl
summary.json        # aggregated metrics matching model-comparison.md
```

Also emitted:
- Live progress on stderr (one line per turn: runtime, primary/sub-agent split, cost)
- Final aggregate JSON on stdout (pipe to `jq` or a spreadsheet)

## What gets measured (per turn + aggregate)

Matches the columns from `strategy/model-comparison.md`:

- Runtime (seconds)
- Tool calls, split into `primary` vs `sub-agent`
- Sub-agent list (name, model, duration, tool count, success)
- Iterations (from CLI `complete` event)
- Input / output / cache-read / cache-write tokens
- Cache hit rate (auto-detects Anthropic vs OpenAI convention)
- Cost in USD
- Stagnation trigger count
- Errors / timeouts
- Rate-limit state

## Comparing runs

The `summary.json` has a stable schema (`kepler.model-comparison-run/1`), so
diffing two runs is a jq / spreadsheet exercise:

```bash
jq '.aggregate' results/deepseek-*/summary.json
jq '.aggregate' results/glm52-*/summary.json
```

Or import both into the running matrix in `model-comparison.md`.

## Questions file

The 7-question set lives in `questions.json`. To try a different set:

```bash
node benchmark/model-comparison/run.mjs \
  --label "custom" --questions ./my-questions.json
```

### SWE-bench hard-10 set

`questions-swe-hard10.json` is a companion question set built from the 10
SWE-bench Lite instances that v5 (DeepSeek Flash) failed with sub-agent
activity. Use it to A/B model × framework changes on real hard cases without
spinning up the full SWE-bench pipeline. Warm-cache, one persistent session,
matches interactive-user behavior.

One-time setup — clones each repo at its base commit to
`~/.kepler-bench-repos/<instance_id>`:

```bash
node benchmark/model-comparison/prep-swe-repos.mjs
```

Then fire against any model / framework combo:

```bash
# DeepSeek Flash (baseline)
TARANG_ENV=local node benchmark/model-comparison/run-persistent.mjs \
  --questions benchmark/model-comparison/questions-swe-hard10.json \
  --label "3.4.4-deepseek-2026-07-18" \
  --model deepseek/deepseek-v4-flash --route platform

# GLM 5.2
TARANG_ENV=local node benchmark/model-comparison/run-persistent.mjs \
  --questions benchmark/model-comparison/questions-swe-hard10.json \
  --label "3.4.4-glm52-2026-07-18" \
  --model z-ai/glm-5.2 --route platform
```

To reset repos between runs (each question mutates its clone with `edit_file`):

```bash
node benchmark/model-comparison/prep-swe-repos.mjs --reset
```

Each question's `instance_id`, `repo`, and `base_commit` fields are surfaced
in the summary so you can diff resolve outcomes against
`benchmark/results/runs/swebench-*` runs.

Schema (`kepler.model-comparison-questions/1`):

```json
{
  "schema": "kepler.model-comparison-questions/1",
  "questions": [
    { "q": 1, "text": "…", "tests": "…", "expected": "…" }
  ]
}
```

## Known limitations

- Question ordering matters — Q3-Q7 assume Q1's discovery has run
- `--resume` uses the CLI's last-session-wins convention; if you interleave
  runs against different backends, session boundaries can leak. Run to
  completion before starting the next label.
- Sub-agent tool counts come from the CLI's `sub_agent` events and the
  backend `complete` event. If either drops an event, the split may be off
  by a few tools. Check `q*-raw.jsonl` when a number looks wrong.
- The harness doesn't reset the CLI's session store — each run appends. Use
  `--label` to keep runs separate.

## When to run this

- Before merging a branch that touches sub-agent behavior, tool dispatch,
  enrichment, or model routing
- After changing `PLATFORM_ROUTING` in `sub_agents.py`
- After changing `PLATFORM_REASONING_MODEL` in the backend env
- Whenever you promote a candidate model from `strategy/model-comparison.md`'s
  "Candidate Models To Track" table
- After a framework version bump (e.g. `agent_framework 3.4.4`), use the
  hard-10 set for a fast A/B before running the full 300-instance SWE-bench
  Docker pipeline
