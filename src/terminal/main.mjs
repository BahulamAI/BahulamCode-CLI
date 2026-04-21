#!/usr/bin/env node
/**
 * Orca CLI — ANSI Terminal UI.
 * Zero React. Zero Ink. Zero flickering.
 */

import { startTerminalRepl } from './repl.mjs';

startTerminalRepl().catch(err => {
  process.stderr.write(`\x1b[31mFatal: ${err.message}\x1b[0m\n`);
  process.exit(1);
});
