#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TARANG_NPM_DIR=${TARANG_NPM_DIR:-"$REPO_ROOT"}
TB_VENV=${TB_VENV:-"${REPO_ROOT}/../tbench-env"}
BACKEND_URL=${BACKEND_URL:-http://127.0.0.1:8001}
ENV_FILE=${ENV_FILE:-"${REPO_ROOT}/.tarang-tbench.env"}
MODEL=${MODEL:-deepseek/deepseek-v4-flash}
DATASET=${DATASET:-terminal-bench-core==0.1.1}
CONCURRENCY=${CONCURRENCY:-1}

set -a
source "$ENV_FILE"
set +a

cd "$TARANG_NPM_DIR"
export PYTHONPATH="$TARANG_NPM_DIR/benchmark/terminal-bench${PYTHONPATH:+:$PYTHONPATH}"

# Generate a unique output path per run to prevent parallel result conflicts.
RUN_ID="$(date -u +%Y-%m-%d__%H-%M-%S)-$$"
OUTPUT_PATH="${TARANG_NPM_DIR}/benchmark/results/terminal-bench/${RUN_ID}"

exec "$TB_VENV/bin/tb" run \
    --dataset "$DATASET" \
    --agent-import-path kepler_agent:KeplerAgent \
    --model "$MODEL" \
    --agent-kwarg "backend_url=$BACKEND_URL" \
    --n-concurrent "$CONCURRENCY" \
    --output-path "$OUTPUT_PATH" \
    "$@"
