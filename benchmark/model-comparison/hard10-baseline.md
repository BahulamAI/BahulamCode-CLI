# SWE Hard10 Baseline Ledger

These files track repeatable Hard10 benchmark runs:

- `hard10-runs.csv`: one row per model/framework run.
- `hard10-turns.csv`: one row per SWE instance for runs where per-turn metrics are available.
- `results/<label>-<timestamp>/summary.json`: canonical raw aggregate emitted by the harness.
- `results/<label>-<timestamp>/q*-raw.jsonl`: raw event stream for each turn.

Verification fields:

- `patched`: whether the run is judged to match the expected SWE fix.
- `patch_produced`: whether the repo had a persisted git diff after the turn.
- `edit_file_calls`: count of edit/write tool calls in the raw JSONL.
- `changed_files`: comma-separated git diff file list after the run.

The 2026-07-18 DeepSeek run at framework SHA `7b023ee` completed all 10 turns
with no agent/backend errors, but produced no patches. Raw logs show zero
`edit_file` calls across all turns, and all benchmark repos remained clean.
