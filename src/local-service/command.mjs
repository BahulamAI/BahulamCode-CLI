/**
 * CLI command group for Bahulam local workspaces.
 */

import {
  createLocalWorkspaceSession,
  listLocalWorkspaceSessions,
} from './session-store.mjs';
import { startLocalWorkspaceService } from './server.mjs';
import { openLocalBrowser } from './browser.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

export async function runLocalWorkspaceCommand(argv = [], { cwd = process.cwd() } = {}) {
  const args = parseLocalWorkspaceArgs(argv);

  if (args.help || args.command === 'help') {
    printLocalWorkspaceHelp();
    return;
  }

  if (args.command === 'list' || args.command === 'status') {
    printLocalWorkspaceSessions();
    return;
  }

  if (!['open', 'start', 'serve'].includes(args.command)) {
    process.stderr.write(`${YELLOW}! Unknown workspace command: ${args.command || '(empty)'}${RESET}\n\n`);
    printLocalWorkspaceHelp();
    process.exitCode = 2;
    return;
  }

  const { session, token } = createLocalWorkspaceSession({
    targetPath: args.targetPath || cwd,
    cwd,
    kind: args.kind,
  });

  const service = await startLocalWorkspaceService({
    session,
    token,
    port: args.port,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, session, url: service.url, port: service.port }, null, 2)}\n`);
  } else {
    process.stderr.write(`\n${BOLD}${CYAN}Bahulam Local Workspace${RESET}\n`);
    process.stderr.write(`  ${DIM}session${RESET}  ${session.id}\n`);
    process.stderr.write(`  ${DIM}kind${RESET}     ${session.kind}\n`);
    process.stderr.write(`  ${DIM}root${RESET}     ${session.root_path}\n`);
    if (session.focus_path) process.stderr.write(`  ${DIM}focus${RESET}    ${session.focus_path}\n`);
    process.stderr.write(`  ${DIM}url${RESET}      ${CYAN}${service.url}${RESET}\n\n`);
  }

  if (args.open) {
    openLocalBrowser(service.url);
  }

  process.stderr.write(`${GREEN}ready${RESET} ${DIM}local service is bound to 127.0.0.1:${service.port}. Press Ctrl+C to stop.${RESET}\n`);

  await waitForShutdown(service);
}

export function parseLocalWorkspaceArgs(argv = []) {
  const out = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'open',
    targetPath: null,
    port: 0,
    kind: null,
    open: true,
    json: false,
    help: false,
  };

  const startIndex = out.command === argv[0] ? 1 : 0;
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--port':
        out.port = Number(argv[++i]) || 0;
        break;
      case '--kind':
        out.kind = argv[++i] || null;
        break;
      case '--no-open':
        out.open = false;
        break;
      case '--json':
        out.json = true;
        out.open = false;
        break;
      default:
        if (!arg.startsWith('-') && !out.targetPath) out.targetPath = arg;
        break;
    }
  }

  return out;
}

function printLocalWorkspaceHelp() {
  process.stderr.write(`
  ${BOLD}${CYAN}Bahulam Local Workspace${RESET}

  ${BOLD}Usage:${RESET}
    bahulam workspace open [path]       Open a local coding/document workspace
    bahulam workspace start [path]      Alias for open
    bahulam workspace list              List recent local workspace sessions
    bahulam local open [path]           Same command group, shorter alias

  ${BOLD}Options:${RESET}
    --port <n>      Bind a specific localhost port
    --kind <name>   Override inferred kind: coding, documents, workspace
    --no-open       Start service without opening the browser
    --json          Print session JSON and do not open the browser

  ${DIM}The service binds to 127.0.0.1 and grants only the selected file or folder root.${RESET}
`);
}

function printLocalWorkspaceSessions() {
  const sessions = listLocalWorkspaceSessions({ limit: 20 });
  if (!sessions.length) {
    process.stderr.write(`${DIM}No local workspace sessions.${RESET}\n`);
    return;
  }
  for (const s of sessions) {
    process.stderr.write(`${CYAN}${s.id}${RESET}  ${s.kind}  ${s.status}  ${DIM}${s.root_path}${s.focus_path ? `/${s.focus_path}` : ''}${RESET}\n`);
  }
}

function waitForShutdown(service) {
  return new Promise((resolve) => {
    let done = false;
    const stop = async () => {
      if (done) return;
      done = true;
      await service.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
