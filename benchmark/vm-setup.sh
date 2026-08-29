#!/bin/bash
# VM Setup Script — deploy backend + CLI + harness to an Azure VM
# Run from laptop: ./benchmark/vm-setup.sh [VM_IP]
#
# What it does:
#   1. Packages backend + agent framework + CLI into a tarball
#   2. Uploads to VM
#   3. Installs Python + Node deps
#   4. Copies CLI auth token
#   5. Writes ~/.tarang-benchmark.env with all flags

set -euo pipefail

VM_IP="${1:-20.9.77.9}"
VM="azureuser@${VM_IP}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
BUNDLE="/tmp/kepler-vm-bundle.tar.gz"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Kepler VM Setup → ${VM_IP}                              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Package ──
echo "[1/5] Packaging..."
cd "$PLATFORM_ROOT"
tar czf "$BUNDLE" \
    --exclude='.git' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.venv' \
    --exclude='node_modules' \
    --exclude='benchmark/results' \
    --exclude='_legacy' \
    --exclude='.next' \
    codekepler-backend/app/ \
    codekepler-backend/configs/ \
    codekepler-backend/requirements.txt \
    tarang-ai-agent-framework/agent-framework-pypi/ \
    codekepler-npm/src/ \
    codekepler-npm/benchmark/swe-bench/ \
    codekepler-npm/benchmark/shards/ \
    codekepler-npm/benchmark/run.sh \
    codekepler-npm/package.json
echo "  Bundle: $(du -h "$BUNDLE" | cut -f1)"

# ── 2. Upload ──
echo "[2/5] Uploading to ${VM_IP}..."
scp "$BUNDLE" "${VM}":~/kepler-vm-bundle.tar.gz

# ── 3. Install ──
echo "[3/5] Installing on VM..."
ssh "$VM" bash <<'REMOTE'
set -e

# Extract into home dir (creates ~/codekepler-backend, ~/codekepler-npm, ~/tarang-ai-agent-framework)
tar xzf ~/kepler-vm-bundle.tar.gz -C ~/
rm ~/kepler-vm-bundle.tar.gz

# Symlinks for compatibility (harness uses ~/tarang-npm, backend uses ~/tarang-backend)
ln -sfn ~/codekepler-backend ~/tarang-backend
ln -sfn ~/codekepler-npm ~/tarang-npm

# System deps (idempotent)
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
fi
sudo apt-get install -y -qq python3-pip python3-venv docker.io ripgrep tmux jq 2>/dev/null
sudo usermod -aG docker $USER 2>/dev/null || true

# Backend venv
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

echo "  Dependencies installed"
REMOTE

# ── 4. CLI auth ──
echo "[4/5] Setting up CLI auth..."
# Try kepler config first, then orca
TOKEN=""
for cfg in "$HOME/.kepler/config.json" "$HOME/.orca/config.json"; do
    if [ -f "$cfg" ]; then
        TOKEN=$(python3 -c "import json; print(json.load(open('$cfg'))['token'])" 2>/dev/null || true)
        [ -n "$TOKEN" ] && break
    fi
done

if [ -z "$TOKEN" ]; then
    echo "  WARNING: No CLI token found in ~/.kepler/config.json or ~/.orca/config.json"
    echo "  You'll need to manually create ~/.kepler/config.json on the VM"
else
    ssh "$VM" bash <<REMOTE_AUTH
mkdir -p ~/.kepler ~/.orca
echo '{"token": "${TOKEN}"}' > ~/.kepler/config.json
echo '{"token": "${TOKEN}"}' > ~/.orca/config.json
chmod 600 ~/.kepler/config.json ~/.orca/config.json
echo "  CLI token configured"
REMOTE_AUTH
fi

# ── 5. Env file ──
echo "[5/5] Writing env file..."

# Try to read API key from existing env or local config
OR_KEY=$(grep -s OPENROUTER_API_KEY "$HOME/.tarang-benchmark.env" 2>/dev/null | cut -d= -f2 || true)
LIC_KEY=$(grep -s LICENSE_KEY "$PLATFORM_ROOT/codekepler-backend/.env" 2>/dev/null | cut -d= -f2 || true)

# If we can't find them locally, try reading from VM
if [ -z "$OR_KEY" ]; then
    OR_KEY=$(ssh "$VM" 'grep -s OPENROUTER_API_KEY ~/.tarang-benchmark.env 2>/dev/null | cut -d= -f2' || true)
fi
if [ -z "$LIC_KEY" ]; then
    LIC_KEY=$(ssh "$VM" 'grep -s LICENSE_KEY ~/.tarang-benchmark.env 2>/dev/null | cut -d= -f2' || true)
fi

ssh "$VM" bash <<REMOTE_ENV
cat > ~/.tarang-benchmark.env << 'ENVEOF'
SKIP_QUOTA=1
TARANG_ENV=local
OPENROUTER_API_KEY=${OR_KEY}
LICENSE_KEY=${LIC_KEY}
KEPLER_STAGNATION_DETECTION=true
KEPLER_ENHANCED_STAGNATION=true
KEPLER_STAGNATION_THRESHOLD=3
KEPLER_MEMORY_ENABLED=false
KEPLER_PREFLIGHT_PLAN=true
ENVEOF
chmod 600 ~/.tarang-benchmark.env
echo "  Env file written"
REMOTE_ENV

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  VM Ready: ${VM_IP}                                      ║"
echo "║                                                          ║"
echo "║  SSH in and start backend:                               ║"
echo "║    ssh ${VM}                                             ║"
echo "║    set -a; source ~/.tarang-benchmark.env; set +a        ║"
echo "║    source ~/backend-env/bin/activate                     ║"
echo "║    cd ~/tarang-backend                                   ║"
echo "║    nohup uvicorn app.main:app --port 8150 &              ║"
echo "║                                                          ║"
echo "║  Quick benchmark:                                        ║"
echo "║    ./benchmark/run.sh minimax/minimax-m3 --limit 1       ║"
echo "╚══════════════════════════════════════════════════════════╝"
