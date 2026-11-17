import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerBroadcaster } from './event-tap.mjs';
import { TOKENS, LIGHT_TOKENS } from '../ui/palette.mjs';
import { term } from '../ui/term.mjs';

import { stripTerminalControls } from '../core/display-sanitize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_PENDING_EVENT_BYTES = 8 * 1024 * 1024;

function captureTerminalMode() {
  if (process.platform === 'win32' || !process.stdin.isTTY) return null;
  const result = spawnSync('stty', ['-g'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : null;
}

function restoreTerminalMode(savedMode) {
  if (!savedMode || process.platform === 'win32' || !process.stdin.isTTY) return false;
  const result = spawnSync('stty', [savedMode], { stdio: 'inherit' });
  return result.status === 0;
}

function fallbackEvent(event) {
  const source = event?.data || {};
  const take = (value, limit = 1200) => typeof value === 'string' ? stripTerminalControls(value).slice(0, limit) : undefined;
  let data;
  switch (event?.type) {
    case 'turn_started': data = { text: take(source.text, 500) }; break;
    case 'message_end': data = { text: take(source.text, 1600) }; break;
    case 'tool_requested': data = {
      name: take(source.name, 80), primary: take(source.primary, 240), preview: take(source.preview, 500),
    }; break;
    case 'tool_finished': data = {
      ok: source.ok !== false,
      summary: take(source.summary, 240), preview: take(source.preview, 1200),
      exit_code: Number.isInteger(source.exit_code) ? source.exit_code : undefined,
      duration_ms: Number.isFinite(source.duration_ms) ? source.duration_ms : undefined,
      diff_stats: source.diff_stats,
    }; break;
    case 'agent_spawned': data = { type: take(source.type, 80), task: take(source.task, 300) }; break;
    case 'agent_finished': data = { ok: source.ok !== false, report: take(source.report, 600) }; break;
    case 'turn_ended': data = { ok: source.ok !== false, summary: take(source.summary, 500) }; break;
    case 'notice': data = {
      level: take(source.level, 24), title: take(source.title, 120),
      cause: take(source.cause, 240), next_step: take(source.next_step, 240),
    }; break;
    case 'command_result': data = {
      name: take(source.name, 100), result: take(source.result, 800), ok: source.ok !== false,
    }; break;
    default: return null;
  }
  return { type: event.type, agent_id: take(event.agent_id, 100), data };
}

/** Host the Rust renderer while Node keeps ownership of the coding session. */
export function startRustTuiHost({
  onCommand,
  onCommandFailure,
  onExit,
  env = process.env,
  mode,
  maxPendingEventBytes = MAX_PENDING_EVENT_BYTES,
} = {}) {
  const binary = env.BAHULAM_TUI_BINARY || path.resolve(here, '../../rust/target/debug/bahulam-tui');
  if (!fs.existsSync(binary)) throw new Error(`Rust terminal client is not built: ${binary}. Run npm run tui:build.`);
  const savedTerminalMode = captureTerminalMode();
  const requestedTheme = (env.BAHULAM_THEME || '').toLowerCase();
  const child = spawn(binary, ['--stdio'], { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'], env: { ...env,
    BAHULAM_TUI_MODE: mode || env.BAHULAM_TUI_MODE || 'inline',
    BAHULAM_THEME: ['dark','light','high-contrast','ansi'].includes(requestedTheme) ? requestedTheme : term().appearance,
    BAHULAM_TUI_COLOR_LEVEL: term().colorLevel,
    BAHULAM_TUI_PALETTE: JSON.stringify({ dark: TOKENS, light: LIGHT_TOKENS }),
  } });
  const events = child.stdio[3];
  const commands = child.stdio[4];
  let buffer = '';
  let closed = false;
  let eventPipeFailed = false;
  let terminalState = { active: false, alternate_screen: false, keyboard_enhancement: false, shell_command_marked: false, shell_prompt_marked: false };
  const recentEvents = [];
  let failure = null;
  let killTimer;
  const stopChild = () => {
    if (child.exitCode != null || child.signalCode != null) return;
    child.kill('SIGTERM');
    killTimer ||= setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); }, 2000);
    killTimer.unref();
  };
  const failPipe = error => {
    if (closed || eventPipeFailed) return;
    eventPipeFailed = true;
    failure = stripTerminalControls(error.message || String(error));
    stopChild();
  };
  events.on('error', failPipe);
  commands.on('error', failPipe);
  const reportCommandFailure = (error, command) => {
    try {
      if (onCommandFailure) onCommandFailure(error, command);
      else process.stderr.write(`[bahulam-tui] command failed: ${error.message}\n`);
    } catch (reportError) {
      process.stderr.write(`[bahulam-tui] could not report command failure: ${reportError.message}\n`);
    }
  };
  const send = event => {
    if (closed || eventPipeFailed || !events.writable) return Promise.resolve(false);
    const line = `${JSON.stringify(event)}\n`;
    if (events.writableLength + Buffer.byteLength(line) > maxPendingEventBytes) {
      failPipe(new Error(`event pipe exceeded ${maxPendingEventBytes} bytes`));
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      let settled = false;
      const done = error => {
        if (settled) return;
        settled = true;
        if (error) failPipe(error);
        resolve(!error && !closed && !eventPipeFailed);
      };
      events.write(line, done);
    });
  };
  const unregister = registerBroadcaster(event => {
    if (closed || eventPipeFailed || !events.writable) return;
    const fallback = fallbackEvent(event);
    if (fallback) {
      recentEvents.push(fallback);
      if (recentEvents.length > 100) recentEvents.shift();
    }
    void send(event);
  }, { schemaVersion: 2, live: true });

  commands.setEncoding('utf8');
  commands.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { failPipe(new Error('command pipe exceeded 8 MiB')); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const command = JSON.parse(line);
        if (command?.type === 'terminal_state') {
          terminalState = {
            active: command.data?.active === true,
            alternate_screen: command.data?.active === true && command.data?.alternate_screen === true,
            keyboard_enhancement: command.data?.active === true && command.data?.keyboard_enhancement === true,
            shell_command_marked: command.data?.active === true && command.data?.shell_command_marked === true,
            shell_prompt_marked: command.data?.active === true && command.data?.shell_prompt_marked === true,
          };
          continue;
        }
        Promise.resolve(onCommand?.(command)).catch(error => {
          reportCommandFailure(error, command);
        });
      } catch (error) {
        reportCommandFailure(new Error(`invalid command: ${error.message}`), null);
      }
    }
  });
  child.once('error', error => { failure = stripTerminalControls(error.message); });
  child.once('close', (code, signal) => {
    closed = true;
    clearTimeout(killTimer);
    unregister();
    const terminalModeRestored = restoreTerminalMode(savedTerminalMode);
    onExit?.({ code, signal, failure, recentEvents, terminalState, terminalModeRestored });
  });
  return {
    child,
    send,
    close() {
      closed = true;
      unregister();
      try { events.end(); } catch {}
      try { commands.destroy(); } catch {}
      stopChild();
    },
  };
}
