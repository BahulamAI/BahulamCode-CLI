#!/bin/bash
# ============================================================================
# Deploy & Run — one-command benchmark deployment to any Azure VM
#
# Usage:
#   ./benchmark/deploy-and-run.sh <VM_IP> <MODEL> [PARALLEL] [OPTIONS]
#
# Examples:
#   ./benchmark/deploy-and-run.sh 172.202.17.40 deepseek/deepseek-v4-flash 1
#   ./benchmark/deploy-and-run.sh 172.202.17.40 anthropic/claude-sonnet-4-6 3 --gateway bedrock
#   ./benchmark/deploy-and-run.sh 20.9.77.9 deepseek/deepseek-v4-flash 1 --skip-setup
#
# Requires: ssh access to VM, local repos at expected paths
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
for arg in "$@"; do
    case "$arg" in
        --skip-setup) SKIP_SETUP=true ;;
        --gateway=*) GATEWAY="${arg#--gateway=}" ;;
        --key=*) API_KEY="${arg#--key=}" ;;
        --license=*) LICENSE_KEY="${arg#--license=}" ;;
        --token=*) CLI_TOKEN="${arg#--token=}" ;;
    esac
done

VM="azureuser@${VM_IP}"
PLATFORM_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL_SLUG=$(echo "$MODEL" | tr '/' '_')
RUN_ID="${MODEL_SLUG}_$(date +%Y%m%d_%H%M%S)"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Kepler Benchmark Deploy & Run                          ║"
echo "║  VM: ${VM_IP}                                           ║"
echo "║  Model: ${MODEL}                                        ║"
echo "║  Parallel: ${PARALLEL}                                  ║"
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
    codekepler-npm/package.json
echo "  Bundle: $(du -h $BUNDLE | cut -f1)"

# ── 2. Upload ──
echo "[2/5] Uploading to ${VM_IP}..."
scp "$BUNDLE" "${VM}":~/kepler-bench-bundle.tar.gz

# ── 3. Setup VM (skip if --skip-setup) ──
if [ "$SKIP_SETUP" = false ]; then
echo "[3/5] Setting up VM..."
ssh "$VM" bash << 'REMOTE_SETUP'
set -e

# Extract
rm -rf ~/codekepler-backend ~/codekepler-npm ~/tarang-ai-agent-framework
tar xzf ~/kepler-bench-bundle.tar.gz -C ~/
rm ~/kepler-bench-bundle.tar.gz

# Map to working paths (VM uses tarang-* dirs)
rm -rf ~/tarang-backend ~/tarang-npm
ln -sf ~/codekepler-backend ~/tarang-backend
ln -sf ~/codekepler-npm ~/tarang-npm

# System deps (idempotent)
if ! command -v node &>/dev/null || [ "$(node --version | cut -d. -f1)" != "v20" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
fi
sudo apt-get install -y -qq python3-pip python3-venv docker.io ripgrep tmux jq 2>/dev/null
sudo usermod -aG docker $USER 2>/dev/null || true

# Python backend venv
if [ ! -d ~/backend-env ]; then
    python3 -m venv ~/backend-env
fi
source ~/backend-env/bin/activate
pip install --quiet -r ~/tarang-backend/requirements.txt 2>&1 | tail -3
pip install --quiet -e ~/tarang-ai-agent-framework/agent-framework-pypi/ 2>&1 | tail -3
deactivate

# SWE-bench venv
if [ ! -d ~/swebench-env ]; then
    python3 -m venv ~/swebench-env
fi
source ~/swebench-env/bin/activate
pip install --quiet swebench datasets 2>&1 | tail -3
deactivate

echo "  VM setup complete"
REMOTE_SETUP
else
    echo "[3/5] Skipping setup (--skip-setup)"
    ssh "$VM" bash -c "tar xzf ~/kepler-bench-bundle.tar.gz -C ~/ && rm ~/kepler-bench-bundle.tar.gz"
    # Update symlinks
    ssh "$VM" bash -c "rm -f ~/tarang-backend ~/tarang-npm; ln -sf ~/codekepler-backend ~/tarang-backend; ln -sf ~/codekepler-npm ~/tarang-npm"
fi

# ── 4. Configure auth & env ──
echo "[4/5] Configuring..."

# CLI token
if [ -z "$CLI_TOKEN" ]; then
    CLI_TOKEN=$(python3 -c "import json,os; p='$HOME/.kepler/config.json'; print(json.load(open(p if os.path.exists(p) else '$HOME/.orca/config.json'))['token'])" 2>/dev/null || echo "")
fi

# API key — auto-detect from gateway if not provided
if [ -z "$API_KEY" ]; then
    case "$GATEWAY" in
        *OpenRouter*) API_KEY=$(grep OPENROUTER_API_KEY "$HOME/.tarang-benchmark.env" 2>/dev/null | cut -d= -f2 || echo "") ;;
        *Claude*|*Anthropic*) API_KEY=$(grep ANTHROPIC_API_KEY "$PLATFORM_ROOT/codekepler-backend/.env" 2>/dev/null | cut -d= -f2 || echo "") ;;
    esac
fi

# License key
if [ -z "$LICENSE_KEY" ]; then
    LICENSE_KEY=$(grep LICENSE_KEY "$PLATFORM_ROOT/codekepler-backend/.env" 2>/dev/null | cut -d= -f2 || echo "")
fi

# Build env var block based on gateway type
ENV_SECRETS=""
case "$GATEWAY" in
    *OpenRouter*)
        ENV_SECRETS="OPENROUTER_API_KEY=${API_KEY}" ;;
    *Claude*|*Anthropic*)
        ENV_SECRETS="ANTHROPIC_API_KEY=${API_KEY}" ;;
    *Bedrock*)
        ENV_SECRETS="AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-}
AWS_REGION=${AWS_REGION:-us-east-1}" ;;
    *OpenAI*)
        ENV_SECRETS="OPENAI_API_KEY=${API_KEY}" ;;
esac

ssh "$VM" bash << REMOTE_CONFIG
mkdir -p ~/.kepler ~/.orca
echo '{"token": "${CLI_TOKEN}"}' > ~/.kepler/config.json
echo '{"token": "${CLI_TOKEN}"}' > ~/.orca/config.json
chmod 600 ~/.kepler/config.json ~/.orca/config.json

cat > ~/.tarang-benchmark.env << ENVEOF
EXECUTION_MODE=enterprise
SKIP_QUOTA=1
TARANG_ENV=local
KEPLER_STAGNATION_DETECTION=true
KEPLER_ENHANCED_STAGNATION=true
KEPLER_STAGNATION_THRESHOLD=3
LLM_GATEWAY=${GATEWAY}
LLM_MODEL=${MODEL}
${ENV_SECRETS}
LICENSE_KEY=${LICENSE_KEY}
ENVEOF
chmod 600 ~/.tarang-benchmark.env
echo "  Auth configured (EXECUTION_MODE=enterprise, gateway=${GATEWAY})"
REMOTE_CONFIG

# ── 5. Start benchmark ──
echo "[5/5] Starting benchmark..."
ssh "$VM" bash << REMOTE_RUN
cat > ~/run-benchmark.sh << 'SEOF'
#!/bin/bash
set -u
set -a
source ~/.tarang-benchmark.env
set +a
export LOG_DIR=~/kepler-logs

echo "=== Kepler Benchmark: ${MODEL} ==="
echo "Run ID: ${RUN_ID}"
echo "Parallel: ${PARALLEL}"
echo "Started: \$(date)"

cd ~/tarang-backend
source ~/backend-env/bin/activate
fuser -k 8000/tcp 2>/dev/null; sleep 1
uvicorn app.main:app --port 8000 > ~/backend-${RUN_ID}.log 2>&1 &
BACKEND_PID=\$!
sleep 10

if ! curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "Backend failed!"; tail -20 ~/backend-${RUN_ID}.log
    kill \$BACKEND_PID 2>/dev/null; exit 1
fi
echo "Backend ready"

source ~/swebench-env/bin/activate
cd ~/tarang-npm
python3 benchmark/swe-bench/harness.py \\
    --dataset lite \\
    --model ${MODEL} \\
    --parallel ${PARALLEL} \\
    --timeout 600 \\
    --skip-done \\
    --output ~/results-${RUN_ID}.json \\
    2>&1 | tee ~/benchmark-${RUN_ID}.log

echo "Done: \$(date)"
kill \$BACKEND_PID 2>/dev/null
SEOF
chmod +x ~/run-benchmark.sh
tmux new-session -d -s bench "bash ~/run-benchmark.sh"
echo "  Benchmark started in tmux"
REMOTE_RUN

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Benchmark running!                                      ║"
echo "║                                                          ║"
echo "║  Check progress:                                         ║"
echo "║    ssh ${VM} 'cat ~/results-${RUN_ID}.json | python3 -c  ║"
echo "║      \"import json,sys;d=json.load(sys.stdin);             ║"
echo "║      print(len(d.get(chr(114)+chr(101)+chr(115)+chr(117) ║"
echo "║      +chr(108)+chr(116)+chr(115),[])),'done')\"'           ║"
echo "║                                                          ║"
echo "║  Results: ~/results-${RUN_ID}.json                       ║"
echo "║  Logs:    ~/benchmark-${RUN_ID}.log                      ║"
echo "║  Backend: ~/backend-${RUN_ID}.log                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
