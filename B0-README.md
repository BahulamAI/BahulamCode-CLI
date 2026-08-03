# @bahulamai/code

Bahulam Code is Bahulam's AI coding agent for terminal-first software work. It can inspect a
repo, plan changes, run tools, ask for human approval, resume prior sessions, and
keep local project context in `.bahulam/`.

## Install

```bash
npm install -g @bahulamai/code@latest
```

Run without global install:

```bash
npx @bahulamai/code@latest
```

Update an existing global install:

```bash
npm update -g @bahulamai/code
bahulam-code --version
```

Requires Node.js 18 or newer.

## Quick Start

```bash
bahulam-code login
bahulam-code
bahulam-code "fix the failing auth test"
```

Common startup commands:

```bash
bahulam-code                    Start interactive REPL
bahulam-code "instruction"      Run a single instruction and exit
bahulam-code login              Sign in through the browser
bahulam-code dashboard          Open local analytics dashboard
bahulam-code sessions           List recent local sessions
bahulam-code stats              Aggregate local session stats
bahulam-code history            Show recent prompt history
bahulam-code --version            Show installed version
```

## What's New

- Resume sessions with summary-only, summary plus last 10 turns, or summary plus
  last 20 turns.
- Resume summaries are checkpointed in the selected session transcript, so future
  resumes summarize only new uncovered history.
- Approval prompts now use one consistent layout across shell, sensitive reads,
  destructive actions, and backend/framework HITL approvals.
- Reject/stop is a single action. Use re-plan with note when you want to steer
  the agent.
- Approval logs redact secrets before writing to `.bahulam/approvals.log`.
- Long shell commands wrap instead of being truncated.
- Long-running shell commands return an observed output tail instead of hanging
  silently.

## REPL Commands

```text
/help                   Show commands and command groups
/status                 Session status and loaded project context
/plan                   Show project plan and task files
/tasks                  List or add project tasks
/stats                  Session metrics
/history                Conversation history
/history approvals      Recent approval decisions
/resume                 Resume a previous local session
/clear                  Clear in-memory conversation history
/explore <query>        Spawn read-only codebase explorer
/review <query>         Spawn code review agent
/architect <query>      Spawn architecture planning agent
/safety                 Show safety guardrail status
/revoke                 Revoke auto-approvals
/settings               Show effective settings and policy sources
/exit                   Exit the REPL
```

Keyboard:

```text
Esc                     Stop current execution or close a prompt
Space                   Pause / resume execution
Ctrl+C                  Exit
```

## Resume Behavior

`/resume` reads local JSONL transcripts from `~/.bahulam/projects/**`. The
selected session is the source of truth.

For large sessions, Bahulam Code shows mode choices:

```text
full transcript
summary only
summary + last 10 turns
summary + last 20 turns
```

The session picker still shows the raw full transcript estimate, for example
`593k ctx`. If a summary checkpoint exists, it also shows a status such as
`summarized 82%`. That means earlier reconstructed messages are already covered
by a stored `resume_summary` marker. Summary and tail modes reuse that marker and
only summarize uncovered messages when needed.

The agent receives:

1. resume metadata
2. the original user request
3. the checkpointed or freshly generated summary
4. the retained recent tail for summary-plus-tail modes

## Resilient Streaming

Bahulam Code keeps a per-task SSE event cursor while a turn is running. If the network
connection drops mid-turn, the CLI reconnects to the same backend task and asks
for events after the last rendered event id. This protects long-running tool
sessions from transient connection drops.

The terminal shows reconnect states inline:

```text
! connection lost; attempt 1 from event 42
✓ reconnected · replayed 6 events
```

Tool callbacks use idempotency keys, so retry/reconnect windows do not duplicate
completed local tool results.

## Approvals And HITL

Bahulam Code auto-approves low-risk reads and safe shell inspection commands. It asks
for confirmation for sensitive reads, mutating shell commands, destructive
actions, network actions, and framework-level HITL requests.

Prompt actions:

```text
Enter / y      approve once
t              always allow this tool type, when available
s              trust this pattern for the session, when policy allows it
a              trust this pattern for the project, when policy allows it
r              re-plan with a note for the agent
n / Esc        stop without running
?              show why approval is required
```

Sensitive reads include files such as `.env`, `*.pem`, and `secrets/**`.

Approval decisions are logged locally in `.bahulam/approvals.log`. Secret-like
values in commands, nested args, query strings, authorization headers, and
rejection notes are redacted before the log is written.

## Project Context

Bahulam Code uses a project-local `.bahulam/` folder for hand-editable context:

```text
.bahulam/
  KEPLER.md          Project operating brief
  settings.json      Project settings and policy
  hooks.json         Tool/user hook configuration
  hitl.md            Approval guidance
  tasks/
    backlog.md
    active.md
    blocked.md
    done.md
```

Use `/plan` and `/tasks` in the REPL to inspect and update task files.

## Skills

Bahulam Code supports portable `SKILL.md` bundles and Claude-compatible skill
directories. Skill metadata is included in cached context; full instructions and
references are loaded only when needed.

Discovery precedence:

1. `<project>/.bahulam/skills`
2. `<project>/.claude/skills`
3. `~/.bahulam/skills`
4. `~/.claude/skills`

Install skills:

```bash
bahulam-code skills install ./my-skill
bahulam-code skills install github:owner/skills-repository
bahulam-code skills install https://github.com/owner/skills.git
bahulam-code skills install ./team-skills --project
```

## Configuration

Settings are managed in the web dashboard and synced to the CLI:

https://bahulam.ai/dashboard/settings

Common local paths:

```text
~/.bahulam/                        Global CLI state
~/.bahulam/projects/**             Local JSONL transcripts
~/.bahulam/history.jsonl           Prompt history
<project>/.bahulam/                Project context and policy
<project>/.bahulam/approvals.log   Project approval audit log
```

Provider API keys can be configured in the dashboard or through environment
variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and
`OPENROUTER_API_KEY`.

Runtime controls:

```text
KEPLER_RECONNECT_MAX_ELAPSED_MS    Max reconnect window for a dropped stream
KEPLER_BLOCK_SEPARATOR             space, dotted, or off
```

## Troubleshooting

Check installed package:

```bash
npm list -g @bahulamai/code --depth=0
bahulam-code --version
```

Use a clean one-off run:

```bash
npx @bahulamai/code@latest --version
```

If npm cache permissions are broken, use a temporary cache:

```bash
env NPM_CONFIG_CACHE=/private/tmp/bahulam-code-npm-cache npm pack --dry-run
```

If a resume session shows a large context number, check whether the row also
shows `summarized`. The large number is the full transcript estimate; summary and
tail modes usually send much less.

## Links

- Website: https://bahulam.ai
- Company: https://axplusb.tech
- Repository: https://github.com/raviakasapu/codekepler-npm

## License

MIT
