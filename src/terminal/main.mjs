#!/usr/bin/env node
/**
 * Bahulam Code CLI — ANSI Terminal UI. Bahulam's coding agent.
 * Zero React. Zero Ink. Zero flickering.
 */

import { startTerminalRepl } from './repl.mjs';
import {
  runSessionsCommand,
  runStatsCommand,
  runHistoryCommand,
} from './analytics.mjs';
import { parseArgs } from '../config/cli-args.mjs';

// ── Subcommands ──

const subcommand = process.argv[2];
const subcommandArgs = process.argv.slice(3);

function parseKeplerSubcommandArgs(command, argv) {
  const parsed = {
    command,
    workflowSubcommand: null,
    workflowSlug: null,
    workflowFile: null,
    workflowDir: null,
    agentSubcommand: null,
    agentSlug: null,
    agentDir: null,
    instruction: null,
    pattern: null,
    yes: false,
    verbose: false,
    debug: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--file':
      case '-f':
        parsed.workflowFile = argv[++i];
        break;
      case '--dir':
        if (command === 'agent') parsed.agentDir = argv[++i];
        else parsed.workflowDir = argv[++i];
        break;
      case '--instruction':
      case '--input':
      case '--print':
      case '-p':
        parsed.instruction = argv[++i];
        break;
      case '--pattern':
        parsed.pattern = argv[++i];
        break;
      case '--yes':
      case '-y':
        parsed.yes = true;
        break;
      case '--verbose':
      case '-v':
        parsed.verbose = true;
        break;
      case '--debug':
      case '-d':
        parsed.debug = true;
        parsed.verbose = true;
        break;
      default:
        if (arg.startsWith('-')) break;
        if (command === 'workflow') {
          if (!parsed.workflowSubcommand) parsed.workflowSubcommand = arg;
          else if (!parsed.workflowSlug) parsed.workflowSlug = arg;
        } else if (command === 'agent') {
          if (!parsed.agentSubcommand) parsed.agentSubcommand = arg;
          else if (!parsed.agentSlug) parsed.agentSlug = arg;
        }
        break;
    }
  }

  return parsed;
}

async function main() {
  if (subcommand === 'dashboard') {
    // Launch Bahulam Pulse Next.js dashboard
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'pulse', 'cli.js');
    const child = spawn(process.execPath, [cliPath, ...subcommandArgs], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  if (subcommand === 'sessions') {
    await runSessionsCommand(subcommandArgs);
    return;
  }

  if (subcommand === 'stats') {
    await runStatsCommand(subcommandArgs);
    return;
  }

  if (subcommand === 'history') {
    await runHistoryCommand(subcommandArgs);
    return;
  }

  if (subcommand === 'init') {
    const { runInitCommand } = await import('./init.mjs');
    await runInitCommand(subcommandArgs);
    return;
  }

  if (subcommand === 'skills' || subcommand === 'skill') {
    const { runSkillsCommand } = await import('./skills.mjs');
    try {
      await runSkillsCommand(subcommandArgs);
    } catch (err) {
      process.stderr.write(`\x1b[31m✗ Skills command failed: ${err.message}\x1b[0m\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (subcommand === 'login') {
    const { TarangAuth } = await import('../auth/tarang-auth.mjs');
    const auth = new TarangAuth();
    try {
      await auth.login();
      process.stderr.write('\x1b[32m✓ Login successful!\x1b[0m\n');
      return;
    } catch (err) {
      process.stderr.write(`\x1b[31m✗ Login failed: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  if (subcommand === 'logout') {
    const { TarangAuth } = await import('../auth/tarang-auth.mjs');
    const auth = new TarangAuth();
    const success = auth.logout();
    if (success) {
      process.stderr.write('\x1b[32m✓ Signed out. Credentials cleared.\x1b[0m\n');
    } else {
      process.stderr.write('\x1b[33m! No credentials to clear.\x1b[0m\n');
    }
    return;
  }

  if (subcommand === 'workflow') {
    const { handleWorkflowCommand } = await import('../commands/workflow.mjs');
    await handleWorkflowCommand(parseKeplerSubcommandArgs('workflow', subcommandArgs));
    return;
  }

  if (subcommand === 'agent') {
    const { handleAgentCommand } = await import('../commands/agent.mjs');
    await handleAgentCommand(parseKeplerSubcommandArgs('agent', subcommandArgs));
    return;
  }

  if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { version } = require('../../package.json');
    process.stdout.write(`Bahulam Code v${version}\n`);
    return;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stderr.write(`
  \x1b[1m\x1b[36mBahulam Code\x1b[0m — Bahulam's coding agent — bahulam.ai

  \x1b[1mUsage:\x1b[0m
    bahulam-code                        Start interactive REPL
    bahulam-code "instruction"          Run a single instruction
    bahulam-code --headless -p "x"      Non-interactive: auto-approve, JSONL output
    bahulam-code --headless -p "x" --vision screenshot.png
                              Attach an image via the vision analysis pipeline
    bahulam-code --resume               Resume last conversation
    bahulam-code dashboard              Open analytics dashboard
    bahulam-code login                  Sign in via browser
    bahulam-code logout                 Sign out and clear credentials
    bahulam-code init                   Scaffold .bahulam config, memory, hooks, tasks
    bahulam-code version                Show version

  \x1b[1mAnalytics:\x1b[0m
    bahulam-code sessions               List recent local sessions
    bahulam-code stats                  Show aggregate local session stats
    bahulam-code history                Show recent prompt history

  \x1b[1mSkills:\x1b[0m
    bahulam-code skills list [--all|--project]
    bahulam-code skills view <name> [resource]
    bahulam-code skills install <path-or-git-url> [--project] [--force]
    bahulam-code skills update <name> [--project]
    bahulam-code skills remove <name> [--project]

  \x1b[1mREPL Commands:\x1b[0m
    /help                   Show available commands
    /stats                  Session metrics (tokens, cost, tools)
    /cost                   Detailed cost breakdown by model
    /model [role] [model]   Show or set session model override
    /history                Conversation history
    /new                    Start a new session
    /clear                  Clear conversation history
    /safety                 Show safety guardrail status
    /revoke                 Revoke auto-approvals
    /explore <query>        Spawn read-only codebase explorer
    /review <query>         Spawn code review agent
    /architect <query>      Spawn architecture planning agent
    /agents create <name>   Create project-local user-defined agent YAML
    /agents edit <name>     Open a local agent YAML in your editor
    /agents sync [name]     Sync all or one local agent to Supabase
    /attach <image-path>    Attach an image to next prompt
    /attach clipboard       Attach image copied to macOS/Windows clipboard
    /exit                   Exit the REPL

  \x1b[1mKeyboard:\x1b[0m
    Esc                     Cancel current execution
    Space                   Pause / resume execution
    Ctrl+C                  Exit

  \x1b[1mEnvironment:\x1b[0m
    TARANG_ENV              Set backend (local, treetop, production)
    ANTHROPIC_API_KEY       Direct Anthropic API key
    OPENROUTER_API_KEY      OpenRouter API key
    BAHULAM_CONFIG_DIR        Override config directory (default: ~/.bahulam)
    KEPLER_CONFIG_DIR         Legacy config directory override
    KEPLER_RECONNECT_MAX_ELAPSED_MS
                            Max reconnect window for dropped streams
    BAHULAM_TTY_MODE=stable Scrollback-safe transcript if fixed dock redraws leak
    KEPLER_BLOCK_SEPARATOR  Tool/content separator: space, dotted, or off

  \x1b[2mDocs: https://bahulam.ai\x1b[0m
`);
    return;
  }

  // ── Headless mode (benchmarks, automation) ──
  const args = parseArgs(process.argv.slice(2));
  if (args.prompt && (process.argv.includes('--headless') || !process.stdin.isTTY)) {
    const { runHeadless } = await import('../core/headless.mjs');
    await runHeadless({
      instruction: args.prompt,
      model: args.model,
      timeout: args.timeout || (args.maxTurns ? args.maxTurns * 60 : 600),
      verbose: args.verbose,
      cacheReport: args.cacheReport,
      local: args.local,
      vision: args.vision,
    });
    return;
  }

  await startTerminalRepl();
}

main().catch(err => {
  process.stderr.write(`\x1b[31mFatal: ${err.message}\x1b[0m\n`);
  process.exit(1);
});
