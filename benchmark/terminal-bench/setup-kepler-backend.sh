#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

BACKEND_DIR=${BACKEND_DIR:-"${REPO_ROOT}/../tarang-backend"}
FRAMEWORK_DIR=${FRAMEWORK_DIR:-"${REPO_ROOT}/../tarang-ai-agent-framework"}
VENV_DIR=${VENV_DIR:-"${REPO_ROOT}/.venv-terminal-bench-backend"}

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/pip" install -e "$BACKEND_DIR" "mcp>=1.9.0"
"$VENV_DIR/bin/pip" install -e "$FRAMEWORK_DIR/agent-framework-pypi"

echo "Kepler Terminal-Bench backend environment: $VENV_DIR"
