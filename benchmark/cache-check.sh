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

MODEL="${MODEL:-deepseek/deepseek-v4-flash}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Cache Hit Regression Check                             ║"
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

# ── Step 2: Create deterministic test project ──
echo -n "[2/4] Setting up test project... "
TEST_DIR="/tmp/cache-check-project"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

# Fixed test project — same files every run for deterministic cache testing
cat > "$TEST_DIR/calculator.py" << 'PYCODE'
"""Calculator module with intentional bugs for cache testing."""

def add(a, b):
    """Add two numbers."""
    return a - b  # BUG: subtracts instead of adding

def subtract(a, b):
    """Subtract b from a."""
    return a - b

def multiply(a, b):
    """Multiply two numbers."""
    return a + b  # BUG: adds instead of multiplying

def divide(a, b):
    """Divide a by b."""
    if b == 0:
        raise ZeroDivisionError("Cannot divide by zero")
    return a / b

class ScientificCalculator:
    """Extended calculator with scientific operations."""

    def __init__(self):
        self.history = []

    def power(self, base, exp):
        """Raise base to exp."""
        result = base ** exp
        self.history.append(f"{base}^{exp} = {result}")
        return result

    def sqrt(self, n):
        """Square root."""
        if n < 0:
            raise ValueError("Cannot take sqrt of negative")
        return n ** 0.5

    def factorial(self, n):
        """Calculate factorial."""
        if n < 0:
            raise ValueError("Negative factorial")
        if n <= 1:
            return 1
        return n * self.factorial(n - 1)
PYCODE

cat > "$TEST_DIR/test_calculator.py" << 'PYCODE'
"""Tests for calculator module."""
from calculator import add, subtract, multiply, divide, ScientificCalculator

def test_add():
    assert add(2, 3) == 5

def test_subtract():
    assert subtract(10, 4) == 6

def test_multiply():
    assert multiply(3, 4) == 12

def test_divide():
    assert divide(10, 2) == 5.0

def test_divide_by_zero():
    try:
        divide(1, 0)
        assert False, "Should have raised"
    except ZeroDivisionError:
        pass

def test_power():
    calc = ScientificCalculator()
    assert calc.power(2, 3) == 8

def test_sqrt():
    calc = ScientificCalculator()
    assert calc.sqrt(16) == 4.0

def test_factorial():
    calc = ScientificCalculator()
    assert calc.factorial(5) == 120
PYCODE

cd "$TEST_DIR" && git init -q && git add -A && git commit -q -m "initial"
echo "OK"

# ── Step 3: Run headless with fixed prompt ──
echo "[3/4] Running headless agent..."

# Select test prompt — use PROMPT env var to choose
# Default: calculator (small, fast, deterministic)
# Set PROMPT=dashboard for real-world project test
PROMPT_TYPE="${PROMPT:-calculator}"

if [ "$PROMPT_TYPE" = "dashboard" ]; then
    # Real-world prompt — tests against codekepler project
    TEST_DIR="/Users/sree/Sites/Tarang Orca/codekepler"
    INSTRUCTION="so I have collected the amount, and users has subscribed, now where does it show on dashboard?"
elif [ "$PROMPT_TYPE" = "api" ]; then
    # Backend API prompt — tests against codekepler-backend
    TEST_DIR="/Users/sree/Sites/Tarang Orca/codekepler-backend"
    INSTRUCTION="what is the api or other supported tables in backend that we need to use?"
else
    # Default: calculator (deterministic, small project)
    INSTRUCTION="Fix the bugs in calculator.py in this project. The add() function subtracts instead of adding, and multiply() adds instead of multiplying. After fixing, run the tests with: python -m pytest test_calculator.py -v"
fi

export TARANG_ENV=local
cd "$TEST_DIR"
timeout 300 node "${REPO_ROOT}/src/terminal/main.mjs" \
    --headless --verbose \
    --instruction "$INSTRUCTION" \
    --model "$MODEL" \
    2>&1 | tee /tmp/cache-check/output.jsonl | tail -5

# ── Step 4: Parse and report ──
echo ""
echo "[4/4] Parsing results..."
python3 -c "
import json
for line in open('/tmp/cache-check/output.jsonl'):
    try:
        d = json.loads(line.strip())
        if d.get('type') == 'complete':
            u = d.get('usage', {})
            tb = d.get('tool_breakdown', {})
            tools = d.get('tools', 0)
            inp = u.get('input_tokens', 1)
            out = u.get('output_tokens', 0)
            cr = u.get('cache_read', 0)
            cw = u.get('cache_write', 0)
            rate = round(100 * cr / max(inp, 1))
            cost = d.get('cost_usd', 0)
            dur = d.get('duration_s', 0)

            print()
            print('=' * 60)
            print('  CACHE CHECK RESULTS')
            print('=' * 60)
            print(f'  Tools:        {tools}')
            print(f'  Tool detail:  {tb}')
            print(f'  Duration:     {dur:.1f}s')
            print(f'  Cost:         \${cost:.4f}')
            print(f'  Input tokens: {inp:,}')
            print(f'  Output:       {out:,}')
            print(f'  Cache read:   {cr:,}')
            print(f'  Cache write:  {cw:,}')
            print(f'  ─────────────────────────────')
            print(f'  CACHE HIT:    {rate}%')
            print(f'  ─────────────────────────────')
            if rate >= 35:
                print(f'  Status:       ✓ PASS (>= 35% baseline)')
            elif rate >= 20:
                print(f'  Status:       ⚠ DEGRADED (20-35%)')
            else:
                print(f'  Status:       ✗ FAIL (< 20%)')
            print('=' * 60)

            # Save as JSON for tracking
            import os, datetime
            result = {
                'timestamp': datetime.datetime.now().isoformat(),
                'tools': tools, 'tool_breakdown': tb,
                'duration_s': dur, 'cost_usd': cost,
                'input_tokens': inp, 'output_tokens': out,
                'cache_read': cr, 'cache_write': cw,
                'cache_hit_pct': rate,
                'status': 'PASS' if rate >= 35 else ('DEGRADED' if rate >= 20 else 'FAIL'),
            }
            log_file = '/tmp/cache-check/history.jsonl'
            with open(log_file, 'a') as f:
                f.write(json.dumps(result) + '\n')
            print(f'  Logged to:    {log_file}')
            break
    except:
        pass
"

echo ""
echo "Baseline: 39% cache hit on SWE-bench with DeepSeek Flash (v3.0.0)"
echo "Run this after any change to framework/backend/CLI to catch regressions."
