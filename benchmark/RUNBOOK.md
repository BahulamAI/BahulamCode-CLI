# Benchmark Runbook

Step-by-step guide for running SWE-bench and Terminal-bench evaluations.

## VM Inventory

| VM | Name | Size | IP | Role |
|----|------|------|----|------|
| VM1 | swebench-eval-vm | D16s_v3 (16 vCPU) | 20.9.77.9 | Docker eval + terminal-bench |
| VM2 | swebench-eval-vm-2 | D4s_v3 (4 vCPU) | 172.202.17.40 | SWE-bench shard runner |
| VM3 | swebench-eval-vm-3 | D4s_v3 (4 vCPU) | 104.43.140.29 | SWE-bench shard runner |
| VM4 | swebench-eval-vm-4 | D4s_v3 (4 vCPU) | 74.249.204.194 | SWE-bench shard runner |
| VM5 | swebench-eval-vm-5 | D4s_v3 (4 vCPU) | 20.29.69.244 | SWE-bench shard runner |

Resource Group: `AZ-RG-ORCA-BENCHMARK` (centralus)

## VM Management

```bash
RG=AZ-RG-ORCA-BENCHMARK

# Start all VMs
for i in "" "-2" "-3" "-4" "-5"; do
  az vm start -g $RG -n swebench-eval-vm$i --no-wait
done

# Get IPs (may change after restart)
for i in "" "-2" "-3" "-4" "-5"; do
  echo -n "swebench-eval-vm$i: "
  az vm show -d -g $RG -n swebench-eval-vm$i --query publicIps -o tsv
done

# Stop all VMs (save costs)
for i in "-2" "-3" "-4" "-5"; do
  az vm deallocate -g $RG -n swebench-eval-vm$i --no-wait
done
```

---

## Part 1: Code Deployment

### 1.1 Package and deploy to all VMs

From your laptop, in the `Tarang Orca` directory:

```bash
# Package everything
cd "/Users/sree/Sites/Tarang Orca"
tar czf /tmp/kepler-sync.tar.gz \
  --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' \
  --exclude='.venv' --exclude='node_modules' --exclude='.next' \
  --exclude='benchmark/results' --exclude='_legacy' \
  codekepler-backend/app/ \
  codekepler-backend/configs/ \
  codekepler-backend/requirements.txt \
  codekepler-backend/.env \
  tarang-ai-agent-framework/agent-framework-pypi/src/ \
  tarang-ai-agent-framework/agent-framework-pypi/setup.py \
  tarang-ai-agent-framework/agent-framework-pypi/pyproject.toml \
  codekepler-npm/src/ \
  codekepler-npm/benchmark/swe-bench/ \
  codekepler-npm/benchmark/shards/ \
  codekepler-npm/package.json

# Deploy to each VM
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo "Deploying to $IP..."
  scp /tmp/kepler-sync.tar.gz azureuser@$IP:~/kepler-sync.tar.gz
  ssh azureuser@$IP 'cd ~ && tar xzf kepler-sync.tar.gz && rm kepler-sync.tar.gz && \
    rm -f ~/tarang-backend ~/tarang-npm && \
    ln -sfn ~/codekepler-backend ~/tarang-backend && \
    ln -sfn ~/codekepler-npm ~/tarang-npm && \
    source ~/backend-env/bin/activate && \
    pip install -e ~/tarang-ai-agent-framework/agent-framework-pypi/ --quiet && \
    echo "OK"'
done
```

### 1.2 Set up CLI auth on each VM

```bash
# Use the same token as local (~/.kepler/config.json)
TOKEN='{"token": "kepler_3f396fbdaed7ce42163b315b3a124db44e231f36106e02da79a714df409dc393"}'
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@$IP "mkdir -p ~/.kepler ~/.orca && \
    echo '$TOKEN' > ~/.kepler/config.json && \
    echo '$TOKEN' > ~/.orca/config.json && \
    chmod 600 ~/.kepler/config.json ~/.orca/config.json"
done
```

### 1.3 Clear license locks (if switching license keys)

```bash
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@$IP 'sudo rm -f /var/lib/agent_framework/.license_lock'
done
```

### 1.4 Verify env file on each VM

Each VM needs `~/.tarang-benchmark.env` with:

```bash
SKIP_QUOTA=1
TARANG_ENV=local
OPENROUTER_API_KEY=sk-or-v1-...
LICENSE_KEY=eyJ...
KEPLER_STAGNATION_DETECTION=true
KEPLER_ENHANCED_STAGNATION=true
KEPLER_STAGNATION_THRESHOLD=3
KEPLER_MEMORY_ENABLED=false
KEPLER_PREFLIGHT_PLAN=true
KEPLER_PREFLIGHT_TIMEOUT_SECONDS=120
```

Verify:
```bash
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo -n "$IP: "
  ssh azureuser@$IP 'grep -c "=" ~/.tarang-benchmark.env'
  echo " vars"
done
```

---

## Part 2: SWE-bench Lite (300 instances)

### 2.1 Generate shard files (if not already present)

```bash
# 5 shards of 60 (full 300)
ssh azureuser@20.9.77.9 'source ~/swebench-env/bin/activate && python3 -c "
from datasets import load_dataset
import os, math
ds = load_dataset(\"princeton-nlp/SWE-bench_Lite\", split=\"test\")
ids = sorted([x[\"instance_id\"] for x in ds])
for n_shards, prefix in [(5, \"shard\"), (4, \"shard4\")]:
    chunk = math.ceil(len(ids) / n_shards)
    os.makedirs(os.path.expanduser(\"~/codekepler-npm/benchmark/shards\"), exist_ok=True)
    for i in range(n_shards):
        shard = ids[i*chunk:(i+1)*chunk]
        path = os.path.expanduser(f\"~/codekepler-npm/benchmark/shards/{prefix}_{i+1}.txt\")
        with open(path, \"w\") as f:
            f.write(chr(10).join(shard) + chr(10))
        print(f\"  {prefix}_{i+1}.txt: {len(shard)} instances\")
"'
```

Or use existing shards:
```bash
# Copy from local
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@$IP 'mkdir -p ~/codekepler-npm/benchmark/shards'
  scp benchmark/shards/shard_*.txt azureuser@$IP:~/codekepler-npm/benchmark/shards/
done
```

### 2.2 Upload shard files to each VM

For 4-VM run (VMs 2-5, 75 instances each):
```bash
# Split 300 into 4 shards of 75
cat benchmark/shards/shard_*.txt > /tmp/all300.txt
split -l 75 /tmp/all300.txt /tmp/shard75_

# Upload
scp /tmp/shard75_aa azureuser@172.202.17.40:~/shard.txt
scp /tmp/shard75_ab azureuser@104.43.140.29:~/shard.txt
scp /tmp/shard75_ac azureuser@74.249.204.194:~/shard.txt
scp /tmp/shard75_ad azureuser@20.29.69.244:~/shard.txt
```

### 2.3 Start backends on all VMs

```bash
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@$IP 'kill $(pgrep -x uvicorn) 2>/dev/null; sleep 1; \
    set -a; source ~/.tarang-benchmark.env; set +a; \
    export LOG_DIR=~/kepler-logs; \
    cd ~/tarang-backend; source ~/backend-env/bin/activate; \
    nohup uvicorn app.main:app --port 8000 > ~/backend.log 2>&1 &'
done

# Verify (wait 15s)
sleep 15
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo -n "$IP: "
  ssh azureuser@$IP 'curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health'
  echo ""
done
```

### 2.4 Start benchmark run

```bash
MODEL="deepseek/deepseek-v4-flash"  # or deepseek/deepseek-v4-pro
DATE=$(date +%Y%m%d_%H%M)
SHARD=1

for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  SHARD=$((SHARD + 1))
  RUN_ID="${MODEL//\//_}_${DATE}_shard${SHARD}"
  echo "Starting shard $SHARD on $IP..."
  ssh azureuser@$IP "tmux new-session -d -s bench '\
    export TARANG_ENV=local; \
    source ~/swebench-env/bin/activate; \
    cd ~/codekepler-npm; \
    python3 benchmark/swe-bench/harness.py \
      --dataset lite \
      --model $MODEL \
      --parallel 1 \
      --timeout 600 \
      --instance-file ~/shard.txt \
      --output ~/results-${RUN_ID}.json \
      2>&1 | tee ~/benchmark-${RUN_ID}.log'"
done
```

### 2.5 Monitor progress

```bash
# Quick status
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo -n "$IP: "
  ssh azureuser@$IP 'RESULT=$(ls -t ~/results-*.json 2>/dev/null | head -1); \
    python3 -c "import json; d=json.load(open(\"$RESULT\")); r=d[\"results\"]; \
    edited=sum(1 for x in r if x.get(\"kepler\",{}).get(\"tool_breakdown\",{}).get(\"edit_file\",0)>0); \
    tested=sum(1 for x in r if x.get(\"kepler\",{}).get(\"tool_breakdown\",{}).get(\"run_tests\",0)>0); \
    print(f\"{len(r)}/75, {edited} edited, {tested} tested\")" 2>/dev/null'
done

# Detailed telemetry
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo "=== $IP ==="
  ssh azureuser@$IP 'grep "CACHE\|COMPLETE" ~/backend.log | tail -5' | \
    sed 's/\x1b\[[0-9;]*m//g'
done
```

### 2.6 Collect results

```bash
# Download from all VMs
mkdir -p /tmp/bench_results
for i in 2 3 4 5; do
  case $i in
    2) IP=172.202.17.40;; 3) IP=104.43.140.29;;
    4) IP=74.249.204.194;; 5) IP=20.29.69.244;;
  esac
  RESULT=$(ssh azureuser@$IP 'ls -t ~/results-*.json 2>/dev/null | head -1')
  scp azureuser@$IP:"$RESULT" /tmp/bench_results/shard${i}.json
done

# Merge and build predictions
python3 << 'PYEOF'
import json, glob
all_results = []
for f in sorted(glob.glob("/tmp/bench_results/shard*.json")):
    all_results.extend(json.load(open(f)).get("results", []))

predictions = [{"instance_id": r["instance_id"],
                "model_patch": r.get("model_patch", ""),
                "model_name_or_path": "kepler"} for r in all_results]

with open("/tmp/bench_results/predictions.json", "w") as f:
    json.dump(predictions, f, indent=2)

patched = sum(1 for p in predictions if p["model_patch"])
edited = sum(1 for r in all_results if r.get("kepler",{}).get("tool_breakdown",{}).get("edit_file",0) > 0)
print(f"Total: {len(all_results)}, edited={edited}, patched={patched}")
PYEOF
```

### 2.7 Run Docker evaluation (on VM1)

```bash
# Upload predictions to VM1
scp /tmp/bench_results/predictions.json azureuser@20.9.77.9:~/eval/predictions.json

# Start Docker eval (6 workers on D16s_v3)
ssh azureuser@20.9.77.9 'source ~/swebench-env/bin/activate && \
  nohup python3 -m swebench.harness.run_evaluation \
    --predictions_path ~/eval/predictions.json \
    --dataset_name princeton-nlp/SWE-bench_Lite \
    --run_id kepler-eval \
    --max_workers 6 \
    > ~/eval/docker-eval.log 2>&1 &'

# Monitor
ssh azureuser@20.9.77.9 'tail -c 200 ~/eval/docker-eval.log | \
  tr "\r" "\n" | grep -o "✓=[0-9]*.*✖=[0-9]*" | tail -1'

# Get final result
ssh azureuser@20.9.77.9 'python3 -c "
import json
d = json.load(open(\"kepler.kepler-eval.json\"))
resolved = d.get(\"resolved_ids\", d.get(\"resolved\", []))
total = len(resolved) + len(d.get(\"unresolved_ids\", d.get(\"unresolved\", [])))
print(f\"{len(resolved)}/{total} = {100*len(resolved)/total:.1f}%\")
"'
```

### 2.8 Save results

```bash
# Copy Docker eval result
scp azureuser@20.9.77.9:~/kepler.kepler-eval.json \
  /tmp/bench_results/docker-eval.json

# Save to standardized location
RUN_DIR="benchmark/results/runs/swebench-<RUN_NAME>"
mkdir -p "$RUN_DIR"
cp /tmp/bench_results/predictions.json "$RUN_DIR/"
# Merge harness results into one file
python3 -c "
import json, glob
results = []
for f in sorted(glob.glob('/tmp/bench_results/shard*.json')):
    results.extend(json.load(open(f)).get('results', []))
json.dump({'results': results}, open('$RUN_DIR/harness-results.json', 'w'), indent=2)
"
cp /tmp/bench_results/docker-eval.json "$RUN_DIR/"
```

---

## Part 3: Terminal-bench

### 3.1 Setup (one-time on VM1)

```bash
ssh azureuser@20.9.77.9 << 'EOF'
if [ ! -d ~/tbench-env ]; then
    python3 -m venv ~/tbench-env
fi
source ~/tbench-env/bin/activate
pip install --quiet terminal-bench
tb --help > /dev/null && echo "tb CLI: OK"
EOF
```

### 3.2 Start backend on port 8001

```bash
ssh azureuser@20.9.77.9 'set -a; source ~/.tarang-benchmark.env; set +a; \
  export LOG_DIR=~/kepler-logs; \
  cd ~/tarang-backend; source ~/backend-env/bin/activate; \
  nohup uvicorn app.main:app --port 8001 > ~/backend-tbench.log 2>&1 &'

# Verify
sleep 12
ssh azureuser@20.9.77.9 'curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/health'
```

### 3.3 Upload adapter

```bash
scp benchmark/terminal-bench/kepler_agent.py azureuser@20.9.77.9:~/kepler_agent.py
```

### 3.4 Run terminal-bench

```bash
ssh azureuser@20.9.77.9 'source ~/tbench-env/bin/activate; \
  export PYTHONPATH=~; \
  tmux new-session -d -s tbench "\
    source ~/tbench-env/bin/activate && \
    export PYTHONPATH=~ && \
    tb run \
      --dataset terminal-bench-core==0.1.1 \
      --agent-import-path kepler_agent:KeplerAgent \
      --model deepseek/deepseek-v4-flash \
      -k backend_url=http://127.0.0.1:8001 \
      --run-id kepler-tbench \
      --output-path ~/tbench-results \
      2>&1 | tee ~/benchmark-tbench.log"'
```

### 3.5 Run specific tasks only

```bash
ssh azureuser@20.9.77.9 'source ~/tbench-env/bin/activate; \
  export PYTHONPATH=~; \
  tb run \
    --dataset terminal-bench-core==0.1.1 \
    --agent-import-path kepler_agent:KeplerAgent \
    --model deepseek/deepseek-v4-flash \
    -k backend_url=http://127.0.0.1:8001 \
    --run-id kepler-retry \
    --output-path ~/tbench-retry \
    --task-id swe-bench-astropy-1 \
    --task-id cartpole-rl-training \
    --task-id play-zork'
```

### 3.6 Check terminal-bench results

```bash
ssh azureuser@20.9.77.9 'python3 -c "
import json
d = json.load(open(\"~/tbench-results/kepler-tbench/results.json\"))
print(f\"{d[\"n_resolved\"]}/{d[\"n_resolved\"]+d[\"n_unresolved\"]} = {d[\"accuracy\"]*100:.0f}%\")
for r in d[\"results\"]:
    s = \"✓\" if r[\"is_resolved\"] else \"✗\"
    print(f\"  {s} {r[\"task_id\"]}\")
"'
```

---

## Part 4: Troubleshooting

### Backend won't start

```bash
# Check error
tail -20 ~/backend.log

# Common: license lock mismatch
sudo rm -f /var/lib/agent_framework/.license_lock

# Common: missing module
source ~/backend-env/bin/activate
pip install -e ~/tarang-ai-agent-framework/agent-framework-pypi/
pip install anthropic  # if using Claude gateway
```

### Auth fails (401)

```bash
# Check token
cat ~/.kepler/config.json

# Token must exist in Supabase cli_tokens table
# Verify: run locally with same token to test
```

### Agent runs but 0 tools / 0.2s

```bash
# TARANG_ENV not set — CLI connects to production instead of local
export TARANG_ENV=local

# Verify backend is receiving requests
grep "EXECUTE" ~/backend.log | wc -l
```

### Credits exhausted

```bash
# Check OpenRouter dashboard for credit balance
# Top up at https://openrouter.ai/settings/credits
# Or switch to a different API key
```

### Stale uvicorn from previous session

```bash
pkill -f "uvicorn app.main:app"
sleep 2
pgrep -x uvicorn  # should be empty
```

### Docker eval stuck on last instance

```bash
# Kill and check results (N-1 instances evaluated)
pkill -f run_evaluation
ls ~/kepler*.json  # result file should exist
```

---

## Part 5: Quick reference

### Check all VMs at once

```bash
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo -n "$IP: "
  ssh -o ConnectTimeout=5 azureuser@$IP 'RESULT=$(ls -t ~/results-*.json 2>/dev/null | head -1); \
    python3 -c "import json; d=json.load(open(\"$RESULT\")); \
    print(f\"{len(d[\"results\"])}/75\")" 2>/dev/null || echo "no results"'
done
```

### Kill everything on all VMs

```bash
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@$IP 'tmux kill-session -t bench 2>/dev/null; \
    kill $(pgrep -x uvicorn) 2>/dev/null; echo "cleaned"'
done
```

### VM filesystem layout

```
~/codekepler-backend/     # Backend (actual code)
~/codekepler-npm/         # CLI + harness (actual code)
~/tarang-backend/         # Symlink → codekepler-backend
~/tarang-npm/             # Symlink → codekepler-npm
~/tarang-ai-agent-framework/  # Agent framework
~/backend-env/            # Python venv for backend
~/swebench-env/           # Python venv for SWE-bench + datasets
~/tbench-env/             # Python venv for terminal-bench (VM1 only)
~/.tarang-benchmark.env   # All env vars
~/.kepler/config.json     # CLI auth token
~/eval/                   # Docker eval predictions + logs
~/results-*.json          # Harness output files
~/benchmark-*.log         # Harness console logs
~/backend*.log            # Backend logs
```
