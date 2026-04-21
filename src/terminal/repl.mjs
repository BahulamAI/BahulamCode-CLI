/**
 * Orca REPL — Pure ANSI terminal UI.
 *
 * No React, no Ink, no batching issues, no flickering.
 * Uses raw ANSI escape codes for rendering.
 */

import * as readline from 'node:readline';
import { cursor, c, drawBox, progressBar, spinner, inPlace, statusBar, stripAnsi, hr } from './ansi.mjs';
import { TarangStreamClient, EVENT_TYPES } from '../core/stream-client.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';

const VERSION = '2.0.0';

// ── Banner ──

const BANNER = [
  ' ██████╗  ██████╗   ██████╗  █████╗ ',
  '██╔═══██╗██╔══██╗ ██╔════╝ ██╔══██╗',
  '██║   ██║██████╔╝ ██║      ███████║',
  '██║   ██║██╔══██╗ ██║      ██╔══██║',
  '╚██████╔╝██║  ██║ ╚██████╗██║  ██║',
  ' ╚═════╝ ╚═╝  ╚═╝  ╚═════╝╚═╝  ╚═╝',
];

function printBanner(auth) {
  process.stderr.write('\n');
  for (const line of BANNER) {
    process.stderr.write(`  ${c.cyan(c.bold(line))}\n`);
  }
  process.stderr.write(`  ${c.gray('Orchestration of Composable Agents')}\n\n`);

  const creds = auth.loadCredentials();
  const env = process.env.TARANG_ENV || 'production';
  const backendUrl = resolveBackendUrl();

  process.stderr.write(`  ${c.gray('Provider:')}  ${c.green('Tarang')}\n`);
  process.stderr.write(`  ${c.gray('Endpoint:')}  ${c.gray(backendUrl)}\n`);
  process.stderr.write(`  ${c.gray('Auth:')}      ${creds.token ? c.green('✓ logged in') : c.red('✗ not logged in (/login)')}\n`);
  process.stderr.write(`  ${c.gray('Env:')}       ${c.gray(env)}\n`);
  process.stderr.write(`  ${c.gray('Version:')}   ${c.gray(`v${VERSION}`)}\n`);
  process.stderr.write('\n');
  process.stderr.write(`  ${c.gray('/help commands  /login auth  Ctrl+C exit')}\n\n`);
}

// ── Event Renderer ──

function renderEvent(event) {
  const { type, data } = event;

  switch (type) {
    case 'status': {
      const msg = data?.message || '';
      if (!msg || msg === 'Agent started') return;
      if (msg.startsWith('Creating agent') || msg.startsWith('Task type:')) {
        inPlace(`  ${c.gray(msg)}`);
      } else {
        inPlace(`  ${spinner(msg)}`);
      }
      break;
    }

    case 'thinking': {
      const text = data?.message || data?.text || '';
      if (text && !text.startsWith('Processing')) {
        inPlace(`  ${spinner(text.slice(0, 100))}`);
      }
      break;
    }

    case 'content':
    case 'content_partial': {
      const text = data?.text || '';
      if (text) {
        inPlace(''); // Clear spinner
        // Render content with 2-space indent
        for (const line of text.split('\n')) {
          process.stdout.write(`  ${line}\n`);
        }
      }
      break;
    }

    case 'tool_call':
    case 'tool_request': {
      const tool = data?.tool || 'unknown';
      const args = data?.args || {};
      const desc = tool === 'read_file' ? `Reading ${args.file_path || args.path || 'file'}`
        : tool === 'write_file' ? `Writing ${args.file_path || args.path || 'file'}`
        : tool === 'edit_file' ? `Editing ${args.file_path || args.path || 'file'}`
        : tool === 'shell' ? `Running: ${(args.command || '').slice(0, 50)}`
        : tool === 'list_files' ? `Listing files${args.pattern ? ' (' + args.pattern + ')' : ''}`
        : tool === 'search_code' ? `Searching: ${args.query || ''}`
        : tool;
      inPlace(`  ${spinner(desc)}`);
      break;
    }

    case 'change': {
      const icon = data?.type === 'create' ? c.green('+') : c.green('~');
      process.stderr.write(`  ${icon} ${c.green(data?.path || '')}\n`);
      break;
    }

    case 'phase_start':
    case 'phase_update': {
      const phase = data?.phase || data?.stage_name || '';
      if (phase) process.stderr.write(`\n  ${spinner(c.bold(phase))}\n`);
      break;
    }

    case 'worker_update': {
      const worker = data?.worker || '';
      const status = data?.status || '';
      if (worker) inPlace(`  ${spinner(`${worker}: ${status}`)}`);
      break;
    }

    case 'delegation': {
      process.stderr.write(`  ${c.cyan(`${data?.from || ''} → ${data?.to || ''}`)}${data?.instruction ? ': ' + data.instruction : ''}\n`);
      break;
    }

    case 'error': {
      inPlace('');
      process.stderr.write(`\n  ${c.red('✗ ' + (data?.message || 'Unknown error'))}\n`);
      if ((data?.message || '').includes('Authentication')) {
        process.stderr.write(`  ${c.gray('Run /login to re-authenticate')}\n`);
      }
      break;
    }

    case 'complete': {
      inPlace(''); // Clear spinner
      const duration = data?.duration_s ? `${Number(data.duration_s).toFixed(1)}s` : '';
      const tools = data?.tool_calls || 0;
      const parts = [];
      if (duration) parts.push(duration);
      if (tools > 0) parts.push(`${tools} tool calls`);
      const stats = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      process.stderr.write(`\n  ${c.green('✓ Done' + stats)}\n`);

      // Show token usage
      const usage = data?.usage;
      if (usage && (usage.total_input_tokens || usage.input_tokens)) {
        const inp = usage.total_input_tokens || usage.input_tokens || 0;
        const out = usage.total_output_tokens || usage.output_tokens || 0;
        process.stderr.write(`  ${c.gray(`Tokens: ${inp.toLocaleString()} in / ${out.toLocaleString()} out`)}\n`);
      }
      break;
    }

    case 'cancelled':
      inPlace('');
      process.stderr.write(`\n  ${c.yellow('Cancelled' + (data?.reason ? ': ' + data.reason : ''))}\n`);
      break;

    case 'paused':
      process.stderr.write(`  ${c.cyan('Paused')}\n`);
      break;

    case 'resumed':
      process.stderr.write(`  ${c.green('Resumed')}\n`);
      break;

    // Ignore: session_info, plan, etc.
    default:
      break;
  }
}

// ── Slash Commands ──

async function handleCommand(input, ctx) {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/help':
      process.stderr.write(`\n  ${c.bold('Orca Commands')}\n\n`);
      process.stderr.write(`  ${c.cyan('/login')}       Sign in via browser\n`);
      process.stderr.write(`  ${c.cyan('/whoami')}      Show logged-in user\n`);
      process.stderr.write(`  ${c.cyan('/status')}      Show session info\n`);
      process.stderr.write(`  ${c.cyan('/clear')}       Clear conversation\n`);
      process.stderr.write(`  ${c.cyan('/git')}         Git status\n`);
      process.stderr.write(`  ${c.cyan('/diff')}        Git diff\n`);
      process.stderr.write(`  ${c.cyan('/stats')}       System stats\n`);
      process.stderr.write(`  ${c.cyan('/exit')}        Exit CLI\n`);
      process.stderr.write(`\n  ${c.bold('Keyboard')}\n`);
      process.stderr.write(`  ${c.bold('Ctrl+C')} exit\n\n`);
      return true;

    case '/login':
      process.stderr.write(`${c.cyan('Starting login flow...')}\n`);
      try {
        await ctx.auth.login();
        process.stderr.write(`${c.green('✓ Login successful!')}\n`);
      } catch (err) {
        process.stderr.write(`${c.red('✗ Login failed: ' + err.message)}\n`);
      }
      return true;

    case '/whoami': {
      const creds = ctx.auth.loadCredentials();
      if (!creds.token) { process.stderr.write(`${c.red('Not logged in. Run /login.')}\n`); return true; }
      process.stderr.write(`${c.gray('Fetching...')}\n`);
      try {
        const resp = await fetch(`${creds.backendUrl}/api/user/me`, {
          headers: { 'Authorization': `Bearer ${creds.token}` },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        process.stderr.write(`  ${c.green('✓')} ${data.github_username || 'unknown'}\n`);
        process.stderr.write(`  ${c.gray('Email:')}   ${data.email || 'n/a'}\n`);
        process.stderr.write(`  ${c.gray('User ID:')} ${data.id}\n`);
        process.stderr.write(`  ${c.gray('Role:')}    ${data.role || 'user'}\n\n`);
      } catch (err) {
        process.stderr.write(`${c.red('✗ ' + err.message)}\n`);
      }
      return true;
    }

    case '/status': {
      const creds = ctx.auth.loadCredentials();
      const env = process.env.TARANG_ENV || 'production';
      process.stderr.write(`\n  ${c.bold('Session Status')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(35))}\n`);
      process.stderr.write(`  ${c.gray('Backend:')}  ${creds.backendUrl}\n`);
      process.stderr.write(`  ${c.gray('Env:')}      ${env}\n`);
      process.stderr.write(`  ${c.gray('Token:')}    ${creds.token ? 'yes' : 'no'}\n`);
      process.stderr.write(`  ${c.gray('CWD:')}      ${process.cwd()}\n`);

      // System stats
      const mem = process.memoryUsage();
      const os = await import('node:os');
      process.stderr.write(`  ${c.gray('Node:')}     ${process.version}\n`);
      process.stderr.write(`  ${c.gray('Heap:')}     ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB\n`);
      process.stderr.write(`  ${c.gray('Memory:')}   ${((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1)}G / ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}G\n\n`);
      return true;
    }

    case '/stats': {
      const os = await import('node:os');
      const mem = process.memoryUsage();
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      const memPct = Math.round((usedMem / totalMem) * 100);
      const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);

      process.stderr.write(`\n  ${c.bold('System Stats')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(35))}\n`);
      process.stderr.write(`  ${progressBar(memPct, 15, 'Memory')} ${(usedMem / 1024 / 1024 / 1024).toFixed(1)}G\n`);
      process.stderr.write(`  ${progressBar(heapPct, 15, 'Heap')} ${(mem.heapUsed / 1024 / 1024).toFixed(0)}M\n`);
      process.stderr.write(`  ${c.gray('History:')}  ${ctx.history.length} messages\n\n`);
      return true;
    }

    case '/clear':
      ctx.history.length = 0;
      process.stderr.write(`${c.gray('Conversation cleared.')}\n`);
      return true;

    case '/git': {
      const { execSync } = await import('node:child_process');
      try {
        process.stdout.write(execSync('git status --short --branch', { encoding: 'utf-8' }) + '\n');
      } catch (e) { process.stderr.write(`${c.red(e.message)}\n`); }
      return true;
    }

    case '/diff': {
      const { execSync } = await import('node:child_process');
      try {
        process.stdout.write(execSync('git diff --stat', { encoding: 'utf-8' }) || '(no changes)\n');
      } catch (e) { process.stderr.write(`${c.red(e.message)}\n`); }
      return true;
    }

    case '/exit':
    case '/quit':
      process.stderr.write(`\n  ${c.cyan('Goodbye!')}\n\n`);
      process.exit(0);

    default:
      process.stderr.write(`  ${c.gray('Unknown command: ' + cmd + '. Type /help.')}\n`);
      return true;
  }
}

// ── Main REPL ──

export async function startTerminalRepl() {
  const auth = new TarangAuth();
  const toolExecutor = createToolExecutor();
  const approval = new ApprovalManager({ autoApprove: false });
  const history = [];
  const ctx = { auth, history };

  printBanner(auth);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${c.cyan('orca>')} `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Slash commands
    if (input.startsWith('/')) {
      await handleCommand(input, ctx);
      rl.prompt();
      return;
    }

    // Regular prompt — stream from Tarang backend
    history.push({ role: 'user', content: input });

    const creds = auth.loadCredentials();
    if (!creds.token) {
      process.stderr.write(`  ${c.red('Not logged in. Run /login first.')}\n`);
      rl.prompt();
      return;
    }

    const client = new TarangStreamClient({
      baseUrl: creds.backendUrl,
      token: creds.token,
      toolExecutor,
      approvalManager: approval,
    });

    let assistantContent = '';

    try {
      for await (const event of client.execute(input, { cwd: process.cwd() }, history)) {
        renderEvent(event);

        // Capture assistant response for history
        if (event.type === 'content' || event.type === 'content_partial') {
          const text = event.data?.text || '';
          if (text) assistantContent = text;
        }
      }
    } catch (err) {
      inPlace('');
      process.stderr.write(`  ${c.red('Error: ' + err.message)}\n`);
    }

    if (assistantContent) {
      history.push({ role: 'assistant', content: assistantContent });
    }

    process.stdout.write('\n');
    rl.prompt();
  });

  rl.on('close', () => {
    process.stderr.write(`\n  ${c.cyan('Goodbye!')}\n\n`);
    process.exit(0);
  });
}
