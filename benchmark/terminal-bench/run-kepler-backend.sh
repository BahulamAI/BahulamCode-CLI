#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ENV_FILE=${ENV_FILE:-"${REPO_ROOT}/.tarang-tbench.env"}
BACKEND_DIR=${BACKEND_DIR:-"${REPO_ROOT}/../tarang-backend"}
VENV_DIR=${VENV_DIR:-"${REPO_ROOT}/.venv-terminal-bench-backend"}
PORT=${PORT:-8001}

set -a
source "$ENV_FILE"
set +a

cd "$BACKEND_DIR"
exec "$VENV_DIR/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$PORT"
