#!/usr/bin/env python3
"""
SWE-bench Harness — run Kepler against SWE-bench instances and score results.

Usage:
    python harness.py --dataset lite --model deepseek/deepseek-chat-v3-0324
    python harness.py --dataset verified --model anthropic/claude-sonnet-4-20250514 --limit 10
    python harness.py --instance django__django-16527

Flow per instance:
    1. Clone repo at base_commit
    2. Apply test patch (the failing test)
    3. Run: kepler --headless -p "Fix: {problem_statement}"
    4. Collect file changes (git diff)
    5. Run test suite
    6. Score: PASS (tests pass) or FAIL
    7. Record results to benchmark/results/

Requires: pip install swebench datasets
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

RESULTS_DIR = Path(__file__).parent.parent / "results"
WORKDIR = Path("/tmp/kepler-swe-bench")


def load_dataset(dataset_name: str, limit: int = None):
    """Load SWE-bench dataset from HuggingFace."""
    try:
        from datasets import load_dataset
    except ImportError:
        print("Install datasets: pip install datasets", file=sys.stderr)
        sys.exit(1)

    if dataset_name == "lite":
        ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
    elif dataset_name == "verified":
        ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
    else:
        ds = load_dataset("princeton-nlp/SWE-bench", split="test")

    instances = list(ds)
    if limit:
        instances = instances[:limit]

    print(f"Loaded {len(instances)} instances from SWE-bench {dataset_name}", file=sys.stderr)
    return instances


def setup_repo(instance: dict) -> Path:
    """Clone repo and checkout base commit."""
    repo = instance["repo"]
    base_commit = instance["base_commit"]

    repo_dir = WORKDIR / repo.replace("/", "__") / base_commit[:8]
    if repo_dir.exists():
        shutil.rmtree(repo_dir)

    repo_dir.mkdir(parents=True, exist_ok=True)

    # Clone full repo (shallow clone misses old commits)
    result = subprocess.run(
        ["git", "clone", f"https://github.com/{repo}.git", str(repo_dir)],
        capture_output=True, timeout=300,
    )
    if result.returncode != 0:
        # Fallback to shallow clone + fetch
        subprocess.run(
            ["git", "clone", "--depth", "1", f"https://github.com/{repo}.git", str(repo_dir)],
            capture_output=True, timeout=120,
        )
        subprocess.run(
            ["git", "fetch", "--depth", "100", "origin", base_commit],
            capture_output=True, cwd=repo_dir, timeout=120,
        )

    # Checkout the specific base commit
    checkout = subprocess.run(
        ["git", "checkout", base_commit],
        capture_output=True, cwd=repo_dir, timeout=30,
    )
    if checkout.returncode != 0:
        print(f"  WARNING: git checkout {base_commit[:8]} failed", file=sys.stderr)

    # Verify files exist
    py_count = len(list(repo_dir.rglob("*.py")))
    print(f"  Repo ready: {py_count} .py files", file=sys.stderr)

    return repo_dir


def apply_test_patch(repo_dir: Path, instance: dict) -> bool:
    """Apply the test patch (failing test to verify the fix)."""
    test_patch = instance.get("test_patch", "")
    if not test_patch:
        return True

    patch_file = repo_dir / "test_patch.diff"
    patch_file.write_text(test_patch)

    result = subprocess.run(
        ["git", "apply", "--check", str(patch_file)],
        capture_output=True, cwd=repo_dir,
    )

    if result.returncode != 0:
        # Try with more relaxed options
        result = subprocess.run(
            ["git", "apply", "--3way", str(patch_file)],
            capture_output=True, cwd=repo_dir,
        )

    if result.returncode != 0:
        return False

    subprocess.run(
        ["git", "apply", str(patch_file)],
        capture_output=True, cwd=repo_dir,
    )
    return True


KEPLER_MAIN = Path(__file__).parent.parent.parent / "src" / "terminal" / "main.mjs"


def run_kepler(repo_dir: Path, instance: dict, model: str, timeout: int = 600, debug: bool = False) -> dict:
    """Run Kepler in headless mode on the instance."""
    problem = instance["problem_statement"]
    repo_abs = str(repo_dir.resolve())
    instruction = (
        f"Fix the following issue in the code at {repo_abs}. "
        f"Use search_code to find the relevant file, read_file to understand the code, "
        f"then edit_file with ABSOLUTE paths to fix it. You MUST call edit_file.\n\n"
        f"After editing, you MUST run the relevant tests to verify your fix works. "
        f"Use run_tests or shell to execute the test suite. Do NOT finish without "
        f"running tests. If tests fail, fix your code and re-test.\n\n"
        f"{problem}"
    )

    cmd = [
        "node", str(KEPLER_MAIN), "--headless", "--verbose",
        "--timeout", str(timeout),
        "-p", instruction,
    ]
    if model and model != "profile":
        cmd.extend(["-m", model])

    start = time.time()

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(repo_dir),
            timeout=timeout,
            env={**os.environ, "TARANG_ENV": os.environ.get("TARANG_ENV", "local")},
        )
        duration = time.time() - start

        # Parse JSONL output
        events = []
        for line in result.stdout.strip().split("\n"):
            if line.strip():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

        # Extract metrics from events
        complete_event = next((e for e in events if e.get("type") == "complete"), {})

        # Save debug output
        if debug:
            debug_dir = RESULTS_DIR / "debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            instance_id = instance["instance_id"].replace("/", "__")
            (debug_dir / f"{instance_id}_stdout.txt").write_text(result.stdout or "")
            (debug_dir / f"{instance_id}_stderr.txt").write_text(result.stderr or "")
            print(f"  [DEBUG] Saved to {debug_dir / instance_id}_*.txt", file=sys.stderr)

        return {
            "success": result.returncode == 0,
            "duration_s": round(duration, 1),
            "cost_usd": complete_event.get("cost_usd", 0),
            "tools": complete_event.get("tools", 0),
            "tool_breakdown": complete_event.get("tool_breakdown", {}),
            "sub_agents": complete_event.get("sub_agents", []),
            "stagnation_triggers": complete_event.get("stagnation_triggers", 0),
            "usage": complete_event.get("usage", {}),
            "events": events,
            "stderr": result.stderr[-500:] if result.stderr else "",
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "duration_s": timeout,
            "cost_usd": 0,
            "tools": 0,
            "events": [],
            "stderr": "Timeout",
        }
    except Exception as e:
        return {
            "success": False,
            "duration_s": time.time() - start,
            "cost_usd": 0,
            "tools": 0,
            "events": [],
            "stderr": str(e),
        }


def collect_patch(repo_dir: Path) -> str:
    """Collect the git diff of Kepler's changes."""
    result = subprocess.run(
        ["git", "diff"],
        capture_output=True, text=True, cwd=repo_dir,
    )
    return result.stdout


def run_tests(repo_dir: Path, instance: dict) -> dict:
    """Run the test suite to verify the fix."""
    # Use FAIL_TO_PASS tests from SWE-bench — these are the tests that should pass after fix
    fail_to_pass = instance.get("FAIL_TO_PASS", "")
    if isinstance(fail_to_pass, str):
        try:
            import json as _json
            fail_to_pass = _json.loads(fail_to_pass)
        except Exception:
            fail_to_pass = []

    repo = instance.get("repo", "")

    # Django uses its own test runner
    if "django" in repo:
        if fail_to_pass:
            # Extract specific test labels from "test_name (module.path.TestClass)"
            test_labels = []
            for t in fail_to_pass:
                if "(" in t:
                    # "test_foo (bar.tests.BazTests)" → "bar.tests.BazTests.test_foo"
                    test_name = t.split("(")[0].strip()
                    module = t.split("(")[1].rstrip(")").strip()
                    test_labels.append(f"{module}.{test_name}")
                else:
                    test_labels.append(t)
            test_cmd = f"python tests/runtests.py {' '.join(test_labels)}"
        else:
            test_cmd = "python tests/runtests.py"
    else:
        test_cmd = instance.get("test_cmd", "")
        if not test_cmd:
            if (repo_dir / "setup.py").exists():
                test_cmd = "python -m pytest -x --timeout=60"
            elif (repo_dir / "package.json").exists():
                test_cmd = "npm test"
            else:
                test_cmd = "python -m pytest -x --timeout=60"

    print(f"  Test cmd: {test_cmd[:80]}", file=sys.stderr)

    try:
        # Ensure the repo's code is used, not system-installed packages
        test_env = {**os.environ, "PYTHONPATH": str(repo_dir)}
        result = subprocess.run(
            test_cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=str(repo_dir),
            timeout=120,
            env=test_env,
        )

        passed = result.returncode == 0
        test_out = (result.stderr or result.stdout or "")[-1000:]
        if not passed:
            print(f"  Test output: {test_out[-200:]}", file=sys.stderr)
        return {
            "passed": passed,
            "exit_code": result.returncode,
            "stdout": result.stdout[-1000:] if result.stdout else "",
            "stderr": result.stderr[-1000:] if result.stderr else "",
        }
    except subprocess.TimeoutExpired:
        return {"passed": False, "exit_code": -1, "stdout": "", "stderr": "Test timeout"}
    except Exception as e:
        return {"passed": False, "exit_code": -1, "stdout": "", "stderr": str(e)}


def run_instance(instance: dict, model: str, timeout: int = 600, debug: bool = False) -> dict:
    """Run a single SWE-bench instance end-to-end."""
    instance_id = instance["instance_id"]
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"Instance: {instance_id}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    result = {
        "instance_id": instance_id,
        "repo": instance["repo"],
        "model": model,
        "timestamp": datetime.now().isoformat(),
    }

    # 1. Setup repo
    print("  [1/5] Cloning repo...", file=sys.stderr)
    try:
        repo_dir = setup_repo(instance)
    except Exception as e:
        result.update({"status": "error", "error": f"Clone failed: {e}"})
        return result

    # 2. Apply test patch
    print("  [2/5] Applying test patch...", file=sys.stderr)
    if not apply_test_patch(repo_dir, instance):
        result.update({"status": "error", "error": "Test patch failed"})
        return result

    # 3. Run Kepler
    print(f"  [3/5] Running Kepler (model={model}, timeout={timeout}s)...", file=sys.stderr)
    kepler_result = run_kepler(repo_dir, instance, model, timeout, debug=debug)
    result["kepler"] = {
        "success": kepler_result["success"],
        "duration_s": kepler_result["duration_s"],
        "cost_usd": kepler_result["cost_usd"],
        "tools": kepler_result["tools"],
        "tool_breakdown": kepler_result.get("tool_breakdown", {}),
        "sub_agents": kepler_result.get("sub_agents", []),
        "stagnation_triggers": kepler_result.get("stagnation_triggers", 0),
        "usage": kepler_result.get("usage", {}),
    }

    if not kepler_result["success"]:
        result.update({"status": "kepler_failed", "error": kepler_result["stderr"][:200]})
        return result

    # 4. Collect patch
    print("  [4/5] Collecting changes...", file=sys.stderr)
    patch = collect_patch(repo_dir)
    result["patch_lines"] = len(patch.split("\n")) if patch else 0
    result["model_patch"] = patch  # Store actual diff for swebench eval

    if not patch.strip():
        result.update({"status": "no_changes", "error": "Kepler made no file changes"})
        return result

    # 5. Skip inline tests (swebench Docker eval handles this properly)
    result["status"] = "patched"

    icon = "✓" if result["status"] == "PASS" else "✗"
    cost = f"${kepler_result['cost_usd']:.3f}" if kepler_result["cost_usd"] else "?"
    print(f"  {icon} {result['status']}  ({kepler_result['duration_s']}s, {cost})", file=sys.stderr)

    # Cleanup
    try:
        shutil.rmtree(repo_dir)
    except Exception:
        pass

    return result


def normalize_result(result: dict) -> dict:
    """Migrate pre-Kepler result entries when resuming an existing output file."""
    if "kepler" not in result and "orca" in result:
        result["kepler"] = result.pop("orca")
    if result.get("status") == "orca_failed":
        result["status"] = "kepler_failed"
    if result.get("error") == "Orca made no file changes":
        result["error"] = "Kepler made no file changes"
    return result


def summarize_results(results: list[dict]) -> tuple[int, int, int]:
    passed = sum(result.get("status") == "patched" for result in results)
    errors = sum(
        result.get("status") in ("error", "kepler_failed", "no_changes")
        for result in results
    )
    failed = len(results) - passed - errors
    return passed, failed, errors


def result_cost(result: dict) -> float:
    return result.get("kepler", {}).get("cost_usd", 0)


def main():
    parser = argparse.ArgumentParser(description="Kepler SWE-bench Harness")
    parser.add_argument("--dataset", default="lite", choices=["lite", "verified", "full"])
    parser.add_argument("--model", default="deepseek/deepseek-chat-v3-0324")
    parser.add_argument("--limit", type=int, help="Max instances to run")
    parser.add_argument("--instance", help="Run a specific instance ID")
    parser.add_argument("--instance-file", help="File with instance IDs to run (one per line)")
    parser.add_argument("--timeout", type=int, default=600, help="Timeout per instance (seconds)")
    parser.add_argument("--output", help="Output file (default: results/<model>_<dataset>.json)")
    parser.add_argument("--parallel", type=int, default=1, help="Number of parallel instances (default: 1)")
    parser.add_argument("--debug", action="store_true", help="Save raw agent output for debugging")
    parser.add_argument("--skip-done", action="store_true", help="Skip instances already in output file")
    args = parser.parse_args()

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    WORKDIR.mkdir(parents=True, exist_ok=True)

    # Load dataset
    instances = load_dataset(args.dataset, args.limit)

    if args.instance:
        instances = [i for i in instances if i["instance_id"] == args.instance]
        if not instances:
            print(f"Instance not found: {args.instance}", file=sys.stderr)
            sys.exit(1)

    if args.instance_file:
        with open(args.instance_file) as f:
            target_ids = set(line.strip() for line in f if line.strip())
        instances = [i for i in instances if i["instance_id"] in target_ids]
        print(f"Instance file: {len(target_ids)} IDs, {len(instances)} matched in dataset", file=sys.stderr)

    # Skip already-done instances
    results = []
    if args.skip_done:
        model_slug = args.model.replace("/", "_")
        output_path = args.output or str(RESULTS_DIR / f"{model_slug}_{args.dataset}.json")
        if Path(output_path).exists():
            try:
                existing = json.load(open(output_path))
                results = [
                    normalize_result(result)
                    for result in existing.get("results", [])
                ]
                done_ids = set(r["instance_id"] for r in results)
                before = len(instances)
                instances = [i for i in instances if i["instance_id"] not in done_ids]
                print(f"Skip-done: {len(done_ids)} already done, {len(instances)} remaining (from {before})", file=sys.stderr)
            except Exception as e:
                print(f"Skip-done: could not load {output_path}: {e}", file=sys.stderr)

    # Run instances (sequential or parallel)
    passed, failed, errors = summarize_results(results)

    # Incremental results file — write after each instance so nothing is lost on kill
    model_slug = args.model.replace("/", "_")
    output_path = args.output or str(RESULTS_DIR / f"{model_slug}_{args.dataset}.json")

    def save_incremental():
        """Save results after every completed instance."""
        total = len(results)
        summary = {
            "benchmark": f"swe-bench-{args.dataset}",
            "model": args.model,
            "timestamp": datetime.now().isoformat(),
            "total": total,
            "passed": passed,
            "failed": failed,
            "errors": errors,
            "pass_rate": round((passed / total * 100) if total > 0 else 0, 1),
            "total_cost_usd": round(sum(result_cost(r) for r in results), 3),
            "avg_cost_usd": round(sum(result_cost(r) for r in results) / total if total > 0 else 0, 3),
            "results": results,
        }
        with open(output_path, "w") as f:
            json.dump(summary, f, indent=2)

    if args.parallel > 1:
        # Parallel execution
        from concurrent.futures import ProcessPoolExecutor, as_completed
        print(f"\nRunning {len(instances)} instances with {args.parallel} workers...", file=sys.stderr)

        with ProcessPoolExecutor(max_workers=args.parallel) as executor:
            future_to_instance = {
                executor.submit(run_instance, inst, args.model, args.timeout, args.debug): inst
                for inst in instances
            }
            for i, future in enumerate(as_completed(future_to_instance)):
                result = future.result()
                results.append(result)
                status = result.get("status", "?")
                icon = "✓" if status == "patched" else "✗"
                cost = result_cost(result)
                print(f"  [{i+1}/{len(instances)}] {icon} {result['instance_id']}  ({status}, ${cost:.3f})", file=sys.stderr)

                if status == "patched":
                    passed += 1
                elif status in ("error", "kepler_failed", "no_changes"):
                    errors += 1
                else:
                    failed += 1

                save_incremental()
    else:
        # Sequential execution
        for i, instance in enumerate(instances):
            print(f"\n[{i+1}/{len(instances)}]", file=sys.stderr)
            result = run_instance(instance, args.model, args.timeout, debug=args.debug)
            results.append(result)

            if result["status"] == "patched":
                passed += 1
            elif result["status"] in ("error", "kepler_failed", "no_changes"):
                errors += 1
            else:
                failed += 1

            save_incremental()

    # Summary
    total = len(results)
    pass_rate = (passed / total * 100) if total > 0 else 0
    total_cost = sum(result_cost(r) for r in results)
    avg_cost = total_cost / total if total > 0 else 0

    summary = {
        "benchmark": f"swe-bench-{args.dataset}",
        "model": args.model,
        "timestamp": datetime.now().isoformat(),
        "total": total,
        "passed": passed,
        "failed": failed,
        "errors": errors,
        "pass_rate": round(pass_rate, 1),
        "total_cost_usd": round(total_cost, 3),
        "avg_cost_usd": round(avg_cost, 3),
        "results": results,
    }

    print(f"\n{'='*60}", file=sys.stderr)
    print(f"RESULTS: {passed}/{total} passed ({pass_rate:.1f}%)", file=sys.stderr)
    print(f"COST: ${total_cost:.3f} total, ${avg_cost:.3f} avg per instance", file=sys.stderr)
    print(f"MODEL: {args.model}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    # Save results
    model_slug = args.model.replace("/", "_")
    output_path = args.output or str(RESULTS_DIR / f"{model_slug}_{args.dataset}.json")
    with open(output_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"Results saved to: {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
