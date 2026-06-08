#!/bin/bash
# VM Setup Script — deploy backend + CLI + harness on Azure VM
# Run from laptop: ./benchmark/vm-setup.sh
#
# What it does:
#   1. Packages backend + agent framework + CLI
#   2. Uploads to VM
#   3. Installs Python deps
#   4. Sets up ~/.orca/config.json (CLI auth)
#   5. Verifies everything works

set -euo pipefail

VM="azureuser@20.9.77.9"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
BUNDLE="/tmp/orca-vm-full-bundle.tar.gz"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Orca VM Setup — packaging and deploying                 ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Package everything ──
echo "[1/5] Packaging..."

cd "$PLATFORM_ROOT"
tar czf "$BUNDLE" \
    --exclude='.git' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.venv' \
    --exclude='node_modules' \
    --exclude='benchmark/.venv' \
    --exclude='benchmark/results' \
    --exclude='_legacy' \
    --exclude='.next' \
    tarang-backend/app/ \
    tarang-backend/configs/ \
    tarang-backend/requirements.txt \
    tarang-backend/.env \
    tarang-ai-agent-framework/agent-framework-pypi/ \
    tarang-npm/src/ \
    tarang-npm/benchmark/swe-bench/ \
    tarang-npm/benchmark/run.sh \
    tarang-npm/package.json

echo "  Bundle: $(du -h $BUNDLE | cut -f1)"

# ── 2. Upload ──
echo "[2/5] Uploading to VM..."
scp "$BUNDLE" "$VM":~/orca-vm-bundle.tar.gz

# ── 3. Extract + Install ──
echo "[3/5] Installing on VM..."
ssh "$VM" bash <<'REMOTE'
set -e

# Extract
rm -rf ~/tarang-backend ~/tarang-npm ~/tarang-ai-agent-framework
tar xzf ~/orca-vm-bundle.tar.gz -C ~/
rm ~/orca-vm-bundle.tar.gz

# Python venv for backend
if [ ! -d ~/backend-env ]; then
    python3 -m venv ~/backend-env
fi
source ~/backend-env/bin/activate

# Install backend deps
pip install --quiet -r ~/tarang-backend/requirements.txt 2>&1 | tail -3

# Install agent framework (local editable)
pip install --quiet -e ~/tarang-ai-agent-framework/agent-framework-pypi/ 2>&1 | tail -3

echo "  Python deps installed"

# Ensure swebench env has datasets
source ~/swebench-env/bin/activate
pip show datasets >/dev/null 2>&1 || pip install --quiet datasets

echo "  All deps ready"
REMOTE

# ── 4. Set up CLI auth ──
echo "[4/5] Setting up CLI auth..."
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.orca/config.json'))['token'])")

ssh "$VM" bash <<REMOTE
mkdir -p ~/.orca
cat > ~/.orca/config.json <<EOF
{"token": "$TOKEN"}
EOF
chmod 600 ~/.orca/config.json
echo "  CLI token configured"
REMOTE

# ── 5. Create env + start script ──
echo "[5/5] Creating VM start script..."
ssh "$VM" bash <<'REMOTE'
# Ensure .bashrc has the right exports
grep -q TARANG_ENV ~/.bashrc || echo 'export TARANG_ENV=local' >> ~/.bashrc
grep -q OPENROUTER_API_KEY ~/.bashrc || echo 'export OPENROUTER_API_KEY=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' >> ~/.bashrc

# Create convenience start script
cat > ~/start-benchmark.sh <<'EOF'
#!/bin/bash
# Start backend + run benchmark
set -euo pipefail

export TARANG_ENV=local
export OPENROUTER_API_KEY=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

MODEL="${1:-deepseek/deepseek-v4-pro}"
LIMIT="${2:-}"
EXTRA_ARGS="${@:3}"

echo "Starting backend..."
source ~/backend-env/bin/activate
cd ~/tarang-backend
uvicorn app.main:app --port 8000 &
BACKEND_PID=$!
sleep 3

# Verify backend is up
if ! curl -s http://localhost:8000/health > /dev/null 2>&1; then
    echo "Backend failed to start!"
    kill $BACKEND_PID 2>/dev/null
    exit 1
fi
echo "Backend running (PID $BACKEND_PID)"

echo "Starting benchmark..."
source ~/swebench-env/bin/activate
cd ~/tarang-npm

ARGS="--model $MODEL"
if [ -n "$LIMIT" ]; then
    ARGS="$ARGS --limit $LIMIT"
fi

python3 benchmark/swe-bench/harness_vm.py $ARGS $EXTRA_ARGS

echo "Stopping backend..."
kill $BACKEND_PID 2>/dev/null
wait $BACKEND_PID 2>/dev/null
echo "Done!"
EOF
chmod +x ~/start-benchmark.sh
echo "  Created ~/start-benchmark.sh"
REMOTE

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  VM Ready!                                               ║"
echo "║                                                          ║"
echo "║  Test 1 instance:                                        ║"
echo "║    ssh $VM './start-benchmark.sh deepseek/deepseek-v4-pro 1 --gen-only'"
echo "║                                                          ║"
echo "║  Full run (background):                                  ║"
echo "║    ssh $VM 'nohup ./start-benchmark.sh deepseek/deepseek-v4-pro > /tmp/bench.log 2>&1 &'"
echo "║                                                          ║"
echo "║  Stop VM when done:                                      ║"
echo "║    az vm deallocate --resource-group AZ-RG-ORCA-BENCHMARK --name swebench-eval-vm"
echo "╚══════════════════════════════════════════════════════════╝"
