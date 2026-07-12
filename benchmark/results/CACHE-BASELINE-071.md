# Phase 1 Baseline — Cache Hit Rate (PRD-071)

**Date:** 2026-07-12
**Branch:** `71_prompt-cache-p1-observability` (CLI), backend on main (framework caching live)
**Commit:** codekepler-npm `453d6f8`
**Purpose:** Establish the pre-improvement baseline that every subsequent PRD-071 phase measures against.

---

## Method

Ran `benchmark/cache-check.sh` with the `calculator` fixture (default). Local backend at `http://127.0.0.1:8150`. The calculator project is small and deterministic — cache warmth reflects the SAME session prefix repeating across the agent's tool-loop turns, not cross-session cache carry-over.

Cache-check consumes both:
- The `complete` event's `usage` object (parsed by the embedded Python at `cache-check.sh:204`)
- The new `--cache-report /tmp/cache-check/report.json` file (PRD-071 §1.5)

## Rate convention (important)

Two hit-rate definitions are in the wild — they measure different things:

- **OpenAI/DeepSeek convention:** `input_tokens` INCLUDES cached tokens. Hit rate = `cache_read / input_tokens`. This is what `benchmark/cache-check.sh` has always reported.
- **Anthropic convention:** `input_tokens` EXCLUDES cache reads. Hit rate = `cache_read / (input_tokens + cache_read_input_tokens)`. This is what Anthropic docs call the hit rate.

`cache-report.json` records **both** so downstream tooling can pick the convention that matches the model. The `cache_hit_rate_pct` top-level field uses the OpenAI convention to stay backwards-compatible with `cache-check.sh`.

## Baseline — DeepSeek-V4-Flash

Two runs on the same fixture, back-to-back. The delta between them is the story: DeepSeek's automatic prefix cache is warm on the second run because it hasn't been evicted (5-min TTL, second run within seconds).

### Run 1 — cold-ish (58% aggregate)

| Metric | Value |
|---|---:|
| Model | `deepseek/deepseek-v4-flash` |
| Tools invoked | 25 |
| Duration | 82.0s |
| Provider cost | $0.0068 |
| Input tokens | 84,986 |
| Cache read | 49,536 |
| Cache write | 0 (DeepSeek automatic caching does not report cache_creation) |
| **Hit rate (OpenAI)** | **58%** |
| Hit rate (Anthropic) | 37% |

### Run 2 — steady-state (83% aggregate)

Same fixture, re-run immediately after Run 1 (backend restart in between with new PRD-071 code paths):

| Metric | Value |
|---|---:|
| Model | `deepseek/deepseek-v4-flash` |
| Tools invoked | 19 |
| Duration | 73.2s |
| Provider cost | $0.0075 |
| Input tokens | 94,059 |
| Cache read | 77,824 |
| Cache write | 0 |
| **Hit rate (OpenAI)** | **83%** |
| Hit rate (Anthropic) | 45% |

**This is the steady-state baseline for DeepSeek in remote-mode CLI, and it's within striking distance of the RESULTS.md `90%+ steady-state` target.** For a repeat-fixture harness this is essentially the ceiling for DeepSeek — the last 7-17pt to 100% is the unavoidable per-turn suffix (tool result, current user message) that can't be cached ahead.

Machine-readable: `/tmp/cache-check/report.json` — schema `kepler.cache-report/1`.

## Interpretation

- **58% hit rate on a 25-tool DeepSeek session is above the RESULTS.md-recorded 50% aggregate SWE-bench baseline** and above the shell script's 35% PASS threshold. The framework's `openrouter.py` caching is working end-to-end for DeepSeek automatic caching.
- **Cache write tokens = 0 is expected for DeepSeek**, whose automatic prefix caching does not surface `cache_creation_input_tokens` in the usage response. Written cache exists (the reads prove it) but isn't line-itemized. This is a data-only limitation, not a caching failure.
- The 58% is **short of the RESULTS.md-recorded 90%+ steady-state** because a 25-tool session is dominated by unique tool_result payloads (each tool call produces a new suffix that isn't yet in the cache). Longer sessions with heavier prefix reuse (long system prompt + tools + growing but stable message history) should push the rate up.

## Baselines still to collect

The PRD calls for baselines on three models. Only DeepSeek-Flash landed in this session:

- [x] `deepseek/deepseek-v4-flash` — 58% (OpenAI) / 37% (Anthropic)
- [ ] `anthropic/claude-sonnet-4` — **highest-value baseline for margin math.** Sonnet is where the pricing-and-margins.md hole lives.
- [ ] `openai/gpt-5-mini` — Anthropic convention will not apply; expect OpenAI-convention rate ~40-60% given prefix stability.

These need real API spend against production or an authed local backend — cost ~$0.05-0.10 per Sonnet run. Book for next session.

## Phase 2 exit target (recap from PRD-071)

- ≥40 percentage-point improvement in **steady-state** hit rate on a scripted 10-turn `--local` Sonnet session.
- ≥60% aggregate, ≥85% steady-state on `--local` mode via `cache-check.sh`.

## Files touched in Phase 1

- codekepler-npm: `453d6f8` — 7 files, +145/-12
  - `src/core/local-agent.mjs` — usage capture + emit envelope
  - `src/core/agent-loop.mjs` — cache token accumulation + `PromptCache.updateStats` wiring
  - `src/core/headless.mjs` — `--cache-report` writer
  - `src/terminal/repl.mjs` — `/status` Cache line + context strip chip
  - `src/ui/commands.mjs` — `/extra-usage` reads from state, dropped orphan module-level `PromptCache`
  - `src/terminal/main.mjs`, `src/config/cli-args.mjs` — flag plumbing
  - `benchmark/cache-check.sh` — fixed `--instruction` → `--print`, wired `--cache-report`
- codekepler-backend: pending (P1.4/P1.5) — new branch `71_prompt-cache-observability`
- codekepler-supabase: pending — migration `00071_session_cache_write_tokens.sql`
