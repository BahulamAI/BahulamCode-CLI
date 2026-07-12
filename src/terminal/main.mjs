#!/usr/bin/env node
/**
 * Kepler CLI — ANSI Terminal UI.
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

async function main() {
  if (subcommand === 'dashboard') {
    // Launch Kepler Pulse Next.js dashboard
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

  if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { version } = require('../../package.json');
    process.stdout.write(`kepler v${version}\n`);
    return;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stderr.write(`
  \x1b[1m\x1b[36mkepler\x1b[0m — AI Coding Agent — codekepler.ai

  \x1b[1mUsage:\x1b[0m
    kepler                    Start interactive REPL
    kepler "instruction"      Run a single instruction
    kepler --headless -p "x"  Non-interactive: auto-approve, JSONL output
    kepler --resume            Resume last conversation
    kepler dashboard          Open Kepler Pulse analytics dashboard
    kepler login              Sign in via browser
    kepler logout             Sign out and clear credentials
    kepler version            Show version

  \x1b[1mAnalytics:\x1b[0m
    kepler sessions           List recent local sessions
    kepler stats              Show aggregate local session stats
    kepler history            Show recent prompt history

  \x1b[1mSkills:\x1b[0m
    kepler skills list [--all|--project]
    kepler skills view <name> [resource]
    kepler skills install <path-or-git-url> [--project] [--force]
    kepler skills update <name> [--project]
    kepler skills remove <name> [--project]

  \x1b[1mREPL Commands:\x1b[0m
    /help                   Show available commands
    /stats                  Session metrics (tokens, cost, tools)
    /cost                   Detailed cost breakdown by model
    /history                Conversation history
    /clear                  Clear conversation history
    /safety                 Show safety guardrail status
    /revoke                 Revoke auto-approvals
    /explore <query>        Spawn read-only codebase explorer
    /review <query>         Spawn code review agent
    /architect <query>      Spawn architecture planning agent
    /exit                   Exit the REPL

  \x1b[1mKeyboard:\x1b[0m
    Esc                     Cancel current execution
    Space                   Pause / resume execution
    Ctrl+C                  Exit

  \x1b[1mEnvironment:\x1b[0m
    TARANG_ENV              Set backend (local, development, production)
    ANTHROPIC_API_KEY       Direct Anthropic API key
    OPENROUTER_API_KEY      OpenRouter API key
    KEPLER_CONFIG_DIR         Override config directory (default: ~/.kepler)

  \x1b[2mDocs: https://codekepler.ai/docs\x1b[0m
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
    });
    return;
  }

  await startTerminalRepl();
}

main().catch(err => {
  process.stderr.write(`\x1b[31mFatal: ${err.message}\x1b[0m\n`);
  process.exit(1);
});
