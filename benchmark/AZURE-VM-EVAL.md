# SWE-bench Benchmark: Azure VM Setup & Evaluation

## VM Inventory

| Name | Size | IP | State | Role |
|------|------|----|-------|------|
| `swebench-eval-vm` | D16s_v3 (16 vCPU, 64GB) | 20.9.77.9 | running | Primary |
| `swebench-eval-vm-2` | D8s_v3 (8 vCPU, 32GB) | 172.202.17.40 | deallocated | Spare |
| `swebench-eval-vm-3..5` | cloned from VM1 snapshot | — | create on demand | Parallel shards |

Resource Group: `AZ-RG-ORCA-BENCHMARK` (centralus)

## Quick Reference

```bash
RG=AZ-RG-ORCA-BENCHMARK

# Start / stop / get IP
az vm start -g $RG -n swebench-eval-vm
az vm deallocate -g $RG -n swebench-eval-vm
az vm show -d -g $RG -n swebench-eval-vm --query publicIps -o tsv

# SSH
ssh azureuser@20.9.77.9

# Emergency (SSH blocked)
az vm run-command invoke -g $RG -n swebench-eval-vm \
  --command-id RunShellScript --scripts 'sudo -u azureuser bash -c "CMD"'
```

## VM Layout

```
~/tarang-backend/              # Backend (symlink to ~/codekepler-backend)
~/tarang-npm/                  # CLI + harness (symlink to ~/codekepler-npm)
~/tarang-ai-agent-framework/   # Agent framework (pip install -e)
~/backend-env/                 # Python venv — uvicorn + backend deps
~/swebench-env/                # Python venv — swebench + datasets
~/.tarang-benchmark.env        # All env vars (API keys, flags)
~/.kepler/config.json          # CLI auth token (kepler_ or orca_ prefix)
```

## Setup from Scratch

### 1. Deploy code to VM (current practice — tarball sync)

Old `deploy-and-run.sh` and `vm-setup.sh` scripts are unused and stale. The actual sync pattern we run every time we bump framework/backend/CLI:

```bash
# From your laptop, in "Tarang Orca" parent dir:

# a. Package framework (source only, no build artifacts)
tar czf /tmp/framework.tar.gz \
  -C tarang-ai-agent-framework/agent-framework-pypi \
  --exclude='__pycache__' --exclude='*.egg-info' \
  --exclude='dist' --exclude='build' --exclude='.pytest_cache' \
  src pyproject.toml

# b. Package backend (app + configs + Dockerfile; drop junk)
tar czf /tmp/backend.tar.gz -C codekepler-backend \
  --exclude='.venv' --exclude='__pycache__' --exclude='.git' \
  --exclude='node_modules' --exclude='.pytest_cache' \
  --exclude='*.egg-info' --exclude='.mypy_cache' --exclude='dist' \
  --exclude='build' --exclude='local' --exclude='.next' \
  app configs Dockerfile

# c. Package harness only (if CLI changes, add `src` too)
tar czf /tmp/harness.tar.gz -C codekepler-npm \
  --exclude='node_modules' --exclude='__pycache__' benchmark

# d. Ship
scp /tmp/framework.tar.gz /tmp/backend.tar.gz /tmp/harness.tar.gz \
  azureuser@20.9.77.9:~/

# e. Install on VM
ssh azureuser@20.9.77.9 <<'SSH'
set -a && source ~/.tarang-benchmark.env && set +a
source ~/backend-env/bin/activate

# Extract framework and reinstall (editable)
cd ~/tarang-ai-agent-framework/agent-framework-pypi && tar xzf ~/framework.tar.gz
pip install -e . --quiet

# Extract backend + harness (overlays existing files)
cd ~/tarang-backend && tar xzf ~/backend.tar.gz
cd ~/codekepler-npm && tar xzf ~/harness.tar.gz

# Verify
python3 -c "import agent_framework; print('framework:', agent_framework.__version__)"
SSH
```

### 2. Configure environment

The env file `~/.tarang-benchmark.env` must contain:

```bash
# ── Auth / secrets ──────────────────────────────────
OPENROUTER_API_KEY=sk-or-v1-...
LICENSE_KEY=eyJ...                    # Agent framework license JWT
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# ── Backend flags ───────────────────────────────────
SKIP_QUOTA=1                          # Bypass credit-check for benchmark user
TARANG_ENV=local                      # CLI resolves to http://127.0.0.1:8150
LLM_GATEWAY=OpenRouterGateway
ENCRYPTION_SECRET=dev-secret-change-in-production

# ── Model routing (the ONLY levers that matter) ─────
# Main coder model — swap this to change the primary agent between v-runs:
PLATFORM_REASONING_MODEL=deepseek/deepseek-v4-flash

# Ceiling defaults (used when user has no per-role override):
PLATFORM_FAST_MODEL=deepseek/deepseek-v4-flash
PLATFORM_ORCHESTRATOR_MODEL=deepseek/deepseek-v4-pro

# Sub-agent per-role overrides (win over PLATFORM_ROUTING in sub_agents.py):
EXPLORER_MODEL=minimax/minimax-m3     # or: SUB_AGENT_EXPLORE_MODEL=...
PLAN_MODEL=deepseek/deepseek-v4-pro   # or: SUB_AGENT_PLAN_MODEL=...

# ── Agent behaviour flags (AGENT_* prefix, NOT KEPLER_*) ─
AGENT_MEMORY_ENABLED=false            # Prevents cross-session path leaks
AGENT_PREFLIGHT_PLAN=true             # Pre-flight plan with reasoning model
AGENT_PREFLIGHT_TIMEOUT_SECONDS=120
```

**Do NOT use `KEPLER_STAGNATION_*`, `KEPLER_MEMORY_ENABLED`, `KEPLER_PREFLIGHT_PLAN`** — those names were silently ignored by the runtime and are the reason v3-flash-rerun100 misbehaved. Everything is `AGENT_*` now.

**Priority chain for main-agent model** (per `app/services/model_defaults.py`):

1. Request `context.model_override` (CLI `--model` flag — currently no-op, see below)
2. User Supabase `default_reasoning_model` (per-user setting via web dashboard)
3. `PLATFORM_REASONING_MODEL` env var ← **this is the benchmark lever**
4. `CODER_MODEL` / `LLM_MODEL` env fallbacks
5. Hardcoded fallback `deepseek/deepseek-v4-flash`

Note: the CLI's `-m` / `--model` flag is a no-op (parser was removed). To change the main model between v-runs, **edit `PLATFORM_REASONING_MODEL` in the env file and restart the backend**.

### 3. Configure CLI auth

```bash
mkdir -p ~/.kepler
cat > ~/.kepler/config.json << 'EOF'
{"token": "orca_<YOUR_CLI_TOKEN_HASH>"}
EOF
chmod 600 ~/.kepler/config.json
```

The token is a `kepler_`, `orca_`, or `tarang_` prefixed hash stored in
Supabase `cli_tokens` table. Copy from `~/.orca/config.json` if migrating.

### 4. Start backend (tmux, not nohup)

We use tmux so the session survives SSH drops and we can `tmux attach` to watch live:

```bash
tmux kill-session -t back 2>/dev/null   # if already running
tmux new-session -d -s back "\
  set -a && source ~/.tarang-benchmark.env && set +a && \
  export LOG_DIR=~/kepler-logs && mkdir -p \$LOG_DIR && \
  cd ~/tarang-backend && source ~/backend-env/bin/activate && \
  uvicorn app.main:app --port 8150 2>&1 | tee ~/backend.log"

sleep 25   # startup takes ~20s (Supabase seed, license validate, etc.)

# Verify — no /health endpoint; root returns JSON
python3 -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8150/', timeout=3).status)"
# → 200

# Framework version
grep "agent_framework version:" ~/backend.log | tail -1

# Verify env vars picked up by uvicorn process:
UPID=$(pgrep -f "backend-env/bin/uvicorn" | head -1)
cat /proc/$UPID/environ | tr "\0" "\n" | grep -E "^(PLATFORM_|EXPLORER|PLAN|AGENT_)" | sort
```

To attach and watch live: `tmux attach -t back` (`Ctrl+B, D` to detach).

## Running Benchmarks

### Single instance (smoke test)

The `--model` flag on the harness is passed through the CLI's `-m` flag — which is a no-op after the model-flag removal. The backend picks the main model from `PLATFORM_REASONING_MODEL` env var. Set that first, then run the smoke:

```bash
source ~/swebench-env/bin/activate
cd ~/codekepler-npm
python3 benchmark/swe-bench/harness.py \
  --dataset lite \
  --model deepseek/deepseek-v4-flash \
  --instance django__django-11848 \
  --timeout 300 \
  --debug \
  --output /tmp/test-single.json
```

`--model` still goes into the results file as a label and is what the CLI passes on the command line, but the actual routing uses env. Always confirm via `[CACHE] model=<...>` in `~/backend.log`.

### Full 300 (sequential in tmux)

```bash
tmux new-session -d -s full "\
  cd ~/codekepler-npm && \
  set -a && source ~/.tarang-benchmark.env && set +a && \
  python3 benchmark/swe-bench/harness.py \
    --dataset lite \
    --model deepseek/deepseek-v4-flash \
    --parallel 2 \
    --timeout 600 \
    --skip-done \
    --output ~/results-full300_$(date +%Y%m%d_%H%M).json \
    2>&1 | tee ~/benchmark-full300_$(date +%Y%m%d_%H%M).log"

# Watch:
tmux attach -t full
# Or peek:
tail -f ~/benchmark-full300_*.log
```

**Parallel choice:**

- `--parallel 1` — safe, ~20-24h, avoids the sympy worktree race that killed v5/v6 harness mid-run
- `--parallel 2` — ~10-14h, works but may hit the sympy race and require resume with `--skip-done`
- `--parallel 4` — ~4-6h, higher risk of the race; v5 crashed twice at parallel=4

### Sharded parallel (5 VMs)

**Untested since Jun 2026** — VM2-5 have been deallocated the entire time we've been iterating. The `--gen-shards` flag referenced in older docs does not exist in the current harness. If you want to shard, use `--instance-file` with a manually-split list:

```bash
# Split the 300 instance IDs into 5 shards of 60:
python3 -c "
from datasets import load_dataset
ds = load_dataset('princeton-nlp/SWE-bench_Lite', split='test')
ids = sorted(x['instance_id'] for x in ds)
for i in range(5):
    with open(f'/tmp/shard_{i+1}.txt', 'w') as f:
        f.write('\n'.join(ids[i*60:(i+1)*60]))
    print(f'shard_{i+1}.txt: {ids[i*60]} .. {ids[(i+1)*60-1]}')
"

# On each VM (once code is deployed):
python3 benchmark/swe-bench/harness.py \
  --dataset lite \
  --model deepseek/deepseek-v4-flash \
  --instance-file /tmp/shard_N.txt \
  --parallel 1 --timeout 600 \
  --output ~/results-shard-N.json
```

The 5-VM parallel setup block below is also unverified — treat as scaffolding, not a tested procedure.

### Monitor progress

Live tail:
```bash
tail -f ~/benchmark-full300_*.log
```

Or a richer snapshot including cache hit / cost / sub-agent counts:
```bash
python3 - <<'PY'
import json, glob
for f in sorted(glob.glob(os.path.expanduser("~/results-full300_*.json"))):
    r = json.load(open(f))["results"]
    patched = sum(1 for x in r if x.get("model_patch"))
    cost = sum(x.get("kepler",{}).get("cost_usd",0) for x in r)
    inp = sum(x.get("kepler",{}).get("usage",{}).get("input_tokens",0) for x in r)
    cr  = sum(x.get("kepler",{}).get("usage",{}).get("cache_read",0) for x in r)
    subs = sum(1 for x in r if x.get("kepler",{}).get("sub_agents"))
    tim = sum(1 for x in r if x.get("kepler",{}).get("duration_s",0) >= 599.5 and not x.get("model_patch"))
    print(f"{f}: {len(r)}/300  patched: {patched} ({100*patched//max(len(r),1)}%)  cost: ${cost:.2f}  cache: {100*cr//max(inp,1)}%  subs: {subs}  timeouts: {tim}")
PY
```

## Cache Verification (PRD-071)

Before starting a long benchmark run, verify prompt caching is landing. Wasting Sonnet or Opus tokens without cache reads makes a 300-instance run 3-5× more expensive.

### Quick cache check

```bash
cd ~/tarang-npm
MODEL=<model_id> bash benchmark/cache-check.sh
# defaults to deepseek/deepseek-v4-flash — override with MODEL=anthropic/claude-sonnet-5, z-ai/glm-5.2, etc.
```

Runs a scripted calculator-fixture session and reports:

- `Input / Cache read / Cache write` tokens
- `CACHE HIT %` — auto-detects OpenAI vs Anthropic usage convention
- Cost in USD

Also writes `/tmp/cache-check/report.json` (schema `kepler.cache-report/1`) with both hit-rate conventions surfaced separately.

### Reference numbers (2026-07-12, calculator fixture, single session)

| Model | Path | Hit rate | Cost | Notes |
|---|---|---:|---:|---|
| `deepseek/deepseek-v4-flash` | OpenRouter → Fireworks/etc | 58% cold → **83% steady** | ~$0.007 | Auto-cache, no explicit writes |
| `z-ai/glm-5.2` | OpenRouter → Zhipu | 74–83% | ~$0.007–$0.013 | Auto-cache, no explicit writes |
| `anthropic/claude-sonnet-4` | OpenRouter → **Vertex** | 74% (aggregate) | ~$0.009 | `cache_write:0` — Vertex envelope hides writes |
| `claude-sonnet-5` | **Anthropic direct** | **84–88%** | ~$0.059–$0.070 | Full write reporting, 1h TTL beta live |

### Real-world workload — razorpay-testing project (`Read + write tests + run`)

Same prompt against ~1075 LOC codebase (4 Python files, no existing tests). Iteration ladder across the full PRD-071 stack:

| Model | Path | Hit rate | Cost | Tools | Duration | Outcome |
|---|---|---:|---:|---:|---:|---|
| `z-ai/glm-5.2` (baseline, all bugs) | OR → Zhipu | **43%** | $0.318 | 109 | 538s | ❌ Over-explored |
| `anthropic/claude-sonnet-5` (baseline) | OR → Vertex | **55%** | $0.018 | 17 | 101s | ❌ Misread cwd |
| `z-ai/glm-5.2` + PRD-071 partial | OR → Alibaba pinned | **59%** | $0.172 | 27 | 436s | ✅ Completed 15 tests |
| **`z-ai/glm-5.2` + PRD-071 full** | **OR → Alibaba, compression off** | **91%** | **$0.0175** | 12 | 122s | ✅ **12 tests** |

**The 91% run is the target state.** Details:
- Pure append-only history (input grows monotonically 4.2k → 14.2k)
- Zero compression events
- Steady-state 98-100% cache hit for turns 16-24
- Provider pinned to Alibaba upstream (no cross-provider variance)
- Operating-context message marked with cache_control at a fixed position (byte-stable)

**What "compression off" means in workspace.yaml**:
```yaml
context:
  compression:
    enabled: false   # PRD-071: prevents msg[0] rewrite that broke prompt cache
``` The cached-vs-fresh ratio drops.

**Cost picture on real work at 43-55% cache hit:**
- GLM 5.2: $0.318 for a 9-min session, ~$0.0029/tool — cheap even at 43% cache
- Sonnet 5 via OR-Vertex: $0.018 for a 100s session, ~$0.0011/tool — but cache_write hidden
- Extrapolating to a full 300-instance SWE-bench run: GLM ~$95, Sonnet ~$5.40 on OR-Vertex path (understated because Vertex hides writes)

**Neither model completed the task** — GLM stagnated in read loops, Sonnet misread the cwd. Cache measurement is valid regardless. For quality benchmarking, prefer harnesses that don't rely on the agent finishing gracefully.

**Consequence for benchmark budgeting:** at these hit rates, Sonnet 5 direct comes in around $18 for a 300-instance run (vs the naive uncached estimate of ~$50-70). GLM 5.2 and DeepSeek stay near $2-4 per 300-run. Verify hit rate BEFORE launching a full run — a cache regression can double the bill.

### Wiring caveats

- **`temperature`** is now stripped from requests to Sonnet 4/4.5/4.6/5 and Opus 4 (Anthropic API 400s otherwise). Patched in `app/patches/claude_gateway.py`.
- **1h TTL cache** requires the backend to send `anthropic-beta: extended-cache-ttl-2025-04-11`. Same patch handles this.
- **Vertex-served Claude via OpenRouter** hides `cache_creation_input_tokens`. If cache_write always reports 0 on Claude, you're routed through Vertex — pending fix in P5.4 (`provider: {order:["anthropic"]}` in OR request body).
- **Column `sessions.cache_creation_tokens`** — added by migration `00071_cache_write_tokens.sql`. Must be applied to any Supabase project the backend talks to (kepler-dev and appstak-dev already have it; run `supabase db push` for others).

### If cache-check reports 0%

- Backend must be running with the PRD-071 patch — check for `[patches] ClaudeGateway temperature+TTL patch installed` in the startup log.
- `~/.tarang-benchmark.env` should NOT set `KEPLER_MEMORY_ENABLED=true` for repeatable cache measurement — memory injection makes the prefix non-deterministic.
- Re-run with `KEPLER_ENV=local` (already the default in the file above).
- Watch the framework's `[CACHE]` log line via `docker logs codekepler-backend-1 -f | grep CACHE` — shows per-turn sys=cached/tools=cached/msgs=N and read/write counters at the wire.

## Docker Evaluation (Official Score)

### 1. Build predictions file

```bash
python3 << 'PYEOF'
import json, glob, os

# Merge all shard results if needed
all_results = []
for f in sorted(glob.glob(os.path.expanduser("~/results-shard-*.json"))):
    all_results.extend(json.load(open(f)).get("results", []))

# Or single file:
# all_results = json.load(open(os.path.expanduser("~/results-full.json")))["results"]

predictions = [{
    "instance_id": r["instance_id"],
    "model_patch": r.get("model_patch", ""),
    "model_name_or_path": "kepler"
} for r in all_results]

os.makedirs(os.path.expanduser("~/eval"), exist_ok=True)
out = os.path.expanduser("~/eval/predictions.json")
json.dump(predictions, open(out, "w"), indent=2)
patched = sum(1 for p in predictions if p["model_patch"])
print(f"Wrote {out}: {patched}/{len(predictions)} with patches")
PYEOF
```

### 2. Run swebench evaluation

Use `--max_workers 4` on the D16s_v3 — 6 has OOM'd once when many sympy containers were rebuilding simultaneously.

```bash
source ~/swebench-env/bin/activate
RUN_ID="kepler-eval-$(date +%Y%m%d-%H%M)"
tmux new-session -d -s eval "\
  cd ~/eval && \
  python3 -m swebench.harness.run_evaluation \
    --predictions_path ~/eval/predictions.json \
    --dataset_name princeton-nlp/SWE-bench_Lite \
    --run_id $RUN_ID \
    --max_workers 4 \
    2>&1 | tee ~/eval/docker-eval.log"

# Monitor
tmux attach -t eval
# or:
tail -f ~/eval/docker-eval.log

# Report file: ~/eval/kepler-<model>.<run-id>.json
# Contains: resolved_ids, unresolved_ids, empty_patch_ids, error_ids
```

Typical timing on D16s_v3: **~15 min per 100 patches with `--max_workers 4`.** For a full 300 with ~220 patches, budget ~40-45 min.

### 3. Score

```bash
python3 -c "
import json
r = json.load(open('kepler.kepler-eval.json'))
resolved = len(r.get('resolved_ids', r.get('resolved', [])))
total = resolved + len(r.get('unresolved_ids', r.get('unresolved', [])))
print(f'{resolved}/{total} = {100*resolved/total:.1f}%')
"
```

## 5-VM Parallel Setup

To run 300 instances across 5 VMs in ~5 hours:

### Create VMs 3–5 from VM1 snapshot

```bash
RG=AZ-RG-ORCA-BENCHMARK
LOCATION=centralus

# 1. Snapshot VM1's OS disk (VM must be running or deallocated)
DISK_ID=$(az vm show -g $RG -n swebench-eval-vm --query storageProfile.osDisk.managedDisk.id -o tsv)
az snapshot create -g $RG -n vm1-snapshot --source "$DISK_ID" -l $LOCATION

# 2. Create managed disks from snapshot
for i in 3 4 5; do
  az disk create -g $RG -n swebench-disk-$i \
    --source vm1-snapshot --size-gb 200 -l $LOCATION --sku Standard_LRS
done

# 3. Create VMs from those disks
for i in 3 4 5; do
  az vm create -g $RG -n swebench-eval-vm-$i \
    --attach-os-disk swebench-disk-$i \
    --os-type Linux --size Standard_D8s_v3 \
    -l $LOCATION --public-ip-sku Standard
done

# 4. Get IPs
for i in 1 2 3 4 5; do
  NAME="swebench-eval-vm"
  [ $i -gt 1 ] && NAME="swebench-eval-vm-$i"
  IP=$(az vm show -d -g $RG -n $NAME --query publicIps -o tsv)
  echo "VM$i ($NAME): $IP"
done
```

### Distribute shards and run

Use `benchmark/run.sh --parallel-vms` or manually:

```bash
# Generate shards
python3 benchmark/swe-bench/harness.py --dataset lite --gen-shards 5

# Deploy to each VM and start
for i in 1 2 3 4 5; do
  VM_IP=<IP_OF_VM_$i>
  ./benchmark/deploy-and-run.sh $VM_IP minimax/minimax-m3 1 \
    --skip-setup --shard=$i
done
```

### Collect and merge results

```bash
for i in 1 2 3 4 5; do
  scp azureuser@<VM${i}_IP>:~/results-shard-${i}.json /tmp/
done

python3 << 'PYEOF'
import json, glob
all_results = []
for f in sorted(glob.glob("/tmp/results-shard-*.json")):
    all_results.extend(json.load(open(f)).get("results", []))
print(f"Total: {len(all_results)} instances")
patched = sum(1 for r in all_results if r.get("model_patch"))
print(f"Patched: {patched}/{len(all_results)}")
PYEOF
```

### Cleanup (save costs)

```bash
RG=AZ-RG-ORCA-BENCHMARK
for i in 2 3 4 5; do
  az vm deallocate -g $RG -n swebench-eval-vm-$i --no-wait
done
# Delete clones when no longer needed:
# for i in 3 4 5; do
#   az vm delete -g $RG -n swebench-eval-vm-$i --yes
#   az disk delete -g $RG -n swebench-disk-$i --yes
# done
# az snapshot delete -g $RG -n vm1-snapshot
```

## Results History

### Full 300 SWE-bench Lite runs (Docker-evaluated)

| Run | Date | Framework | Main model | Patched | **Resolved** | Cost | Cache | Notes |
|---|---|---|---|---:|---:|---:|---:|---|
| v1-v4 | Jun 2026 | pre-PRD-071 | DS V4 Flash | see RESULTS.md | 28–36.8% | $6–14 | 40–50% | Baseline runs, harness contamination in v1/v2 |
| **v5** | 2026-07-15 | 3.2.7 | DS V4 Flash | 212 (71%) | **142 (47.3%)** | $4.14 | 91% | +PRD-071 cache parity |
| **v6** | 2026-07-15 | 3.2.7 | Tencent HY3 (free) | 230 (77%) | **133 (44.3%)** | $0 | 93% | Free-tier main; sub-agents never fired |
| **v7** | 2026-07-17 | 3.2.7 | GLM 5.2 | 235 (78%) | **183 (61.0%)** | $46 | 94% | Top of SWE-bench Lite leaderboard tier |

### Hard-10 A/B tests (10 v5-failed instances)

Used to iterate framework changes without spending 12h + $30 on a full 300 run each time.

| Framework | Model | Patched | **Resolved** | Cost | Sub-agents fired |
|---|---|---:|---:|---:|---:|
| v5 baseline | DS Flash (old code) | 0/10 | 0 | ~$0.50 | 10 (old counting) |
| 3.4.4 | DS Flash | 1/10 | 0 | $0.10 | 0 |
| 3.4.4 | GLM 5.2 | 3/10 | 1 | $1.05 | 0 |
| **3.4.13** | **DS Flash** | **8/10** | **4** | **$0.40** | **2** |
| 3.4.13 | GLM 5.2 | 4/10 | 2 | $0.50 | 0 |
| 3.4.13 | Kimi K3 | 1/10 | 1 | $0.62 | 0 |
| 3.4.14 | DS Flash | 5/10 | 2 | $0.20 | 1 |
| 3.4.14 | GLM 5.2 | 4/10 | 2 | $0.39 | 0 |
| 3.4.14 | Kimi K3 | 3/10 | 2 | $2.57 | 0 |

### Cache-check calibration (single-session smoke, calculator fixture)

| Model | Path | Hit rate | Cost | Date |
|---|---|---:|---:|---:|
| DS V4 Flash | OR → Fireworks | 58% cold → 83% steady | ~$0.007 | 2026-07-12 |
| GLM 5.2 | OR → Zhipu | 74–83% | ~$0.007–$0.013 | 2026-07-12 |
| Claude Sonnet 5 (direct) | Anthropic API | 84–88% | ~$0.059–$0.070 | 2026-07-12 |

Full artifacts per run at `benchmark/results/runs/swebench-<vN>-<model>-300/`. See `benchmark/results/RESULTS.md` for narrative and cross-run analysis.

## Troubleshooting

**Auth fails (401)**:
- Check `~/.kepler/config.json` has a `kepler_` or `orca_` prefixed token
- The LICENSE_KEY JWT is for framework licensing, NOT for CLI auth
- Verify token exists in Supabase `cli_tokens` table

**Backend won't start**:
- Check `LICENSE_KEY` is set: `grep LICENSE_KEY ~/.tarang-benchmark.env`
- Check port free: `fuser 8150/tcp` (kill if occupied)
- Check logs: `tail -50 ~/backend.log`

**Stale uvicorn from previous session**:
- `pkill -f "uvicorn app.main:app"` then wait 2s, verify with `pgrep -x uvicorn`
- Restart with `set -a; source ~/.tarang-benchmark.env; set +a` to pick up flags

**Agent explores wrong directory**:
- `AGENT_MEMORY_ENABLED=false` prevents cross-session path injection (NOT `KEPLER_MEMORY_ENABLED` — that was silently ignored)
- Clean `/tmp/kepler-swe-bench` between runs if stale indexes persist

**Preflight plan not generating**:
- `AGENT_PREFLIGHT_PLAN=true` must be in the env file (NOT `KEPLER_PREFLIGHT_PLAN`)
- Check gateway class matches `PLATFORM_ROUTING` in `sub_agents.py` (needs `OpenRouterV2Gateway` entry)
- Logs: `grep -iE "preflight|plan.*sub-agent" ~/backend.log`

**Main model isn't what the harness says**:
- The CLI's `-m` / `--model` flag is a no-op — parser was removed. `[CACHE] model=...` in the backend log is authoritative.
- Real routing lever is `PLATFORM_REASONING_MODEL` env var. Restart backend after changing it.
- Sub-agent routing lever: `EXPLORER_MODEL`, `PLAN_MODEL` (or the `SUB_AGENT_*_MODEL` variants).

**Orphan Kepler session after killing the harness**:
- The backend's uvicorn keeps running the agent loop even after the SSE client (harness) disconnects. Killing the harness tmux does NOT stop the LLM calls.
- To fully stop, `tmux kill-session -t back` and restart uvicorn. Otherwise the orphan will burn tokens until it hits `max_iterations: 100`.

**Harness crashes with `FileNotFoundError: /tmp/kepler-swe-bench/sympy__sympy/<hash>`**:
- Known race between parallel workers on the sympy worktree. Doesn't affect completed instances.
- Recover with `--skip-done` (the results file up to the crash is preserved).
- Reduce `--parallel` to 1 to avoid entirely.

**OpenRouter HTTP 402 (Payment Required) at the start of a run**:
- Balance may be over the per-request reservation threshold OR at $0.
- Check: `KEY=$(grep OPENROUTER_API_KEY ~/.tarang-benchmark.env | cut -d= -f2); curl -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/credits`
- Top up to at least $10-20 free balance for DeepSeek Flash workloads, $50+ for GLM 5.2 / Kimi K3 (they have larger per-request reservations).
