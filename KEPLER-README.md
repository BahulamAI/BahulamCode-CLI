# @axplusb/kepler

Kepler is an AI coding agent for terminal-first software work. It can inspect a
repo, plan changes, run tools, ask for human approval, resume prior sessions, and
keep local project context in `.kepler/`.

## Install

```bash
npm install -g @axplusb/kepler@latest
```

Run without global install:

```bash
npx @axplusb/kepler@latest
```

Update an existing global install:

```bash
npm update -g @axplusb/kepler
kepler version
```

Requires Node.js 18 or newer.

## Quick Start

```bash
kepler login
kepler
kepler "fix the failing auth test"
```

Common startup commands:

```bash
kepler                    Start interactive REPL
kepler "instruction"      Run a single instruction and exit
kepler login              Sign in through the browser
kepler dashboard          Open Kepler Pulse analytics dashboard
kepler sessions           List recent local sessions
kepler stats              Aggregate local session stats
kepler history            Show recent prompt history
kepler version            Show installed version
```

## What's New In 2.2.0

- Resume sessions with summary-only, summary plus last 10 turns, or summary plus
  last 20 turns.
- Resume summaries are checkpointed in the selected session transcript, so future
  resumes summarize only new uncovered history.
- Approval prompts now use one consistent layout across shell, sensitive reads,
  destructive actions, and backend/framework HITL approvals.
- Reject/stop is a single action. Use re-plan with note when you want to steer
  the agent.
- Approval logs redact secrets before writing to `.kepler/approvals.log`.
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

`/resume` reads local JSONL transcripts from `~/.kepler/projects/**`. The
selected session is the source of truth.

For large sessions, Kepler shows mode choices:

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

## Approvals And HITL

Kepler auto-approves low-risk reads and safe shell inspection commands. It asks
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

Approval decisions are logged locally in `.kepler/approvals.log`. Secret-like
values in commands, nested args, query strings, authorization headers, and
rejection notes are redacted before the log is written.

## Project Context

Kepler uses a project-local `.kepler/` folder for hand-editable context:

```text
.kepler/
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

Kepler supports portable `SKILL.md` bundles and Claude-compatible skill
directories. Skill metadata is included in cached context; full instructions and
references are loaded only when needed.

Discovery precedence:

1. `<project>/.kepler/skills`
2. `<project>/.claude/skills`
3. `~/.kepler/skills`
4. `~/.claude/skills`

Install skills:

```bash
kepler skills install ./my-skill
kepler skills install github:owner/skills-repository
kepler skills install https://github.com/owner/skills.git
kepler skills install ./team-skills --project
```

## Configuration

Settings are managed in the web dashboard and synced to the CLI:

https://codekepler.ai/dashboard/settings

Common local paths:

```text
~/.kepler/                         Global CLI state
~/.kepler/projects/**              Local JSONL transcripts
~/.kepler/history.jsonl            Prompt history
<project>/.kepler/                 Project context and policy
<project>/.kepler/approvals.log    Project approval audit log
```

Provider API keys can be configured in the dashboard or through environment
variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and
`OPENROUTER_API_KEY`.

## Troubleshooting

Check installed package:

```bash
npm list -g @axplusb/kepler --depth=0
kepler version
```

Use a clean one-off run:

```bash
npx @axplusb/kepler@latest --version
```

If npm cache permissions are broken, use a temporary cache:

```bash
env NPM_CONFIG_CACHE=/private/tmp/kepler-npm-cache npm pack --dry-run
```

If a resume session shows a large context number, check whether the row also
shows `summarized`. The large number is the full transcript estimate; summary and
tail modes usually send much less.

## Links

- Website: https://codekepler.ai
- Company: https://axplusb.tech
- Repository: https://github.com/raviakasapu/codekepler-npm

## License

MIT
