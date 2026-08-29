#!/bin/bash
# Setup Terminal-Bench on Azure VM
# Run: ssh azureuser@20.9.77.9 < setup-terminal-bench.sh

set -euo pipefail

echo "╔══════════════════════════════════════════╗"
echo "║  Terminal-Bench Setup                     ║"
echo "╚══════════════════════════════════════════╝"

# Python env
if [ ! -d ~/tbench-env ]; then
    echo "[1/4] Creating Python environment..."
    python3 -m venv ~/tbench-env
else
    echo "[1/4] Python env exists"
fi

source ~/tbench-env/bin/activate

# Install terminal-bench
echo "[2/4] Installing terminal-bench..."
pip install --quiet terminal-bench 2>&1 | tail -3

# Verify
echo "[3/4] Verifying installation..."
tb --help > /dev/null 2>&1 && echo "  tb CLI: OK" || echo "  tb CLI: FAILED"
docker --version > /dev/null 2>&1 && echo "  Docker: OK" || echo "  Docker: FAILED"

# Create results directory
mkdir -p ~/benchmark/results/terminal-bench

echo "[4/4] Setup complete!"
echo ""
echo "Run benchmark:"
echo "  source ~/tbench-env/bin/activate"
echo "  export OPENROUTER_API_KEY=\$OPENROUTER_API_KEY"
echo "  tb run --agent terminus --model deepseek/deepseek-v4-flash --dataset terminal-bench-core==0.1.1"
