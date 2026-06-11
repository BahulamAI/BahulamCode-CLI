#!/usr/bin/env python3
"""
SWE-bench VM Harness — end-to-end benchmark on Azure VM.

Runs Kepler patch generation and swebench Docker evaluation in one shot.
Designed for the Azure VM (swebench-eval-vm, x86_64, Docker installed).

Usage:
    # Full lite benchmark (300 instances)
    python3 harness_vm.py --model deepseek/deepseek-v4-pro

    # Quick test (10 instances)
    python3 harness_vm.py --model deepseek/deepseek-v4-pro --limit 10

    # Skip generation (already have predictions), just evaluate
    python3 harness_vm.py --eval-only --predictions results/official/deepseek_deepseek-v4-pro/predictions.json

    # Skip evaluation (just generate patches)
    python3 harness_vm.py --gen-only --model deepseek/deepseek-v4-pro --limit 5

Flow:
    Phase 1 — Generate patches (Kepler headless via harness.py)
    Phase 2 — Convert results to swebench predictions format
    Phase 3 — Run swebench Docker evaluation
    Phase 4 — Summarize results

Prerequisites (on VM):
    - Node.js 20+ (for Kepler CLI)
    - Python 3.12+ with swebench, datasets
    - Docker (for swebench evaluation)
    - OPENROUTER_API_KEY or appropriate LLM key in env
    - Kepler CLI: npm install in tarang-npm/
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

BENCHMARK_DIR = Path(__file__).parent.parent
RESULTS_DIR = BENCHMARK_DIR / "results"
PREDICTIONS_DIR = RESULTS_DIR / "official"
HARNESS_PY = Path(__file__).parent / "harness.py"


def result_cost(result: dict) -> float:
    """Read current Kepler metrics and historical pre-rebrand metrics."""
    metrics = result.get("kepler") or result.get("orca") or {}
    return metrics.get("cost_usd", 0)


def phase_generate(model: str, dataset: str, limit: int | None, parallel: int, timeout: int, debug: bool) -> Path:
    """Phase 1: Run Kepler harness to generate patches."""
    print("\n" + "=" * 70)
    print("  PHASE 1: PATCH GENERATION")
    print(f"  Model: {model} | Dataset: {dataset} | Parallel: {parallel}")
    print("=" * 70 + "\n")

    model_slug = model.replace("/", "_")
    output_file = RESULTS_DIR / f"{model_slug}_{dataset}.json"

    cmd = [
        sys.executable, str(HARNESS_PY),
        "--dataset", dataset,
        "--model", model,
        "--parallel", str(parallel),
        "--timeout", str(timeout),
        "--output", str(output_file),
    ]
    if limit:
        cmd.extend(["--limit", str(limit)])
    if debug:
        cmd.append("--debug")

    start = time.time()
    result = subprocess.run(cmd, cwd=str(BENCHMARK_DIR.parent))
    duration = time.time() - start

    if result.returncode != 0:
        print(f"\n  [ERROR] Generation failed (exit {result.returncode})", file=sys.stderr)
        sys.exit(1)

    print(f"\n  Generation complete in {duration/60:.1f} minutes")
    print(f"  Results: {output_file}")
    return output_file


def phase_convert(results_file: Path, model: str, dataset: str) -> Path:
    """Phase 2: Convert harness results to swebench predictions format."""
    print("\n" + "=" * 70)
    print("  PHASE 2: CONVERT TO SWEBENCH PREDICTIONS")
    print("=" * 70 + "\n")

    with open(results_file) as f:
        data = json.load(f)

    results = data.get("results", [])
    model_slug = model.replace("/", "_")

    # swebench expects: [{"instance_id": ..., "model_patch": ..., "model_name_or_path": ...}]
    predictions = []
    patches_found = 0
    for r in results:
        instance_id = r.get("instance_id", "")
        patch = r.get("model_patch", "")

        if patch:
            patches_found += 1

        predictions.append({
            "instance_id": instance_id,
            "model_patch": patch,
            "model_name_or_path": model,
        })

    # Save predictions
    pred_dir = PREDICTIONS_DIR / model_slug
    pred_dir.mkdir(parents=True, exist_ok=True)
    pred_file = pred_dir / "predictions.json"

    with open(pred_file, "w") as f:
        json.dump(predictions, f, indent=2)

    print(f"  Predictions: {len(predictions)} total, {patches_found} with patches")
    print(f"  Saved to: {pred_file}")
    return pred_file


def phase_evaluate(predictions_file: Path, dataset: str, run_id: str, max_workers: int) -> Path:
    """Phase 3: Run swebench Docker evaluation."""
    print("\n" + "=" * 70)
    print("  PHASE 3: SWEBENCH DOCKER EVALUATION")
    print(f"  Predictions: {predictions_file}")
    print(f"  Workers: {max_workers}")
    print("=" * 70 + "\n")

    dataset_map = {
        "lite": "princeton-nlp/SWE-bench_Lite",
        "verified": "princeton-nlp/SWE-bench_Verified",
        "full": "princeton-nlp/SWE-bench",
    }
    dataset_name = dataset_map.get(dataset, dataset_map["lite"])

    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--predictions_path", str(predictions_file),
        "--dataset_name", dataset_name,
        "--run_id", run_id,
        "--max_workers", str(max_workers),
    ]

    log_file = Path("/tmp/swebench-eval.log")
    print(f"  Log: {log_file}")
    print(f"  Running: {' '.join(cmd)}\n")

    start = time.time()
    with open(log_file, "w") as log:
        result = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    duration = time.time() - start

    if result.returncode != 0:
        print(f"\n  [ERROR] Evaluation failed (exit {result.returncode})", file=sys.stderr)
        print(f"  Check log: {log_file}", file=sys.stderr)
        # Don't exit — still summarize what we have
    else:
        print(f"\n  Evaluation complete in {duration/60:.1f} minutes")

    return log_file


def phase_summarize(results_file: Path, model: str):
    """Phase 4: Print final summary."""
    print("\n" + "=" * 70)
    print("  FINAL RESULTS")
    print("=" * 70 + "\n")

    with open(results_file) as f:
        data = json.load(f)

    total = data.get("total", 0)
    passed = data.get("passed", 0)
    failed = data.get("failed", 0)
    errors = data.get("errors", 0)
    pass_rate = data.get("pass_rate", 0)
    total_cost = data.get("total_cost_usd", 0)
    avg_cost = data.get("avg_cost_usd", 0)

    print(f"  Model:      {model}")
    print(f"  Dataset:    {data.get('benchmark', '?')}")
    print(f"  Total:      {total}")
    print(f"  Passed:     {passed} ({pass_rate}%)")
    print(f"  Failed:     {failed}")
    print(f"  Errors:     {errors}")
    print(f"  Total cost: ${total_cost:.3f}")
    print(f"  Avg cost:   ${avg_cost:.3f}/instance")
    print()

    # Show failures
    results = data.get("results", [])
    failures = [r for r in results if r.get("status") == "FAIL"]
    if failures:
        print(f"  Failed instances ({len(failures)}):")
        for r in failures[:20]:
            cost = result_cost(r)
            print(f"    - {r['instance_id']} (${cost:.3f})")
        if len(failures) > 20:
            print(f"    ... and {len(failures) - 20} more")


def main():
    parser = argparse.ArgumentParser(
        description="SWE-bench VM Harness — end-to-end generation + evaluation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--model", default="deepseek/deepseek-v4-pro", help="OpenRouter model ID")
    parser.add_argument("--dataset", default="lite", choices=["lite", "verified", "full"])
    parser.add_argument("--limit", type=int, help="Max instances to generate")
    parser.add_argument("--parallel", type=int, default=4, help="Parallel workers for generation (default: 4)")
    parser.add_argument("--eval-workers", type=int, default=4, help="Parallel workers for Docker eval (default: 4)")
    parser.add_argument("--timeout", type=int, default=300, help="Timeout per instance in seconds")
    parser.add_argument("--run-id", default=None, help="Eval run ID (default: kepler-<model>-<timestamp>)")
    parser.add_argument("--debug", action="store_true", help="Save raw agent output (required for predictions)")

    # Phase control
    parser.add_argument("--gen-only", action="store_true", help="Only generate patches, skip evaluation")
    parser.add_argument("--eval-only", action="store_true", help="Only run evaluation (requires --predictions)")
    parser.add_argument("--predictions", help="Path to existing predictions.json (for --eval-only)")

    args = parser.parse_args()

    # Validate
    if args.eval_only and not args.predictions:
        parser.error("--eval-only requires --predictions <path>")

    model_slug = args.model.replace("/", "_")
    run_id = args.run_id or f"kepler-{model_slug}-{datetime.now().strftime('%Y%m%d-%H%M')}"

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    print("\n" + "#" * 70)
    print("#  KEPLER SWE-BENCH VM HARNESS")
    print(f"#  Model: {args.model}")
    print(f"#  Dataset: {args.dataset} | Limit: {args.limit or 'all'}")
    print(f"#  Run ID: {run_id}")
    print(f"#  Started: {datetime.now().isoformat()}")
    print("#" * 70)

    # Check prerequisites
    if not args.eval_only:
        if not os.environ.get("OPENROUTER_API_KEY") and not os.environ.get("ANTHROPIC_API_KEY"):
            print("\n  [WARN] No OPENROUTER_API_KEY or ANTHROPIC_API_KEY in env", file=sys.stderr)

    predictions_file = None

    # Phase 1 + 2: Generate
    if not args.eval_only:
        # Force debug mode — we need stdout to extract patches for predictions
        results_file = phase_generate(
            model=args.model,
            dataset=args.dataset,
            limit=args.limit,
            parallel=args.parallel,
            timeout=args.timeout,
            debug=True,  # Always debug on VM — need patches for eval
        )
        phase_summarize(results_file, args.model)

        if not args.gen_only:
            predictions_file = phase_convert(results_file, args.model, args.dataset)
    else:
        predictions_file = Path(args.predictions)
        if not predictions_file.exists():
            print(f"  [ERROR] Predictions not found: {predictions_file}", file=sys.stderr)
            sys.exit(1)

    # Phase 3: Evaluate
    if not args.gen_only and predictions_file:
        phase_evaluate(
            predictions_file=predictions_file,
            dataset=args.dataset,
            run_id=run_id,
            max_workers=args.eval_workers,
        )

    print("\n" + "#" * 70)
    print(f"#  COMPLETE — {datetime.now().isoformat()}")
    print("#" * 70 + "\n")


if __name__ == "__main__":
    main()
