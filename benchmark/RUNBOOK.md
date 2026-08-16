# Benchmark Runbook

Run SWE-bench and Terminal-bench with the public Bahulam CLI path:

```text
npm CLI -> bundled Python runtime -> Bahulam Gateway -> model provider
```

The benchmark VMs should not run `codekepler-backend`, `tarang-ai-agent-framework`
source, or direct provider keys for the normal CLI benchmark. The runtime is
already bundled into a platform-specific npm package or supplied as a tarball.

## VM Inventory

| VM | Name | Size | IP | Role | Status |
|----|------|------|----|------|--------|
| VM1 | swebench-eval-vm | D16s_v3 (16 vCPU) | 172.173.113.58 | Docker eval + hard-10 bundled runtime | DEALLOCATED 2026-08-15 (disks + IP retained) |
| VM2 | swebench-eval-vm-2 | D4s_v3 (4 vCPU) | (was 172.202.17.40) | SWE-bench shard runner | DECOMMISSIONED — VM deleted, network shell remains |
| VM3 | swebench-eval-vm-3 | D4s_v3 (4 vCPU) | (was 104.43.140.29) | SWE-bench shard runner | DECOMMISSIONED — VM deleted, network shell remains |
| VM4 | swebench-eval-vm-4 | D4s_v3 (4 vCPU) | (was 74.249.204.194) | SWE-bench shard runner | DECOMMISSIONED — VM deleted, network shell remains |
| VM5 | swebench-eval-vm-5 | D4s_v3 (4 vCPU) | (was 20.29.69.244) | SWE-bench shard runner | DECOMMISSIONED — VM deleted, network shell remains |

Resource Group: `AZ-RG-ORCA-BENCHMARK` in `centralus`.

**Current state (2026-08-15):** Only VM1 exists (deallocated). VMs 2–5 were deleted prior to this run; the RG retains only their NSGs (`swebench-eval-vm{,-2,-3,-4,-5}NSG`), the VNET (`swebench-eval-vmVNET`), and the subnet (`swebench-eval-vmSubnet`). Rebuild any VM via `az vm create` reusing the existing VNET/NSG. VM1 disk contains all benchmark artifacts from the 2026-08-15 bundled-runtime hard-10 runs (delegation-tuned + baseline-reverted); restart with `az vm start -g AZ-RG-ORCA-BENCHMARK -n swebench-eval-vm`.

## VM Management

```bash
RG=AZ-RG-ORCA-BENCHMARK

for i in "" "-2" "-3" "-4" "-5"; do
  az vm start -g "$RG" -n "swebench-eval-vm$i" --no-wait
done

for i in "" "-2" "-3" "-4" "-5"; do
  echo -n "swebench-eval-vm$i: "
  az vm show -d -g "$RG" -n "swebench-eval-vm$i" --query publicIps -o tsv
done

for i in "-2" "-3" "-4" "-5"; do
  az vm deallocate -g "$RG" -n "swebench-eval-vm$i" --no-wait
done
```

## What Goes To The VM

Copy only the benchmark inputs and the CLI/runtime artifacts:

| Item | Required | Destination | Notes |
|------|----------|-------------|-------|
| `codekepler-npm` source checkout or tarball | Yes | `~/codekepler-npm` | Must include `package.json`, `package-lock.json`, `src/`, `benchmark/swe-bench/`, `benchmark/model-comparison/`, and `benchmark/terminal-bench/` if terminal-bench is needed. |
| Linux runtime tarball | Yes when testing an unpublished runtime | `~/runtime-tarballs/` | Example: `bahulam-runtime-linux-x64-<version>.tgz`. Linux VMs cannot use a Darwin runtime tarball. |
| Shard file | Yes for shard VMs | `~/shard.txt` | One file per SWE-bench runner VM. |
| Benchmark env file | Yes | `~/.bahulam-benchmark.env` | Contains gateway URL, runtime mode, and token exports. `chmod 600`. |
| Bahulam CLI token config | Optional | `~/.bahulam/config.json` | Use this instead of exporting `B0_TOKEN` if the VM has completed `bahulam login`. |
| SWE-bench predictions | Docker eval only | `~/eval/predictions.json` on VM1 | Produced after shard runs finish. |

Do not copy these for the normal bundled CLI path:

- `codekepler-backend`
- `tarang-ai-agent-framework` source
- backend `.env` files
- `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or other direct provider keys
- `TARANG_BACKEND_URL`
- `SKIP_QUOTA`
- `TARANG_ENV=local`

BYOK remains a Bahulam Gateway/user-account concern. Do not copy BYOK provider
keys onto benchmark VMs for the bundled CLI route.

## Required Variables

Create `~/.bahulam-benchmark.env` on every VM and source it before a run.

```bash
cat > ~/.bahulam-benchmark.env << 'EOF'
export BAHULAM_RUNTIME_MODE=bundled
export TARANG_ENV=bundled
export BAHULAM_PRODUCT=bahulam
export LLM_GATEWAY=BahulamGateway

export BAHULAM_GATEWAY_URL=https://gateway.bahulam.ai/v1
export LICENSE_PORTAL_URL=https://gateway.bahulam.ai/portal

export EXECUTION_MODE=retail
export AGENT_MEMORY_ENABLED=false
export KEPLER_MEMORY_ENABLED=false
export KEPLER_STAGNATION_DETECTION=true
export KEPLER_ENHANCED_STAGNATION=true
export KEPLER_STAGNATION_THRESHOLD=3
export KEPLER_PREFLIGHT_PLAN=true
export KEPLER_PREFLIGHT_TIMEOUT_SECONDS=120
EOF

chmod 600 ~/.bahulam-benchmark.env
```

Set one user token path:

```bash
read -rsp "Bahulam user CLI token (b0_...): " B0_TOKEN_VALUE
echo
printf '\nexport B0_TOKEN=%q\n' "$B0_TOKEN_VALUE" >> ~/.bahulam-benchmark.env
unset B0_TOKEN_VALUE
```

Or write the login config instead:

```bash
mkdir -p ~/.bahulam
chmod 700 ~/.bahulam
read -rsp "Bahulam user CLI token (b0_...): " B0_TOKEN_VALUE
echo
printf '{"token":"%s"}\n' "$B0_TOKEN_VALUE" > ~/.bahulam/config.json
chmod 600 ~/.bahulam/config.json
unset B0_TOKEN_VALUE
```

For dev gateway testing, replace the two gateway URLs:

```bash
export BAHULAM_GATEWAY_URL=https://bahulam-gateway-dev.<domain>/v1
export LICENSE_PORTAL_URL=https://bahulam-gateway-dev.<domain>/portal
```

You do not need to run a gateway on the benchmark VM unless the benchmark is
explicitly validating a local gateway build. In that case, point the two gateway
URLs at that local gateway.

Only set `BAHULAM_RUNTIME_ROOT` when bypassing the npm runtime package and
pointing at an extracted runtime directory:

```bash
export BAHULAM_RUNTIME_ROOT=/absolute/path/to/bahulam-runtime-linux-x64
```

## Local Mac Setup

Use this to smoke-test before sending artifacts to Linux VMs.

```bash
cd /Users/sree/Sites/Tarang-Orca/codekepler-npm
npm ci --include=optional
```

If testing a local Darwin runtime tarball:

```bash
npm install --no-save \
  /Users/sree/Sites/Tarang-Orca/codekepler-bahulam-runtime/dist/2.6.12-local.3/bahulam-runtime-darwin-arm64-2.6.12-local.3.tgz
```

Or point directly at an extracted local runtime:

```bash
export BAHULAM_RUNTIME_ROOT=/Users/sree/Sites/Tarang-Orca/codekepler-bahulam-runtime/dist/2.6.12-local.3/darwin-arm64
```

Verify runtime discovery:

```bash
source ~/.bahulam-benchmark.env
node -e "import('./src/core/bundled-runtime.mjs').then(m => console.log(JSON.stringify(m.runtimeInfo(), null, 2)))"
RUNTIME_BIN=$(node -e "import('./src/core/bundled-runtime.mjs').then(m => console.log(m.runtimeInfo().bin))")
"$RUNTIME_BIN" --version
```

Smoke-test the headless CLI:

```bash
source ~/.bahulam-benchmark.env
BAHULAM_RUNTIME_DEBUG=1 \
  node src/terminal/main.mjs --headless --verbose --timeout 180 \
  -p 'Say exactly OK.' | tee /tmp/bahulam-cli-smoke.jsonl

jq 'select(.type == "complete") | {tools, usage, rate_limit, sub_agents}' \
  /tmp/bahulam-cli-smoke.jsonl
```

## Package For Linux VMs

If using the published package version, a normal `npm ci --include=optional`
on Linux should install `@bahulam/runtime-linux-x64` automatically.

If testing a local runtime build, copy the Linux runtime tarball. Do not copy a
Darwin runtime tarball to the Linux benchmark VMs.

```bash
cd /Users/sree/Sites/Tarang-Orca/codekepler-npm

tar czf /tmp/bahulam-npm-benchmark-src.tgz \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='benchmark/results' \
  --exclude='.DS_Store' \
  .

RUNTIME_TARBALL=/Users/sree/Sites/Tarang-Orca/codekepler-bahulam-runtime/dist/<version>/bahulam-runtime-linux-x64-<version>.tgz

for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@"$IP" 'rm -rf ~/codekepler-npm && mkdir -p ~/codekepler-npm ~/runtime-tarballs'
  scp /tmp/bahulam-npm-benchmark-src.tgz azureuser@"$IP":~/
  scp "$RUNTIME_TARBALL" azureuser@"$IP":~/runtime-tarballs/
  ssh azureuser@"$IP" 'tar xzf ~/bahulam-npm-benchmark-src.tgz -C ~/codekepler-npm'
done
```

Install on each VM:

```bash
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@"$IP" 'cd ~/codekepler-npm && npm ci --include=optional'
done
```

If using the copied local Linux runtime tarball:

```bash
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@"$IP" 'cd ~/codekepler-npm && npm install --no-save ~/runtime-tarballs/bahulam-runtime-linux-x64-*.tgz'
done
```

Copy the env file to all VMs after creating it locally, or create it on each VM:

```bash
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  scp ~/.bahulam-benchmark.env azureuser@"$IP":~/.bahulam-benchmark.env
  ssh azureuser@"$IP" 'chmod 600 ~/.bahulam-benchmark.env'
done
```

Verify each VM can find and start the bundled runtime:

```bash
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo "=== $IP ==="
  ssh azureuser@"$IP" 'source ~/.bahulam-benchmark.env && cd ~/codekepler-npm && node -e "import(\"./src/core/bundled-runtime.mjs\").then(m => console.log(JSON.stringify(m.runtimeInfo(), null, 2)))"'
done
```

## SWE-Bench Smoke Run

Local one-instance smoke:

```bash
cd /Users/sree/Sites/Tarang-Orca/codekepler-npm
source ~/.bahulam-benchmark.env

python3 -m venv ~/swebench-env
source ~/swebench-env/bin/activate
python -m pip install --upgrade pip
python -m pip install datasets swebench

python3 benchmark/swe-bench/harness.py \
  --dataset lite \
  --limit 1 \
  --model deepseek/deepseek-v4-flash \
  --timeout 600 \
  --debug \
  --output /tmp/bahulam-swe-smoke.json
```

Persistent hard-10 smoke through the same bundled runtime:

```bash
cd /Users/sree/Sites/Tarang-Orca/codekepler-npm
source ~/.bahulam-benchmark.env

node benchmark/model-comparison/prep-swe-repos.mjs \
  --reset \
  --questions benchmark/model-comparison/questions-swe-hard10.json

node benchmark/model-comparison/run-persistent.mjs \
  --questions benchmark/model-comparison/questions-swe-hard10.json \
  --label bahulam-bundled-$(date +%Y%m%d-%H%M) \
  --model deepseek/deepseek-v4-flash \
  --route platform \
  --timeout 480
```

## SWE-Bench VM Run

Create shard files on VM1 if they are not already present:

```bash
ssh azureuser@20.9.77.9 'source ~/swebench-env/bin/activate && python3 - << "PY"
from datasets import load_dataset
import math
from pathlib import Path

ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
ids = sorted(x["instance_id"] for x in ds)
out = Path("~/codekepler-npm/benchmark/shards").expanduser()
out.mkdir(parents=True, exist_ok=True)
chunk = math.ceil(len(ids) / 4)
for i in range(4):
    shard = ids[i * chunk:(i + 1) * chunk]
    path = out / f"shard4_{i + 1}.txt"
    path.write_text("\n".join(shard) + "\n")
    print(path, len(shard))
PY'
```

Or copy existing local shards:

```bash
for IP in 20.9.77.9 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@"$IP" 'mkdir -p ~/codekepler-npm/benchmark/shards'
  scp benchmark/shards/shard*.txt azureuser@"$IP":~/codekepler-npm/benchmark/shards/
done
```

Upload one shard to each runner VM:

```bash
scp benchmark/shards/shard4_1.txt azureuser@172.202.17.40:~/shard.txt
scp benchmark/shards/shard4_2.txt azureuser@104.43.140.29:~/shard.txt
scp benchmark/shards/shard4_3.txt azureuser@74.249.204.194:~/shard.txt
scp benchmark/shards/shard4_4.txt azureuser@20.29.69.244:~/shard.txt
```

Start the four shard runs. This starts no backend process; the CLI spawns the
bundled runtime inside each `node` process.

```bash
MODEL=deepseek/deepseek-v4-flash
DATE=$(date +%Y%m%d_%H%M)
SHARD=0

for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  SHARD=$((SHARD + 1))
  RUN_ID="bahulam_${MODEL//\//_}_${DATE}_shard${SHARD}"
  echo "Starting shard $SHARD on $IP..."
  ssh azureuser@"$IP" "tmux new-session -d -s bench '\
    source ~/.bahulam-benchmark.env && \
    source ~/swebench-env/bin/activate && \
    cd ~/codekepler-npm && \
    python3 benchmark/swe-bench/harness.py \
      --dataset lite \
      --model $MODEL \
      --parallel 1 \
      --timeout 600 \
      --instance-file ~/shard.txt \
      --output ~/results-${RUN_ID}.json \
      --skip-done \
      --debug \
      2>&1 | tee ~/benchmark-${RUN_ID}.log'"
done
```

Monitor progress:

```bash
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo "=== $IP ==="
  ssh azureuser@"$IP" 'RESULT=$(ls -t ~/results-*.json 2>/dev/null | head -1); test -n "$RESULT" || { echo "no results yet"; exit 0; }; RESULT="$RESULT" python3 - << PY
import json, os
path = os.environ["RESULT"]
d = json.load(open(path))
r = d.get("results", [])
edited = sum(1 for x in r if x.get("kepler", {}).get("tool_breakdown", {}).get("edit_file", 0) > 0)
tested = sum(1 for x in r if x.get("kepler", {}).get("tool_breakdown", {}).get("run_tests", 0) > 0)
print(f"{len(r)} done, {edited} edited, {tested} tested")
PY'
done
```

Inspect the latest complete event for tools, usage, and sub-agents:

```bash
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo "=== $IP ==="
  ssh azureuser@"$IP" 'RESULT=$(ls -t ~/results-*.json 2>/dev/null | head -1); test -n "$RESULT" || exit 0; jq ".results[-1].kepler | {tools, tool_breakdown, sub_agents, usage, stderr}" "$RESULT"'
done
```

Collect and merge results:

```bash
mkdir -p /tmp/bench_results

for i in 1 2 3 4; do
  case "$i" in
    1) IP=172.202.17.40 ;;
    2) IP=104.43.140.29 ;;
    3) IP=74.249.204.194 ;;
    4) IP=20.29.69.244 ;;
  esac
  RESULT=$(ssh azureuser@"$IP" 'ls -t ~/results-*.json 2>/dev/null | head -1')
  scp azureuser@"$IP":"$RESULT" "/tmp/bench_results/shard${i}.json"
done

python3 - << 'PY'
import glob
import json

all_results = []
for f in sorted(glob.glob("/tmp/bench_results/shard*.json")):
    all_results.extend(json.load(open(f)).get("results", []))

predictions = [
    {
        "instance_id": r["instance_id"],
        "model_patch": r.get("model_patch", ""),
        "model_name_or_path": "bahulam-code",
    }
    for r in all_results
]

with open("/tmp/bench_results/predictions.json", "w") as f:
    json.dump(predictions, f, indent=2)

patched = sum(1 for p in predictions if p["model_patch"])
edited = sum(
    1
    for r in all_results
    if r.get("kepler", {}).get("tool_breakdown", {}).get("edit_file", 0) > 0
)
print(f"Total: {len(all_results)}, edited={edited}, patched={patched}")
PY
```

## Docker Evaluation On VM1

The runbook assumes the SWE-bench Docker images are already built or pulled on
VM1. It does not build images. If `swebench.harness.run_evaluation` starts
building missing images, stop the run and prepare the VM image cache separately.

Preflight:

```bash
ssh azureuser@20.9.77.9 'docker images --format "{{.Repository}}:{{.Tag}}" | grep -Ei "swe|sweb" | head'
```

Run evaluation:

```bash
ssh azureuser@20.9.77.9 'mkdir -p ~/eval'
scp /tmp/bench_results/predictions.json azureuser@20.9.77.9:~/eval/predictions.json

ssh azureuser@20.9.77.9 'source ~/swebench-env/bin/activate && \
  nohup python3 -m swebench.harness.run_evaluation \
    --predictions_path ~/eval/predictions.json \
    --dataset_name princeton-nlp/SWE-bench_Lite \
    --run_id bahulam-code-eval \
    --max_workers 6 \
    > ~/eval/docker-eval.log 2>&1 &'
```

Monitor and collect:

```bash
ssh azureuser@20.9.77.9 'tail -f ~/eval/docker-eval.log'

scp azureuser@20.9.77.9:~/bahulam-code.bahulam-code-eval.json \
  /tmp/bench_results/docker-eval.json
```

Save a local run bundle:

```bash
cd /Users/sree/Sites/Tarang-Orca/codekepler-npm
RUN_DIR="benchmark/results/runs/swebench-bahulam-$(date +%Y%m%d-%H%M)"
mkdir -p "$RUN_DIR"
cp /tmp/bench_results/predictions.json "$RUN_DIR/"
cp /tmp/bench_results/docker-eval.json "$RUN_DIR/"

python3 - << PY
import glob
import json
results = []
for f in sorted(glob.glob("/tmp/bench_results/shard*.json")):
    results.extend(json.load(open(f)).get("results", []))
json.dump({"results": results}, open("$RUN_DIR/harness-results.json", "w"), indent=2)
PY
```

## Terminal-Bench

Terminal-bench still uses the SSE HTTP API shape, so start the bundled runtime
directly on a fixed local port and point the Terminal-bench adapter at it.

One-time setup on VM1:

```bash
ssh azureuser@20.9.77.9 'python3 -m venv ~/tbench-env && \
  source ~/tbench-env/bin/activate && \
  pip install --upgrade pip && \
  pip install terminal-bench'
```

Start bundled runtime on port `8001`:

```bash
ssh azureuser@20.9.77.9 'source ~/.bahulam-benchmark.env && \
  cd ~/codekepler-npm && \
  RUNTIME_BIN=$(node -e "import(\"./src/core/bundled-runtime.mjs\").then(m => console.log(m.runtimeInfo().bin))") && \
  tmux kill-session -t bahulam-runtime 2>/dev/null || true && \
  tmux new-session -d -s bahulam-runtime "source ~/.bahulam-benchmark.env && exec \"$RUNTIME_BIN\" --port 8001"'

ssh azureuser@20.9.77.9 'curl -s http://127.0.0.1:8001/healthz'
```

Run Terminal-bench:

```bash
scp benchmark/terminal-bench/kepler_agent.py azureuser@20.9.77.9:~/kepler_agent.py

ssh azureuser@20.9.77.9 'source ~/tbench-env/bin/activate && \
  source ~/.bahulam-benchmark.env && \
  export PYTHONPATH=~ && \
  tb run \
    --dataset terminal-bench-core==0.1.1 \
    --agent-import-path kepler_agent:KeplerAgent \
    --model deepseek/deepseek-v4-flash \
    -k backend_url=http://127.0.0.1:8001 \
    --run-id bahulam-tbench \
    --output-path ~/tbench-results \
    2>&1 | tee ~/benchmark-tbench.log'
```

## Troubleshooting

Runtime not found:

```bash
cd ~/codekepler-npm
source ~/.bahulam-benchmark.env
node -e "import('./src/core/bundled-runtime.mjs').then(m => console.log(JSON.stringify(m.runtimeInfo(), null, 2)))"
ls -la node_modules/@bahulam/runtime-linux-x64/bin
```

Authentication fails with `401`:

```bash
source ~/.bahulam-benchmark.env
test -n "$B0_TOKEN" && echo "B0_TOKEN present"
test -f ~/.bahulam/config.json && jq '{token_present: (.token | type == "string")}' ~/.bahulam/config.json
echo "$BAHULAM_GATEWAY_URL"
```

The CLI reports product `kepler`:

```bash
cd ~/codekepler-npm
rg -n "BAHULAM_PRODUCT|this.product|product = 'bahulam'" src
node -e "import('./src/core/bundled-runtime.mjs').then(m => console.log(m.runtimeInfo()))"
```

Zero tools or zero content:

```bash
source ~/.bahulam-benchmark.env
cd ~/codekepler-npm
BAHULAM_RUNTIME_DEBUG=1 node src/terminal/main.mjs --headless --verbose --timeout 180 -p 'Inspect this repository and list the top-level files.' | tee /tmp/bahulam-debug.jsonl
jq -r 'select(.type == "error" or .type == "complete")' /tmp/bahulam-debug.jsonl
```

Docker evaluation starts building images:

```bash
pkill -f swebench.harness.run_evaluation
docker images --format "{{.Repository}}:{{.Tag}}" | grep -Ei "swe|sweb" | head
```

Low prompt-cache numbers:

- Use the persistent runner when comparing models.
- Keep the same gateway URL, model, runtime version, and framework version for a run.
- Avoid injecting per-instance volatile text into the shared system/context prefix.
- Compare gateway logs for `cache_creation_input_tokens` and `cache_read_input_tokens`.

## Quick Reference

Check all shard VMs:

```bash
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  echo "=== $IP ==="
  ssh -o ConnectTimeout=5 azureuser@"$IP" 'tmux ls 2>/dev/null || true; RESULT=$(ls -t ~/results-*.json 2>/dev/null | head -1); test -n "$RESULT" && jq ".results | length" "$RESULT" || echo "no results"'
done
```

Stop benchmark sessions:

```bash
for IP in 172.202.17.40 104.43.140.29 74.249.204.194 20.29.69.244; do
  ssh azureuser@"$IP" 'tmux kill-session -t bench 2>/dev/null || true'
done
ssh azureuser@20.9.77.9 'tmux kill-session -t bahulam-runtime 2>/dev/null || true'
```

Expected VM filesystem layout:

```text
~/codekepler-npm/              CLI source and benchmark harness
~/runtime-tarballs/            Optional copied runtime npm tarballs
~/swebench-env/                Python venv for datasets and SWE-bench
~/tbench-env/                  Python venv for Terminal-bench on VM1
~/.bahulam-benchmark.env       Runtime, gateway, and benchmark variables
~/.bahulam/config.json         Optional saved Bahulam user CLI token
~/shard.txt                    Assigned SWE-bench shard on runner VMs
~/results-*.json               Harness output files
~/benchmark-*.log              Harness console logs
~/eval/                        Docker eval predictions and logs on VM1
```
