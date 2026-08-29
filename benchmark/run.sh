#!/bin/bash
# Run Kepler SWE-bench benchmark (on VM or locally).
#
# Usage:
#   ./benchmark/run.sh                                     # default model
#   ./benchmark/run.sh minimax/minimax-m3                   # specific model
#   ./benchmark/run.sh minimax/minimax-m3 --limit 10        # first 10
#   ./benchmark/run.sh minimax/minimax-m3 --shard 2         # shard 2 of 5
#   ./benchmark/run.sh --gen-shards 5                       # generate shard files

set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="minimax/minimax-m3"
if [[ $# -gt 0 && "$1" != -* ]]; then
    MODEL="$1"
    shift
fi

# Handle --gen-shards
for arg in "$@"; do
    if [[ "$arg" == "--gen-shards" ]]; then
        NUM_SHARDS="${2:-5}"
        echo "Generating $NUM_SHARDS shard files..."
        source ~/swebench-env/bin/activate 2>/dev/null || true
        python3 -c "
from datasets import load_dataset
import os, math

ds = load_dataset('princeton-nlp/SWE-bench_Lite', split='test')
ids = sorted([x['instance_id'] for x in ds])
n = $NUM_SHARDS
chunk = math.ceil(len(ids) / n)
os.makedirs('benchmark/shards', exist_ok=True)
for i in range(n):
    shard = ids[i*chunk:(i+1)*chunk]
    path = f'benchmark/shards/shard_{i+1}.txt'
    with open(path, 'w') as f:
        f.write('\n'.join(shard) + '\n')
    print(f'  {path}: {len(shard)} instances')
print(f'Total: {len(ids)} instances across {n} shards')
"
        exit 0
    fi
done

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
