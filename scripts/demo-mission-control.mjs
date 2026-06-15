#!/usr/bin/env node
/**
 * Mission Control demo — drives the orbit state machine through a fake
 * session so you can see the status bar live in your real terminal.
 *
 *   node scripts/demo-mission-control.mjs
 *
 * The script writes "agent output" lines in the scroll region while the
 * bottom two lines update with orbit, task, sub-agents, turn, and cost.
 * Press Ctrl+C to abort; the scroll region is restored automatically.
 */

import { paint } from '../src/ui/palette.mjs';
import { attachOrbit, unmount } from '../src/ui/status-bar.mjs';
import { createOrbit } from '../src/state/orbit.mjs';
import { formatCard, recordCard, lastCard } from '../src/ui/tool-card.mjs';
import { detailFor } from '../src/ui/tool-details.mjs';

let _cid = 0;
function card({ tool, args, result, durationMs }) {
  const head = formatCard({ tool, args, result, durationMs });
  process.stderr.write(`${head}\n`);
  recordCard({ id: `demo-${++_cid}`, tool, args, head, result, durationMs });
}

function expandLastCard() {
  const c = lastCard();
  if (!c) return;
  process.stderr.write('\n' + detailFor(c) + '\n\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => process.stderr.write(`  ${line}\n`);

const o = createOrbit();
const detach = attachOrbit(o);

try {
  log(paint.text.dim('Mission Control demo — Ctrl+C to abort'));
  await sleep(800);

  o.onUserInput('Fix the JWT expiration bug in auth.py');
  log(paint.brand.primary('kepler') + ' reading the codebase…');
  await sleep(1200);

  o.onToolCall('search_code');
  card({
    tool: 'search_code', args: { query: 'JWT validation' },
    result: { output: 'src/auth.py:12:def validate_jwt(token):\nsrc/auth.py:45:    return jwt.decode(token)\nsrc/handlers.py:8:from .auth import validate_jwt\nsrc/handlers.py:33:    user = validate_jwt(req.token)\n' },
    durationMs: 120,
  });
  await sleep(900);

  log(paint.text.dim('— pressing d expands the last card:'));
  await sleep(400);
  expandLastCard();
  await sleep(900);

  o.onToolCall('explore');
  o.onSubAgentStart();
  card({
    tool: 'explore', args: { task: 'find all callers of validate_jwt' },
    result: { output: 'Identified 3 caller files; suggest centralizing refresh logic in middleware/auth.py' },
    durationMs: 2100,
  });
  await sleep(1200);
  o.onSubAgentEnd();
  await sleep(600);

  o.onToolCall('plan');
  card({
    tool: 'plan', args: { task: 'Add token refresh + middleware' },
    result: { output: '1. Add refresh endpoint\n2. Extract validate_jwt into middleware\n3. Wire callers to middleware\n4. Add tests' },
    durationMs: 1400,
  });
  await sleep(1100);

  o.onToolCall('edit_file');
  card({
    tool: 'edit_file', args: { file_path: 'src/auth.py' },
    result: { lines_added: 12, lines_removed: 4 },
    durationMs: 320,
  });
  await sleep(900);

  o.onToolCall('edit_file');
  card({
    tool: 'edit_file', args: { file_path: 'src/middleware/auth.py' },
    result: { lines_added: 28, lines_removed: 0 },
    durationMs: 280,
  });
  await sleep(900);

  o.onToolCall('run_tests');
  card({
    tool: 'run_tests', args: { command: 'pytest tests/test_auth.py' },
    result: { output: '24 passed in 1.2s' },
    durationMs: 1240,
  });
  await sleep(900);

  o.onApprovalRequired({ tool: 'shell', tier: 'shell-dangerous' });
  log(paint.brand.accent('approval needed: shell "rm -rf node_modules"'));
  await sleep(2500);

  o.onApprovalResolved();
  log(paint.state.success('approved'));
  await sleep(600);

  o.onComplete({ cost: 0.14 });
  log(paint.state.success('✅ mission accomplished · 5 tools · $0.14 · 9s'));
  await sleep(1500);
} finally {
  detach();
  unmount();
}
