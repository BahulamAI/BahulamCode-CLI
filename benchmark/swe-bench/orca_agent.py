"""
Orca Agent Adapter for SWE-bench evaluation.

Runs Orca in headless mode against a repo and returns the patch (git diff).
This is the bridge between swebench's evaluation harness and Orca's CLI.

Usage:
    agent = OrcaAgent(model="deepseek/deepseek-chat-v3-0324")
    patch = agent.solve(instance, repo_dir, timeout=600)
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

# Orca CLI entrypoint
ORCA_MAIN = Path(__file__).parent.parent.parent / "src" / "terminal" / "main.mjs"


class OrcaAgent:
    """SWE-bench agent adapter — runs Orca headless and returns a patch."""

    def __init__(
        self,
        model: str = "deepseek/deepseek-chat-v3-0324",
        backend_url: str = None,
        timeout: int = 600,
    ):
        self.model = model
        self.backend_url = backend_url or os.environ.get(
            "TARANG_BACKEND_URL", "http://localhost:8000"
        )
        self.default_timeout = timeout

    def solve(
        self,
        instance: dict,
        repo_dir: str,
        timeout: int = None,
    ) -> dict:
        """
        Solve a SWE-bench instance and return the result.

        Args:
            instance: SWE-bench instance dict with problem_statement, instance_id, etc.
            repo_dir: Path to the cloned repo (already at base_commit)
            timeout: Max seconds for Orca to work

        Returns:
            dict with:
                instance_id: str
                model_patch: str (git diff)
                model_name_or_path: str
                duration_s: float
                cost_usd: float
                tools: int
                success: bool
        """
        timeout = timeout or self.default_timeout
        instance_id = instance.get("instance_id", "unknown")
        problem = instance.get("problem_statement", "")

        instruction = (
            f"Fix the following issue in the code at {repo_dir}. "
            f"Use search_code or grep to find the relevant file, "
            f"read_file to understand the code, then edit_file to fix it. "
            f"You MUST call edit_file to make changes.\n\n"
            f"{problem}"
        )

        cmd = [
            "node", str(ORCA_MAIN),
            "--headless", "--verbose",
            "-p", instruction,
        ]
        if self.model:
            cmd.extend(["-m", self.model])

        env = {
            **os.environ,
            "TARANG_ENV": os.environ.get("TARANG_ENV", "local"),
            "TARANG_BACKEND_URL": self.backend_url,
        }

        start = time.time()
        tools = 0
        cost = 0.0

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=repo_dir,
                timeout=timeout,
                env=env,
            )

            # Parse JSONL output for metrics
            for line in (result.stdout or "").strip().split("\n"):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                    if event.get("type") == "complete":
                        tools = event.get("tools", 0)
                        cost = event.get("cost_usd", 0)
                except json.JSONDecodeError:
                    pass

        except subprocess.TimeoutExpired:
            pass  # Still collect the patch — partial work counts

        duration = time.time() - start

        # Collect patch (git diff of changes)
        try:
            diff_result = subprocess.run(
                ["git", "diff"],
                capture_output=True, text=True, cwd=repo_dir,
            )
            patch = diff_result.stdout
        except Exception:
            patch = ""

        return {
            "instance_id": instance_id,
            "model_patch": patch,
            "model_name_or_path": f"Orca v2.7.1 + {self.model}",
            "duration_s": round(duration, 1),
            "cost_usd": cost,
            "tools": tools,
            "success": bool(patch.strip()),
        }


def generate_predictions(
    dataset: str = "lite",
    model: str = "deepseek/deepseek-chat-v3-0324",
    limit: int = None,
    timeout: int = 600,
    output_dir: str = None,
    instances: list = None,
):
    """
    Generate predictions (patches) for SWE-bench instances.

    This is Step 1 of the official evaluation flow:
    1. generate_predictions() → predictions.json
    2. swebench run_evaluation() → scores

    Args:
        dataset: "lite" | "verified" | "full"
        model: OpenRouter model ID
        limit: Max instances to process
        timeout: Seconds per instance
        output_dir: Where to save predictions
        instances: Optional pre-loaded instance list
    """
    from datasets import load_dataset

    output_dir = output_dir or f"benchmark/results/official/{model.replace('/', '_')}"
    os.makedirs(output_dir, exist_ok=True)

    # Load dataset
    if instances is None:
        ds_name = {
            "lite": "princeton-nlp/SWE-bench_Lite",
            "verified": "princeton-nlp/SWE-bench_Verified",
            "full": "princeton-nlp/SWE-bench",
        }.get(dataset, dataset)
        ds = load_dataset(ds_name, split="test")
        instances = list(ds)
        if limit:
            instances = instances[:limit]

    print(f"Generating predictions for {len(instances)} instances with {model}", file=sys.stderr)

    agent = OrcaAgent(model=model, timeout=timeout)
    predictions = []
    passed = 0
    total = 0

    for i, instance in enumerate(instances):
        instance_id = instance["instance_id"]
        total += 1
        print(f"\n[{i+1}/{len(instances)}] {instance_id}", file=sys.stderr)

        # Setup repo
        repo = instance["repo"]
        base_commit = instance["base_commit"]
        repo_dir = Path(f"/tmp/orca-swebench/{repo.replace('/', '__')}/{base_commit[:8]}")

        if repo_dir.exists():
            import shutil
            shutil.rmtree(repo_dir)
        repo_dir.mkdir(parents=True, exist_ok=True)

        try:
            subprocess.run(
                ["git", "clone", f"https://github.com/{repo}.git", str(repo_dir)],
                capture_output=True, timeout=300,
            )
            subprocess.run(
                ["git", "checkout", base_commit],
                capture_output=True, cwd=repo_dir, timeout=30,
            )
        except Exception as e:
            print(f"  Clone failed: {e}", file=sys.stderr)
            predictions.append({
                "instance_id": instance_id,
                "model_patch": "",
                "model_name_or_path": f"Orca v2.7.1 + {model}",
            })
            continue

        # Apply test patch
        test_patch = instance.get("test_patch", "")
        if test_patch:
            patch_file = repo_dir / "test.patch"
            patch_file.write_text(test_patch)
            subprocess.run(
                ["git", "apply", str(patch_file)],
                capture_output=True, cwd=repo_dir,
            )

        # Run Orca
        result = agent.solve(instance, str(repo_dir), timeout)

        if result["success"]:
            passed += 1
            print(f"  Patch generated ({result['tools']} tools, {result['duration_s']}s, ${result['cost_usd']:.3f})", file=sys.stderr)
        else:
            print(f"  No patch ({result['tools']} tools, {result['duration_s']}s)", file=sys.stderr)

        predictions.append({
            "instance_id": instance_id,
            "model_patch": result["model_patch"],
            "model_name_or_path": result["model_name_or_path"],
        })

        # Cleanup
        try:
            import shutil
            shutil.rmtree(repo_dir)
        except Exception:
            pass

    # Save predictions
    predictions_path = os.path.join(output_dir, "predictions.json")
    with open(predictions_path, "w") as f:
        json.dump(predictions, f, indent=2)

    print(f"\n{'='*60}", file=sys.stderr)
    print(f"Patches generated: {passed}/{total}", file=sys.stderr)
    print(f"Predictions saved to: {predictions_path}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)
    print(f"\nNext step: run official evaluation:", file=sys.stderr)
    print(f"  python -m swebench.harness.run_evaluation \\", file=sys.stderr)
    print(f"    --predictions_path {predictions_path} \\", file=sys.stderr)
    print(f"    --swe_bench_tasks {dataset} \\", file=sys.stderr)
    print(f"    --log_dir {output_dir}/logs", file=sys.stderr)

    return predictions_path


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Orca SWE-bench Agent")
    parser.add_argument("--dataset", default="lite", choices=["lite", "verified", "full"])
    parser.add_argument("--model", default="deepseek/deepseek-chat-v3-0324")
    parser.add_argument("--limit", type=int, help="Max instances")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--output", help="Output directory")
    parser.add_argument("--instance", help="Run a specific instance ID")
    args = parser.parse_args()

    instances = None
    if args.instance:
        from datasets import load_dataset
        ds_name = "princeton-nlp/SWE-bench_Lite" if args.dataset == "lite" else f"princeton-nlp/SWE-bench_{args.dataset.title()}"
        ds = load_dataset(ds_name, split="test")
        instances = [i for i in ds if i["instance_id"] == args.instance]

    generate_predictions(
        dataset=args.dataset,
        model=args.model,
        limit=args.limit,
        timeout=args.timeout,
        output_dir=args.output,
        instances=instances,
    )
