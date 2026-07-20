
  - Repos: 10 cloned to ~/.kepler-bench-repos/ (2.6G total)
  - Backend: local Docker on port 8150, framework 3.4.12 (SubAgentAdvisor pure-tool)
  - Auth: existing token works, TARANG_ENV=local handles URL resolution
  - Harness: run-persistent.mjs fired with the hard-10 question set
  - Model: DeepSeek Flash (platform route)
  - Output: benchmark/model-comparison/results/local-3.4.12-deepseek-hard10-<timestamp>/


Iteration loop from here

  For every model × framework change you want to A/B:

  # 1. Restart the container to pick up framework edits (volume-mounted)
  docker restart codekepler-backend-1

  # 2. Reset repos between runs
  node benchmark/model-comparison/prep-swe-repos.mjs --reset

  # 3. Fire another run
  TARANG_ENV=local node benchmark/model-comparison/run-persistent.mjs \
    --questions benchmark/model-comparison/questions-swe-hard10.json \
    --label "<some-label>" --model <model-id> --route platform
  
  For different models within the same framework — no need to restart container, just change env in
  .env.local and restart, or use the --model flag on run-persistent (it overrides per-request).

