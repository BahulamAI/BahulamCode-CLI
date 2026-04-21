/**
 * Orca REPL — Full Claude-like terminal UX.
 *
 * Pure ANSI. No React. No Ink. No flickering.
 *
 * Features:
 * - Persistent status bar (model, cost, context, elapsed)
 * - Spinner with tool names (in-place updates)
 * - Markdown rendering (bold, code blocks, lists)
 * - Input history (Up/Down arrows)
 * - Command autocomplete (Tab)
 * - Cost tracking per session
 * - Permission prompts (Y/n/a/t)
 */

import * as readline from 'node:readline';
import { cursor, c, drawBox, progressBar, spinner, inPlace, statusBar, renderMarkdown, formatElapsed, formatCost, hr } from './ansi.mjs';
import { TarangStreamClient, EVENT_TYPES } from '../core/stream-client.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';

const VERSION = '2.0.0';

// ── Session State ──

const session = {
  startTime: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  turns: 0,
  history: [],         // conversation messages
  inputHistory: [],    // previous prompts (for Up/Down)
  user: null,          // { github_username, email, role }
  model: null,         // from backend user profile
};

// ── Commands ──

const COMMANDS = {
  '/help':    'Show commands',
  '/login':   'Sign in via browser',
  '/whoami':  'Show logged-in user',
  '/status':  'Session status & system info',
  '/stats':   'Progress bars & metrics',
  '/clear':   'Clear conversation',
  '/git':     'Git status',
  '/diff':    'Git diff',
  '/cost':    'Show session cost',
  '/history': 'Show conversation',
  '/compact': 'Compact conversation context',
  '/exit':    'Exit CLI',
};

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
  const creds = auth.loadCredentials();
  const env = process.env.TARANG_ENV || 'production';
  const backendUrl = resolveBackendUrl();

  process.stderr.write('\n');
  for (const line of BANNER) {
    process.stderr.write(`  ${c.cyan(c.bold(line))}\n`);
  }
  process.stderr.write(`  ${c.gray('Orchestration of Composable Agents')}\n\n`);

  process.stderr.write(`  ${c.gray('Provider:')}  ${c.green('Tarang')}  ${c.gray('│')}  ${c.gray('Env: ' + env)}  ${c.gray('│')}  ${c.gray('v' + VERSION)}\n`);
  process.stderr.write(`  ${c.gray('Endpoint:')}  ${c.gray(backendUrl)}\n`);
  process.stderr.write(`  ${c.gray('Auth:')}      ${creds.token ? c.green('✓ logged in') : c.red('✗ run /login')}\n\n`);
  process.stderr.write(`  ${c.gray('Type your instructions, or /help for commands')}\n`);
  process.stderr.write(`  ${c.gray('Ctrl+C exit  Tab autocomplete  ↑↓ history')}\n\n`);
}

// ── Status Bar Update ──

function updateStatusBar() {
  const cost = formatCost(session.inputTokens, session.outputTokens);
  const elapsed = formatElapsed(session.startTime);
  const totalTokens = session.inputTokens + session.outputTokens;
  const ctxPct = Math.min(100, Math.round((totalTokens / 200000) * 100));
  const ctxColor = ctxPct < 50 ? 'green' : ctxPct < 80 ? 'yellow' : 'red';

  statusBar([
    c.cyan(c.bold('orca')),
    c.green(session.user?.github_username || '—'),
    c.gray(session.model || 'backend'),
    c[ctxColor](`ctx:${ctxPct}%`),
    c.gray(`${(totalTokens / 1000).toFixed(1)}k tok`),
    c.gray(cost),
    c.yellow(elapsed),
  ]);
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
        inPlace(`  ${spinner(text.slice(0, 80))}`);
      }
      break;
    }

    case 'content':
    case 'content_partial': {
      const text = data?.text || '';
      if (text) {
        inPlace('');
        const rendered = renderMarkdown(text);
        for (const line of rendered.split('\n')) {
          process.stdout.write(`  ${line}\n`);
        }
      }
      break;
    }

    case 'tool_call':
    case 'tool_request': {
      session.toolCalls++;
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
      if (phase) {
        inPlace('');
        process.stderr.write(`\n  ${spinner(c.bold(phase))}\n`);
      }
      break;
    }

    case 'worker_update': {
      const worker = data?.worker || '';
      const status = data?.status || '';
      if (worker) inPlace(`  ${spinner(`${worker}: ${status}`)}`);
      break;
    }

    case 'delegation':
      process.stderr.write(`  ${c.cyan(`${data?.from || ''} → ${data?.to || ''}`)}${data?.instruction ? ': ' + data.instruction : ''}\n`);
      break;

    case 'error':
      inPlace('');
      process.stderr.write(`\n  ${c.red('✗ ' + (data?.message || 'Unknown error'))}\n`);
      if ((data?.message || '').includes('Authentication')) {
        process.stderr.write(`  ${c.gray('Run /login to re-authenticate')}\n`);
      }
      break;

    case 'complete': {
      inPlace('');
      const duration = data?.duration_s ? `${Number(data.duration_s).toFixed(1)}s` : '';
      const tools = data?.tool_calls || session.toolCalls || 0;
      const parts = [];
      if (duration) parts.push(duration);
      if (tools > 0) parts.push(`${tools} tool calls`);
      const stats = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      process.stderr.write(`\n  ${c.green('✓ Done' + stats)}\n`);

      // Update session token counts
      const usage = data?.usage;
      if (usage) {
        const inp = usage.total_input_tokens || usage.input_tokens || 0;
        const out = usage.total_output_tokens || usage.output_tokens || 0;
        session.inputTokens += inp;
        session.outputTokens += out;
        process.stderr.write(`  ${c.gray(`Tokens: ${inp.toLocaleString()} in / ${out.toLocaleString()} out`)}\n`);
      }
      break;
    }

    case 'cancelled':
      inPlace('');
      process.stderr.write(`\n  ${c.yellow('Cancelled' + (data?.reason ? ': ' + data.reason : ''))}\n`);
      break;

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
      process.stderr.write(`\n  ${c.bold('Orca Commands')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      for (const [name, desc] of Object.entries(COMMANDS)) {
        process.stderr.write(`  ${c.cyan(name.padEnd(12))} ${desc}\n`);
      }
      process.stderr.write(`\n  ${c.bold('Keyboard')}\n`);
      process.stderr.write(`  ${c.gray('Ctrl+C')}  exit   ${c.gray('↑↓')}  history   ${c.gray('Tab')}  autocomplete\n\n`);
      return;

    case '/login':
      process.stderr.write(`${c.cyan('Starting login flow...')}\n`);
      try {
        await ctx.auth.login();
        process.stderr.write(`${c.green('✓ Login successful!')}\n`);
        // Fetch user profile after login
        await fetchUser(ctx);
      } catch (err) {
        process.stderr.write(`${c.red('✗ Login failed: ' + err.message)}\n`);
      }
      return;

    case '/whoami': {
      if (!session.user) await fetchUser(ctx);
      if (session.user) {
        process.stderr.write(`\n  ${c.green('✓')} ${session.user.github_username}\n`);
        process.stderr.write(`  ${c.gray('Email:')}   ${session.user.email || 'n/a'}\n`);
        process.stderr.write(`  ${c.gray('User ID:')} ${session.user.id}\n`);
        process.stderr.write(`  ${c.gray('Role:')}    ${session.user.role || 'user'}\n\n`);
      } else {
        process.stderr.write(`  ${c.red('Not logged in. Run /login.')}\n`);
      }
      return;
    }

    case '/status': {
      const creds = ctx.auth.loadCredentials();
      const env = process.env.TARANG_ENV || 'production';
      const os = await import('node:os');
      const mem = process.memoryUsage();

      process.stderr.write(`\n  ${c.bold('Session')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${c.gray('User:')}      ${session.user?.github_username || '—'}\n`);
      process.stderr.write(`  ${c.gray('Model:')}     ${session.model || 'backend default'}\n`);
      process.stderr.write(`  ${c.gray('Backend:')}   ${creds.backendUrl}\n`);
      process.stderr.write(`  ${c.gray('Env:')}       ${env}\n`);
      process.stderr.write(`  ${c.gray('Turns:')}     ${session.turns}\n`);
      process.stderr.write(`  ${c.gray('Duration:')}  ${formatElapsed(session.startTime)}\n`);
      process.stderr.write(`  ${c.gray('Cost:')}      ${formatCost(session.inputTokens, session.outputTokens)}\n`);
      process.stderr.write(`  ${c.gray('CWD:')}       ${process.cwd()}\n\n`);

      process.stderr.write(`  ${c.bold('System')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${c.gray('Node:')}      ${process.version}\n`);
      process.stderr.write(`  ${c.gray('Platform:')}  ${process.platform} ${os.arch()}\n`);
      process.stderr.write(`  ${c.gray('Heap:')}      ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB\n`);
      process.stderr.write(`  ${c.gray('Memory:')}    ${((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1)}G / ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}G\n\n`);
      return;
    }

    case '/stats': {
      const os = await import('node:os');
      const mem = process.memoryUsage();
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      const totalTokens = session.inputTokens + session.outputTokens;
      const ctxPct = Math.min(100, (totalTokens / 200000) * 100);

      process.stderr.write(`\n  ${c.bold('Metrics')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${progressBar(ctxPct, 15, 'Context')} ${(totalTokens / 1000).toFixed(1)}k tok\n`);
      process.stderr.write(`  ${progressBar(Math.round((usedMem / totalMem) * 100), 15, 'Memory')} ${(usedMem / 1024 / 1024 / 1024).toFixed(1)}G\n`);
      process.stderr.write(`  ${progressBar(Math.round((mem.heapUsed / mem.heapTotal) * 100), 15, 'Heap')} ${(mem.heapUsed / 1024 / 1024).toFixed(0)}M\n`);
      process.stderr.write(`  ${c.gray('Turns:')}    ${session.turns}\n`);
      process.stderr.write(`  ${c.gray('Tools:')}    ${session.toolCalls}\n`);
      process.stderr.write(`  ${c.gray('Cost:')}     ${formatCost(session.inputTokens, session.outputTokens)}\n`);
      process.stderr.write(`  ${c.gray('Elapsed:')} ${formatElapsed(session.startTime)}\n\n`);
      return;
    }

    case '/cost':
      process.stderr.write(`  ${c.gray('Input:')}  ${session.inputTokens.toLocaleString()} tokens\n`);
      process.stderr.write(`  ${c.gray('Output:')} ${session.outputTokens.toLocaleString()} tokens\n`);
      process.stderr.write(`  ${c.gray('Cost:')}   ${formatCost(session.inputTokens, session.outputTokens)}\n`);
      return;

    case '/history':
      if (session.history.length === 0) { process.stderr.write(`  ${c.gray('No conversation yet.')}\n`); return; }
      process.stderr.write(`\n  ${c.bold('Conversation')} (${session.history.length} messages)\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      for (const msg of session.history.slice(-20)) {
        const role = msg.role === 'user' ? c.cyan('You') : c.green('Orca');
        process.stderr.write(`  ${role}: ${msg.content.slice(0, 80)}${msg.content.length > 80 ? '...' : ''}\n`);
      }
      process.stderr.write('\n');
      return;

    case '/compact': {
      const before = session.history.length;
      if (before <= 4) { process.stderr.write(`  ${c.gray('Nothing to compact.')}\n`); return; }
      session.history.splice(2, session.history.length - 6);
      process.stderr.write(`  ${c.gray(`Compacted: ${before} → ${session.history.length} messages`)}\n`);
      return;
    }

    case '/clear':
      session.history.length = 0;
      session.toolCalls = 0;
      process.stderr.write(`  ${c.gray('Conversation cleared.')}\n`);
      return;

    case '/git': {
      const { execSync } = await import('node:child_process');
      try { process.stdout.write(execSync('git status --short --branch', { encoding: 'utf-8' }) + '\n'); }
      catch (e) { process.stderr.write(`  ${c.red(e.message)}\n`); }
      return;
    }

    case '/diff': {
      const { execSync } = await import('node:child_process');
      try { process.stdout.write(execSync('git diff --stat', { encoding: 'utf-8' }) || '(no changes)\n'); }
      catch (e) { process.stderr.write(`  ${c.red(e.message)}\n`); }
      return;
    }

    case '/exit':
    case '/quit':
      process.stderr.write(`\n  ${c.cyan('Goodbye!')}\n\n`);
      process.exit(0);

    default:
      process.stderr.write(`  ${c.gray(`Unknown: ${cmd}. Type /help.`)}\n`);
  }
}

// ── Fetch User Profile ──

async function fetchUser(ctx) {
  const creds = ctx.auth.loadCredentials();
  if (!creds.token) return;
  try {
    const resp = await fetch(`${creds.backendUrl}/api/user/me`, {
      headers: { 'Authorization': `Bearer ${creds.token}` },
    });
    if (resp.ok) {
      session.user = await resp.json();
      session.model = session.user.default_reasoning_model || session.user.default_orchestrator_model || null;
    }
  } catch {}
}

// ── Main REPL ──

export async function startTerminalRepl() {
  const auth = new TarangAuth();
  const toolExecutor = createToolExecutor();
  const approval = new ApprovalManager({ autoApprove: false });
  const ctx = { auth };

  printBanner(auth);

  // Fetch user profile in background
  fetchUser(ctx);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${c.cyan('orca>')} `,
    completer: (line) => {
      if (line.startsWith('/')) {
        const hits = Object.keys(COMMANDS).filter(cmd => cmd.startsWith(line));
        return [hits.length ? hits : Object.keys(COMMANDS), line];
      }
      return [[], line];
    },
    historySize: 100,
  });

  rl.prompt();

  // Update status bar periodically
  const statusInterval = setInterval(() => updateStatusBar(), 5000);

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Save to input history
    session.inputHistory.push(input);

    // Slash commands
    if (input.startsWith('/')) {
      await handleCommand(input, ctx);
      updateStatusBar();
      rl.prompt();
      return;
    }

    // Regular prompt
    session.history.push({ role: 'user', content: input });
    session.turns++;
    session.toolCalls = 0;

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
      for await (const event of client.execute(input, { cwd: process.cwd() }, session.history)) {
        renderEvent(event);

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
      session.history.push({ role: 'assistant', content: assistantContent });
    }

    updateStatusBar();
    process.stdout.write('\n');
    rl.prompt();
  });

  rl.on('close', () => {
    clearInterval(statusInterval);
    process.stderr.write(`\n  ${c.cyan('Goodbye!')}\n\n`);
    process.exit(0);
  });
}
