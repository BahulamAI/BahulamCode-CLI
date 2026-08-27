/**
 * Bahulam local service.
 *
 * Localhost-only HTTP surface for browser workspaces. This module intentionally
 * does not depend on Pulse or the terminal REPL daemon.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { resolveWebUrl } from '../core/backend-url.mjs';
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
      const relay = agentRelay;
      for (const client of sseClients) {
        try {
          client.end();
        } catch {}
      }
      sseClients.clear();
      server.close(async () => {
        await relay?.close?.();
        resolve();
      });
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

  if (req.method === 'GET' && url.pathname === '/assets/bahulam-mark.png') {
    sendBrandMark(res);
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

  if (req.method === 'GET' && url.pathname === '/api/chat/history') {
    const relay = getAgentRelay(session);
    const history = await relay.loadHistory();
    sendJson(res, 200, history);
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
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; media-src 'self' blob:",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

function sendBrandMark(res) {
  const candidates = [
    '../../../appstak-platform/apps/bahulam/public/brand/bahulam-mark.png',
    '../../../appstak-platform/apps/appstak/public/brand/bahulam-mark.png',
  ].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(fs.readFileSync(file));
        return;
      }
    } catch {}
  }

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#1B1B1B"/><text x="20" y="25" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="18" font-weight="800" fill="#FFFDF7">B</text></svg>';
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(svg);
}

function localAuthInfo() {
  try {
    const credentials = new TarangAuth().loadCredentials();
    return {
      authenticated: Boolean(credentials.token),
      backendUrl: credentials.backendUrl || '',
      modelMode: credentials.modelMode || '',
      routePreference: credentials.routePreference || '',
    };
  } catch {
    return {
      authenticated: false,
      backendUrl: '',
      modelMode: '',
      routePreference: '',
    };
  }
}

function joinUrl(base, pathSuffix) {
  const root = String(base || 'https://bahulam.ai').replace(/\/$/, '');
  const suffix = String(pathSuffix || '/');
  return `${root}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
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
  const webUrl = resolveWebUrl();
  const publicUrl = process.env.BAHULAM_PUBLIC_URL || webUrl;
  const auth = localAuthInfo();
  const dashboardUrl = joinUrl(webUrl, '/dashboard');
  const loginUrl = joinUrl(webUrl, '/login?redirect=/dashboard');
  const billingUrl = joinUrl(webUrl, '/dashboard/billing');
  const pricingUrl = joinUrl(webUrl, '/pricing');
  const cloudIdeUrl = joinUrl(webUrl, '/cloudide');
  const authLabel = auth.authenticated ? 'CLI signed in' : 'CLI login needed';
  const accountUrl = auth.authenticated ? billingUrl : loginUrl;
  const accountLabel = auth.authenticated ? 'Account' : 'Login';
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
:root{color-scheme:light;--ws-foreground:#1B1B1B;--ws-muted:rgba(27,27,27,.52);--ws-faint:rgba(27,27,27,.3);--ws-border:rgba(27,27,27,.10);--ws-border-subtle:rgba(27,27,27,.06);--ws-bg:#FFFDF7;--ws-surface:#F7F5EF;--ws-panel:#fff;--ws-tab:#FAF9F5;--ws-primary:#0891B2;--ws-hover:rgba(27,27,27,.04);--ws-active:rgba(27,27,27,.08);--ws-success:#047857;--ws-success-bg:#ECFDF5;--ws-error:#B91C1C;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--ws-bg);color:var(--ws-foreground);font:13px/1.45 var(--sans);overflow:hidden}
button,textarea,input{font:inherit}button{color:inherit}.shell{display:flex;flex-direction:column;height:100vh;min-height:560px;background:var(--ws-bg)}
.global-bar{height:40px;display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(27,27,27,.08);background:#FFFDF7;padding:0 16px;flex:0 0 auto;min-width:0}
.dashboard-link{height:28px;display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;border-radius:6px;padding:0;color:rgba(27,27,27,.40);font-size:12px;text-decoration:none;cursor:pointer;transition:color .15s ease;white-space:nowrap}.dashboard-link:hover{color:rgba(27,27,27,.70)}.dashboard-link svg{width:14px;height:14px;flex:0 0 auto}.brand-divider{width:1px;height:16px;background:rgba(27,27,27,.10);flex:0 0 auto}
.ide-brand{height:28px;display:flex;align-items:center;gap:6px;text-decoration:none;color:var(--ws-foreground);white-space:nowrap}.brand-mark{width:20px;height:20px;border-radius:5px;object-fit:contain;display:block}.brand-title{font:800 12px/1 var(--mono);letter-spacing:-.01em;color:#1B1B1B}
.global-spacer{flex:1;min-width:10px}.global-links{display:flex;align-items:center;gap:10px;min-width:0;overflow:hidden}.global-link{color:rgba(27,27,27,.46);font-size:12px;text-decoration:none;white-space:nowrap}.global-link:hover{color:rgba(27,27,27,.78)}.auth-chip{height:22px;display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(27,27,27,.10);border-radius:999px;background:#fff;padding:0 8px;color:rgba(27,27,27,.46);font-size:11px;white-space:nowrap}.auth-chip:before{content:"";width:6px;height:6px;border-radius:999px;background:#A8A29E}.auth-chip.signed-in{border-color:#BBF7D0;background:#ECFDF5;color:#047857}.auth-chip.signed-in:before{background:#10B981}
.topbar{height:38px;display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(27,27,27,.06);background:rgba(255,255,255,.80);backdrop-filter:blur(10px);padding:0 16px;flex:0 0 auto}.terminal-icon{width:16px;height:16px;color:rgba(27,27,27,.30);flex:0 0 auto}.workspace-name{font-size:14px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace-kind{font-size:12px;color:rgba(27,27,27,.30)}.top-actions{margin-left:auto;display:flex;align-items:center;gap:6px;min-width:0}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;border:1px solid var(--ws-border);background:#fff;padding:2px 8px;font-size:10px;font-weight:500;color:rgba(27,27,27,.58);white-space:nowrap}.badge.local{border-color:#BBF7D0;background:var(--ws-success-bg);color:var(--ws-success)}.badge.local:before{content:"";width:6px;height:6px;border-radius:999px;background:#10B981}
.icon-button{height:26px;min-width:26px;border:1px solid rgba(27,27,27,.10);border-radius:6px;background:#fff;color:rgba(27,27,27,.64);display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 8px;cursor:pointer;font-size:11px;font-weight:500;transition:background .15s ease,color .15s ease,border-color .15s ease}.icon-button:hover{background:#F7F5EF;color:var(--ws-foreground)}.icon-button[aria-pressed="true"]{background:rgba(27,27,27,.08);border-color:rgba(27,27,27,.10);color:#1B1B1B}.icon-button svg{width:14px;height:14px}
.menubar{height:28px;display:flex;align-items:center;gap:2px;border-bottom:1px solid rgba(27,27,27,.06);background:#F7F5EF;padding:0 12px;flex:0 0 auto;user-select:none}.menu-item{height:22px;border:0;background:transparent;border-radius:5px;padding:0 8px;color:rgba(27,27,27,.58);font-size:12px;cursor:pointer}.menu-item:hover{background:var(--ws-hover);color:rgba(27,27,27,.86)}
main{--left-w:256px;--right-w:480px;display:grid;grid-template-columns:var(--left-w) 6px minmax(360px,1fr) 6px var(--right-w);flex:1;min-height:0}.panel{min-width:0;background:var(--ws-panel);overflow:hidden}.files{background:rgba(255,255,255,.52)}.work{display:flex;flex-direction:column;background:#fff}.agent{background:rgba(255,255,255,.58);display:flex;flex-direction:column}.resizer{background:transparent;border-left:1px solid var(--ws-border-subtle);border-right:1px solid transparent;cursor:col-resize;position:relative}.resizer:hover,.resizer.dragging{background:rgba(8,145,178,.08);border-left-color:rgba(8,145,178,.25)}
main.hide-files{grid-template-columns:0 0 minmax(360px,1fr) 6px var(--right-w)}main.hide-files .files,main.hide-files .left-resizer{display:none}main.hide-agent{grid-template-columns:var(--left-w) 6px minmax(360px,1fr) 0 0}main.hide-agent .agent,main.hide-agent .right-resizer{display:none}
.section-head{height:36px;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:var(--ws-faint);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;background:rgba(255,255,255,.45)}.section-actions{display:flex;align-items:center;gap:4px}.section-button{height:20px;border:0;background:transparent;border-radius:5px;color:rgba(27,27,27,.35);cursor:pointer;padding:0 4px}.section-button:hover{background:var(--ws-hover);color:rgba(27,27,27,.70)}
.file-list{padding:6px;overflow:auto;height:calc(100% - 36px)}.row{display:flex;align-items:center;gap:5px;width:100%;height:27px;border:0;background:transparent;text-align:left;border-radius:6px;padding:0 8px;color:rgba(27,27,27,.62);cursor:pointer;font-size:12px;line-height:1}.row:hover{background:var(--ws-hover);color:rgba(27,27,27,.84)}.row.selected{background:var(--ws-active);color:var(--ws-foreground)}.row:focus-visible{outline:2px solid rgba(8,145,178,.35);outline-offset:1px}.chev{width:12px;text-align:center;color:rgba(27,27,27,.32);font:11px var(--mono)}.icon{width:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--ws-faint);font-size:11px;font-family:var(--mono)}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sub{color:rgba(27,27,27,.28);font:10px var(--mono);margin-left:auto}.loading-row{height:24px;padding-left:32px;color:rgba(27,27,27,.30);font:11px var(--mono)}
.tabbar{height:36px;display:flex;align-items:center;border-bottom:1px solid var(--ws-border-subtle);background:var(--ws-tab);flex:0 0 auto;overflow-x:auto}.tab{height:100%;display:flex;align-items:center;gap:7px;border:0;border-right:1px solid var(--ws-border-subtle);padding:0 9px;background:transparent;color:rgba(27,27,27,.45);font-size:11px;cursor:pointer;max-width:220px;min-width:90px}.tab.active{background:#fff;color:var(--ws-foreground);box-shadow:inset 0 -1.5px 0 var(--ws-foreground)}.tab:hover{background:rgba(27,27,27,.03);color:rgba(27,27,27,.75)}.tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tab-close{border:0;background:transparent;border-radius:4px;color:rgba(27,27,27,.28);cursor:pointer;padding:0 2px}.tab-close:hover{background:rgba(27,27,27,.07);color:rgba(27,27,27,.70)}.tab-muted{flex:1;height:100%;border-left:1px solid var(--ws-border-subtle);min-width:24px}
.viewer{flex:1;min-height:0;overflow:auto;background:#fff}.file-header{height:34px;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;gap:8px;padding:0 12px;background:rgba(27,27,27,.015);font:12px var(--mono);color:rgba(27,27,27,.50)}.path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-actions{margin-left:auto;display:flex;gap:6px}.file-action{font:11px var(--sans);color:rgba(27,27,27,.50);text-decoration:none;border:1px solid var(--ws-border);border-radius:6px;padding:2px 7px;background:#fff}.file-action:hover{color:var(--ws-foreground);background:var(--ws-surface)}.empty{color:var(--ws-faint);padding:24px;font-size:12px}.error{color:var(--ws-error)}
.code-wrap{display:grid;grid-template-columns:auto 1fr;align-items:start;min-height:100%;font:12px/1.55 var(--mono)}.line-nums{user-select:none;text-align:right;padding:14px 10px 14px 14px;color:rgba(27,27,27,.25);background:#FAF9F5;border-right:1px solid var(--ws-border-subtle);white-space:pre}.code-pre{margin:0;padding:14px;white-space:pre;overflow:auto;color:#1F2937;background:#fff;min-height:100%}.markdown-preview{max-width:880px;padding:24px 28px;color:rgba(27,27,27,.86);font-size:14px;line-height:1.65}.markdown-preview h1,.markdown-preview h2,.markdown-preview h3{line-height:1.2;margin:18px 0 8px}.markdown-preview p{margin:0 0 12px}.markdown-preview code,.message-content code{font-family:var(--mono);font-size:.92em;background:rgba(27,27,27,.06);border-radius:4px;padding:1px 4px}.markdown-preview pre,.message-content pre{overflow:auto;background:#0D1117;color:#E5E7EB;border-radius:7px;padding:12px}.image-preview{height:100%;display:flex;align-items:center;justify-content:center;padding:18px;background:#F8F7F2}.image-preview img{max-width:100%;max-height:100%;object-fit:contain;border:1px solid var(--ws-border);background:#fff}.frame-preview{height:100%;min-height:420px}.frame-preview iframe{width:100%;height:100%;border:0}.table-preview{padding:18px;overflow:auto}.table-preview table{border-collapse:collapse;font-size:12px;background:#fff}.table-preview th,.table-preview td{border:1px solid var(--ws-border);padding:5px 7px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.table-preview th{background:#F7F5EF;text-align:left;color:rgba(27,27,27,.65)}.binary-preview{height:100%;display:flex;align-items:center;justify-content:center;padding:24px;color:rgba(27,27,27,.50);text-align:center}
.chat-head{height:36px;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;gap:8px;padding:0 12px;background:rgba(255,255,255,.55)}.chat-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:rgba(27,27,27,.35)}.chat-subtitle{min-width:0;flex:1;font-size:10px;color:rgba(27,27,27,.28);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chat-body{display:flex;flex-direction:column;flex:1;min-height:0}.thread{flex:1;min-height:0;overflow:auto;padding:16px 14px 10px;background:rgba(255,255,255,.40)}.thread-inner{display:flex;flex-direction:column;gap:12px}.empty-chat{display:flex;height:100%;align-items:center;justify-content:center;text-align:center;color:rgba(27,27,27,.35);font-size:12px}.msg{display:flex}.msg.user{justify-content:flex-end}.msg.assistant{justify-content:flex-start}.bubble{max-width:86%;border-radius:16px;padding:10px 12px;font-size:13px;line-height:1.55;word-break:break-word}.user .bubble{background:#1B1B1B;color:#FFFDF7}.assistant-stack{width:100%;max-width:960px;display:flex;flex-direction:column;gap:8px}.assistant-bubble{display:none;max-width:94%;border-radius:16px;background:#F7F5EF;padding:11px 13px;color:rgba(27,27,27,.86);font-size:13px;line-height:1.6}.assistant-bubble:not(:empty){display:block}.message-content p{margin:0 0 10px}.message-content p:last-child{margin-bottom:0}.message-content ul{margin:0 0 10px 18px;padding:0}.message-content li{margin:2px 0}
.activity-card{display:none;overflow:hidden;border:1px solid var(--ws-border);border-radius:8px;background:#FFFDF7;font-size:12px}.activity-card.active{display:block}.activity-head{height:28px;width:100%;border:0;background:transparent;display:flex;align-items:center;gap:8px;padding:0 9px;cursor:pointer;color:rgba(27,27,27,.68)}.activity-head:hover{background:#F7F5EF}.activity-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:11px;font-weight:650}.activity-rollup{font-size:10px;color:rgba(27,27,27,.38)}.activity-rows{border-top:1px solid rgba(27,27,27,.05);padding:7px 9px;max-height:96px;overflow:auto;display:flex;flex-direction:column;gap:5px}.activity-card.expanded .activity-rows{max-height:300px}.activity-row{display:flex;align-items:flex-start;gap:7px;color:rgba(27,27,27,.65);font-size:11px;line-height:1.35}.activity-row .status-dot{width:8px;height:8px;border-radius:999px;background:rgba(27,27,27,.18);margin-top:4px;flex:0 0 auto}.activity-row.running .status-dot{background:#0891B2}.activity-row.done .status-dot{background:#059669}.activity-row.error .status-dot{background:#DC2626}.activity-row.thinking{font-style:italic;color:rgba(27,27,27,.48)}.activity-row pre{display:none;margin:4px 0 0;max-height:120px;overflow:auto;border-radius:6px;background:rgba(27,27,27,.04);padding:6px;font:10px/1.4 var(--mono);color:rgba(27,27,27,.62);white-space:pre-wrap}.activity-card.expanded .activity-row pre{display:block}.trace{display:none;max-height:170px;overflow:auto;border-top:1px solid var(--ws-border-subtle);background:#fff;padding:6px}.trace.open{display:block}.trace-row{font:11px/1.45 var(--mono);border-bottom:1px solid rgba(27,27,27,.05);padding:6px 4px;color:rgba(27,27,27,.52)}.trace-row b{color:var(--ws-primary)}
.composer{border-top:1px solid var(--ws-border-subtle);background:#FFFDF7;padding:10px 12px}.composer-box{border:1px solid var(--ws-border);border-radius:10px;background:#fff;overflow:hidden}textarea{display:block;width:100%;min-height:84px;max-height:240px;resize:vertical;border:0;padding:10px 11px;background:#fff;color:var(--ws-foreground);outline:none}.composer-actions{height:34px;border-top:1px solid var(--ws-border-subtle);display:flex;align-items:center;justify-content:space-between;padding:0 8px}.status{font-size:11px;color:var(--ws-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px}button.primary{height:24px;border:0;border-radius:6px;background:var(--ws-foreground);color:#fff;font-size:11px;font-weight:750;padding:0 10px;cursor:pointer}button.primary:hover{background:#2B2B2B}button.primary:disabled{opacity:.45;cursor:not-allowed}
@media(max-width:980px){body{overflow:auto}.shell{height:auto;min-height:100vh}.global-links .global-link:not(:last-of-type){display:none}.auth-chip{display:none}main,main.hide-files,main.hide-agent{display:flex;flex-direction:column}.resizer{display:none}.panel{min-height:320px}.files,.agent{border:0;border-bottom:1px solid var(--ws-border-subtle)}.top-actions .badge:not(.local){display:none}.thread{min-height:420px}.bubble{max-width:94%}}
</style>
</head>
<body>
<div class="shell">
  <header class="global-bar">
    <a class="dashboard-link" href="${escapeHtml(dashboardUrl)}" target="_blank" rel="noreferrer" title="Open dashboard">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg>
      <span>Dashboard</span>
    </a>
    <div class="brand-divider"></div>
    <a class="ide-brand" href="${escapeHtml(cloudIdeUrl)}" target="_blank" rel="noreferrer" aria-label="Cloud IDE">
      <img class="brand-mark" src="/assets/bahulam-mark.png" alt="">
      <span class="brand-title">Cloud IDE</span>
    </a>
    <div class="global-spacer"></div>
    <nav class="global-links" aria-label="Bahulam links">
      <a class="global-link" href="${escapeHtml(publicUrl)}" target="_blank" rel="noreferrer">Bahulam</a>
      <a class="global-link" href="${escapeHtml(pricingUrl)}" target="_blank" rel="noreferrer">Pricing</a>
      <a class="global-link" href="${escapeHtml(billingUrl)}" target="_blank" rel="noreferrer">Subscriptions</a>
      <a class="global-link" href="${escapeHtml(accountUrl)}" target="_blank" rel="noreferrer">${escapeHtml(accountLabel)}</a>
      <span class="auth-chip ${auth.authenticated ? 'signed-in' : ''}" title="${escapeHtml(auth.backendUrl || 'No backend URL resolved')}">${escapeHtml(authLabel)}</span>
    </nav>
  </header>
  <div class="topbar">
    <svg class="terminal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
    <div class="workspace-name">${rootName}</div>
    <div class="workspace-kind">${escapeHtml(session.kind)}</div>
    <div class="top-actions">
      <span class="badge local">local</span>
      <span class="badge">${escapeHtml(session.id)}</span>
      <button class="icon-button" id="toggleExplorer" type="button" title="Hide file explorer" aria-label="Toggle file explorer" aria-pressed="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path></svg></button>
      <button class="icon-button" id="toggleAgent" type="button" title="Hide agent chat" aria-label="Toggle agent chat" aria-pressed="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M15 3v18"></path></svg></button>
    </div>
  </div>
  <div class="menubar">
    <button class="menu-item" type="button">File</button>
    <button class="menu-item" type="button">Edit</button>
    <button class="menu-item" type="button">Run</button>
    <button class="menu-item" type="button">Tools</button>
  </div>
  <main id="layout">
    <section class="panel files" id="filesPanel">
      <div class="section-head"><span>Files</span><span class="section-actions"><button class="section-button" id="refreshFiles" type="button" title="Refresh">↻</button><span id="fileCount"></span></span></div>
      <div class="file-list" id="fileList"></div>
    </section>
    <div class="resizer left-resizer" data-resize="left"></div>
    <section class="panel work">
      <div class="tabbar" id="tabbar"><div class="tab-muted"></div></div>
      <div class="viewer" id="viewer"><div class="empty">Loading...</div></div>
    </section>
    <div class="resizer right-resizer" data-resize="right"></div>
    <section class="panel agent" id="agentPanel">
      <div class="chat-head"><span class="chat-title">Agent</span><span class="chat-subtitle" id="bridgeState">bridge pending</span><button class="section-button" id="traceToggle" type="button" title="Trace">Trace</button></div>
      <div class="chat-body">
        <div class="thread" id="thread"><div class="thread-inner" id="threadInner"><div class="empty-chat" id="emptyChat">Ask about this local workspace.</div></div></div>
        <div class="trace" id="events"></div>
        <form class="composer" id="composer">
          <div class="composer-box">
          <textarea id="prompt" placeholder="Ask about this local workspace"></textarea>
          <div class="composer-actions">
            <div class="status" id="sendStatus"></div>
            <button class="primary" id="send" type="submit">Send</button>
          </div>
          </div>
        </form>
      </div>
    </section>
  </main>
</div>
<script>
const BOOT = ${boot};
const token = BOOT.token;
const layoutKey = 'bahulam_local_ide_layout_v2';
let currentPath = BOOT.initialPath || '.';
const headers = { 'X-Bahulam-Local-Token': token };
const dirCache = new Map();
const expandedDirs = new Set(['.']);
const loadingDirs = new Set();
const openTabs = [];
const fileCache = new Map();
let activePath = null;
let activeTurn = null;
let turnSeq = 0;
let traceOpen = false;

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
function rawUrl(path){return '/api/file/raw?token=' + encodeURIComponent(token) + '&path=' + encodeURIComponent(path);}
function basename(p){const parts=String(p||'').split('/').filter(Boolean);return parts.length?parts[parts.length-1]:'Workspace';}
function extname(p){const name=basename(p).toLowerCase();const i=name.lastIndexOf('.');return i>=0?name.slice(i+1):'';}
function formatBytes(size){const n=Number(size)||0;if(n<1024)return String(n);if(n<1024*1024)return Math.round(n/1024)+'K';return (n/1024/1024).toFixed(1)+'M';}
function parentPath(p){const parts=String(p||'.').split('/').filter(Boolean);parts.pop();return parts.length?parts.join('/'):'.';}
function applyLayout(){
  let prefs={leftWidth:256,rightWidth:480,explorerVisible:true,agentVisible:true};
  try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}
  const layout=document.getElementById('layout');
  layout.style.setProperty('--left-w', Math.max(180, Math.min(520, prefs.leftWidth)) + 'px');
  layout.style.setProperty('--right-w', Math.max(360, Math.min(760, prefs.rightWidth)) + 'px');
  layout.classList.toggle('hide-files', !prefs.explorerVisible);
  layout.classList.toggle('hide-agent', !prefs.agentVisible);
  document.getElementById('toggleExplorer').setAttribute('aria-pressed', String(prefs.explorerVisible));
  document.getElementById('toggleAgent').setAttribute('aria-pressed', String(prefs.agentVisible));
  document.getElementById('toggleExplorer').title = prefs.explorerVisible ? 'Hide file explorer' : 'Show file explorer';
  document.getElementById('toggleAgent').title = prefs.agentVisible ? 'Hide agent chat' : 'Show agent chat';
}
function saveLayoutPatch(patch){
  let prefs={leftWidth:256,rightWidth:480,explorerVisible:true,agentVisible:true};
  try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}
  prefs={...prefs,...patch};
  localStorage.setItem(layoutKey, JSON.stringify(prefs));
  applyLayout();
}
function setupResizers(){
  for(const handle of document.querySelectorAll('.resizer')){
    handle.addEventListener('mousedown', e=>{
      e.preventDefault();
      const type=handle.dataset.resize;
      handle.classList.add('dragging');
      const startX=e.clientX;
      let prefs={leftWidth:256,rightWidth:480,explorerVisible:true,agentVisible:true};
      try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}
      const startLeft=prefs.leftWidth;
      const startRight=prefs.rightWidth;
      function move(ev){
        if(type==='left') saveLayoutPatch({leftWidth:Math.max(180, Math.min(520, startLeft + ev.clientX - startX))});
        if(type==='right') saveLayoutPatch({rightWidth:Math.max(360, Math.min(760, startRight - ev.clientX + startX))});
      }
      function up(){handle.classList.remove('dragging');window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);}
      window.addEventListener('mousemove',move);
      window.addEventListener('mouseup',up);
    });
  }
}
async function loadDir(path){
  const key=path||'.';
  if(loadingDirs.has(key))return;
  loadingDirs.add(key);
  renderExplorer();
  try {
    const data=await api('/api/files?path='+encodeURIComponent(key));
    if(data.type==='directory'){
      dirCache.set(data.path, data);
      document.getElementById('fileCount').textContent=String(data.entries.length);
    } else {
      openFile(data.path, data);
    }
  } catch (err) {
    addTrace('file_error',{path:key,message:err.message});
  } finally {
    loadingDirs.delete(key);
    renderExplorer();
  }
}
async function openFile(path, knownData){
  currentPath=path;
  if(!openTabs.some(t=>t.path===path))openTabs.push({path,name:basename(path)});
  activePath=path;
  renderTabs();
  renderExplorer();
  let data=knownData||fileCache.get(path);
  if(!data){
    document.getElementById('viewer').innerHTML='<div class="file-header"><span class="path">'+esc(path)+'</span></div><div class="empty">Loading...</div>';
    data=await api('/api/files?path='+encodeURIComponent(path));
    fileCache.set(path,data);
  }
  renderFile(data);
}
function closeTab(path){
  const i=openTabs.findIndex(t=>t.path===path);
  if(i>=0)openTabs.splice(i,1);
  if(activePath===path){
    const next=openTabs[Math.max(0,i-1)]||openTabs[0]||null;
    activePath=next?next.path:null;
    if(next) openFile(next.path);
    else renderEmptyViewer();
  }
  renderTabs();
}
function renderTabs(){
  const bar=document.getElementById('tabbar');
  const tabs=openTabs.map(tab=>'<button class="tab '+(tab.path===activePath?'active':'')+'" data-tab="'+esc(tab.path)+'" title="'+esc(tab.path)+'"><span>◇</span><span class="tab-name">'+esc(tab.name)+'</span><span class="tab-close" data-close="'+esc(tab.path)+'">×</span></button>').join('');
  bar.innerHTML=tabs+'<div class="tab-muted"></div>';
  bar.querySelectorAll('[data-tab]').forEach(btn=>btn.addEventListener('click',e=>{if(e.target.dataset.close)return;openFile(btn.dataset.tab);}));
  bar.querySelectorAll('[data-close]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();closeTab(btn.dataset.close);}));
}
function renderExplorer(){
  const root=dirCache.get('.');
  const list=document.getElementById('fileList');
  if(!root){list.innerHTML='<div class="loading-row">Loading...</div>';return;}
  list.innerHTML=renderEntries(root.entries||[],0);
  list.querySelectorAll('[data-dir]').forEach(btn=>btn.addEventListener('click',async()=>{const p=btn.dataset.dir;if(expandedDirs.has(p)&&p!=='.')expandedDirs.delete(p);else{expandedDirs.add(p);if(!dirCache.has(p))await loadDir(p);}renderExplorer();}));
  list.querySelectorAll('[data-file]').forEach(btn=>btn.addEventListener('click',()=>openFile(btn.dataset.file)));
}
function renderEntries(entries,depth){
  return entries.map(entry=>{
    const pad=8+depth*13;
    if(entry.type==='directory'){
      const open=expandedDirs.has(entry.path);
      const child=dirCache.get(entry.path);
      const rows=open?(child?renderEntries(child.entries||[],depth+1):'<div class="loading-row" style="padding-left:'+(pad+24)+'px">Loading...</div>'):'';
      return '<button class="row" style="padding-left:'+pad+'px" data-dir="'+esc(entry.path)+'"><span class="chev">'+(open?'⌄':'›')+'</span><span class="icon">▦</span><span class="name">'+esc(entry.name)+'</span></button>'+rows;
    }
    return '<button class="row '+(entry.path===activePath?'selected':'')+'" style="padding-left:'+pad+'px" data-file="'+esc(entry.path)+'"><span class="chev"></span><span class="icon">◇</span><span class="name">'+esc(entry.name)+'</span><span class="sub">'+(entry.size!=null?formatBytes(entry.size):'')+'</span></button>';
  }).join('');
}
function renderEmptyViewer(){
  document.getElementById('viewer').innerHTML='<div class="empty">Select a file.</div>';
}
function renderFile(data){
  currentPath=data.path;
  const file=data.file||{};
  const ext=extname(data.path);
  const text=data.preview&&data.preview.content!=null?data.preview.content:null;
  const header='<div class="file-header"><span>◇</span><span class="path">'+esc(data.path)+'</span><span class="sub">'+(file.size!=null?formatBytes(file.size):'')+'</span><span class="file-actions"><a class="file-action" href="'+rawUrl(data.path)+'" target="_blank" rel="noreferrer">Open</a></span></div>';
  if(['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext)){document.getElementById('viewer').innerHTML=header+'<div class="image-preview"><img src="'+rawUrl(data.path)+'" alt="'+esc(data.path)+'"></div>';return;}
  if(ext==='pdf'){document.getElementById('viewer').innerHTML=header+'<div class="frame-preview"><iframe src="'+rawUrl(data.path)+'"></iframe></div>';return;}
  if(text!=null&&['md','mdx'].includes(ext)){document.getElementById('viewer').innerHTML=header+'<div class="markdown-preview">'+markdown(text)+'</div>';return;}
  if(text!=null&&['json','jsonl'].includes(ext)){document.getElementById('viewer').innerHTML=header+renderCode(formatJson(text),data.path);return;}
  if(text!=null&&['csv','tsv'].includes(ext)){document.getElementById('viewer').innerHTML=header+renderTable(text,ext==='tsv'?'\\t':',');return;}
  if(text!=null){document.getElementById('viewer').innerHTML=header+renderCode(text,data.path);return;}
  document.getElementById('viewer').innerHTML=header+'<div class="binary-preview"><div>Preview unavailable for .'+esc(ext||'file')+'.<br>Agent-side tools can still inspect and transform it locally.</div></div>';
}
function renderCode(text,path){
  const lines=String(text||'').split('\\n');
  const nums=lines.map((_,i)=>i+1).join('\\n');
  return '<div class="code-wrap"><pre class="line-nums">'+nums+'</pre><pre class="code-pre">'+esc(text)+'</pre></div>';
}
function formatJson(text){try{return JSON.stringify(JSON.parse(text),null,2);}catch{return text;}}
function parseDelimited(text,delim){
  const rows=[];let row=[];let cell='';let quoted=false;
  for(let i=0;i<text.length;i++){const ch=text[i];const next=text[i+1];if(ch==='"'&&quoted&&next==='"'){cell+='"';i++;continue;}if(ch==='"'){quoted=!quoted;continue;}if(ch===delim&&!quoted){row.push(cell);cell='';continue;}if((ch==='\\n'||ch==='\\r')&&!quoted){if(ch==='\\r'&&next==='\\n')i++;row.push(cell);rows.push(row);row=[];cell='';if(rows.length>=200)break;continue;}cell+=ch;}
  if(cell||row.length){row.push(cell);rows.push(row);}
  return rows;
}
function renderTable(text,delim){
  const rows=parseDelimited(text,delim);
  if(!rows.length)return '<div class="empty">No rows.</div>';
  const head=rows[0]||[];
  const body=rows.slice(1);
  return '<div class="table-preview"><table><thead><tr>'+head.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+body.map(r=>'<tr>'+head.map((_,i)=>'<td>'+esc(r[i]||'')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}
function markdown(text){
  const lines=esc(text).split('\\n');
  let out='';let inUl=false;let inPre=false;
  const fence=String.fromCharCode(96,96,96);
  for(const raw of lines){const line=raw.trimEnd();
    if(line.startsWith(fence)){if(inUl){out+='</ul>';inUl=false;}if(inPre){out+='</code></pre>';inPre=false;}else{out+='<pre><code>';inPre=true;}continue;}
    if(inPre){out+=line+'\\n';continue;}
    if(!line.trim()){if(inUl){out+='</ul>';inUl=false;}continue;}
    const h=line.match(/^(#{1,3})\\s+(.*)$/);if(h){if(inUl){out+='</ul>';inUl=false;}out+='<h'+h[1].length+'>'+inlineMd(h[2])+'</h'+h[1].length+'>';continue;}
    const li=line.match(/^[-*]\\s+(.*)$/);if(li){if(!inUl){out+='<ul>';inUl=true;}out+='<li>'+inlineMd(li[1])+'</li>';continue;}
    if(inUl){out+='</ul>';inUl=false;}out+='<p>'+inlineMd(line)+'</p>';
  }
  if(inUl)out+='</ul>';if(inPre)out+='</code></pre>';return out;
}
function inlineMd(s){const tick=String.fromCharCode(96);return s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(new RegExp(tick+'([^'+tick+']+)'+tick,'g'),'<code>$1</code>');}
function addTrace(type, detail){
  const el = document.createElement('div');
  el.className = 'trace-row';
  el.innerHTML = '<b>' + esc(type) + '</b> ' + esc(detail || '');
  const events = document.getElementById('events');
  events.appendChild(el);
  events.scrollTop = events.scrollHeight;
}
function addUserMessage(text){
  document.getElementById('emptyChat')?.remove();
  const el=document.createElement('div');
  el.className='msg user';
  el.innerHTML='<div class="bubble">'+esc(text)+'</div>';
  document.getElementById('threadInner').appendChild(el);
  scrollThread();
}
function addAssistantMessage(text){
  document.getElementById('emptyChat')?.remove();
  const el=document.createElement('div');
  el.className='msg assistant';
  el.innerHTML='<div class="assistant-stack"><div class="assistant-bubble message-content">'+markdown(text)+'</div></div>';
  document.getElementById('threadInner').appendChild(el);
  scrollThread();
}
function addHistoryToolMessage(item){
  document.getElementById('emptyChat')?.remove();
  const el=document.createElement('div');
  el.className='msg assistant';
  const label=(item.tool || item.kind || 'tool') + (item.kind ? ' ' + item.kind : '');
  el.innerHTML='<div class="assistant-stack"><div class="activity-card active"><button class="activity-head" type="button"><span class="activity-label">'+esc(label)+'</span><span class="activity-rollup">history</span><span>›</span></button><div class="activity-rows"><div class="activity-row done"><span class="status-dot"></span><span><span>'+esc(item.content || '')+'</span></span></div></div></div></div>';
  const card=el.querySelector('.activity-card');
  card.querySelector('.activity-head').addEventListener('click',()=>{card.classList.toggle('expanded');});
  document.getElementById('threadInner').appendChild(el);
}
async function loadChatHistory(){
  try {
    const history=await api('/api/chat/history');
    const messages=Array.isArray(history.messages)?history.messages:[];
    if(history.backend_session_id){
      document.getElementById('bridgeState').textContent='resumed';
    }
    if(!messages.length)return;
    for(const msg of messages){
      if(msg.role==='user')addUserMessage(msg.content||'');
      else if(msg.role==='assistant')addAssistantMessage(msg.content||'');
      else if(msg.role==='tool')addHistoryToolMessage(msg);
    }
    scrollThread();
  } catch (err) {
    addTrace('history_error', JSON.stringify({message:err.message}));
  }
}
function ensureAssistantTurn(){
  if(activeTurn)return activeTurn;
  turnSeq+=1;
  const el=document.createElement('div');
  el.className='msg assistant';
  el.innerHTML='<div class="assistant-stack"><div class="activity-card" data-activity><button class="activity-head" type="button"><span class="activity-label">Starting...</span><span class="activity-rollup"></span><span>›</span></button><div class="activity-rows"></div></div><div class="assistant-bubble message-content" data-content></div></div>';
  document.getElementById('threadInner').appendChild(el);
  const activity=el.querySelector('[data-activity]');
  activity.querySelector('.activity-head').addEventListener('click',()=>{activity.classList.toggle('expanded');});
  activeTurn={id:'local_'+turnSeq,el,text:'',activity:[],byKey:new Map(),active:true};
  return activeTurn;
}
function addActivity(level,message,opts={}){
  const turn=ensureAssistantTurn();
  const key=opts.key||null;
  let row=key?turn.byKey.get(key):null;
  if(row){Object.assign(row,{level,message,...opts});}
  else{row={level,message,ts:Date.now(),...opts};turn.activity.push(row);if(key)turn.byKey.set(key,row);}
  renderActivity(turn);
}
function renderActivity(turn){
  const card=turn.el.querySelector('[data-activity]');
  const rows=turn.activity.filter(a=>a.message&&String(a.message).trim());
  if(!rows.length&&!turn.active){card.classList.remove('active');return;}
  card.classList.add('active');
  const latest=rows[rows.length-1];
  card.querySelector('.activity-label').textContent=latest?latest.message:'Starting...';
  const tools=rows.filter(r=>r.kind==='tool').length;
  const errors=rows.filter(r=>r.level==='error').length;
  card.querySelector('.activity-rollup').textContent=[tools?tools+' tools':'',errors?errors+' errors':''].filter(Boolean).join(' · ');
  card.querySelector('.activity-rows').innerHTML=rows.slice(card.classList.contains('expanded')?0:-4).map(r=>'<div class="activity-row '+esc(r.level||'')+'"><span class="status-dot"></span><span><span>'+esc(r.message)+'</span>'+(r.detail?'<pre>'+esc(r.detail)+'</pre>':'')+'</span></div>').join('');
}
function appendAssistantText(text){
  const turn=ensureAssistantTurn();
  turn.text+=text||'';
  turn.el.querySelector('[data-content]').innerHTML=markdown(turn.text);
  scrollThread();
}
function scrollThread(){const t=document.getElementById('thread');t.scrollTop=t.scrollHeight;}
function handleRelayEvent(type, event){
  const data = event.data || {};
  addTrace(type, JSON.stringify(data));
  if (type === 'agent_content') {
    appendAssistantText(data.text || '');
    return;
  }
  if (type === 'agent_relay_ready') {
    document.getElementById('bridgeState').textContent = 'ready';
    return;
  }
  if (type === 'agent_turn_started') {
    activeTurn=null;
    ensureAssistantTurn();
    document.getElementById('bridgeState').textContent = 'running';
    return;
  }
  if (type === 'agent_turn_complete') {
    if(activeTurn){activeTurn.active=false;renderActivity(activeTurn);activeTurn=null;}
    document.getElementById('bridgeState').textContent = 'ready';
    document.getElementById('sendStatus').textContent = 'Done';
    return;
  }
  if (type === 'agent_error') {
    document.getElementById('bridgeState').textContent = 'error';
    document.getElementById('sendStatus').textContent = data.message || data.error || 'Agent error';
    addActivity('error', data.message || data.error || 'Agent error', {detail: data.code || ''});
    return;
  }
  if (type === 'agent_tool_call') {
    const detail=data.args?JSON.stringify(data.args,null,2):'';
    addActivity('running', (data.tool || 'tool'), {key:data.call_id||data.tool, kind:'tool', detail});
    return;
  }
  if (type === 'agent_tool_result') {
    addActivity(data.success===false?'error':'done', (data.tool || 'tool') + (data.success===false?' failed':' completed'), {key:data.call_id||data.tool, kind:'tool', detail:data.output||''});
    return;
  }
  if (type === 'agent_status') {
    addActivity('thinking', data.message || data.type || 'Working');
    return;
  }
  if (type === 'agent_reasoning') {
    addActivity('thinking', data.text || 'Thinking');
    return;
  }
}
const es = new EventSource('/api/events?token=' + encodeURIComponent(token));
es.onmessage = evt => { try { const e = JSON.parse(evt.data); addTrace(e.type, JSON.stringify(e.data || {})); } catch {} };
[
  'session_started','file_browsed','file_read','tool_execution_requested','session_stopped',
  'agent_turn_requested','agent_relay_ready','agent_turn_started','agent_turn_complete',
  'agent_session','agent_status','agent_reasoning','agent_content','agent_tool_call',
  'agent_tool_result','agent_activity','agent_complete','agent_error','agent_event'
].forEach(type => {
  es.addEventListener(type, evt => { try { handleRelayEvent(type, JSON.parse(evt.data)); } catch {} });
});
document.getElementById('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;
  addUserMessage(prompt);
  document.getElementById('prompt').value='';
  activeTurn=null;
  document.getElementById('sendStatus').textContent = 'Sending...';
  document.getElementById('send').disabled = true;
  try {
    await api('/api/agent/turn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt, path: currentPath }) });
  } catch (err) {
    document.getElementById('sendStatus').textContent = err.message;
    document.getElementById('bridgeState').textContent = err.status === 401 ? 'auth required' : 'error';
    addActivity('error', (err.status ? err.status + ' ' : '') + err.message);
  } finally {
    document.getElementById('send').disabled = false;
  }
});
document.getElementById('prompt').addEventListener('keydown', e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();document.getElementById('composer').requestSubmit();}});
document.getElementById('traceToggle').addEventListener('click',()=>{traceOpen=!traceOpen;document.getElementById('events').classList.toggle('open',traceOpen);});
document.getElementById('refreshFiles').addEventListener('click',()=>{dirCache.clear();loadDir('.');});
document.getElementById('toggleExplorer').addEventListener('click',()=>{let prefs={explorerVisible:true};try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}saveLayoutPatch({explorerVisible:!prefs.explorerVisible});});
document.getElementById('toggleAgent').addEventListener('click',()=>{let prefs={agentVisible:true};try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}saveLayoutPatch({agentVisible:!prefs.agentVisible});});
applyLayout();
setupResizers();
renderTabs();
renderEmptyViewer();
loadChatHistory();
loadDir('.').then(()=>{if(currentPath&&currentPath!=='.')openFile(currentPath).catch(()=>{});});
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
