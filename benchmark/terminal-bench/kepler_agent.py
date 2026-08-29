"""Terminal-Bench adapter that runs the full Kepler backend agent."""

from __future__ import annotations

import base64
import json
import os
import shlex
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Iterator

from terminal_bench.agents.base_agent import AgentResult, BaseAgent
from terminal_bench.agents.failure_mode import FailureMode
from terminal_bench.terminal.tmux_session import TmuxSession


class KeplerAgent(BaseAgent):
    """Route Terminal-Bench tasks through Kepler's SSE agent API."""

    def __init__(
        self,
        model_name: str | None = None,
        backend_url: str = "http://127.0.0.1:8001",
        token: str | None = None,
        request_timeout: int = 1800,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.model_name = model_name
        self.backend_url = backend_url.rstrip("/")
        self.token = token or _load_cli_token()
        self.request_timeout = int(request_timeout)

    @staticmethod
    def name() -> str:
        return "kepler"

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
    ) -> AgentResult:
        instruction = self._render_instruction(instruction)
        executor = _ContainerToolExecutor(session)
        instruction = (
            f"Terminal-Bench workspace: {executor.cwd}\n"
            "All requested files and commands MUST stay in that workspace. "
            "Never use /root as the project directory.\n\n"
            f"{instruction}"
        )
        started = time.monotonic()
        markers: list[tuple[float, str]] = []
        usage: dict[str, int] = {}
        task_id: str | None = None

        log_handle = None
        if logging_dir is not None:
            logging_dir.mkdir(parents=True, exist_ok=True)
            (logging_dir / "prompt.txt").write_text(instruction)
            log_handle = (logging_dir / "kepler-events.jsonl").open("w")
            log_handle.write(json.dumps({"workspace": executor.cwd}) + "\n")
            log_handle.flush()

        body = {
            "instruction": instruction,
            "context": {
                "cwd": executor.cwd,
                "files": [],
                "relevant_files": [],
                "freeswim": True,
                "model_override": self.model_name,
            },
            "model": self.model_name,
        }

        request = urllib.request.Request(
            f"{self.backend_url}/api/execute",
            data=json.dumps(body).encode(),
            headers={
                "Accept": "text/event-stream",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(
                request, timeout=self.request_timeout
            ) as response:
                task_id = response.headers.get("X-Task-ID")
                for event, data in _iter_sse(response):
                    if log_handle is not None:
                        log_handle.write(
                            json.dumps({"event": event, "data": data}) + "\n"
                        )
                        log_handle.flush()

                    if event == "tool_call" and not data.get("server_side"):
                        result = executor.execute(
                            str(data.get("tool", "")), data.get("args") or {}
                        )
                        call_id = data.get("call_id") or data.get("request_id")
                        if task_id and call_id:
                            self._send_callback(task_id, str(call_id), result)
                        markers.append(
                            (
                                time.monotonic() - started,
                                json.dumps(
                                    {
                                        "tool": data.get("tool"),
                                        "success": result.get("success", False),
                                    }
                                ),
                            )
                        )
                    elif event == "complete":
                        usage = data.get("usage") or {}
                    elif event == "error":
                        raise RuntimeError(
                            data.get("message") or "Kepler backend returned an error"
                        )

            return AgentResult(
                total_input_tokens=int(usage.get("total_input_tokens", 0)),
                total_output_tokens=int(usage.get("total_output_tokens", 0)),
                failure_mode=FailureMode.NONE,
                timestamped_markers=markers,
            )
        except urllib.error.HTTPError as exc:
            detail = _http_error_detail(exc)
            if log_handle is not None:
                log_handle.write(
                    json.dumps(
                        {
                            "fatal_error": f"HTTP {exc.code}: {exc.reason}",
                            "http_status": exc.code,
                            "http_reason": exc.reason,
                            "http_detail": detail,
                        }
                    )
                    + "\n"
                )
            return AgentResult(
                failure_mode=_fatal_failure_mode(),
                timestamped_markers=markers,
            )
        except (OSError, RuntimeError) as exc:
            if log_handle is not None:
                log_handle.write(
                    json.dumps(
                        {
                            "fatal_error": str(exc),
                            "traceback": traceback.format_exc(),
                        }
                    )
                    + "\n"
                )
            return AgentResult(
                failure_mode=_fatal_failure_mode(),
                timestamped_markers=markers,
            )
        finally:
            if log_handle is not None:
                log_handle.close()

    def _send_callback(
        self, task_id: str, call_id: str, result: dict[str, Any]
    ) -> None:
        body = json.dumps(
            {"task_id": task_id, "call_id": call_id, "result": result}
        ).encode()
        request = urllib.request.Request(
            f"{self.backend_url}/api/callback",
            data=body,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30):
            pass


class _ContainerToolExecutor:
    """Execute Kepler coding tools in the Terminal-Bench task container."""

    def __init__(self, session: TmuxSession) -> None:
        self.session = session
        pane_pid_result = session.container.exec_run(
            [
                "tmux",
                "display-message",
                "-p",
                "-t",
                session._session_name,
                "#{pane_pid}",
            ]
        )
        pane_pid = (pane_pid_result.output or b"").decode(errors="replace").strip()
        pane_cwd = ""
        if pane_pid.isdigit():
            cwd_result = session.container.exec_run(
                ["readlink", f"/proc/{pane_pid}/cwd"]
            )
            pane_cwd = (cwd_result.output or b"").decode(errors="replace").strip()

        app_exists = session.container.exec_run(["test", "-d", "/app"]).exit_code == 0
        configured_cwd = session.container.attrs.get("Config", {}).get("WorkingDir")
        workspace_root = "/app" if app_exists else pane_cwd or configured_cwd or "/"
        workspace_alias = f"/tmp/kepler-tbench-{uuid.uuid4().hex[:12]}"
        alias_result = session.container.exec_run(
            ["ln", "-s", workspace_root, workspace_alias]
        )
        self.cwd = workspace_alias if alias_result.exit_code == 0 else workspace_root

    def execute(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            handler = getattr(self, f"_tool_{name}", None)
            if handler is None:
                return {
                    "success": False,
                    "output": f"Unsupported Terminal-Bench tool: {name}",
                }
            return handler(args)
        except Exception as exc:
            return {"success": False, "output": f"{name} failed: {exc}"}

    def _run(
        self,
        command: list[str] | str,
        *,
        timeout: int = 180,
        workdir: str | None = None,
    ) -> dict[str, Any]:
        if isinstance(command, list):
            shell_command = shlex.join(command)
        else:
            shell_command = command.replace("/root/", f"{self.cwd.rstrip('/')}/")
        wrapped = ["timeout", str(timeout), "bash", "-lc", shell_command]
        result = self.session.container.exec_run(
            wrapped,
            workdir=workdir or self.cwd,
            demux=False,
        )
        output = (result.output or b"").decode(errors="replace")
        return {
            "success": result.exit_code == 0,
            "output": output[-50000:],
            "exit_code": result.exit_code,
        }

    def _path(self, value: str | None) -> str:
        if not value:
            return self.cwd
        if value == "/root":
            return self.cwd
        if value.startswith("/root/"):
            return str(Path(self.cwd) / value.removeprefix("/root/"))
        if value.startswith("/"):
            return value
        return str(Path(self.cwd) / value)

    def _tool_shell(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._run(
            str(args.get("command", "")),
            timeout=int(args.get("timeout") or 180),
        )

    def _tool_run_tests(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._tool_shell(args)

    def _tool_validate_build(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._tool_shell(args)

    def _tool_lint_check(self, args: dict[str, Any]) -> dict[str, Any]:
        command = args.get("command")
        if not command:
            file_path = self._path(args.get("file_path") or args.get("path"))
            command = f"python3 -m py_compile {shlex.quote(file_path)}"
        return self._run(str(command))

    def _tool_read_file(self, args: dict[str, Any]) -> dict[str, Any]:
        file_path = self._path(args.get("file_path") or args.get("path"))
        start = max(1, int(args.get("start_line") or 1))
        end = args.get("end_line")
        if end is None:
            command = ["cat", file_path]
        else:
            command = (
                f"sed -n {shlex.quote(f'{start},{int(end)}p')} "
                f"{shlex.quote(file_path)}"
            )
        return self._run(command)

    def _tool_read_files(self, args: dict[str, Any]) -> dict[str, Any]:
        sections = []
        success = True
        for value in args.get("file_paths") or args.get("paths") or []:
            result = self._tool_read_file({"file_path": value})
            success = success and result["success"]
            sections.append(f"===== {value} =====\n{result['output']}")
        return {"success": success, "output": "\n".join(sections)}

    def _tool_write_file(self, args: dict[str, Any]) -> dict[str, Any]:
        file_path = self._path(args.get("file_path") or args.get("path"))
        return self._write_content(file_path, str(args.get("content", "")))

    def _tool_write_project(self, args: dict[str, Any]) -> dict[str, Any]:
        outputs = []
        success = True
        for item in args.get("files") or []:
            result = self._tool_write_file(
                {
                    "file_path": item.get("path") or item.get("file_path"),
                    "content": item.get("content", ""),
                }
            )
            success = success and result["success"]
            outputs.append(result["output"])
        return {"success": success, "output": "\n".join(outputs)}

    def _tool_edit_file(self, args: dict[str, Any]) -> dict[str, Any]:
        file_path = self._path(args.get("file_path") or args.get("path"))
        payload = base64.b64encode(
            json.dumps(
                {
                    "path": file_path,
                    "search": args.get("search", ""),
                    "replace": args.get("replace", ""),
                    "replace_all": bool(args.get("replace_all", False)),
                }
            ).encode()
        ).decode()
        script = (
            "import base64,json,pathlib,sys;"
            f"d=json.loads(base64.b64decode('{payload}'));"
            "p=pathlib.Path(d['path']);s=p.read_text();old=d['search'];"
            "n=s.count(old);"
            "sys.exit('search string not found') if not n else None;"
            "p.write_text(s.replace(old,d['replace']) if d['replace_all'] "
            "else s.replace(old,d['replace'],1));"
            "print(f'replaced {n if d[\"replace_all\"] else 1} occurrence(s)')"
        )
        return self._run(["python3", "-c", script])

    def _tool_list_files(self, args: dict[str, Any]) -> dict[str, Any]:
        root = self._path(args.get("path"))
        pattern = str(args.get("pattern") or "*")
        return self._run(
            f"find {shlex.quote(root)} -type f -path "
            f"{shlex.quote(str(Path(root) / pattern))} | head -500"
        )

    def _tool_search_files(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._grep(args.get("pattern") or args.get("query"), args)

    def _tool_search_code(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._grep(args.get("query") or args.get("pattern"), args)

    def _tool_grep(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._grep(args.get("pattern"), args)

    def _grep(self, pattern: Any, args: dict[str, Any]) -> dict[str, Any]:
        if not pattern:
            return {"success": False, "output": "pattern is required"}
        root = self._path(args.get("path"))
        include = args.get("include")
        include_arg = f"--glob {shlex.quote(str(include))}" if include else ""
        command = (
            f"if command -v rg >/dev/null; then "
            f"rg -n -C 2 --max-count 20 {include_arg} -e "
            f"{shlex.quote(str(pattern))} {shlex.quote(root)} | head -200; "
            f"else grep -RIn -E {shlex.quote(str(pattern))} "
            f"{shlex.quote(root)} | head -200; fi"
        )
        result = self._run(command)
        if result["exit_code"] == 1:
            result["success"] = True
            result["output"] = f'No matches for "{pattern}"'
        return result

    def _tool_analyze_code(self, args: dict[str, Any]) -> dict[str, Any]:
        file_path = self._path(args.get("file_path") or args.get("path"))
        command = (
            f"grep -nE '^[[:space:]]*(class|def|async def|function|"
            f"export (class|function|const)|[A-Za-z_][A-Za-z0-9_]*[[:space:]]*"
            f"\\([^)]*\\)[[:space:]]*\\{{)' {shlex.quote(file_path)} | head -200"
        )
        return self._run(command)

    def _tool_git_diff(self, args: dict[str, Any]) -> dict[str, Any]:
        file_path = args.get("file_path")
        suffix = f" -- {shlex.quote(str(file_path))}" if file_path else ""
        return self._run(f"git diff{suffix}")

    def _tool_git_status(self, args: dict[str, Any]) -> dict[str, Any]:
        return self._run("git status --short")

    def _tool_get_file_info(self, args: dict[str, Any]) -> dict[str, Any]:
        file_path = self._path(args.get("file_path") or args.get("path"))
        return self._run(["stat", file_path])

    def _tool_validate_file(self, args: dict[str, Any]) -> dict[str, Any]:
        file_path = self._path(args.get("file_path") or args.get("path"))
        return self._run(["test", "-s", file_path])

    def _tool_validate_structure(self, args: dict[str, Any]) -> dict[str, Any]:
        expected = [self._path(value) for value in args.get("expected") or []]
        missing = []
        for file_path in expected:
            result = self._run(["test", "-e", file_path])
            if not result["success"]:
                missing.append(file_path)
        return {
            "success": not missing,
            "output": "Structure valid" if not missing else f"Missing: {missing}",
        }

    def _write_content(self, file_path: str, content: str) -> dict[str, Any]:
        encoded = base64.b64encode(content.encode()).decode()
        script = (
            "import base64,pathlib;"
            f"p=pathlib.Path({file_path!r});"
            "p.parent.mkdir(parents=True,exist_ok=True);"
            f"p.write_bytes(base64.b64decode('{encoded}'));"
            "print(p)"
        )
        return self._run(["python3", "-c", script])


def _iter_sse(response: Any) -> Iterator[tuple[str, dict[str, Any]]]:
    event = "message"
    data_lines: list[str] = []
    for raw_line in response:
        line = raw_line.decode(errors="replace").rstrip("\r\n")
        if not line:
            if data_lines:
                raw_data = "\n".join(data_lines)
                try:
                    data = json.loads(raw_data)
                except json.JSONDecodeError:
                    data = {"message": raw_data}
                yield event, data
            event = "message"
            data_lines = []
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
    if data_lines:
        raw_data = "\n".join(data_lines)
        try:
            data = json.loads(raw_data)
        except json.JSONDecodeError:
            data = {"message": raw_data}
        yield event, data


def _fatal_failure_mode() -> FailureMode:
    return getattr(FailureMode, "FATAL_EXCEPTION", FailureMode.FATAL_LLM_PARSE_ERROR)


def _http_error_detail(exc: urllib.error.HTTPError) -> str:
    try:
        body = exc.read().decode(errors="replace")
    except Exception:
        body = ""
    if not body:
        return ""
    return body[:4000]


def _load_cli_token() -> str:
    env_token = os.environ.get("AGENT_FRAMEWORK_TOKEN", "")
    if env_token.startswith(("kepler_", "tarang_")):
        return env_token

    for path in (
        Path.home() / ".kepler" / "config.json",
    ):
        try:
            token = json.loads(path.read_text()).get("token", "")
        except (OSError, json.JSONDecodeError):
            continue
        if token.startswith(("kepler_", "tarang_")):
            return token

    return env_token or "internal-local-dev"
