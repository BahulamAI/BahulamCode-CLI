#!/bin/bash
# Run Orca against SWE-bench Lite with specified model.
#
# Usage:
#   ./benchmark/run.sh                                    # DeepSeek (default)
#   ./benchmark/run.sh anthropic/claude-sonnet-4-20250514  # Claude
#   ./benchmark/run.sh --limit 10                         # First 10 only

set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="${1:-deepseek/deepseek-chat-v3-0324}"
LIMIT="${2:-}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ORCA SWE-bench Benchmark                               ║"
echo "║  Model: $MODEL"
echo "║  Dataset: lite (300 instances)                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

ARGS="--dataset lite --model $MODEL"
if [ -n "$LIMIT" ]; then
    ARGS="$ARGS --limit $LIMIT"
fi

python3 benchmark/swe-bench/harness.py $ARGS
