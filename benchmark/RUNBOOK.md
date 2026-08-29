# Benchmark Runbook

Run SWE-bench and Terminal-bench with the public Bahulam CLI path.

## Pipeline (Railway inference + VM1 Docker eval)

Inference runs on Railway (cheap, one-shot container per candidate model). Docker
evaluation runs on VM1 (the only surviving Azure VM). Artifacts flow through the
public `bahulam-benchmarks` repo on GitHub.

```text
Railway container (bahulam-screening project)
  └─ npm install -g @bahulam/code@latest
  └─ python3 screen.py --model <slug> --output-dir /data/screen-<slug>-<date>/
       ├─ preflight_tools_accepted (gateway probe)
       ├─ preflight_pricing (OpenRouter snapshot)
       ├─ harness.py --instance-file <config>
       └─ push-to-benchmarks.sh  →  screening/<run_id> branch on bahulam-benchmarks
                                    (predictions.json + predictions-raw.json +
                                     screening-report.json + pricing.json +
                                     preflight-tools.json + harness.log)

VM1 (swebench-eval-vm, deallocated when idle)
  └─ git pull the screening/<run_id> branch
  └─ swebench.harness.run_evaluation  →  docker-eval.json
  └─ verify-and-report.py  →  merges into screening-report.json
                              flips gates_verdict PENDING-VM → PASS/REJECT
  └─ commit + push to same branch
  └─ (open PR to main via gh)
```

The Azure shard VMs (VMs 2-5) are decommissioned. Only VM1 remains, and only for
Docker eval + Terminal-bench.

## Railway Inventory

| Item | Value |
|------|-------|
| Project | `bahulam-screening` (id `5752685d-0c17-4c9f-9a3c-887b58f1be68`) |
| Region | US East |
| Restart policy | `NEVER` — one-shot per deploy |
| Image build source | `/Users/sree/Sites/Tarang-Orca/bahulam-benchmarks/screening/` (Dockerfile + screen.py + configs + scripts) |
| Base image | `python:3.11-slim` + Node 22 + `npm install -g @bahulam/code@latest` |

One Railway service per candidate model. Each service has its own volume, env
vars, and log stream.

| Service | Volume | Purpose |
|---------|--------|---------|
| `bahulam-screening-worker` | `bahulam-screening-worker-volume` at `/data` (5 GB) | Default worker; flip `CANDIDATE_MODEL` to reuse |
| `bahulam-screening-ox-alpha` | `bahulam-screening-ox-alpha-volume` at `/data` (5 GB) | Example: dedicated per-model service |

Adding a new per-model service (parallel to the worker):

```bash
railway add \
  --service bahulam-screening-<slug> \
  -v "B0_TOKEN=$(jq -r .token ~/.bahulam/config.json)" \
  -v "BENCHMARKS_GH_TOKEN=<PAT from pass.md>" \
  -v "BENCHMARKS_REPO=BahulamAI/bahulam-benchmarks" \
  -v "BAHULAM_GATEWAY_URL=https://gateway.bahulam.ai/v1" \
  -v "BAHULAM_RUNTIME_MODE=bundled" \
  -v "LLM_GATEWAY=BahulamGateway" \
  -v "HARNESS_TIMEOUT_S=1200" \
  -v "HARNESS_PARALLEL=3" \
  -v "CANDIDATE_MODEL=<vendor>/<model-slug>" \
  -v "SCREENING_INSTANCE_FILE=screening-300.txt"

railway service link bahulam-screening-<slug>
railway volume add --mount-path /data     # interactive prompt confirms path
railway up --detach                        # builds image, runs screen once
```

## Required Environment Variables

Set on every Railway service via `railway variables --set KEY=VALUE`.

| Var | Purpose |
|-----|---------|
| `B0_TOKEN` | Bahulam CLI token from `~/.bahulam/config.json`; rotates frequently — refresh via `railway variables --set "B0_TOKEN=$(jq -r .token ~/.bahulam/config.json)"` before each deploy |
| `BENCHMARKS_GH_TOKEN` | Fine-grained GitHub PAT with `Contents: Read and write` on `BahulamAI/bahulam-benchmarks`; SSO-enabled for the org if it's a personal PAT |
| `BENCHMARKS_REPO` | `BahulamAI/bahulam-benchmarks` (override for forks/testing) |
| `BAHULAM_GATEWAY_URL` | `https://gateway.bahulam.ai/v1` (or dev gateway) |
| `BAHULAM_RUNTIME_MODE` | `bundled` |
| `LLM_GATEWAY` | `BahulamGateway` |
| `CANDIDATE_MODEL` | e.g. `deepseek/deepseek-v4-flash`, `stealth/ox-alpha`, `xiaomi/mimo-v2.5` |
| `SCREENING_INSTANCE_FILE` | `screening-5.txt` (pipeline test), `screening-30.txt` (screen), `screening-300.txt` (full lite) |
| `HARNESS_PARALLEL` | `3` (safe default for Railway compute + gateway rate limits) |
| `HARNESS_TIMEOUT_S` | `600` for short screens, `1200` (20 min) for the full 300 |

## Instance File Configs

Live in `bahulam-benchmarks/screening/configs/`:

| File | Instances | Use |
|------|-----------|-----|
| `screening-5.txt` | 5 (django, astropy, sympy, sklearn, requests) | Pipeline shakedown; ~5 min, ~$0.07 on flash |
| `screening-30.txt` | 30 (diverse across 7 projects) | Standard model screen; ~90 min, ~$2 |
| `screening-300.txt` | 300 (full SWE-bench Lite) | Published benchmark run; 8-12 h, ~$20-50 depending on model |

Regenerate `screening-300.txt` from any prior canonical run:

```bash
RUN=/Users/sree/Sites/Tarang-Orca/bahulam-benchmarks/suites/swe-bench-lite/runs/2026-08-20_bundled-flash-300-2.6.15
jq -r '.[] | .instance_id' "$RUN/predictions.json" \
  > /Users/sree/Sites/Tarang-Orca/bahulam-benchmarks/screening/configs/screening-300.txt
```

## Running A Screen

From `/Users/sree/Sites/Tarang-Orca/bahulam-benchmarks/screening/`:

```bash
# Refresh B0_TOKEN (rotates frequently) and confirm which service is linked
railway variables --service bahulam-screening-worker \
  --set "B0_TOKEN=$(jq -r .token ~/.bahulam/config.json)"

# Point at the instance size you want
railway variables --service bahulam-screening-worker \
  --set "SCREENING_INSTANCE_FILE=screening-30.txt"

# Deploy (rebuilds image, starts one-shot container, exits when done)
railway up --detach --service bahulam-screening-worker
```

Follow live progress (harness.log is tailed into container stdout by
`entrypoint.sh`, prefixed with `[harness]`):

```bash
railway logs --service bahulam-screening-worker | grep -E '\[harness\] \[[0-9]+/[0-9]+\]'
```

Check terminal status:

```bash
railway status --service bahulam-screening-worker
```

Post-run signals to look for in the logs:

```text
[screen] wrote canonical predictions.json + rich predictions-raw.json
[screen] wrote /data/screen-<slug>-<date>/screening-report.json (schema_version=2)
[screen] run_id=<date>_<slug> wall_clock=<sec>s
[screen] totals: {...}
[push] repo=BahulamAI/bahulam-benchmarks base=main branch=screening/<run_id> dest=...
[push] DONE — branch ready for VM verify + PR merge
[push] compare: https://github.com/BahulamAI/bahulam-benchmarks/compare/main...screening/<run_id>
```

If `[push] failed` appears, see Troubleshooting → GitHub push 403.

## Report Schema

`screening-report.json` is schema_version=2. Field groups:

- `run_id`, `run_started_at`, `run_finished_at`, `wall_clock_seconds`
- `model.slug`
- `harness`: `cli_version`, `cli_package`, `harness_git_sha`, `gateway_url`, `dataset`, `instance_file`, `instance_count`, `parallel`, `timeout_s`
- `environment`: `hostname`, `railway_deployment_id`, `railway_service_id`, `railway_project_id`, `railway_region`, `python`
- `preflight`: tools_param_accepted probe result
- `totals`: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `tools_invoked`, `sub_agent_invocations`, `harness_cost_usd`, `stagnation_triggers`
- `distributions`: mean/median/p95/min/max/sum for `cost_usd`, `duration_s`, `input_tokens`, `output_tokens`, `tools_per_instance`
- `cache`: `cache_read_tokens`, `cache_write_tokens`, `cache_hit_ratio_input`
- `tool_breakdown`: aggregated tool call counts across all instances
- `outcome_counts`: counts by `status` (patched, no_changes, timeout, bahulam_failed, error)
- `metrics`: `patched`, `patch_rate`, `tool_call_emission_rate`, `zero_tool_timeout_count`, `avg_duration_s`, `harness_cost_per_patched_usd`, etc.
- `gates_verdict`: `PENDING-VM` (Railway-side), flipped to `PASS`/`REJECT` by the VM verify step
- `gates_pending_vm`: list of fields Docker eval on VM adds

All Railway-side fields are final at push time. Only `resolve_rate`,
`resolve_per_patch`, `dashboard_cost_usd`, `cost_delta_pct`, and `gates_verdict`
are computed later on VM1.

## Local Mac Setup (smoke test only)

The Railway image is the source of truth. Use local only to smoke-test screen.py
changes before pushing:

```bash
cd /Users/sree/Sites/Tarang-Orca/codekepler-npm
npm ci --include=optional

# Local one-instance smoke through the same bundled runtime
python3 -m venv ~/swebench-env
source ~/swebench-env/bin/activate
python -m pip install --upgrade pip
python -m pip install datasets swebench

source ~/.bahulam/config.json >/dev/null 2>&1 || true
export B0_TOKEN=$(jq -r .token ~/.bahulam/config.json)
export BAHULAM_RUNTIME_MODE=bundled
export LLM_GATEWAY=BahulamGateway
export BAHULAM_GATEWAY_URL=https://gateway.bahulam.ai/v1

python3 benchmark/swe-bench/harness.py \
  --dataset lite \
  --limit 1 \
  --model deepseek/deepseek-v4-flash \
  --timeout 600 \
  --debug \
  --output /tmp/bahulam-swe-smoke.json
```

## VM1 — Docker Evaluation

VM1 (`swebench-eval-vm`, D16s_v3, RG `AZ-RG-ORCA-BENCHMARK`, `centralus`) is
deallocated when idle. Disks retained. All 300 SWE-bench Lite images should be
present in the local Docker cache from prior runs.

Start VM1 and get its current public IP:

```bash
RG=AZ-RG-ORCA-BENCHMARK
az vm start -g "$RG" -n swebench-eval-vm
az vm show -d -g "$RG" -n swebench-eval-vm --query publicIps -o tsv
```

Fetch the Railway-pushed branch and run Docker eval:

```bash
VM_IP=$(az vm show -d -g AZ-RG-ORCA-BENCHMARK -n swebench-eval-vm --query publicIps -o tsv)
RUN_ID=2026-08-22_stealth-ox-alpha        # replace with your target run
BRANCH=screening/$RUN_ID

ssh azureuser@"$VM_IP" "cd ~/bahulam-benchmarks && git fetch origin '$BRANCH' && git checkout '$BRANCH'"

ssh azureuser@"$VM_IP" 'docker images --format "{{.Repository}}:{{.Tag}}" | grep -Ei "swe|sweb" | head'

ssh azureuser@"$VM_IP" "source ~/swebench-env/bin/activate && \
  cd ~/bahulam-benchmarks && \
  PRED=suites/screening/runs/$RUN_ID/predictions.json && \
  nohup python3 -m swebench.harness.run_evaluation \
    --predictions_path \$PRED \
    --dataset_name princeton-nlp/SWE-bench_Lite \
    --run_id ${RUN_ID}-eval \
    --max_workers 6 \
    > suites/screening/runs/$RUN_ID/docker-eval.log 2>&1 &"
```

Monitor:

```bash
ssh azureuser@"$VM_IP" "tail -f ~/bahulam-benchmarks/suites/screening/runs/$RUN_ID/docker-eval.log"
```

Merge Docker eval output into `screening-report.json`, commit, push:

```bash
ssh azureuser@"$VM_IP" "cd ~/bahulam-benchmarks && \
  cp *${RUN_ID}-eval*.json suites/screening/runs/$RUN_ID/docker-eval.json && \
  python3 screening/scripts/verify-and-report.py \
    --run-dir suites/screening/runs/$RUN_ID \
    --merge && \
  git add suites/screening/runs/$RUN_ID/ && \
  git commit -m 'screening: $RUN_ID Docker eval + verdict' && \
  git push origin $BRANCH"
```

Open PR from `screening/<RUN_ID>` → `main`, review, merge.

When done, deallocate VM1:

```bash
az vm deallocate -g AZ-RG-ORCA-BENCHMARK -n swebench-eval-vm --no-wait
```

**Never stop VM1 without enumerating consumers first** (bahulam-benchmarks CI, any
in-flight Docker eval, Terminal-bench runs).

## Terminal-Bench

Terminal-bench still uses the SSE HTTP API shape, so start the bundled runtime
on a fixed local port on VM1 and point the Terminal-bench adapter at it.

One-time setup on VM1:

```bash
ssh azureuser@"$VM_IP" 'python3 -m venv ~/tbench-env && \
  source ~/tbench-env/bin/activate && \
  pip install --upgrade pip && \
  pip install terminal-bench'
```

Start bundled runtime on port `8001`:

```bash
ssh azureuser@"$VM_IP" 'source ~/.bahulam-benchmark.env && \
  cd ~/codekepler-npm && \
  RUNTIME_BIN=$(node -e "import(\"./src/core/bundled-runtime.mjs\").then(m => console.log(m.runtimeInfo().bin))") && \
  tmux kill-session -t bahulam-runtime 2>/dev/null || true && \
  tmux new-session -d -s bahulam-runtime "source ~/.bahulam-benchmark.env && exec \"$RUNTIME_BIN\" --port 8001"'

ssh azureuser@"$VM_IP" 'curl -s http://127.0.0.1:8001/healthz'
```

Run Terminal-bench:

```bash
scp benchmark/terminal-bench/kepler_agent.py azureuser@"$VM_IP":~/kepler_agent.py

ssh azureuser@"$VM_IP" 'source ~/tbench-env/bin/activate && \
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

## Parallel Model Matrix

To screen multiple candidates concurrently, create one Railway service per
model. Each service builds its own image, has its own volume, and pushes to its
own branch. Concurrency is bounded by Bahulam gateway rate limits (safe at
~3 services × parallel=3 = 9 concurrent CLI processes hitting the gateway).

Example: run `deepseek-v4-flash-0731`, `xiaomi/mimo-v2.5`, `tencent/hy3` in
parallel:

```bash
for slug in deepseek-v4-flash-0731 mimo-v2.5 hy3; do
  case "$slug" in
    deepseek-v4-flash-0731) MODEL=deepseek/deepseek-v4-flash-0731 ;;
    mimo-v2.5)              MODEL=xiaomi/mimo-v2.5 ;;
    hy3)                    MODEL=tencent/hy3 ;;
  esac
  railway add --service "bahulam-screening-$slug" \
    -v "B0_TOKEN=$(jq -r .token ~/.bahulam/config.json)" \
    -v "BENCHMARKS_GH_TOKEN=$(sed -n 's/^Bahulam Benchmarks Railway PAT: //p' /Users/sree/Sites/Tarang-Orca/pass.md)" \
    -v "BENCHMARKS_REPO=BahulamAI/bahulam-benchmarks" \
    -v "BAHULAM_GATEWAY_URL=https://gateway.bahulam.ai/v1" \
    -v "BAHULAM_RUNTIME_MODE=bundled" \
    -v "LLM_GATEWAY=BahulamGateway" \
    -v "HARNESS_TIMEOUT_S=1200" \
    -v "HARNESS_PARALLEL=3" \
    -v "CANDIDATE_MODEL=$MODEL" \
    -v "SCREENING_INSTANCE_FILE=screening-300.txt"
  railway service link "bahulam-screening-$slug"
  railway volume add --mount-path /data
  railway up --detach
done

railway service link bahulam-screening-worker    # return to default context
```

## Troubleshooting

**GitHub push 403** (`fatal: unable to access '...bahulam-benchmarks.git/': The requested URL returned error: 403`):

- Fine-grained PAT missing `Contents: Read and write` (needs BOTH read and write).
- Personal PAT not SSO-authorized for `BahulamAI` org — go to <https://github.com/settings/tokens>, find the PAT, click "Configure SSO", enable for `BahulamAI`.
- Fine-grained PAT resource selection doesn't include `bahulam-benchmarks`.

Refresh the token on Railway after fixing:

```bash
GH=$(sed -n 's/^Bahulam Benchmarks Railway PAT: //p' /Users/sree/Sites/Tarang-Orca/pass.md)
railway variables --service bahulam-screening-worker --set "BENCHMARKS_GH_TOKEN=$GH"
railway redeploy --service bahulam-screening-worker --yes
```

**Preflight 401** (`HTTP 401: Invalid or expired token`):

`B0_TOKEN` has rotated. Refresh:

```bash
B0=$(jq -r .token ~/.bahulam/config.json)
railway variables --service bahulam-screening-worker --set "B0_TOKEN=$B0"
railway redeploy --service bahulam-screening-worker --yes
```

**"Bahulam runtime not found at /root/.bahulam/runtime/current/bin/bahulam-agent"**:

The Dockerfile installs the CLI via `npm install -g` so postinstall runs and
lands the runtime at the standard path. If this error appears, verify the image
was rebuilt after the switch (build id after `2026-08-22T14:00Z`).

**Zero patches / zero tokens after Railway container completes**:

The CLI ran but produced no work. Almost always the runtime-not-found bug above.
Confirm via `railway logs | grep -F 'runtime not found'`.

**Railway VOLUME directive rejected at build**:

`dockerfile invalid: docker VOLUME at Line N is not supported, use Railway Volumes`.
Dockerfiles cannot declare `VOLUME`. Attach a Railway Volume via
`railway volume add --mount-path /data` instead.

**Zero visibility during long runs**:

`screen.py` writes harness output to a file (`$OUT/harness.log`), not container
stdout. `entrypoint.sh` spawns `tail -F "$OUT/harness.log" | sed -u 's/^/[harness] /'`
in the background so `[n/M]` markers stream live via `railway logs`. If you
don't see `[harness]`-prefixed lines mid-run, the tail is broken.

**Docker eval starts building images** (should be pulling only):

```bash
ssh azureuser@"$VM_IP" 'pkill -f swebench.harness.run_evaluation'
ssh azureuser@"$VM_IP" 'docker images --format "{{.Repository}}:{{.Tag}}" | grep -Ei "swe|sweb" | head'
```

Prepare the image cache separately before restarting the eval run.

**Low prompt-cache numbers**:

- Keep the same gateway URL, model, runtime version for a run.
- Avoid per-instance volatile text in the shared system/context prefix.
- Compare gateway logs for `cache_creation_input_tokens` vs `cache_read_input_tokens`.

## Quick Reference

Check all screening services:

```bash
railway service list --project bahulam-screening
```

Cancel a running deploy:

```bash
railway service list --project bahulam-screening
# find the running service, then kill its deployment via the dashboard
# (Railway CLI has no direct "cancel deploy" — supersede with railway up)
```

Filesystem inside a Railway container (during run):

```text
/opt/bahulam-cli/                          Global @bahulam/code install (via npm install -g)
                                           symlinked from $(npm root -g)/@bahulam/code
/opt/bahulam-cli/benchmark/swe-bench/      Vendored harness.py + kepler_agent.py
/opt/screen/                               screen.py + configs/ + entrypoint.sh + push-to-benchmarks.sh
/root/.bahulam/runtime/current/bin/        Runtime binary (set up by postinstall)
/data/                                     Railway volume — screen output survives container exit
```

## Deprecated: Azure Shard VMs

VMs 2-5 (`swebench-eval-vm-2..5`) are deleted; only their NSGs remain in
`AZ-RG-ORCA-BENCHMARK`. The old per-shard flow is preserved in git history at
tag/pre-`RAILWAY_MIGRATION_2026_08_22` on this file, or by `git log -- benchmark/RUNBOOK.md`.
Do not attempt to bring them back — the Railway path is cheaper (~$0.15/run vs
~$4.80/run on D16s_v3) and easier to fan out across models.
