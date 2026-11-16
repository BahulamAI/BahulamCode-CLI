import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerBroadcaster } from './event-tap.mjs';
import { TOKENS, LIGHT_TOKENS } from '../ui/palette.mjs';
import { term } from '../ui/term.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Host the Rust renderer while Node keeps ownership of the coding session. */
export function startRustTuiHost({ onCommand, onExit, mode } = {}) {
  const binary = process.env.BAHULAM_TUI_BINARY || path.resolve(here, '../../rust/target/debug/bahulam-tui');
  if (!fs.existsSync(binary)) throw new Error(`Rust terminal client is not built: ${binary}. Run npm run tui:build.`);
  const requestedTheme = (process.env.BAHULAM_THEME || '').toLowerCase();
  const child = spawn(binary, ['--stdio'], {
    stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
    env: { ...process.env,
      BAHULAM_TUI_MODE: mode || process.env.BAHULAM_TUI_MODE || 'inline',
      BAHULAM_THEME: ['dark', 'light', 'high-contrast', 'ansi'].includes(requestedTheme) ? requestedTheme : term().appearance,
      BAHULAM_TUI_COLOR_LEVEL: term().colorLevel,
      BAHULAM_TUI_PALETTE: JSON.stringify({ dark: TOKENS, light: LIGHT_TOKENS }),
    },
  });
  const events = child.stdio[3];
  const commands = child.stdio[4];
  let buffer = '';
  let closed = false;
  const unregister = registerBroadcaster(event => {
    if (closed || !events.writable) return;
    events.write(`${JSON.stringify(event)}\n`);
  }, { schemaVersion: 2, live: true });

  commands.setEncoding('utf8');
  commands.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const command = JSON.parse(line);
        Promise.resolve(onCommand?.(command)).catch(error => {
          process.stderr.write(`[bahulam-tui] command failed: ${error.message}\n`);
        });
      } catch (error) {
        process.stderr.write(`[bahulam-tui] invalid command: ${error.message}\n`);
      }
    }
  });
  child.once('error', error => process.stderr.write(`[bahulam-tui] failed to start: ${error.message}\n`));
  child.once('exit', (code, signal) => {
    closed = true;
    unregister();
    onExit?.({ code, signal });
  });
  return {
    child,
    send(event) {
      if (closed || !events.writable) return Promise.resolve(false);
      if (events.write(`${JSON.stringify(event)}\n`)) return Promise.resolve(true);
      return new Promise(resolve => {
        const done = () => { events.removeListener('drain', done); events.removeListener('close', done); resolve(!closed); };
        events.once('drain', done);
        events.once('close', done);
      });
    },
    close() {
      closed = true;
      unregister();
      try { events.end(); } catch {}
      try { commands.destroy(); } catch {}
      if (child.exitCode == null) child.kill('SIGTERM');
    },
  };
}
