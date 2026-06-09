# SWE-bench Benchmark: Azure VM Setup & Run Guide

## VM Details

| Field | Value |
|-------|-------|
| Resource Group | `AZ-RG-ORCA-BENCHMARK` |
| VM Name | `swebench-eval-vm` |
| Location | centralus |
| Size | Standard_D4s_v3 (4 vCPU, 16GB RAM) |
| OS | Ubuntu 24.04 LTS (x86_64) |
| Disk | 100GB |
| Public IP | `20.9.77.9` (may change after deallocate/start) |
| User | `azureuser` |
| Cost | ~$0.19/hr |
| GitHub SSH | `axplusbtechdev` account has VM's deploy key |

## VM Management

```bash
# Start VM
az vm start --resource-group AZ-RG-ORCA-BENCHMARK --name swebench-eval-vm

# Get IP (may change after restart)
az vm show -d --resource-group AZ-RG-ORCA-BENCHMARK --name swebench-eval-vm --query publicIps -o tsv

# SSH in
ssh azureuser@20.9.77.9

# Stop VM (saves cost, keeps disk)
az vm deallocate --resource-group AZ-RG-ORCA-BENCHMARK --name swebench-eval-vm

# If SSH is blocked, use Azure run-command:
az vm run-command invoke --resource-group AZ-RG-ORCA-BENCHMARK --name swebench-eval-vm \
  --command-id RunShellScript --scripts 'sudo -u azureuser bash -c "YOUR_COMMAND"'
```

## What's Installed on VM

```
~/tarang-backend/           # Backend (git clone, git pull to update)
~/tarang-npm/               # CLI + benchmark harness
~/tarang-ai-agent-framework/  # Agent framework (pip install -e)
~/backend-env/              # Python venv for backend
~/swebench-env/             # Python venv for swebench + datasets
~/start-benchmark.sh        # Main entry point
~/.kepler/config.json       # CLI auth token
```

## How to Run a Benchmark

### Step 1: Start VM and update code

```bash
az vm start --resource-group AZ-RG-ORCA-BENCHMARK --name swebench-eval-vm
ssh azureuser@20.9.77.9

# Pull latest backend (includes agent prompt changes)
cd ~/tarang-backend && git pull origin main
```

### Step 2: Run single instance (quick test)

```bash
export AGENT_FRAMEWORK_TOKEN=internal-local-dev
export SKIP_QUOTA=1
export TARANG_ENV=local
export OPENROUTER_API_KEY=sk-or-v1-...

# Start backend
source ~/backend-env/bin/activate
cd ~/tarang-backend
uvicorn app.main:app --port 8000 &
sleep 10

# Run one instance
source ~/swebench-env/bin/activate
cd ~/tarang-npm
python3 benchmark/swe-bench/harness.py \
  --dataset lite \
  --model deepseek/deepseek-v4-flash \
  --instance django__django-11848 \
  --timeout 300 \
  --debug \
  --output /tmp/test-single.json

# Check result
cat /tmp/test-single.json | python3 -m json.tool | head -20

pkill -f uvicorn
```

### Step 3: Run batch (multiple instances)

```bash
# Use start-benchmark.sh (starts backend + runs harness)
# Usage: ./start-benchmark.sh MODEL LIMIT EXTRA_ARGS

# 10 instances with flash
./start-benchmark.sh deepseek/deepseek-v4-flash 10

# Full 300 (background, ~3 hours)
nohup ./start-benchmark.sh deepseek/deepseek-v4-flash > /tmp/bench-full.log 2>&1 &

# Monitor
tail -f /tmp/bench-full.log
grep -c "\[.*\/300\]" /tmp/bench-full.log
```

### Step 4: Docker evaluation (get actual score)

```bash
# Build predictions from harness results
python3 << 'PYEOF'
import json, os
d = json.load(open("/home/azureuser/tarang-npm/benchmark/results/MODEL_SLUG_lite.json"))
predictions = [{"instance_id": r["instance_id"], "model_patch": r.get("model_patch", ""), "model_name_or_path": "MODEL"} for r in d["results"]]
os.makedirs("benchmark/results/official/MODEL_SLUG", exist_ok=True)
json.dump(predictions, open("benchmark/results/official/MODEL_SLUG/predictions.json", "w"), indent=2)
print(f"{sum(1 for p in predictions if p['model_patch'])}/{len(predictions)} with patches")
PYEOF

# Run swebench Docker eval
source ~/swebench-env/bin/activate
nohup python3 -m swebench.harness.run_evaluation \
  --predictions_path ~/tarang-npm/benchmark/results/official/MODEL_SLUG/predictions.json \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --run_id kepler-RUN_NAME \
  --max_workers 4 \
  > /tmp/swebench-eval.log 2>&1 &

# Monitor
tail -f /tmp/swebench-eval.log

# Results appear as: deepseek__deepseek-v4-flash.kepler-RUN_NAME.json
```

### Step 5: Copy results back to laptop

```bash
scp azureuser@20.9.77.9:~/deepseek*.json ~/Sites/Tarang\ Orca/tarang-npm/benchmark/results/official/
scp -r azureuser@20.9.77.9:~/tarang-npm/benchmark/results/debug/ ~/Sites/Tarang\ Orca/tarang-npm/benchmark/results/debug-latest/
```

## Important Notes

- `AGENT_FRAMEWORK_TOKEN=internal-local-dev` MUST be exported before starting backend
- `LICENSE_KEY` in .env/.env.development causes JWT validation failure (placeholder public key in source install) — remove it or ensure AGENT_FRAMEWORK_TOKEN is checked first
- Backend needs ~10s to start (seed templates + scheduler) — health check may fail at 5s
- `start-benchmark.sh` already has AGENT_FRAMEWORK_TOKEN and SKIP_QUOTA exported
- Patches are saved incrementally — safe to kill mid-run, no data loss
- Debug traces saved to `benchmark/results/debug/{instance_id}_stdout.txt`

## Benchmark Results History

### V4 Flash (300 instances, June 2026)
- **30.7%** resolve rate (92/300)
- Cost: ~$10 total ($0.034/instance on OpenRouter)

### V4 Pro (28 instance sample, June 2026)
- **50.0%** resolve rate (14/28)
- Cost: ~$16 total ($0.48/instance on OpenRouter)

### Phase 1 Optimized Agent (5 instance test, June 2026)
- 2/5 previously failed instances now resolve
- django__django-11848: timeout → RESOLVED
- astropy__astropy-12907: timeout → RESOLVED
- Agent improvements: line-range reads, test-after-edit, manual verification
