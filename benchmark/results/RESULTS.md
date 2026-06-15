# Kepler Benchmark Results

## SWE-bench Lite (300 instances)

### Runs

| Run | Date | Model | Instances | Real Patches | Edit Rate | Test Rate | Resolved | Cache | Cost | Notes |
|-----|------|-------|-----------|-------------|-----------|-----------|----------|-------|------|-------|
| v1 | 06-09 | DS-V4-Flash | 300 | 198 (66%)† | n/a | n/a | 92 (28%*) | n/a | $13.76 | Baseline, no preflight |
| v2 | 06-13 | DS-V4-Flash | 300 | 172 (57%)† | 62% | 48% | 121 (38%*) | 40% | $6.15 | +OperatingBrief |
| v3 | 06-13 | DS-V4-Flash | 100‡ | 45 (45%) | 27% | 22% | 38 (32%) | 39% | — | Fixed harness, no stagnation§ |
| **v4** | **06-14** | **DS-V4-Flash** | **296** | **165 (56%)** | **60%** | **45%** | **109 (36.8%)** | **50%** | **$10.91** | **+Scratchpad, +cache fixes** |

† v1/v2 used old harness that leaked `test_patch` into `git diff`. Real patch count excludes test-only diffs.

\* v1/v2 resolve rates include 9/8 "free" resolves from harness test_patch leak. True rates: v1=28%, v2=38%.

‡ v3 ran instances 201-300 only (the hardest shard).

§ v3 had broken env vars (`KEPLER_STAGNATION_DETECTION` instead of `AGENT_STAGNATION_DETECTION`) — stagnation detection and preflight plans were silently disabled.

### Resolve Quality

| Metric | v1 | v2 | v3 | v4 |
|--------|----|----|----|----|
| Resolve / evaluated | 39% | 41% | 72% | **61.6%** |
| Resolve / real patch | 46% | 66% | 71% | **~66%** |
| Evaluated | 238 | 297 | 53 | 177 |
| No-patch instances | 9† | 2† | 47 | 119 |

The **resolve/evaluated rate of 61.6%** is the highest on a full run. When v4 produces a patch, it resolves 2 out of 3 times.

The 119 no-patch instances are the bottleneck — agent investigated but never edited. Caused by:
- 11 `kepler_failed` (crashes/timeouts)
- 108 `no_changes` (read loops without edits, primarily sympy/matplotlib)

### Reasoning Model Test (Hard 10)

10 hardest instances where Flash failed (97-172 tool calls, 0 edits):

| Model | Patched | Resolved | Cost | Notes |
|-------|---------|----------|------|-------|
| DS-V4-Flash | 0/10 | 0/10 | $1.46 | All read loops, no edits |
| Claude Haiku 4.5 | **10/10** | **3/10** | $4.50 | Direct Anthropic, incl Sonnet consult |

Resolved: django-13710, sympy-15345, sympy-16988.

**Validates reasoning nudge**: Flash handles volume ($0.04/inst), reasoning model breaks stagnation on hard cases ($0.45/inst). Projected: +3-10 resolved at ~$20 extra cost.

### Harness Contamination Analysis

| Run | Total "patches" | Test-only (harness leak) | Real source patches |
|-----|-----------------|------------------------|---------------------|
| v1 | 291 | 93 (test leak: 289) | 198 |
| v2 | 298 | 126 (test leak: 113) | 172 |
| v3 | 53 | 8 (test leak: 0) | 45 |
| v4 | 181 | 16 (test leak: 0) | 165 |

### Cache Optimization Impact

| Metric | Before (v2) | After (v4) |
|--------|-------------|------------|
| Cache hit rate | 40% (no explicit markers for DeepSeek) | **50%** (90%+ steady-state) |
| System prompt | Mutated every turn (Layer 2) | **Stable** (never changes) |
| Tool cache | Unstable (filtering) | **Stable** (25 sorted tools) |
| Post-compression cache | 3,968 tokens (9%) | **80-95%** (scratchpad) |
| Cost/instance | $0.021 | $0.037 (harder instances) |

### Tool Usage (v4)

| Tool | Calls | Avg/inst | % |
|------|-------|----------|---|
| read_file | 2,275 | 7.7 | 28% |
| grep | 1,539 | 5.2 | 19% |
| shell | 1,315 | 4.5 | 16% |
| search_code | 1,010 | 3.4 | 12% |
| get_project_overview | 320 | 1.1 | 4% |
| edit_file | 246 | 0.8 | 3% |
| run_tests | 187 | 0.6 | 2% |

Read:Write ratio = 21:1. Median 16 tools/inst, P95 = 107, Max = 187.

### Persistent Failure Analysis

Zero-edit hotspots: sympy (56%), matplotlib (50%), sphinx (50%), pylint (50%).

| Category | Count | Root Cause |
|----------|-------|------------|
| Never resolved, never edited | ~90 | Search/navigation failure — can't find where to edit |
| Never resolved, edited | ~30 | Fix quality — edits wrong code |
| Always resolved (all runs) | ~60 | Reliable fixes |
| Sometimes resolved | ~40 | Nondeterministic |

## Terminal-Bench

| Run | Date | Model | Resolved | Rate | Notes |
|-----|------|-------|----------|------|-------|
| tbench-v1-flash-10 | 06-10 | DS-V4-Flash | 4/10 | 40% | Core dataset |
| tbench-v2-flash-27 | 06-13 | DS-V4-Flash | 6/27 | 22% | Full dataset |

## Run Directory Structure

```
results/
├── RESULTS.md
├── runs/
│   ├── swebench-v1-flash-300/      (baseline 28%, harness contaminated)
│   ├── swebench-v2-flash-100/      (43%, harness contaminated)
│   ├── swebench-v2-flash-300/      (38%, harness contaminated)
│   ├── swebench-v3-flash-rerun100/ (32%, fixed harness, no stagnation)
│   ├── swebench-v4-flash-300/      (36.8%, scratchpad + cache, 61.6% resolve/eval)
│   └── tbench-v1-flash-10/         (40%)
└── archive/
```
