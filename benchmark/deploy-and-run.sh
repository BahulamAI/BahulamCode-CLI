#!/bin/bash
# ============================================================================
# Deploy & Run — one-command benchmark deployment to any Azure VM
#
# Usage:
#   ./benchmark/deploy-and-run.sh <VM_IP> <MODEL> [PARALLEL] [OPTIONS]
#
# Examples:
#   ./benchmark/deploy-and-run.sh 20.9.77.9 minimax/minimax-m3 1
#   ./benchmark/deploy-and-run.sh 20.9.77.9 deepseek/deepseek-v4-flash 1 --skip-setup
#   ./benchmark/deploy-and-run.sh 20.9.77.9 minimax/minimax-m3 1 --shard=2
#
# Options:
#   --skip-setup     Skip VM setup (just upload code + run)
#   --shard=N        Run only shard N (requires benchmark/shards/shard_N.txt)
#   --gateway=X      LLM gateway class (default: OpenRouterV2Gateway)
#   --key=X          API key override
#   --license=X      License key override
#   --token=X        CLI auth token override
# ============================================================================

set -euo pipefail

VM_IP="${1:?Usage: $0 <VM_IP> <MODEL> [PARALLEL] [OPTIONS]}"
MODEL="${2:?Usage: $0 <VM_IP> <MODEL> [PARALLEL]}"
PARALLEL="${3:-1}"
shift 3 || true

# Parse options
SKIP_SETUP=false
GATEWAY="OpenRouterV2Gateway"
API_KEY=""
LICENSE_KEY=""
CLI_TOKEN=""
SHARD=""
for arg in "$@"; do
    case "$arg" in
        --skip-setup) SKIP_SETUP=true ;;
        --gateway=*) GATEWAY="${arg#--gateway=}" ;;
        --key=*) API_KEY="${arg#--key=}" ;;
        --license=*) LICENSE_KEY="${arg#--license=}" ;;
        --token=*) CLI_TOKEN="${arg#--token=}" ;;
        --shard=*) SHARD="${arg#--shard=}" ;;
    esac
done

VM="azureuser@${VM_IP}"
PLATFORM_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL_SLUG=$(echo "$MODEL" | tr '/' '_')
RUN_ID="${MODEL_SLUG}_$(date +%Y%m%d_%H%M%S)"
[ -n "$SHARD" ] && RUN_ID="${RUN_ID}_shard${SHARD}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Kepler Benchmark Deploy & Run                          ║"
echo "║  VM: ${VM_IP}                                           ║"
echo "║  Model: ${MODEL}                                        ║"
echo "║  Parallel: ${PARALLEL}                                  ║"
printf "║  Shard: %-47s ║\n" "${SHARD:-all}"
echo "║  Run ID: ${RUN_ID}                                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Package code ──
echo "[1/5] Packaging..."
BUNDLE="/tmp/kepler-bench-bundle.tar.gz"
cd "$PLATFORM_ROOT"
tar czf "$BUNDLE" \
    --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' \
    --exclude='.venv' --exclude='node_modules' --exclude='.next' \
    --exclude='benchmark/results' --exclude='_legacy' \
    codekepler-backend/app/ \
    codekepler-backend/configs/ \
    codekepler-backend/requirements.txt \
    tarang-ai-agent-framework/agent-framework-pypi/ \
    codekepler-npm/src/ \
    codekepler-npm/benchmark/swe-bench/ \
    codekepler-npm/benchmark/shards/ \
    codekepler-npm/package.json
echo "  Bundle: $(du -h "$BUNDLE" | cut -f1)"

# ── 2. Upload ──
echo "[2/5] Uploading to ${VM_IP}..."
scp "$BUNDLE" "${VM}":~/kepler-bench-bundle.tar.gz

# ── 3. Setup VM ──
if [ "$SKIP_SETUP" = false ]; then
echo "[3/5] Setting up VM..."
ssh "$VM" bash << 'REMOTE_SETUP'
set -e
rm -rf ~/codekepler-backend ~/codekepler-npm ~/tarang-ai-agent-framework
tar xzf ~/kepler-bench-bundle.tar.gz -C ~/
rm ~/kepler-bench-bundle.tar.gz

ln -sfn ~/codekepler-backend ~/tarang-backend
ln -sfn ~/codekepler-npm ~/tarang-npm

if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
fi
sudo apt-get install -y -qq python3-pip python3-venv docker.io ripgrep tmux jq 2>/dev/null
sudo usermod -aG docker $USER 2>/dev/null || true

if [ ! -d ~/backend-env ]; then python3 -m venv ~/backend-env; fi
source ~/backend-env/bin/activate
pip install --quiet -r ~/tarang-backend/requirements.txt 2>&1 | tail -3
pip install --quiet -e ~/tarang-ai-agent-framework/agent-framework-pypi/ 2>&1 | tail -3
deactivate

if [ ! -d ~/swebench-env ]; then python3 -m venv ~/swebench-env; fi
source ~/swebench-env/bin/activate
pip install --quiet swebench datasets 2>&1 | tail -3
deactivate
echo "  VM setup complete"
REMOTE_SETUP
else
    echo "[3/5] Skipping setup (--skip-setup)"
    ssh "$VM" bash -c "tar xzf ~/kepler-bench-bundle.tar.gz -C ~/ && rm ~/kepler-bench-bundle.tar.gz"
    ssh "$VM" bash -c "ln -sfn ~/codekepler-backend ~/tarang-backend; ln -sfn ~/codekepler-npm ~/tarang-npm"
fi

# ── 4. Configure auth & env ──
echo "[4/5] Configuring..."

if [ -z "$CLI_TOKEN" ]; then
    for cfg in "$HOME/.kepler/config.json" "$HOME/.orca/config.json"; do
        [ -f "$cfg" ] && CLI_TOKEN=$(python3 -c "import json; print(json.load(open('$cfg'))['token'])" 2>/dev/null || true)
        [ -n "$CLI_TOKEN" ] && break
    done
fi

if [ -z "$API_KEY" ]; then
    API_KEY=$(ssh "$VM" 'grep -s OPENROUTER_API_KEY ~/.tarang-benchmark.env 2>/dev/null | cut -d= -f2' || true)
fi
if [ -z "$LICENSE_KEY" ]; then
    LICENSE_KEY=$(ssh "$VM" 'grep -s LICENSE_KEY ~/.tarang-benchmark.env 2>/dev/null | cut -d= -f2' || true)
fi

ssh "$VM" bash << REMOTE_CONFIG
mkdir -p ~/.kepler ~/.orca
echo '{"token": "${CLI_TOKEN}"}' > ~/.kepler/config.json
echo '{"token": "${CLI_TOKEN}"}' > ~/.orca/config.json
chmod 600 ~/.kepler/config.json ~/.orca/config.json

cat > ~/.tarang-benchmark.env << ENVEOF
SKIP_QUOTA=1
TARANG_ENV=local
LLM_GATEWAY=${GATEWAY}
OPENROUTER_API_KEY=${API_KEY}
LICENSE_KEY=${LICENSE_KEY}
KEPLER_STAGNATION_DETECTION=true
KEPLER_ENHANCED_STAGNATION=true
KEPLER_STAGNATION_THRESHOLD=3
KEPLER_MEMORY_ENABLED=false
KEPLER_PREFLIGHT_PLAN=true
ENVEOF
chmod 600 ~/.tarang-benchmark.env
echo "  Auth configured (gateway=${GATEWAY})"
REMOTE_CONFIG

# ── 5. Start benchmark ──
echo "[5/5] Starting benchmark..."

# Build harness args
SHARD_ARG=""
if [ -n "$SHARD" ]; then
    SHARD_ARG="--instance-file benchmark/shards/shard_${SHARD}.txt"
fi

ssh "$VM" bash << REMOTE_RUN
cat > ~/run-benchmark.sh << 'SEOF'
#!/bin/bash
set -u
set -a; source ~/.tarang-benchmark.env; set +a
export LOG_DIR=~/kepler-logs

echo "=== Kepler Benchmark ==="
echo "Model: ${MODEL}"
echo "Run ID: ${RUN_ID}"
echo "Started: \$(date)"

# Start backend
cd ~/tarang-backend
source ~/backend-env/bin/activate
fuser -k 8000/tcp 2>/dev/null; sleep 1
nohup uvicorn app.main:app --port 8000 > ~/backend-${RUN_ID}.log 2>&1 &
BACKEND_PID=\$!
sleep 10

if ! curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "Backend failed!"; tail -20 ~/backend-${RUN_ID}.log
    kill \$BACKEND_PID 2>/dev/null; exit 1
fi
echo "Backend ready (PID \$BACKEND_PID)"

# Run harness
source ~/swebench-env/bin/activate
cd ~/tarang-npm
python3 benchmark/swe-bench/harness.py \
    --dataset lite \
    --model ${MODEL} \
    --parallel ${PARALLEL} \
    --timeout 600 \
    --skip-done \
    ${SHARD_ARG} \
    --output ~/results-${RUN_ID}.json \
    2>&1 | tee ~/benchmark-${RUN_ID}.log

echo "Done: \$(date)"
kill \$BACKEND_PID 2>/dev/null
SEOF
chmod +x ~/run-benchmark.sh
tmux new-session -d -s bench "bash ~/run-benchmark.sh"
echo "  Benchmark started in tmux session 'bench'"
REMOTE_RUN

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Benchmark running on ${VM_IP}                          ║"
echo "║                                                          ║"
echo "║  Monitor:  ssh ${VM} 'tmux attach -t bench'             ║"
echo "║  Results:  ~/results-${RUN_ID}.json                     ║"
echo "║  Logs:     ~/benchmark-${RUN_ID}.log                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
