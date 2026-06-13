# Kepler Benchmark Results

## SWE-bench Lite (300 instances)

Each run directory contains:
- `predictions.json` — SWE-bench format predictions (instance_id, model_patch, model_name_or_path)
- `harness-results.json` — Kepler harness output (telemetry, tool breakdown, costs)
- `docker-eval.json` — SWE-bench Docker evaluation (resolved_ids, unresolved_ids)
- `telemetry.json` — Aggregated telemetry (tools, costs, durations, test rates)
- `run-config.json` — Exact configuration (model, flags, framework version, env vars)

### Runs

| Run ID | Date | Coder Model | Planner | Resolved | Rate | Cost | Notes |
|--------|------|-------------|---------|----------|------|------|-------|
| `swebench-v1-flash-300` | 2026-06-09 | DS-V4-Flash | none | 115/300 | 38.3% | ~$10 | Baseline, no preflight |
| `swebench-v2-flash-100` | 2026-06-13 | DS-V4-Flash | DS-V4-Pro | 43/100 | 43.0% | $2.19 | +OperatingBrief, first 100 |
| `swebench-v2-flash-300` | pending | DS-V4-Flash | DS-V4-Pro | — | — | — | Full 300 with v3.0.0 |

### Previous (not in standard format)

| File | Description |
|------|-------------|
| `swebench-eval-deepseek-v4-flash-300.json` | v1 Docker eval (92/238 evaluated subset) |
| `swebench-eval-deepseek-v4-pro-33.json` | V4 Pro 33-instance sample |

## Terminal-Bench

| Run ID | Date | Model | Resolved | Rate | Notes |
|--------|------|-------|----------|------|-------|
| `tbench-v1-flash-10` | 2026-06-10 | DS-V4-Flash | 4/10 | 40% | Core dataset |

## Run Directory Structure

```
results/
├── RESULTS.md                          # This file
├── runs/
│   ├── swebench-v1-flash-300/
│   │   ├── run-config.json
│   │   ├── predictions.json
│   │   ├── harness-results.json
│   │   ├── docker-eval.json
│   │   └── telemetry.json
│   ├── swebench-v2-flash-100/
│   │   └── ...
│   └── tbench-v1-flash-10/
│       └── ...
└── official/                           # Legacy (pre-standardized)
```
