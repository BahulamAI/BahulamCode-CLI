#!/bin/bash
# =============================================================================
# Cache Hit Regression Check
# =============================================================================
# Runs a single SWE-bench instance in headless mode and reports cache metrics.
# Use this after ANY change to framework, backend, or CLI to verify caching.
#
# Usage:
#   ./benchmark/cache-check.sh                    # local backend on port 8000
#   ./benchmark/cache-check.sh 20.9.77.9          # remote VM
#   ./benchmark/cache-check.sh local 8001         # local on custom port
#
# Requires:
#   - Backend running (uvicorn app.main:app --port PORT)
#   - CLI auth configured (~/.kepler/config.json or ~/.orca/config.json)
#   - swebench-env or datasets installed (for instance lookup)
#
# Output:
#   Cache hit rate, total tokens, cost, tool count, edit count
#   Compare with baseline: 39% cache hit on SWE-bench with DeepSeek Flash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse args
VM_HOST="${1:-local}"
PORT="${2:-8000}"

if [ "$VM_HOST" = "local" ]; then
    BACKEND_URL="http://127.0.0.1:${PORT}"
    RUN_CMD="node"
    NPM_DIR="$REPO_ROOT"
    RESULTS_DIR="/tmp/cache-check"
else
    BACKEND_URL="http://127.0.0.1:8000"
    RUN_CMD="ssh azureuser@${VM_HOST}"
    NPM_DIR="~/codekepler-npm"
    RESULTS_DIR="~/cache-check"
fi

# Test instance: django-12983 (known to resolve, ~8 tools, quick)
INSTANCE_ID="django__django-12983"
MODEL="${MODEL:-deepseek/deepseek-v4-flash}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Cache Hit Regression Check                             ║"
echo "║  Instance: ${INSTANCE_ID}                               ║"
echo "║  Model:    ${MODEL}                                     ║"
echo "║  Backend:  ${BACKEND_URL}                               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Verify backend is running ──
echo -n "[1/4] Backend health... "
if [ "$VM_HOST" = "local" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BACKEND_URL}/health" 2>/dev/null || echo "000")
else
    HTTP_CODE=$(ssh azureuser@${VM_HOST} "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/health" 2>/dev/null || echo "000")
fi

if [ "$HTTP_CODE" != "200" ]; then
    echo "FAILED (HTTP ${HTTP_CODE})"
    echo ""
    echo "Start the backend first:"
    if [ "$VM_HOST" = "local" ]; then
        echo "  source .venv/bin/activate && set -a && source .env && set +a"
        echo "  uvicorn app.main:app --port ${PORT}"
    else
        echo "  ssh azureuser@${VM_HOST}"
        echo "  set -a; source ~/.tarang-benchmark.env; set +a"
        echo "  cd ~/tarang-backend; source ~/backend-env/bin/activate"
        echo "  uvicorn app.main:app --port 8000"
    fi
    exit 1
fi
echo "OK"

# ── Step 2: Setup test directory ──
echo -n "[2/4] Setting up test repo... "
if [ "$VM_HOST" = "local" ]; then
    mkdir -p /tmp/cache-check
    # Clone django at a known commit (lightweight)
    if [ ! -d "/tmp/cache-check/django" ]; then
        git clone --depth 1 https://github.com/django/django.git /tmp/cache-check/django 2>/dev/null
    fi
    TEST_DIR="/tmp/cache-check/django"
    echo "OK ($(ls "$TEST_DIR"/*.py 2>/dev/null | wc -l | tr -d ' ') top-level files)"
else
    ssh azureuser@${VM_HOST} "mkdir -p ~/cache-check; echo '${INSTANCE_ID}' > ~/cache-check/instance.txt"
    echo "OK"
fi

# ── Step 3: Run headless ──
echo "[3/4] Running headless agent..."
INSTRUCTION="Fix the following issue in the code. Use search_code to find the relevant file, read_file to understand the code, then edit_file to fix it. After editing, run tests to verify.\n\nQuerySet.order_by() crashes on union() querysets with ordering by annotation. The issue is in django/db/models/sql/compiler.py in the get_order_by method."

if [ "$VM_HOST" = "local" ]; then
    export TARANG_ENV=local
    RESULT_FILE="/tmp/cache-check/result.json"
    cd "$TEST_DIR"
    timeout 300 node "${REPO_ROOT}/src/terminal/main.mjs" \
        --headless --verbose \
        --instruction "$INSTRUCTION" \
        --model "$MODEL" \
        2>&1 | tee /tmp/cache-check/output.jsonl | tail -5

    # Parse the complete event
    python3 -c "
import json, sys
for line in open('/tmp/cache-check/output.jsonl'):
    try:
        d = json.loads(line.strip())
        if d.get('type') == 'complete':
            u = d.get('usage', {})
            print()
            print('═' * 60)
            print('  CACHE CHECK RESULTS')
            print('═' * 60)
            print(f'  Tools:        {d.get(\"tools\", 0)}')
            print(f'  Duration:     {d.get(\"duration_s\", 0):.1f}s')
            print(f'  Cost:         \${d.get(\"cost_usd\", 0):.4f}')
            print(f'  Input tokens: {u.get(\"input_tokens\", 0):,}')
            print(f'  Output:       {u.get(\"output_tokens\", 0):,}')
            print(f'  Cache read:   {u.get(\"cache_read\", 0):,}')
            print(f'  Cache write:  {u.get(\"cache_write\", 0):,}')
            inp = u.get('input_tokens', 1)
            cr = u.get('cache_read', 0)
            rate = round(100 * cr / max(inp, 1))
            print(f'  ─────────────────────────────')
            print(f'  CACHE HIT:    {rate}%')
            print(f'  ─────────────────────────────')
            if rate >= 35:
                print(f'  Status:       ✓ PASS (>= 35% baseline)')
            elif rate >= 20:
                print(f'  Status:       ⚠ DEGRADED (20-35%)')
            else:
                print(f'  Status:       ✗ FAIL (< 20%)')
            print('═' * 60)
            break
    except: pass
"
else
    # Remote VM: use SWE-bench harness for a single instance
    ssh azureuser@${VM_HOST} "export TARANG_ENV=local; \
        source ~/swebench-env/bin/activate; \
        cd ~/codekepler-npm; \
        python3 benchmark/swe-bench/harness.py \
            --dataset lite \
            --model ${MODEL} \
            --parallel 1 \
            --timeout 300 \
            --instance ${INSTANCE_ID} \
            --output ~/cache-check/result.json \
            2>&1 | tail -5"

    # Get cache stats from backend log
    ssh azureuser@${VM_HOST} "grep 'CACHE\|COMPLETE' ~/backend.log | tail -5" | \
        sed 's/\x1b\[[0-9;]*m//g'

    # Parse result
    ssh azureuser@${VM_HOST} "python3 -c \"
import json
d = json.load(open('/root/cache-check/result.json'))
r = d['results'][0]
k = r.get('kepler', {})
u = k.get('usage', {})
inp = u.get('input_tokens', 1)
cr = u.get('cache_read', 0)
rate = round(100 * cr / max(inp, 1))
print()
print('═' * 60)
print('  CACHE CHECK RESULTS')
print('═' * 60)
print(f'  Tools:        {k.get(\"tools\", 0)}')
print(f'  Duration:     {k.get(\"duration_s\", 0):.1f}s')
print(f'  Cost:         \\\${k.get(\"cost_usd\", 0):.4f}')
print(f'  Cache read:   {cr:,}')
print(f'  Input tokens: {inp:,}')
print(f'  CACHE HIT:    {rate}%')
if rate >= 35:
    print(f'  Status:       ✓ PASS')
elif rate >= 20:
    print(f'  Status:       ⚠ DEGRADED')
else:
    print(f'  Status:       ✗ FAIL')
print('═' * 60)
\""
fi

echo ""
echo "Baseline: 39% cache hit on SWE-bench with DeepSeek Flash (v3.0.0)"
echo "Run this after any change to framework/backend/CLI to catch regressions."
