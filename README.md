# open-claude-code v2 — Technical Guide

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node src/index.mjs "hello"          # one-shot
node src/index.mjs                   # interactive REPL
node src/index.mjs -m claude-opus-4-6 -p "explain this"  # print mode
```

## Architecture

```
v2/src/
├── core/                    # Core engine
│   ├── agent-loop.mjs       # Async generator (13 event types, recursive)
│   ├── streaming.mjs        # SSE handler (all event types)
│   ├── context-manager.mjs  # Token tracking + compaction
│   ├── system-prompt.mjs    # CLAUDE.md loading + cache boundary
│   ├── session.mjs          # Save/resume/teleport
│   ├── checkpoints.mjs      # File checkpointing + undo
│   ├── cache.mjs            # Prompt caching
│   ├── rate-limiter.mjs     # 429/529 handling + backoff
│   ├── providers.mjs        # 5 AI providers
│   └── scheduler.mjs        # Cron task scheduling
├── tools/                   # 25 tools
│   ├── registry.mjs         # validateInput/call interface
│   ├── bash.mjs             # Shell (sandboxed, timeout, background)
│   ├── read.mjs             # File read (PDF, binary detect, line nums)
│   ├── edit.mjs             # Edit (replace_all, uniqueness check)
│   ├── write.mjs            # Write (mkdir, overwrite protection)
│   ├── glob.mjs             # Glob (proper matching, mtime sort)
│   ├── grep.mjs             # Grep (-i/-n/-A/-B/-C, ripgrep)
│   ├── agent.mjs            # Subagent (worktree, background, model)
│   ├── web-fetch.mjs        # URL fetch
│   ├── web-search.mjs       # Web search
│   ├── todo-write.mjs       # Task management
│   ├── notebook-edit.mjs    # Jupyter notebooks
│   ├── multi-edit.mjs       # Atomic multi-file edits
│   ├── ls.mjs               # Directory listing
│   ├── tool-search.mjs      # Deferred tool discovery
│   ├── ask-user.mjs         # User prompts
│   ├── skill.mjs            # Skill invocation
│   ├── send-message.mjs     # Agent team messaging
│   ├── cron-create.mjs      # Scheduled tasks
│   ├── cron-delete.mjs
│   ├── cron-list.mjs
│   ├── enter-worktree.mjs   # Git worktree
│   ├── exit-worktree.mjs
│   ├── remote-trigger.mjs   # Remote execution
│   ├── lsp.mjs              # Language server
│   └── read-mcp-resource.mjs
├── mcp/                     # MCP protocol
│   ├── client.mjs           # JSON-RPC client
│   ├── transport-sse.mjs    # SSE transport
│   ├── transport-shttp.mjs  # Streamable HTTP
│   └── transport-ws.mjs     # WebSocket
├── permissions/              # Security
│   ├── checker.mjs          # 6 modes + interactive prompts
│   ├── sandbox.mjs          # bubblewrap/seatbelt
│   ├── injection-check.mjs  # Command injection detection
│   ├── path-check.mjs       # File path validation
│   └── prompt.mjs           # Permission prompting
├── hooks/
│   └── engine.mjs           # PreToolUse/PostToolUse/Stop/Notification
├── agents/
│   ├── loader.mjs           # Agent definition loader
│   ├── parser.mjs           # JSON/MD frontmatter parser
│   └── teams.mjs            # Multi-agent teams
├── skills/
│   ├── loader.mjs           # Skill discovery
│   └── runner.mjs           # Skill execution
├── plugins/
│   └── loader.mjs           # Plugin discovery + git clone
├── auth/
│   └── oauth.mjs            # PKCE OAuth flow
├── config/
│   ├── settings.mjs         # 4-source deep merge
│   ├── cli-args.mjs         # All CLI flags
│   └── env.mjs              # 104 env vars
├── ui/
│   ├── repl.mjs             # Interactive REPL
│   ├── ink-app.mjs          # Rich terminal output
│   └── commands.mjs         # 40 slash commands
├── telemetry/
│   └── index.mjs            # Telemetry stub
└── index.mjs                # Entry point

test/
└── test.mjs                 # 1,581 tests
```

## Stats

| Metric | Value |
|--------|:-----:|
| Source files | 61 |
| Lines of code | 8,314 |
| Tests | 1,581 (0 failures) |
| Tools | 25 |
| Slash commands | 40 |
| MCP transports | 4 |
| AI providers | 5 |
| Env vars | 104 |
| Permission modes | 6 |

## Tests

```bash
node test/test.mjs
# Tests: 1581 total, 1581 passed, 0 failed
```
