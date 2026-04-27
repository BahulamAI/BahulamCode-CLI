#!/usr/bin/env node
/**
 * Orca CLI — ANSI Terminal UI.
 * Zero React. Zero Ink. Zero flickering.
 */

import { startTerminalRepl } from './repl.mjs';

// ── Subcommands ──

const subcommand = process.argv[2];

if (subcommand === 'dashboard') {
  // Launch cc-lens pointed at ~/.orca/ for local analytics
  import('node:child_process').then(({ spawn }) => {
    import('node:os').then(({ homedir }) => {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: `${homedir()}/.orca` };
      const child = spawn('npx', ['cc-lens'], { env, stdio: 'inherit', shell: true });
      child.on('error', (err) => {
        process.stderr.write(`\x1b[31mFailed to launch dashboard: ${err.message}\x1b[0m\n`);
        process.stderr.write(`\x1b[2mInstall cc-lens: npm install -g cc-lens\x1b[0m\n`);
        process.exit(1);
      });
      child.on('exit', (code) => process.exit(code || 0));
    });
  });
} else if (subcommand === 'login') {
  // Quick login shortcut
  import('../auth/tarang-auth.mjs').then(({ TarangAuth }) => {
    const auth = new TarangAuth();
    auth.login().then(() => {
      process.stderr.write('\x1b[32m✓ Login successful!\x1b[0m\n');
      process.exit(0);
    }).catch(err => {
      process.stderr.write(`\x1b[31m✗ Login failed: ${err.message}\x1b[0m\n`);
      process.exit(1);
    });
  });
} else if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
  import('node:module').then(({ createRequire }) => {
    const require = createRequire(import.meta.url);
    const { version } = require('../../package.json');
    process.stdout.write(`orca v${version}\n`);
    process.exit(0);
  });
} else if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  process.stderr.write(`
  \x1b[1m\x1b[36morca\x1b[0m — Orchestration of Composable Agents

  \x1b[1mUsage:\x1b[0m
    orca                Start interactive REPL
    orca dashboard      Open local analytics dashboard
    orca login          Sign in via browser
    orca version        Show version

  \x1b[2mOnce in the REPL, type /help for commands.\x1b[0m
`);
  process.exit(0);
} else {
  // Default: start interactive REPL
  startTerminalRepl().catch(err => {
    process.stderr.write(`\x1b[31mFatal: ${err.message}\x1b[0m\n`);
    process.exit(1);
  });
}
