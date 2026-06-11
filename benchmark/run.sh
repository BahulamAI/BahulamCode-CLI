#!/bin/bash
# Run Kepler against SWE-bench Lite with specified model.
#
# Usage:
#   ./benchmark/run.sh                                    # DeepSeek (default)
#   ./benchmark/run.sh anthropic/claude-sonnet-4-20250514  # Claude
#   ./benchmark/run.sh --limit 10                         # First 10 only
#   ./benchmark/run.sh deepseek/deepseek-v4-flash --limit 10

set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="deepseek/deepseek-chat-v3-0324"
if [[ $# -gt 0 && "$1" != -* ]]; then
    MODEL="$1"
    shift
fi

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  KEPLER SWE-bench Benchmark                             ║"
echo "║  Model: $MODEL"
echo "║  Dataset: lite (300 instances)                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

exec python3 benchmark/swe-bench/harness.py \
    --dataset lite \
    --model "$MODEL" \
    "$@"
