#!/usr/bin/env bash
#
# End-to-end environment smoke test for Bahulam Code CLI.
#
# Tests the CLI against three environments a typical developer might use:
#   1. local       — Docker Compose backend on this machine (needs `docker compose up backend`)
#   2. dev         — Bahulam Cloud dev on Azure (treetop, needs internet + valid dev token)
#   3. production  — Bahulam Cloud live on Azure (needs internet + valid prod token)
#   4. bundled     — Local Python runtime shipped in the CLI (needs runtime installed)
#
# Each test:
#   - Verifies the target is reachable (HTTP 200 on /openapi.json for cloud/local; runtime health for bundled)
#   - Runs a single trivial prompt in headless mode
#   - Reports success / failure with the observed response shape
#
# Usage:
#   bash scripts/test-environments.sh              # runs all four
#   bash scripts/test-environments.sh local        # runs just one
#   bash scripts/test-environments.sh dev bundled  # runs a subset

set -uo pipefail   # note: NOT -e; we want to keep going even if one env fails

readonly LOCAL_URL="http://127.0.0.1:8150"
readonly DEV_URL="https://codekepler-backend-dev.kindisland-9034322d.eastus.azurecontainerapps.io"
readonly PROD_URL="https://codekepler-backend-prod.gentlerock-9816c6b8.centralus.azurecontainerapps.io"

readonly CLI_BIN="node $(cd "$(dirname "$0")/.." && pwd)/src/terminal/main.mjs"
readonly PROMPT="say hello in one word"
readonly PASS="✓"
readonly FAIL="✗"

_probe_reachable() {
  local url="$1"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${url}/openapi.json" 2>/dev/null || echo "000")
  if [[ "$status" == "200" ]]; then return 0; fi
  return 1
}

_probe_bundled() {
  local runtime_bin="$HOME/.bahulam/runtime/current/bin/bahulam-agent"
  if [[ ! -x "$runtime_bin" ]]; then return 1; fi
  return 0
}

_run_headless() {
  local env_name="$1" url_override="${2:-}"
  local args=(--headless -p "$PROMPT")
  local env_prefix=(TARANG_ENV="$env_name")
  if [[ -n "$url_override" ]]; then env_prefix+=(TARANG_BACKEND_URL="$url_override"); fi

  local output
  output=$(env "${env_prefix[@]}" $CLI_BIN "${args[@]}" 2>&1 | tail -50)
  local exit_code=$?
  echo "  exit=$exit_code"
  echo "  last 3 lines:"
  echo "$output" | tail -3 | sed 's/^/    /'
  return $exit_code
}

_run_env() {
  local env_name="$1"
  echo ""
  echo "═══ $env_name ═══"

  case "$env_name" in
    local)
      if _probe_reachable "$LOCAL_URL"; then
        echo "  ${PASS} Docker backend reachable at $LOCAL_URL"
        _run_headless local
      else
        echo "  ${FAIL} Docker backend not reachable at $LOCAL_URL"
        echo "  hint: cd ~/Sites/Tarang-Orca/codekepler-deploy-dashboard && docker compose up -d backend"
        return 1
      fi
      ;;
    dev|treetop)
      if _probe_reachable "$DEV_URL"; then
        echo "  ${PASS} Dev backend reachable at $DEV_URL"
        _run_headless dev
      else
        echo "  ${FAIL} Dev backend not reachable"
        return 1
      fi
      ;;
    production|prod)
      if _probe_reachable "$PROD_URL"; then
        echo "  ${PASS} Prod backend reachable at $PROD_URL"
        _run_headless production
      else
        echo "  ${FAIL} Prod backend not reachable"
        return 1
      fi
      ;;
    bundled)
      if _probe_bundled; then
        local ver
        ver=$($HOME/.bahulam/runtime/current/bin/bahulam-agent --version 2>&1)
        echo "  ${PASS} Bundled runtime installed"
        echo "  version: $ver"
        _run_headless bundled
      else
        echo "  ${FAIL} Bundled runtime not installed"
        echo "  hint: ADO_PAT=... bash /Users/sree/Sites/Tarang-Orca/codekepler-backend/scripts/build-cli-runtime-darwin.sh"
        echo "        tar -xzf bahulam-agent-darwin-*.tar.gz -C ~/.bahulam/runtime/"
        echo "        ln -sfn ~/.bahulam/runtime/bahulam-agent-darwin-*/ ~/.bahulam/runtime/current"
        return 1
      fi
      ;;
    *)
      echo "  Unknown environment: $env_name"
      return 2
      ;;
  esac
}

# Which environments to run — command-line args, or all four.
if [[ $# -eq 0 ]]; then
  ENVS=(local dev production bundled)
else
  ENVS=("$@")
fi

echo "Bahulam Code CLI — environment smoke test"
echo "Prompt: ${PROMPT}"
echo "Testing: ${ENVS[*]}"

FAILURES=0
for env in "${ENVS[@]}"; do
  if ! _run_env "$env"; then
    FAILURES=$((FAILURES + 1))
  fi
done

echo ""
echo "═══ Summary ═══"
if [[ $FAILURES -eq 0 ]]; then
  echo "  ${PASS} All ${#ENVS[@]} environments passed"
  exit 0
else
  echo "  ${FAIL} ${FAILURES} of ${#ENVS[@]} environments failed"
  exit 1
fi
