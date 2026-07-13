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

### 1. Deploy code to VM

From your laptop (with repos checked out under a common parent dir):

```bash
./benchmark/deploy-and-run.sh <VM_IP> <MODEL> [PARALLEL] [OPTIONS]

# Examples:
./benchmark/deploy-and-run.sh 20.9.77.9 deepseek/deepseek-v4-flash 1
./benchmark/deploy-and-run.sh 20.9.77.9 minimax/minimax-m3 1 --skip-setup
```

Or use `vm-setup.sh` for setup-only (no benchmark run):

```bash
./benchmark/vm-setup.sh
```

### 2. Configure environment

The env file `~/.tarang-benchmark.env` must contain:

```bash
# Required
OPENROUTER_API_KEY=sk-or-v1-...
LICENSE_KEY=eyJ...                    # Agent framework license JWT
SKIP_QUOTA=1
TARANG_ENV=local

# Recommended
KEPLER_STAGNATION_DETECTION=true
KEPLER_ENHANCED_STAGNATION=true
KEPLER_STAGNATION_THRESHOLD=3
KEPLER_MEMORY_ENABLED=false           # Prevents cross-session path leaks
KEPLER_PREFLIGHT_PLAN=true            # Pre-flight plan with reasoning model
```

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

### 4. Start backend manually

```bash
set -a; source ~/.tarang-benchmark.env; set +a
export LOG_DIR=~/kepler-logs
source ~/backend-env/bin/activate
cd ~/tarang-backend
nohup uvicorn app.main:app --port 8150 > ~/backend.log 2>&1 &

# Verify
curl -s http://localhost:8150/health
# Check env flags are loaded:
tr "\0" "\n" < /proc/$(pgrep -x uvicorn | head -1)/environ | grep KEPLER
```

## Running Benchmarks

### Single instance (smoke test)

```bash
source ~/swebench-env/bin/activate
cd ~/tarang-npm
python3 benchmark/swe-bench/harness.py \
  --dataset lite \
  --model minimax/minimax-m3 \
  --instance django__django-11848 \
  --timeout 300 \
  --debug \
  --output /tmp/test-single.json
```

### Full 300 (sequential, ~24h)

```bash
source ~/swebench-env/bin/activate
cd ~/tarang-npm
nohup python3 benchmark/swe-bench/harness.py \
  --dataset lite \
  --model minimax/minimax-m3 \
  --parallel 1 \
  --timeout 600 \
  --skip-done \
  --output ~/results-full.json \
  > ~/benchmark-full.log 2>&1 &
```

### Sharded parallel (5 VMs, ~5h)

See `run.sh --shard` or manually:

```bash
# Generate shard files (run once on any machine with swebench-env)
python3 benchmark/swe-bench/harness.py --dataset lite --gen-shards 5

# This creates:
#   benchmark/shards/shard_1.txt  (60 instance IDs)
#   benchmark/shards/shard_2.txt  (60 instance IDs)
#   ...
#   benchmark/shards/shard_5.txt  (60 instance IDs)

# On each VM, run its shard:
python3 benchmark/swe-bench/harness.py \
  --dataset lite \
  --model minimax/minimax-m3 \
  --instance-file benchmark/shards/shard_N.txt \
  --timeout 600 \
  --output ~/results-shard-N.json
```

### Monitor progress

```bash
# Count completed instances
cat ~/results-*.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
r = d.get('results', [])
ok = sum(1 for x in r if x.get('model_patch'))
print(f'{ok}/{len(r)} patched ({len(r)} done)')
"

# Tail the log
tail -f ~/benchmark-full.log
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

### Real-world workload — razorpay-testing project (`Explain → write tests → run`)

Same prompt against ~1075 LOC codebase (4 Python files, no existing tests):

| Model | Path | Hit rate | Cost | Tools | Duration | Outcome |
|---|---|---:|---:|---:|---:|---|
| `z-ai/glm-5.2` | OR → Zhipu | **43%** | $0.318 | 109 | 538s | ❌ Over-explored (95 read_file), no test file written |
| `anthropic/claude-sonnet-5` | OR → Vertex | **55%** | $0.018 | 17 | 101s | ❌ Misread cwd, gave up early |

**Insight** — real projects hit rate is materially lower than the calculator fixture (43-55% vs 74-88%). Reason: real work has more unique tool_result content per turn (reading different files each time), and only the growing system prompt + tools + prior history stay stable. The cached-vs-fresh ratio drops.

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

```bash
source ~/swebench-env/bin/activate
nohup python3 -m swebench.harness.run_evaluation \
  --predictions_path ~/eval/predictions.json \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --run_id kepler-eval \
  --max_workers 6 \
  > ~/eval/docker-eval.log 2>&1 &

# Monitor
tail -f ~/eval/docker-eval.log

# Results file: ~/kepler.kepler-eval.json
# Contains: resolved_ids, error_ids, etc.
```

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

| Run | Model | Score | Cost | Cache hit | Date |
|-----|-------|-------|------|-----------|------|
| Full 300 | deepseek-v4-flash | 115/300 = 38.3% | ~$10 | n/m | June 2026 |
| Regression 35 | deepseek-v4-flash | 10/35 new | union 125/300 = 41.7% | n/m | June 2026 |
| Smoke 3 | deepseek-v4-flash | 3/3 resolved | $0.026/inst | n/m | June 2026 |
| V4 Pro 28 | deepseek-v4-pro | 14/28 = 50.0% | $0.48/inst | n/m | June 2026 |
| Cache-check calc | deepseek-v4-flash | 3/3 resolved | $0.007/inst | 83% steady | 2026-07-12 |
| Cache-check calc | z-ai/glm-5.2 | 3/3 resolved | $0.007-$0.013/inst | 74-83% | 2026-07-12 |
| Cache-check calc | claude-sonnet-5 (direct) | 3/3 resolved | $0.06-$0.07/inst | 84-88% | 2026-07-12 |

*"n/m" = not measured. Pre-PRD-071 runs didn't capture cache metrics; starting 2026-07-12, `--cache-report` is wired through and all new runs get hit-rate + write-tokens recorded.*

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
- `KEPLER_MEMORY_ENABLED=false` prevents cross-session path injection
- Clean `/tmp/kepler-swe-bench` between runs if stale indexes persist

**Preflight plan not generating**:
- `KEPLER_PREFLIGHT_PLAN=true` must be in the env file
- Check gateway class matches PLATFORM_ROUTING (needs OpenRouterV2Gateway entry)
- Logs: `grep PreflightPlan ~/backend.log`
