# Bahulam Code

Bahulam Code is a terminal coding agent that works in your repository. Ask it to trace a code path, fix a failing test, or plan a change across packages. Follow its file reads, review its edits as diffs, and see which checks it ran. The full-screen Rust terminal keeps the plan pinned below the conversation and shows which tool each sub-agent is using in a side panel.

[Getting started](https://docs.bahulam.ai/getting-started) · [Command reference](https://docs.bahulam.ai/code/commands) · [npm package](https://www.npmjs.com/package/@bahulam/code) · [Benchmark results](https://github.com/BahulamAI/bahulam-benchmarks)

## Install and sign in

You need Node.js 18 or newer and npm. From the repository you want to work in, run:

```sh
npm install --global @bahulam/code@latest
bahulam login
bahulam
```

`bahulam login` opens your browser to sign in to Bahulam for managed model access. To try the CLI without a global install, run `npx --yes @bahulam/code@latest login` once, then `npx --yes @bahulam/code@latest`. The `bahulam-code` command is an alias for `bahulam`.

Check the installed version with `bahulam --version`. To choose a specific release, inspect the published tags with `npm view @bahulam/code dist-tags` and install the exact version you want, for example `npm install --global @bahulam/code@0.2.6`.

## Try a first task

Start with a question you can verify against your own code. For example, in a checkout service:

```text
Trace how an empty cart reaches order creation. Show me the relevant files and tests.
```

Once you have the explanation, continue in the same session:

```text
Reject empty carts before creating an order. Add a regression test and run the checkout tests.
```

When a tool needs approval, review the command or file change and choose whether to allow it. Expand a tool result with **Show details** to inspect its output. To ask a single question from the shell, run `bahulam "Where are the checkout tests?"`.

| In the session | What it does |
| --- | --- |
| `/explore <question>` | Send a read-only sub-agent to investigate the codebase. |
| `/tui fullscreen` | Follow the conversation, pinned plan, and agent activity together. |
| `/tui inline` | Return to the inline Rust terminal in the same session. |
| `/diff` | Review unstaged changes to tracked files. |
| `/resume` | Choose a saved session for the current project. |
| `/status` | Inspect the current session and model usage. |
| `/help` | Browse the available slash commands. |

## Models and providers

The Bahulam model catalog includes the following model families. The IDs below are examples from the bundled catalog. In a session, use `/model refresh` to fetch the current platform catalog, `/model list text` to list text models, and `/model` to choose models by role. Availability depends on your account and route.

| Provider | Model family | Example catalog ID |
| --- | --- | --- |
| <img src="https://github.com/anthropics.png?size=48" width="22" height="22" alt=""> Anthropic | Claude | `anthropic/claude-sonnet-4-6` |
| <img src="https://github.com/openai.png?size=48" width="22" height="22" alt=""> OpenAI | GPT | `openai/gpt-4.1` |
| <img src="https://github.com/google-deepmind.png?size=48" width="22" height="22" alt=""> Google DeepMind | Gemini | `google/gemini-2.5-pro` |
| <img src="https://github.com/deepseek-ai.png?size=48" width="22" height="22" alt=""> DeepSeek | DeepSeek | `deepseek/deepseek-v4-flash` |
| <img src="https://github.com/QwenLM.png?size=48" width="22" height="22" alt=""> Qwen | Qwen Coder | `qwen/qwen3-coder` |
| <img src="https://github.com/mistralai.png?size=48" width="22" height="22" alt=""> Mistral AI | Codestral | `mistralai/codestral-2508` |

The catalog also includes Kimi, Llama, Grok, GLM, and Nemotron. To select a coding model by ID, enter, for example, `/model deepseek/deepseek-v4-flash`. For a direct, single-instruction run with your own credentials, `bahulam --direct -p "Explain the checkout flow"` accepts `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` from your environment. [Model selection guide](https://docs.bahulam.ai/code/models)

## Terminal and project setup

- **Supported platforms.** The package includes the Rust terminal for macOS (Apple silicon and Intel), Linux with glibc (ARM64 and x64), and Windows x64. Interactive sessions start in Rust inline view when the native runtime is available. The Node terminal is the fallback. Switch to it with `/tui default`.
- **Project instructions.** Put build commands and repository conventions in `AGENTS.md`. Use `/status context` to see which instruction files were loaded.
- **Skills and tools.** Add a reusable skill at `.agents/skills/<name>/SKILL.md`, and inspect it with `/skills list`. Connect external tools through MCP. [Skills guide](https://docs.bahulam.ai/code/skills) · [MCP configuration](https://docs.bahulam.ai/code/mcp)
- **Local workspace.** Run `bahulam workspace open .` to inspect local files in a browser. The CLI keeps session history and configuration under `~/.bahulam/` by default.
- **MCP sign-in.** Register OAuth servers with `bahulam mcp add <name> --url <url> --oauth`, then run `bahulam mcp login <name>`. API-key servers support a masked `--api-key` prompt or environment references in headers. You can run these from the composer with `!bahulam mcp …`. [Authentication and credential storage](./docs/mcp-authentication.md)

## Documentation and development

- [Getting started](https://docs.bahulam.ai/getting-started) · [All commands](https://docs.bahulam.ai/code/commands) · [Troubleshooting](https://docs.bahulam.ai/troubleshooting)
- [Agents and sub-agents](https://docs.bahulam.ai/code/agents) · [Tool approvals](https://docs.bahulam.ai/code/approvals)
- [Terminal appearance, session behavior, and plugin settings](./docs/terminal-and-plugins.md)
- [Release and packaging guide](./RELEASE.md) · [Apache 2.0 license](./LICENSE)

To work on the CLI from a source checkout, run `npm ci` and `npm test`. For Rust terminal changes, also run `npm run test:tui`.
