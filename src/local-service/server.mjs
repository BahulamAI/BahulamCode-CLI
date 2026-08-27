/**
 * Bahulam local service.
 *
 * Localhost-only HTTP surface for browser workspaces. This module intentionally
 * does not depend on Pulse or the terminal REPL daemon.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import { LocalAgentRelay } from './agent-relay.mjs';
import { listWorkspacePath, readWorkspaceFile } from './file-access.mjs';
import {
  assertLoopbackRequest,
  getLocalMachineIdentity,
  loopbackHostForUrl,
  normalizeLoopbackHost,
} from './machine.mjs';
import {
  loadLocalWorkspaceSession,
  publicSession,
  touchLocalWorkspaceSession,
  verifyLocalAccessToken,
} from './session-store.mjs';

export async function startLocalWorkspaceService({
  session,
  token,
  port = 0,
  host = '127.0.0.1',
} = {}) {
  if (!session?.id) throw new Error('session is required');
  if (!token) throw new Error('token is required');

  const loopbackHost = normalizeLoopbackHost(host);
  const machine = getLocalMachineIdentity();
  const fullSession = loadLocalWorkspaceSession(session.id);
  if (!fullSession) throw new Error(`Local workspace session not found: ${session.id}`);
  if (fullSession.machine_id && fullSession.machine_id !== machine.id) {
    const err = new Error('Local workspace session belongs to a different machine');
    err.code = 'LOCAL_ONLY';
    throw err;
  }

  const events = [];
  const sseClients = new Set();
  let agentRelay = null;

  function emit(type, data = {}) {
    const event = {
      id: `evt_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      ts: new Date().toISOString(),
      type,
      session_id: session.id,
      data,
    };
    events.push(event);
    if (events.length > 500) events.shift();
    const frame = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
    return event;
  }

  const server = http.createServer(async (req, res) => {
    try {
      assertLoopbackRequest(req);
      await routeRequest({
        req,
        res,
        sessionId: session.id,
        token,
        events,
        sseClients,
        emit,
        getAgentRelay(localSession) {
          if (!agentRelay) agentRelay = new LocalAgentRelay({ session: localSession, emit });
          return agentRelay;
        },
      });
    } catch (err) {
      sendJson(res, errorStatus(err), {
        ok: false,
        error: err.code || 'local_service_error',
        message: err.message,
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(Number(port) || 0, loopbackHost, () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${loopbackHostForUrl(loopbackHost)}:${actualPort}/workspace/${encodeURIComponent(session.id)}?token=${encodeURIComponent(token)}`;
  touchLocalWorkspaceSession(session.id, {
    status: 'active',
    local_url: url,
    port: actualPort,
    host: loopbackHost,
    pid: process.pid,
  });
  emit('session_started', { url, root_path: session.root_path, focus_path: session.focus_path });

  return {
    url,
    port: actualPort,
    host: loopbackHost,
    close: () => new Promise((resolve) => {
      emit('session_stopped', {});
      for (const client of sseClients) {
        try {
          client.end();
        } catch {}
      }
      sseClients.clear();
      server.close(() => resolve());
    }),
    emit,
  };
}

async function routeRequest({ req, res, sessionId, token, events, sseClients, emit, getAgentRelay }) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      product: 'bahulam-local-service',
      session_id: sessionId,
    });
    return;
  }

  const session = requireAuthorizedSession(sessionId, token, req, url);

  if (req.method === 'GET' && (url.pathname === `/workspace/${sessionId}` || url.pathname === '/')) {
    sendHtml(res, workspaceHtml({ session, token }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    sendJson(res, 200, { ok: true, session });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/files') {
    const requestedPath = url.searchParams.get('path') || session.focus_path || '.';
    const listing = listWorkspacePath(session, requestedPath);
    emit('file_browsed', { path: listing.path, type: listing.type });
    sendJson(res, 200, listing);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/file/raw') {
    const requestedPath = url.searchParams.get('path') || session.focus_path;
    if (!requestedPath) {
      const err = new Error('path is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    const bytes = readWorkspaceFile(session, requestedPath);
    emit('file_read', { path: requestedPath, bytes: bytes.length });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(bytes);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    sseClients.add(res);
    for (const event of events.slice(-100)) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/turn') {
    const body = await readJsonBody(req);
    const prompt = String(body.prompt || '').slice(0, 200);
    emit('agent_turn_requested', { prompt });
    try {
      const relay = getAgentRelay(session);
      const result = await relay.runTurn({
        prompt: body.prompt,
        path: body.path || session.focus_path || '.',
      });
      sendJson(res, 200, result);
    } catch (err) {
      emit('agent_error', {
        code: err.code || 'agent_turn_failed',
        message: err.message || String(err),
        fatal: true,
      });
      throw err;
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/execute') {
    const body = await readJsonBody(req);
    emit('tool_execution_requested', { name: body.name || null });
    sendJson(res, 501, {
      ok: false,
      error: 'local_tool_bridge_not_wired',
      message: 'Tool execution will be routed through the local service permission layer in the next slice.',
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
}

function requireAuthorizedSession(sessionId, token, req, url) {
  const session = loadLocalWorkspaceSession(sessionId);
  if (!session) {
    const err = new Error(`Unknown local workspace session: ${sessionId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  const supplied = url.searchParams.get('token') || req.headers['x-bahulam-local-token'];
  if (!verifyLocalAccessToken(session, supplied)) {
    const err = new Error('Invalid or missing local workspace token');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  return publicSession(session);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body is too large');
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    const err = new Error('Request body must be valid JSON');
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

function errorStatus(err) {
  switch (err.code) {
    case 'UNAUTHORIZED': return 401;
    case 'NOT_FOUND': return 404;
    case 'OUTSIDE_WORKSPACE': return 403;
    case 'LOCAL_ONLY': return 403;
    case 'NOT_FILE': return 400;
    case 'BAD_REQUEST': return 400;
    case 'CONFLICT': return 409;
    case 'auth_required': return 401;
    case 'PAYLOAD_TOO_LARGE': return 413;
    case 'FILE_TOO_LARGE': return 413;
    default: return 500;
  }
}

function workspaceHtml({ session, token }) {
  const boot = JSON.stringify({
    session,
    token,
    initialPath: session.focus_path || '.',
  }).replace(/</g, '\\u003c');
  const title = escapeHtml(session.title || 'Local Workspace');
  const rootName = escapeHtml(path.basename(session.root_path) || session.root_path);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Bahulam Local</title>
<style>
:root{color-scheme:light;--ws-foreground:#1B1B1B;--ws-muted:rgba(27,27,27,.52);--ws-faint:rgba(27,27,27,.3);--ws-border:rgba(27,27,27,.10);--ws-border-subtle:rgba(27,27,27,.06);--ws-bg:#FFFDF7;--ws-surface:#F7F5EF;--ws-panel:#fff;--ws-tab:#FAF9F5;--ws-primary:#0891B2;--ws-primary-soft:#ECFEFF;--ws-hover:rgba(27,27,27,.04);--ws-active:rgba(27,27,27,.08);--ws-success:#047857;--ws-success-bg:#ECFDF5;--ws-error:#B91C1C;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--ws-bg);color:var(--ws-foreground);font:13px/1.45 var(--sans);overflow:hidden}
button,textarea{font:inherit}button{color:inherit}.shell{display:flex;flex-direction:column;height:100vh;min-height:560px;background:var(--ws-bg)}
.global-bar{height:40px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--ws-border-subtle);background:rgba(255,255,255,.88);padding:0 14px;flex:0 0 auto}
.brand{font:700 12px/1 var(--mono);letter-spacing:-.01em;color:#57534E}.back{width:24px;height:24px;border:0;background:transparent;border-radius:6px;color:var(--ws-faint);cursor:pointer}.back:hover{background:var(--ws-hover);color:rgba(27,27,27,.65)}
.global-title{font:700 12px/1 var(--mono);color:rgba(27,27,27,.78)}.global-spacer{flex:1}.machine{display:flex;align-items:center;gap:6px;color:var(--ws-muted);font-size:11px}.dot{width:6px;height:6px;border-radius:999px;background:var(--ws-success)}
.topbar{height:42px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--ws-border-subtle);background:rgba(255,255,255,.80);backdrop-filter:blur(10px);padding:0 16px;flex:0 0 auto}
.terminal-icon{width:16px;height:16px;color:var(--ws-faint);flex:0 0 auto}.workspace-name{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace-kind{font-size:12px;color:var(--ws-faint)}.top-actions{margin-left:auto;display:flex;align-items:center;gap:6px;min-width:0}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;border:1px solid var(--ws-border);background:#fff;padding:2px 8px;font-size:10px;font-weight:600;color:rgba(27,27,27,.58);white-space:nowrap}.badge.local{border-color:#BBF7D0;background:var(--ws-success-bg);color:var(--ws-success)}.badge.local:before{content:"";width:6px;height:6px;border-radius:999px;background:#10B981}
.icon-button{height:24px;min-width:24px;border:1px solid var(--ws-border);border-radius:6px;background:#fff;color:rgba(27,27,27,.64);display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 8px;cursor:pointer;font-size:11px;font-weight:600}.icon-button:hover{background:var(--ws-surface);color:var(--ws-foreground)}
.menubar{height:28px;display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--ws-border-subtle);background:var(--ws-surface);padding:0 10px;flex:0 0 auto;user-select:none}.menu-item{height:22px;border:0;background:transparent;border-radius:5px;padding:0 8px;color:rgba(27,27,27,.58);font-size:12px;cursor:pointer}.menu-item:hover{background:var(--ws-hover);color:rgba(27,27,27,.86)}
main{display:grid;grid-template-columns:256px minmax(360px,1fr) minmax(340px,420px);flex:1;min-height:0}.panel{min-width:0;background:var(--ws-panel);overflow:hidden}.files{border-right:1px solid var(--ws-border-subtle);background:rgba(255,255,255,.52)}.work{display:flex;flex-direction:column;background:#fff}.agent{border-left:1px solid var(--ws-border-subtle);background:rgba(255,255,255,.58);display:flex;flex-direction:column}
.section-head{height:36px;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:var(--ws-faint);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;background:rgba(255,255,255,.45)}
.file-list{padding:6px}.row{display:flex;align-items:center;gap:6px;width:100%;height:26px;border:0;background:transparent;text-align:left;border-radius:6px;padding:0 8px;color:rgba(27,27,27,.62);cursor:pointer;font-size:12px;line-height:1}.row:hover{background:var(--ws-hover);color:rgba(27,27,27,.84)}.row:focus-visible{outline:2px solid rgba(8,145,178,.35);outline-offset:1px}.icon{width:18px;display:inline-flex;align-items:center;justify-content:center;color:var(--ws-faint);font-size:11px;font-family:var(--mono)}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sub{color:rgba(27,27,27,.28);font:10px var(--mono);margin-left:auto}
.tabbar{height:36px;display:flex;align-items:center;border-bottom:1px solid var(--ws-border-subtle);background:var(--ws-tab);flex:0 0 auto}.tab{height:100%;display:flex;align-items:center;gap:7px;border-right:1px solid var(--ws-border-subtle);padding:0 12px;background:#fff;color:var(--ws-foreground);font-size:11px;box-shadow:inset 0 -1.5px 0 var(--ws-foreground);max-width:260px}.tab-muted{flex:1;height:100%;border-left:1px solid var(--ws-border-subtle)}
.viewer{flex:1;min-height:0;overflow:auto;padding:16px;background:#fff}.path{font:12px var(--mono);color:var(--ws-faint);margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty{color:var(--ws-faint);padding:16px;font-size:12px}.error{color:var(--ws-error)}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.55 var(--mono);background:#0D1117;color:#E5E7EB;border:1px solid rgba(248,250,252,.08);border-radius:6px;padding:14px;overflow:auto;max-height:calc(100vh - 170px)}
.agent-body{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;padding:12px}.answer{display:none;max-height:28vh;overflow:auto;border:1px solid var(--ws-border-subtle);border-radius:8px;background:#fff;padding:10px;color:rgba(27,27,27,.82);font-size:12px;white-space:pre-wrap}.answer:not(:empty){display:block}.events{flex:1;min-height:0;overflow:auto;border:1px solid var(--ws-border-subtle);border-radius:8px;background:#fff;padding:6px}.event{font:11px/1.45 var(--mono);border-bottom:1px solid rgba(27,27,27,.05);padding:6px 4px;color:rgba(27,27,27,.56)}.event:last-child{border-bottom:0}.event b{color:var(--ws-primary);font-weight:700}
.composer{border:1px solid var(--ws-border);border-radius:8px;background:#fff;overflow:hidden}textarea{display:block;width:100%;min-height:92px;resize:vertical;border:0;padding:10px;background:#fff;color:var(--ws-foreground);outline:none}.composer-actions{height:34px;border-top:1px solid var(--ws-border-subtle);display:flex;align-items:center;justify-content:space-between;padding:0 8px}.status{font-size:11px;color:var(--ws-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px}button.primary{height:24px;border:0;border-radius:6px;background:var(--ws-foreground);color:#fff;font-size:11px;font-weight:700;padding:0 10px;cursor:pointer}button.primary:hover{background:#2B2B2B}
@media(max-width:960px){body{overflow:auto}.shell{height:auto;min-height:100vh}main{display:flex;flex-direction:column}.panel{min-height:300px}.files,.agent{border:0;border-bottom:1px solid var(--ws-border-subtle)}.top-actions .badge:not(.local){display:none}}
</style>
</head>
<body>
<div class="shell">
  <header class="global-bar">
    <button class="back" type="button" title="Back" aria-label="Back">‹</button>
    <div class="brand">Bahulam Code</div>
    <div class="global-title">Local IDE</div>
    <div class="global-spacer"></div>
    <div class="machine"><span class="dot"></span><span>same machine</span></div>
  </header>
  <div class="topbar">
    <svg class="terminal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
    <div class="workspace-name">${rootName}</div>
    <div class="workspace-kind">${escapeHtml(session.kind)}</div>
    <div class="top-actions">
      <span class="badge local">local</span>
      <span class="badge">${escapeHtml(session.id)}</span>
      <button class="icon-button" type="button" title="Explorer">☰</button>
      <button class="icon-button" type="button" title="Agent">▣</button>
    </div>
  </div>
  <div class="menubar">
    <button class="menu-item" type="button">File</button>
    <button class="menu-item" type="button">Edit</button>
    <button class="menu-item" type="button">Run</button>
    <button class="menu-item" type="button">Tools</button>
  </div>
  <main>
    <section class="panel files">
      <div class="section-head"><span>Files</span><span id="fileCount"></span></div>
      <div class="file-list" id="fileList"></div>
    </section>
    <section class="panel work">
      <div class="tabbar"><div class="tab"><span id="tabIcon">◇</span><span id="tabName">Workspace</span></div><div class="tab-muted"></div></div>
      <div class="viewer" id="viewer"><div class="empty">Loading...</div></div>
    </section>
    <section class="panel agent">
      <div class="section-head"><span>Agent</span><span id="bridgeState">bridge pending</span></div>
      <div class="agent-body">
        <div class="answer" id="answer"></div>
        <div class="events" id="events"></div>
        <div class="composer">
          <textarea id="prompt" placeholder="Ask about this local workspace"></textarea>
          <div class="composer-actions">
            <div class="status" id="sendStatus"></div>
            <button class="primary" id="send">Send</button>
          </div>
        </div>
      </div>
    </section>
  </main>
</div>
<script>
const BOOT = ${boot};
const token = BOOT.token;
let currentPath = BOOT.initialPath || '.';
const headers = { 'X-Bahulam-Local-Token': token };

function esc(value){return String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
async function api(path, opts={}){
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { ok:false, message:text }; }
  if (!res.ok) {
    const err = new Error(body.message || body.error || 'request failed');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
async function loadPath(path){
  currentPath = path || '.';
  try {
    const data = await api('/api/files?path=' + encodeURIComponent(currentPath));
    if (data.type === 'directory') renderDirectory(data);
    else renderFile(data);
  } catch (err) {
    document.getElementById('viewer').innerHTML = '<div class="empty error">' + esc(err.message) + '</div>';
  }
}
function renderDirectory(data){
  document.getElementById('fileCount').textContent = String(data.entries.length);
  document.getElementById('tabIcon').textContent = '▦';
  document.getElementById('tabName').textContent = data.path === '.' ? BOOT.session.title : data.path;
  const list = document.getElementById('fileList');
  const parent = data.path && data.path !== '.' ? '<button class="row" data-path="' + esc(parentPath(data.path)) + '"><span class="icon">‹</span><span class="name">Parent</span></button>' : '';
  list.innerHTML = parent + data.entries.map(entry => '<button class="row" data-path="' + esc(entry.path) + '"><span class="icon">' + (entry.type === 'directory' ? '▸' : '◇') + '</span><span class="name">' + esc(entry.name) + '</span><span class="sub">' + (entry.type === 'file' && entry.size != null ? formatBytes(entry.size) : '') + '</span></button>').join('');
  list.querySelectorAll('button[data-path]').forEach(btn => btn.addEventListener('click', () => loadPath(btn.dataset.path)));
  document.getElementById('viewer').innerHTML = '<div class="path">' + esc(data.path) + '</div><div class="empty">Select a file or ask the agent to work in this folder.</div>';
}
function renderFile(data){
  document.getElementById('fileCount').textContent = '';
  document.getElementById('tabIcon').textContent = '◇';
  document.getElementById('tabName').textContent = basename(data.path);
  const preview = data.preview && data.preview.content != null
    ? '<pre>' + esc(data.preview.content) + '</pre>'
    : '<div class="empty">Binary or large file. Agent-side processing will use local tools.</div>';
  document.getElementById('viewer').innerHTML = '<div class="path">' + esc(data.path) + '</div>' + preview;
}
function basename(p){
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Workspace';
}
function formatBytes(size){
  const n = Number(size) || 0;
  if (n < 1024) return String(n);
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'K';
  return (n / 1024 / 1024).toFixed(1) + 'M';
}
function parentPath(p){
  const parts = String(p || '.').split('/').filter(Boolean);
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}
function addEvent(type, detail){
  const el = document.createElement('div');
  el.className = 'event';
  el.innerHTML = '<b>' + esc(type) + '</b> ' + esc(detail || '');
  const events = document.getElementById('events');
  events.appendChild(el);
  events.scrollTop = events.scrollHeight;
}
function handleRelayEvent(type, event){
  const data = event.data || {};
  if (type === 'agent_content') {
    document.getElementById('answer').textContent += data.text || '';
    return;
  }
  if (type === 'agent_turn_started') {
    document.getElementById('answer').textContent = '';
    document.getElementById('bridgeState').textContent = 'running';
    addEvent(type, data.prompt || '');
    return;
  }
  if (type === 'agent_turn_complete') {
    document.getElementById('bridgeState').textContent = 'ready';
    document.getElementById('sendStatus').textContent = 'Done';
    addEvent(type, (data.event_count || 0) + ' events');
    return;
  }
  if (type === 'agent_error') {
    document.getElementById('bridgeState').textContent = 'error';
    document.getElementById('sendStatus').textContent = data.message || data.error || 'Agent error';
    addEvent(type, data.message || data.error || JSON.stringify(data));
    return;
  }
  if (type === 'agent_tool_call') {
    addEvent(type, (data.tool || 'tool') + ' ' + (data.call_id || ''));
    return;
  }
  if (type === 'agent_tool_result') {
    addEvent(type, (data.success === false ? 'failed ' : 'completed ') + (data.tool || 'tool'));
    return;
  }
  if (type === 'agent_status') {
    addEvent(type, data.message || data.type || '');
    return;
  }
  addEvent(type, JSON.stringify(data));
}
const es = new EventSource('/api/events?token=' + encodeURIComponent(token));
es.onmessage = evt => { try { const e = JSON.parse(evt.data); addEvent(e.type, JSON.stringify(e.data || {})); } catch {} };
[
  'session_started','file_browsed','file_read','tool_execution_requested','session_stopped',
  'agent_turn_requested','agent_relay_ready','agent_turn_started','agent_turn_complete',
  'agent_session','agent_status','agent_reasoning','agent_content','agent_tool_call',
  'agent_tool_result','agent_activity','agent_complete','agent_error','agent_event'
].forEach(type => {
  es.addEventListener(type, evt => { try { handleRelayEvent(type, JSON.parse(evt.data)); } catch {} });
});
document.getElementById('send').addEventListener('click', async () => {
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;
  document.getElementById('sendStatus').textContent = 'Sending...';
  try {
    await api('/api/agent/turn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt, path: currentPath }) });
  } catch (err) {
    document.getElementById('sendStatus').textContent = err.message;
    document.getElementById('bridgeState').textContent = err.status === 401 ? 'auth required' : 'error';
    addEvent('request_error', (err.status ? err.status + ' ' : '') + err.message);
  }
});
loadPath(currentPath);
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
