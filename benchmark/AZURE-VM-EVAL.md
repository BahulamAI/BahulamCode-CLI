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
nohup uvicorn app.main:app --port 8000 > ~/backend.log 2>&1 &

# Verify
curl -s http://localhost:8000/health
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

| Run | Model | Score | Cost | Date |
|-----|-------|-------|------|------|
| Full 300 | deepseek-v4-flash | 115/300 = 38.3% | ~$10 | June 2026 |
| Regression 35 | deepseek-v4-flash | 10/35 new | union 125/300 = 41.7% | June 2026 |
| Smoke 3 | deepseek-v4-flash | 3/3 resolved | $0.026/inst | June 2026 |
| V4 Pro 28 | deepseek-v4-pro | 14/28 = 50.0% | $0.48/inst | June 2026 |

## Troubleshooting

**Auth fails (401)**:
- Check `~/.kepler/config.json` has a `kepler_` or `orca_` prefixed token
- The LICENSE_KEY JWT is for framework licensing, NOT for CLI auth
- Verify token exists in Supabase `cli_tokens` table

**Backend won't start**:
- Check `LICENSE_KEY` is set: `grep LICENSE_KEY ~/.tarang-benchmark.env`
- Check port free: `fuser 8000/tcp` (kill if occupied)
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
