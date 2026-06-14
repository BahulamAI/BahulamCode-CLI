# Kepler Benchmark Results

## SWE-bench Lite (300 instances)

### Runs

| Run | Date | Model | Instances | Real Patches | Edit Rate | Test Rate | Resolved | Cache | Cost | Notes |
|-----|------|-------|-----------|-------------|-----------|-----------|----------|-------|------|-------|
| v1 | 06-09 | DS-V4-Flash | 300 | 198 (66%)† | n/a | n/a | 92 (30.7%) | n/a | $13.76 | Baseline, no preflight |
| v2 | 06-13 | DS-V4-Flash | 300 | 172 (57%)† | 62% | 48% | 121 (40.3%) | 40% | $6.15 | +OperatingBrief |
| v3 | 06-13 | DS-V4-Flash | 100‡ | 45 (45%) | 27% | 22% | 38 (38.0%) | 39% | — | Fixed harness, no stagnation§ |
| v4 | 06-14 | DS-V4-Flash | 253 (running) | 131 (52%) | 57% | 41% | pending | 47% | $9.10 | +Scratchpad, +cache fixes |
| v4 last 100 | 06-14 | DS-V4-Flash | 100 | 59 (59%) | 70% | 49% | pending | 49% | — | Stagnation + preflight active |

† v1/v2 used old harness that leaked `test_patch` into `git diff`. Reported "patch count" (291/298) was inflated — test file diffs appeared as agent patches. Real patch count = source-file-only + mixed patches.

‡ v3 ran instances 201-300 only (the hardest shard).

§ v3 had broken env vars (`KEPLER_STAGNATION_DETECTION` instead of `AGENT_STAGNATION_DETECTION`) — stagnation detection and preflight plans were silently disabled.

### Harness Contamination Analysis

The old harness applied `test_patch` before the agent ran but didn't commit it. `git diff` captured both agent changes AND the test patch, inflating patch counts.

| Run | Total "patches" | Test-only (harness leak) | Test in diff, 0 edits | Real source patches |
|-----|-----------------|------------------------|-----------------------|---------------------|
| v1 | 291 | 93 | 289 (96%) | 198 |
| v2 | 298 | 126 | 113 (38%) | 172 |
| v3 | 53 | 8 | 0 (0%) | 45 |
| v4 | 146 | 15 | — | 131 |

### Quality Metrics

| Metric | v1 | v2 | v3 | v4 last 100 |
|--------|----|----|----|----|
| Resolve / real patch | 92/198 = 46% | 121/172 = 70% | 38/45 = 84% | pending |
| Edit rate | n/a | 62% | 27% | **70%** |
| Test rate | n/a | 48% | 22% | **49%** |
| No-patch (zero edit) | 9† | 2† | 47 | 30 |
| Cache hit | n/a | 40% | 39% | **49%** |
| Cost/instance | $0.0459 | $0.0205 | $0.0083 | $0.0546 |

† v1/v2 no-patch counts are artificially low because the harness leak gave almost every instance a "patch" even when the agent did nothing.

### Key Findings

1. **Fix quality is improving**: resolve/real-patch went from 46% (v1) → 70% (v2) → 84% (v3). When the agent edits, it's increasingly correct.

2. **Edit rate is the bottleneck**: v3's 27% edit rate (broken stagnation) vs v4 last 100's 70% shows stagnation detection matters — without it, the agent loops through reads forever.

3. **Cache hit rate**: 21% (pre-optimization) → 49% (v4 with scratchpad model). Driven by:
   - `cache_messages=True` default (sliding breakpoint on N-1 message)
   - Disabled tool filtering (stable tool list)
   - Removed `history_compressed` from system prompt
   - Scratchpad model (compression preserves cached prefix)
   - Deny-list cache guard (DeepSeek/Kimi/MiniMax get explicit `cache_control`)
   - Moved project resources + plan from system prompt to messages

4. **Env var mismatch**: `KEPLER_*` vs `AGENT_*` prefix caused stagnation + preflight to be silently disabled on VMs. Fixed on 2026-06-14.

### Persistent Failure Analysis (v3, instances 201-300)

| Category | Count | Root Cause |
|----------|-------|------------|
| Never resolved, never edited | 30 | Search/navigation failure |
| Never resolved, edited both runs | 10 | Fix quality — edits wrong code |
| Always resolved (all runs) | 23 | Reliable fixes |
| Sometimes resolved | 29 | Nondeterministic |

Zero-edit hotspots: sympy (56%), sphinx (50%), pylint (50%), seaborn (50%).

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
│   ├── swebench-v1-flash-300/      (baseline 30.7%, harness contaminated)
│   ├── swebench-v2-flash-100/      (43.0%, harness contaminated)
│   ├── swebench-v2-flash-300/      (40.7%, harness contaminated)
│   ├── swebench-v3-flash-rerun100/ (38.0%, fixed harness, no stagnation)
│   ├── swebench-v4-flash-300/      (pending, scratchpad + cache fixes)
│   └── tbench-v1-flash-10/         (40%)
└── archive/
```
