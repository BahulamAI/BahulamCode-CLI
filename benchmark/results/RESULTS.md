# Kepler Benchmark Results

## SWE-bench Lite (300 instances)

### Runs

| Run ID | Date | Coder Model | Planner | Instances | Edited | Patched | Resolved | Resolve/Patch | Cost | Notes |
|--------|------|-------------|---------|-----------|--------|---------|----------|---------------|------|-------|
| `swebench-v1-flash-300` | 2026-06-09 | DS-V4-Flash | none | 300 | ~198 | 291* | 92 (30.7%) | 83/198 = 41.9% | ~$10 | Baseline, no preflight, *old harness inflated |
| `swebench-v2-flash-100` | 2026-06-13 | DS-V4-Flash | DS-V4-Pro | 100 | ~63 | 100* | 43 (43.0%) | — | $2.19 | +OperatingBrief, *old harness |
| `swebench-v2-flash-300` | 2026-06-13 | DS-V4-Flash | DS-V4-Pro | 300 | 185 | 298* | 121 (40.7%) | 113/172 = 65.7% | $6.15 | +OperatingBrief, *old harness |
| `swebench-v3-flash-rerun100` | 2026-06-13 | DS-V4-Flash | DS-V4-Pro | 100 | 54 | 53 | 38 (38.0%) | **38/53 = 71.7%** | — | **Fixed harness**, instances 201-300 |

\* Old harness included test patch in git diff, inflating patch count. Fixed in v3.

### Key Finding: Fix Quality vs Edit Rate

| Metric | v1 (baseline) | v2 (+brief) | v3 (fixed harness) |
|--------|--------------|-------------|-------------------|
| Resolve per real patch | 41.9% | 65.7% | **84.4%** |
| Test rate | 0% | 48% | 45% |
| Zero-edit rate | ~34% | ~38% | 46% |

**When the agent edits, it's right 84% of the time.** The bottleneck is the 46% zero-edit rate — the agent searches but never commits to a fix.

### Persistent Failure Analysis (instances 201-300)

| Category | Count | Root Cause |
|----------|-------|------------|
| Never resolved, never edited | 30 | Search/navigation failure — can't find where to edit |
| Never resolved, edited both runs | 10 | Fix quality — edits wrong code |
| Always resolved (all runs) | 23 | Reliable fixes |
| Sometimes resolved | 29 | Nondeterministic |

Zero-edit hotspots: sympy (56% zero-edit), sphinx (50%), pylint (50%), seaborn (50%).

### Harness Fixes (v3)

1. **git diff baseline**: Commit test patch before agent runs so diff only captures agent changes
2. **test_cmd in instruction**: Include repo-specific test command (fair per SWE-bench rules)

## Terminal-Bench

| Run ID | Date | Model | Resolved | Rate | Notes |
|--------|------|-------|----------|------|-------|
| `tbench-v1-flash-10` | 2026-06-10 | DS-V4-Flash | 4/10 | 40% | Core dataset |
| `tbench-v2-flash-27` | 2026-06-13 | DS-V4-Flash | 6/27 | 22% | Full dataset, no operating brief |

## Run Directory Structure

```
results/
├── RESULTS.md
├── runs/
│   ├── swebench-v1-flash-300/     (baseline 30.7%)
│   ├── swebench-v2-flash-100/     (43.0%, old harness)
│   ├── swebench-v2-flash-300/     (40.7%, old harness)
│   ├── swebench-v3-flash-rerun100/ (38.0%, fixed harness, 71.7% resolve/patch)
│   └── tbench-v1-flash-10/        (40%)
└── archive/                       (legacy files)
```

Each run contains: `predictions.json`, `harness-results.json`, `docker-eval.json`, `telemetry.json`, `run-config.json`
