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
import {
  DEFAULT_MAX_RAW_BYTES,
  contentTypeForPath,
  listWorkspacePath,
  readWorkspaceFile,
} from './file-access.mjs';
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

  if (req.method === 'GET' && url.pathname.startsWith('/vendor/monaco/')) {
    sendPackageAsset({
      res,
      root: fileURLToPath(new URL('../../node_modules/monaco-editor/min/', import.meta.url)),
      pathname: url.pathname,
      prefix: '/vendor/monaco/',
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/vendor/mermaid/')) {
    sendPackageAsset({
      res,
      root: fileURLToPath(new URL('../../node_modules/mermaid/dist/', import.meta.url)),
      pathname: url.pathname,
      prefix: '/vendor/mermaid/',
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
    const history = relay.currentHistory();
    sendJson(res, 200, history);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/sessions') {
    const relay = getAgentRelay(session);
    const historySessions = await relay.listHistorySessions();
    sendJson(res, 200, historySessions);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/resume') {
    const body = await readJsonBody(req);
    const relay = getAgentRelay(session);
    const history = await relay.resumeHistory(body.session_id || body.sessionId);
    sendJson(res, 200, history);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/new') {
    const relay = getAgentRelay(session);
    const history = await relay.startNewHistory();
    sendJson(res, 200, history);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/approvals/')) {
    const approvalId = decodeURIComponent(url.pathname.slice('/api/approvals/'.length));
    const body = await readJsonBody(req);
    const relay = getAgentRelay(session);
    const result = relay.decideApproval(approvalId, body);
    sendJson(res, 200, result);
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
    const bytes = readWorkspaceFile(session, requestedPath, { maxBytes: DEFAULT_MAX_RAW_BYTES });
    emit('file_read', { path: requestedPath, bytes: bytes.length });
    res.writeHead(200, {
      'Content-Type': contentTypeForPath(requestedPath),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:",
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
    'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; media-src 'self' blob:; font-src 'self'; worker-src 'self' blob:",
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

function sendPackageAsset({ res, root, pathname, prefix }) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad_asset_path' });
    return;
  }

  if (!rel || rel.includes('\0')) {
    sendJson(res, 404, { ok: false, error: 'asset_not_found' });
    return;
  }

  const fullPath = path.resolve(root, rel);
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendJson(res, 403, { ok: false, error: 'asset_outside_root' });
    return;
  }

  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      sendJson(res, 404, { ok: false, error: 'asset_not_found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': staticContentType(fullPath),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(fullPath).pipe(res);
  } catch {
    sendJson(res, 404, { ok: false, error: 'asset_not_found' });
  }
}

function staticContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json':
    case '.map': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ttf': return 'font/ttf';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
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
.menubar{height:28px;display:flex;align-items:center;gap:2px;border-bottom:1px solid rgba(27,27,27,.06);background:#F7F5EF;padding:0 12px;flex:0 0 auto;user-select:none;position:relative;z-index:20}.menu-item{height:22px;border:0;background:transparent;border-radius:5px;padding:0 8px;color:rgba(27,27,27,.58);font-size:12px;cursor:pointer}.menu-item:hover{background:var(--ws-hover);color:rgba(27,27,27,.86)}.menubar-spacer{flex:1}.session-menu-wrap{display:flex;align-items:center}.session-menu-button{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-modal-backdrop,.approval-modal-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-start;justify-content:center;background:rgba(27,27,27,.28);padding:92px 16px 24px}.approval-modal-backdrop{z-index:90;background:rgba(27,27,27,.36)}.session-modal-backdrop[hidden],.approval-modal-backdrop[hidden]{display:none}.session-dialog,.approval-dialog{width:min(620px,100%);max-height:min(620px,calc(100vh - 128px));display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(27,27,27,.12);border-radius:8px;background:#FFFDF7;box-shadow:0 24px 70px rgba(27,27,27,.22)}.approval-dialog{width:min(680px,100%)}.session-dialog-head,.approval-dialog-head{height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--ws-border-subtle);padding:0 12px}.session-dialog-title,.approval-dialog-title{font-size:13px;font-weight:750;color:rgba(27,27,27,.80)}.session-dialog-subtitle,.approval-dialog-subtitle{margin-top:1px;font:10px var(--mono);color:rgba(27,27,27,.38);max-width:560px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-menu{display:block;overflow:auto;padding:6px}.session-menu-empty{padding:10px;color:rgba(27,27,27,.42);font-size:12px}.approval-body{padding:12px;overflow:auto}.approval-subject{border:1px solid var(--ws-border);border-radius:7px;background:#fff;padding:10px;font:12px/1.45 var(--mono);color:rgba(27,27,27,.72);white-space:pre-wrap;overflow-wrap:anywhere}.approval-reason{margin-top:10px;color:rgba(27,27,27,.58);font-size:12px;line-height:1.5}.approval-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid var(--ws-border-subtle);padding:10px 12px;background:#F7F5EF}.approval-actions .danger{border-color:rgba(185,28,28,.24);color:#B91C1C}.approval-actions .primary-action{background:#1B1B1B;color:#FFFDF7;border-color:#1B1B1B}
main{--left-w:256px;--right-w:480px;display:grid;grid-template-columns:var(--left-w) 6px minmax(360px,1fr) 6px var(--right-w);flex:1;min-height:0}.panel{min-width:0;background:var(--ws-panel);overflow:hidden}.files{background:rgba(255,255,255,.52)}.work{display:flex;flex-direction:column;background:#fff}.agent{background:rgba(255,255,255,.58);display:flex;flex-direction:column}.resizer{background:transparent;border-left:1px solid var(--ws-border-subtle);border-right:1px solid transparent;cursor:col-resize;position:relative}.resizer:hover,.resizer.dragging{background:rgba(8,145,178,.08);border-left-color:rgba(8,145,178,.25)}
main.hide-files{grid-template-columns:0 0 minmax(360px,1fr) 6px var(--right-w)}main.hide-files .files,main.hide-files .left-resizer{display:none}main.hide-agent{grid-template-columns:var(--left-w) 6px minmax(360px,1fr) 0 0}main.hide-agent .agent,main.hide-agent .right-resizer{display:none}
.section-head{height:36px;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:var(--ws-faint);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;background:rgba(255,255,255,.45)}.section-actions{display:flex;align-items:center;gap:4px}.section-button{height:20px;border:0;background:transparent;border-radius:5px;color:rgba(27,27,27,.35);cursor:pointer;padding:0 4px}.section-button:hover{background:var(--ws-hover);color:rgba(27,27,27,.70)}
.file-list{padding:6px;overflow:auto;height:calc(100% - 36px)}.row{display:flex;align-items:center;gap:5px;width:100%;height:27px;border:0;background:transparent;text-align:left;border-radius:6px;padding:0 8px;color:rgba(27,27,27,.62);cursor:pointer;font-size:12px;line-height:1}.row:hover{background:var(--ws-hover);color:rgba(27,27,27,.84)}.row.selected{background:var(--ws-active);color:var(--ws-foreground)}.row:focus-visible{outline:2px solid rgba(8,145,178,.35);outline-offset:1px}.chev{width:12px;text-align:center;color:rgba(27,27,27,.32);font:11px var(--mono)}.icon{width:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--ws-faint);font-size:11px;font-family:var(--mono)}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sub{color:rgba(27,27,27,.28);font:10px var(--mono);margin-left:auto}.loading-row{height:24px;padding-left:32px;color:rgba(27,27,27,.30);font:11px var(--mono)}
.tabbar{height:36px;display:flex;align-items:center;border-bottom:1px solid var(--ws-border-subtle);background:var(--ws-tab);flex:0 0 auto;overflow-x:auto}.tab{height:100%;display:flex;align-items:center;gap:7px;border:0;border-right:1px solid var(--ws-border-subtle);padding:0 9px;background:transparent;color:rgba(27,27,27,.45);font-size:11px;cursor:pointer;max-width:220px;min-width:90px}.tab.active{background:#fff;color:var(--ws-foreground);box-shadow:inset 0 -1.5px 0 var(--ws-foreground)}.tab:hover{background:rgba(27,27,27,.03);color:rgba(27,27,27,.75)}.tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tab-close{border:0;background:transparent;border-radius:4px;color:rgba(27,27,27,.28);cursor:pointer;padding:0 2px}.tab-close:hover{background:rgba(27,27,27,.07);color:rgba(27,27,27,.70)}.tab-muted{flex:1;height:100%;border-left:1px solid var(--ws-border-subtle);min-width:24px}
.viewer{flex:1;min-height:0;overflow:hidden;background:#fff;display:flex;flex-direction:column}.file-header{min-height:34px;flex:0 0 auto;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 12px;background:rgba(27,27,27,.015);font:12px var(--mono);color:rgba(27,27,27,.50)}.path{min-width:120px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(27,27,27,.08);border-radius:999px;background:#fff;padding:1px 7px;font:10px var(--sans);color:rgba(27,27,27,.48);white-space:nowrap}.file-chip.warn{border-color:#FDE68A;background:#FFFBEB;color:#92400E}.file-actions{margin-left:auto;display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}.file-action{font:11px var(--sans);color:rgba(27,27,27,.50);text-decoration:none;border:1px solid var(--ws-border);border-radius:6px;padding:2px 7px;background:#fff;cursor:pointer}.file-action:hover{color:var(--ws-foreground);background:var(--ws-surface)}select.file-action{height:23px;max-width:160px;padding:1px 24px 1px 7px}.empty{color:var(--ws-faint);padding:24px;font-size:12px}.error{color:var(--ws-error)}
.monaco-host{flex:1;min-height:0}.code-fallback{flex:1;min-height:0;overflow:auto}.code-wrap{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;min-height:100%;font:12px/1.55 var(--mono)}.line-nums{user-select:none;text-align:right;padding:14px 10px 14px 14px;color:rgba(27,27,27,.25);background:#FAF9F5;border-right:1px solid var(--ws-border-subtle);white-space:pre}.code-pre{margin:0;padding:14px;white-space:pre;overflow:auto;color:#1F2937;background:#fff;min-height:100%}.markdown-preview{flex:1;min-height:0;overflow:auto;max-width:920px;padding:24px 28px;color:rgba(27,27,27,.86);font-size:14px;line-height:1.65}.markdown-preview h1,.markdown-preview h2,.markdown-preview h3{line-height:1.2;margin:18px 0 8px}.markdown-preview p{margin:0 0 12px}.markdown-preview code,.message-content code{font-family:var(--mono);font-size:.92em;background:rgba(27,27,27,.06);border-radius:4px;padding:1px 4px}.markdown-preview pre,.message-content pre{overflow:auto;background:#0D1117;color:#E5E7EB;border-radius:7px;padding:12px}.image-stage{flex:1;min-height:0;display:flex;flex-direction:column;background:#F8F7F2}.image-toolbar{height:34px;flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:0 10px;border-bottom:1px solid var(--ws-border-subtle);background:#fff}.image-preview{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto}.image-preview img{max-width:none;max-height:none;object-fit:contain;border:1px solid var(--ws-border);background:#fff;box-shadow:0 10px 30px rgba(27,27,27,.10);transform-origin:center center}.frame-preview{flex:1;min-height:0;background:#F8F7F2}.frame-preview iframe{width:100%;height:100%;border:0;background:#fff}.table-preview{flex:1;min-height:0;padding:18px;overflow:auto}.table-preview .table-meta{margin:0 0 10px;color:rgba(27,27,27,.42);font:11px var(--mono)}.table-preview table{border-collapse:collapse;font-size:12px;background:#fff}.table-preview th,.table-preview td{border:1px solid var(--ws-border);padding:5px 7px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.table-preview th{background:#F7F5EF;text-align:left;color:rgba(27,27,27,.65);position:sticky;top:0}.diagram-preview{flex:1;min-height:0;padding:18px;display:grid;gap:14px;max-width:1100px;overflow:auto}.mermaid-card{border:1px solid var(--ws-border);border-radius:8px;background:#fff;overflow:hidden}.mermaid-output{padding:18px;overflow:auto;min-height:180px;display:flex;align-items:center;justify-content:center}.mermaid-output svg{max-width:100%;height:auto}.mermaid-source{margin:0;border-top:1px solid var(--ws-border-subtle);border-radius:0;background:#FAF9F5;color:rgba(27,27,27,.68);font:11px/1.45 var(--mono);max-height:220px}.viewer-note{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:24px;background:#FAF9F5}.viewer-note-card{width:min(520px,100%);max-height:100%;overflow:auto;border:1px solid var(--ws-border);border-radius:8px;background:#fff;padding:18px;box-shadow:0 10px 34px rgba(27,27,27,.05)}.viewer-note-title{font-size:14px;font-weight:750;color:rgba(27,27,27,.84)}.viewer-note-body{margin-top:8px;color:rgba(27,27,27,.56);font-size:12px;line-height:1.55}.viewer-note-actions{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}.binary-preview{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:24px;color:rgba(27,27,27,.50);text-align:center}
.chat-head{height:36px;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;gap:8px;padding:0 12px;background:rgba(255,255,255,.55)}.chat-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:rgba(27,27,27,.35)}.chat-subtitle{min-width:0;flex:1;font-size:10px;color:rgba(27,27,27,.28);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-tabs{height:32px;display:flex;align-items:center;border-bottom:1px solid var(--ws-border-subtle);background:#F7F5EF;padding:0 8px;gap:3px}.agent-tab{height:24px;border:0;border-radius:6px;background:transparent;color:rgba(27,27,27,.45);font-size:11px;font-weight:650;padding:0 9px;cursor:pointer}.agent-tab:hover{background:var(--ws-hover);color:rgba(27,27,27,.76)}.agent-tab.active{background:#fff;color:var(--ws-foreground);box-shadow:0 0 0 1px rgba(27,27,27,.06)}.chat-body{display:flex;flex-direction:column;flex:1;min-height:0}.chat-pane{display:none;flex-direction:column;flex:1;min-height:0}.chat-pane.active{display:flex}.thread{flex:1;min-height:0;overflow:auto;padding:16px 14px 10px;background:rgba(255,255,255,.40)}.thread-inner{display:flex;flex-direction:column;gap:12px}.empty-chat{display:flex;height:100%;align-items:center;justify-content:center;text-align:center;color:rgba(27,27,27,.35);font-size:12px}.session-list{display:flex;flex-direction:column;gap:2px}.session-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border-radius:6px;padding:8px}.session-row:hover{background:rgba(27,27,27,.035)}.session-main{min-width:0}.session-prompt{font-size:12px;color:rgba(27,27,27,.82);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-meta{margin-top:3px;font:10px/1.4 var(--mono);color:rgba(27,27,27,.38);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-tools{margin-top:5px;display:flex;gap:4px;flex-wrap:wrap}.session-chip{border-radius:999px;border:1px solid rgba(27,27,27,.07);background:#F7F5EF;padding:1px 6px;font:10px var(--mono);color:rgba(27,27,27,.48)}.msg{display:flex}.msg.user{justify-content:flex-end}.msg.assistant{justify-content:flex-start}.bubble{max-width:86%;border-radius:16px;padding:10px 12px;font-size:13px;line-height:1.55;word-break:break-word}.user .bubble{background:#1B1B1B;color:#FFFDF7}.assistant-stack{width:100%;max-width:960px;display:flex;flex-direction:column;gap:8px}.assistant-bubble{display:none;max-width:94%;border-radius:16px;background:#F7F5EF;padding:11px 13px;color:rgba(27,27,27,.86);font-size:13px;line-height:1.6}.assistant-bubble:not(:empty){display:block}.message-content p{margin:0 0 10px}.message-content p:last-child{margin-bottom:0}.message-content ul{margin:0 0 10px 18px;padding:0}.message-content li{margin:2px 0}
.activity-card{display:none;overflow:hidden;border:1px solid var(--ws-border);border-radius:8px;background:#FFFDF7;font-size:12px}.activity-card.active{display:block}.activity-head{height:28px;width:100%;border:0;background:transparent;display:flex;align-items:center;gap:8px;padding:0 9px;cursor:pointer;color:rgba(27,27,27,.68)}.activity-head:hover{background:#F7F5EF}.activity-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:11px;font-weight:650}.activity-rollup{font-size:10px;color:rgba(27,27,27,.38)}.activity-rows{border-top:1px solid rgba(27,27,27,.05);padding:7px 9px;max-height:96px;overflow:auto;display:flex;flex-direction:column;gap:5px}.activity-card.expanded .activity-rows{max-height:300px}.activity-row{display:flex;align-items:flex-start;gap:7px;color:rgba(27,27,27,.65);font-size:11px;line-height:1.35}.activity-row .status-dot{width:8px;height:8px;border-radius:999px;background:rgba(27,27,27,.18);margin-top:4px;flex:0 0 auto}.activity-row.running .status-dot{background:#0891B2}.activity-row.done .status-dot{background:#059669}.activity-row.error .status-dot{background:#DC2626}.activity-row.thinking{font-style:italic;color:rgba(27,27,27,.48)}.activity-row pre{display:none;margin:4px 0 0;max-height:120px;overflow:auto;border-radius:6px;background:rgba(27,27,27,.04);padding:6px;font:10px/1.4 var(--mono);color:rgba(27,27,27,.62);white-space:pre-wrap}.activity-card.expanded .activity-row pre{display:block}.trace{display:block;flex:1;min-height:0;overflow:auto;background:#fff;padding:8px}.trace-row{font:11px/1.45 var(--mono);border-bottom:1px solid rgba(27,27,27,.05);padding:7px 4px;color:rgba(27,27,27,.52);white-space:pre-wrap;overflow-wrap:anywhere}.trace-row b{color:var(--ws-primary)}
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
    <div class="menubar-spacer"></div>
    <div class="session-menu-wrap">
      <button class="menu-item session-menu-button" id="sessionMenuButton" type="button" aria-haspopup="dialog" aria-expanded="false">Chat: New</button>
    </div>
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
      <div class="chat-head"><span class="chat-title">Agent</span><span class="chat-subtitle" id="bridgeState">bridge pending</span></div>
      <div class="agent-tabs" role="tablist" aria-label="Agent panel">
        <button class="agent-tab active" id="chatTab" type="button" role="tab" aria-selected="true" data-agent-tab="chat">Chat</button>
        <button class="agent-tab" id="traceTab" type="button" role="tab" aria-selected="false" data-agent-tab="trace">Trace</button>
      </div>
      <div class="chat-body">
        <div class="chat-pane active" id="chatPane" role="tabpanel" aria-labelledby="chatTab">
          <div class="thread" id="thread"><div class="thread-inner" id="threadInner"><div class="empty-chat" id="emptyChat">Ask about this local workspace.</div></div></div>
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
        <div class="chat-pane" id="tracePane" role="tabpanel" aria-labelledby="traceTab">
          <div class="trace" id="events"></div>
          </div>
      </div>
    </section>
  </main>
  <div class="session-modal-backdrop" id="sessionModal" hidden>
    <section class="session-dialog" role="dialog" aria-modal="true" aria-labelledby="sessionDialogTitle">
      <div class="session-dialog-head">
        <div>
          <div class="session-dialog-title" id="sessionDialogTitle">Chat sessions</div>
          <div class="session-dialog-subtitle">${escapeHtml(session.root_path)}</div>
        </div>
        <button class="icon-button" id="sessionModalClose" type="button" aria-label="Close chat sessions">×</button>
      </div>
      <div class="session-menu" id="sessionMenu" role="menu"></div>
    </section>
  </div>
  <div class="approval-modal-backdrop" id="approvalModal" hidden>
    <section class="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approvalTitle">
      <div class="approval-dialog-head">
        <div>
          <div class="approval-dialog-title" id="approvalTitle">Approval required</div>
          <div class="approval-dialog-subtitle" id="approvalSubtitle"></div>
        </div>
        <button class="icon-button danger" id="approvalDenyTop" type="button">Deny</button>
      </div>
      <div class="approval-body">
        <div class="approval-subject" id="approvalSubject"></div>
        <div class="approval-reason" id="approvalReason"></div>
      </div>
      <div class="approval-actions" id="approvalActions"></div>
    </section>
  </div>
</div>
<script src="/vendor/monaco/vs/loader.js"></script>
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
let historySelectionReady = false;
let historySessions = [];
let sessionMenuOpen = false;
let traceCount = 0;
let pendingApproval = null;
let monacoReady = null;
let activeEditor = null;
let activeImageScale = 1;
let mermaidReady = null;
let mermaidSeq = 0;

const LANGUAGES = [
  ['plaintext','Plain text'],['javascript','JavaScript'],['typescript','TypeScript'],['json','JSON'],
  ['html','HTML'],['css','CSS'],['scss','SCSS'],['markdown','Markdown'],['yaml','YAML'],['toml','TOML'],
  ['xml','XML'],['python','Python'],['ruby','Ruby'],['go','Go'],['rust','Rust'],['java','Java'],
  ['c','C'],['cpp','C++'],['csharp','C#'],['php','PHP'],['kotlin','Kotlin'],['swift','Swift'],
  ['dart','Dart'],['scala','Scala'],['r','R'],['lua','Lua'],['perl','Perl'],['elixir','Elixir'],
  ['clojure','Clojure'],['fsharp','F#'],['shell','Shell'],['powershell','PowerShell'],['bat','Batch'],
  ['sql','SQL'],['graphql','GraphQL'],['dockerfile','Dockerfile'],['hcl','HCL/Terraform'],
  ['powerquery','Power Query'],['msdax','DAX'],['ini','INI']
];

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
function compactId(id){const value=String(id||'');return value.length>16?value.slice(0,8)+'...'+value.slice(-5):value;}
function formatSessionTime(value){if(!value)return 'unknown';try{return new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch{return String(value);}}
function disposeActiveEditor(){try{activeEditor?.dispose?.();}catch{}activeEditor=null;}
function loadMonaco(){
  if(window.monaco)return Promise.resolve(window.monaco);
  if(monacoReady)return monacoReady;
  monacoReady=new Promise((resolve,reject)=>{
    if(!window.require){reject(new Error('Monaco loader unavailable'));return;}
    window.require.config({paths:{vs:'/vendor/monaco/vs'}});
    window.require(['vs/editor/editor.main'],()=>resolve(window.monaco),reject);
  });
  return monacoReady;
}
async function loadMermaid(){
  if(mermaidReady)return mermaidReady;
  mermaidReady=import('/vendor/mermaid/mermaid.esm.min.mjs').then(mod=>{
    const mermaid=mod.default||mod;
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',themeVariables:{primaryColor:'#F7F5EF',primaryTextColor:'#1B1B1B',primaryBorderColor:'#D7D3C8',lineColor:'#64748B',fontFamily:'ui-sans-serif, system-ui, sans-serif'}});
    return mermaid;
  });
  return mermaidReady;
}
function fileKind(data){
  const file=data.file||{};
  if(file.viewer)return file.viewer;
  const ext=extname(data.path);
  if(['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext))return 'image';
  if(ext==='pdf')return 'pdf';
  if(['md','mdx'].includes(ext))return 'markdown';
  if(['mmd','mermaid'].includes(ext))return 'mermaid';
  if(['drawio','dio'].includes(ext))return 'drawio';
  if(['csv','tsv'].includes(ext))return 'table';
  if(['xlsx','xls','ods'].includes(ext))return 'spreadsheet';
  if(['docx','doc','odt'].includes(ext))return 'document';
  if(['pptx','ppt','odp'].includes(ext))return 'presentation';
  if(data.preview&&data.preview.content!=null)return 'code';
  return 'unsupported';
}
function fileLanguage(data){
  const file=data.file||{};
  if(file.language)return file.language;
  const ext=extname(data.path);
  const byExt={js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',json:'json',jsonl:'json',css:'css',scss:'scss',html:'html',htm:'html',md:'markdown',mdx:'markdown',yaml:'yaml',yml:'yaml',toml:'toml',xml:'xml',py:'python',rb:'ruby',go:'go',rs:'rust',java:'java',c:'c',h:'c',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'cpp',sh:'shell',bash:'shell',zsh:'shell',sql:'sql',graphql:'graphql',gql:'graphql',dockerfile:'dockerfile',tf:'hcl',hcl:'hcl',dax:'msdax',pq:'powerquery',m:'powerquery',ini:'ini'};
  const name=basename(data.path).toLowerCase();
  if(name==='dockerfile')return 'dockerfile';
  if(name.startsWith('.env'))return 'plaintext';
  return byExt[ext]||'plaintext';
}
function languageSelect(current,path){
  const opts=LANGUAGES.map(([id,label])=>'<option value="'+esc(id)+'" '+(id===current?'selected':'')+'>'+esc(label)+'</option>').join('');
  return '<select class="file-action" data-language-select="'+esc(path)+'" title="Preview language">'+opts+'</select>';
}
function bindHeaderActions(path){
  document.querySelectorAll('[data-ask-file]').forEach(btn=>btn.addEventListener('click',()=>askAgentForFile(btn.dataset.askFile,btn.dataset.askKind)));
  document.querySelectorAll('[data-language-select]').forEach(sel=>sel.addEventListener('change',()=>{
    const data=fileCache.get(sel.dataset.languageSelect);
    if(data)renderCodeEditor(data,data.preview?.content||'',sel.value);
  }));
}
function askAgentForFile(path,kind){
  const prompt=document.getElementById('prompt');
  const label=kind==='image'?'Analyze this image':kind==='pdf'?'Summarize this PDF':kind==='spreadsheet'?'Inspect this spreadsheet':kind==='document'?'Inspect this document':kind==='presentation'?'Inspect this presentation':'Inspect this file';
  prompt.value=label+' at '+path+'. Explain what it contains and call the right local tools if needed.';
  prompt.focus();
}
function fileHeader(data,{language=null,truncated=false,extraActions=''}={}){
  const file=data.file||{};
  const kind=fileKind(data);
  const label=file.label||kind;
  const chips=[
    '<span class="file-chip">'+esc(label)+'</span>',
    file.size!=null?'<span class="file-chip">'+formatBytes(file.size)+'</span>':'',
    truncated?'<span class="file-chip warn">truncated preview</span>':''
  ].filter(Boolean).join('');
  const lang=language?languageSelect(language,data.path):'';
  return '<div class="file-header"><span>◇</span><span class="path">'+esc(data.path)+'</span>'+chips+'<span class="file-actions">'+lang+extraActions+'<button class="file-action" type="button" data-ask-file="'+esc(data.path)+'" data-ask-kind="'+esc(kind)+'">Ask agent</button><a class="file-action" href="'+rawUrl(data.path)+'" target="_blank" rel="noreferrer">Open</a></span></div>';
}
function renderViewer(html){
  disposeActiveEditor();
  document.getElementById('viewer').innerHTML=html;
}
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
    renderViewer('<div class="file-header"><span class="path">'+esc(path)+'</span></div><div class="empty">Loading...</div>');
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
  renderViewer('<div class="empty">Select a file.</div>');
}
function renderFile(data){
  currentPath=data.path;
  const text=data.preview&&data.preview.content!=null?data.preview.content:null;
  const kind=fileKind(data);
  if(kind==='image'){renderImage(data);return;}
  if(kind==='pdf'){renderPdf(data);return;}
  if(kind==='markdown'&&text!=null){renderMarkdownFile(data,text);return;}
  if(kind==='mermaid'&&text!=null){renderMermaidFile(data,text);return;}
  if(kind==='drawio'){renderDrawioFile(data,text);return;}
  if(kind==='table'&&text!=null){renderTableFile(data,text);return;}
  if(text!=null){
    const formatted=['json','jsonl'].includes(extname(data.path))?formatJson(text):text;
    renderCodeEditor(data,formatted,fileLanguage(data));
    return;
  }
  renderUnsupportedFile(data,kind);
}
function renderCodeEditor(data,text,language){
  const header=fileHeader(data,{language,truncated:Boolean(data.preview&&data.preview.truncated)});
  const hostId='monaco_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
  renderViewer(header+'<div class="monaco-host" id="'+hostId+'"></div>');
  bindHeaderActions(data.path);
  loadMonaco().then(monaco=>{
    const host=document.getElementById(hostId);
    if(!host)return;
    activeEditor=monaco.editor.create(host,{
      value:String(text||''),
      language:language||'plaintext',
      theme:'vs',
      readOnly:true,
      minimap:{enabled:false},
      fontSize:13,
      fontFamily:'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      lineNumbers:'on',
      scrollBeyondLastLine:false,
      wordWrap:'on',
      padding:{top:8},
      tabSize:2,
      renderWhitespace:'selection',
      bracketPairColorization:{enabled:true},
      automaticLayout:true,
      smoothScrolling:true
    });
  }).catch(err=>{
    addTrace('preview_editor_fallback',{path:data.path,message:err.message});
    const viewer=document.getElementById('viewer');
    if(viewer) viewer.innerHTML=header+'<div class="code-fallback">'+renderCode(text)+'</div>';
    bindHeaderActions(data.path);
  });
}
function renderCode(text){
  const lines=String(text||'').split('\\n');
  const nums=lines.map((_,i)=>i+1).join('\\n');
  return '<div class="code-wrap"><pre class="line-nums">'+nums+'</pre><pre class="code-pre">'+esc(text)+'</pre></div>';
}
function formatJson(text){try{return JSON.stringify(JSON.parse(text),null,2);}catch{return text;}}
function renderImage(data){
  activeImageScale=1;
  const header=fileHeader(data,{extraActions:'<button class="file-action" type="button" data-image-zoom="out">-</button><button class="file-action" type="button" data-image-zoom="reset">100%</button><button class="file-action" type="button" data-image-zoom="in">+</button>'});
  renderViewer(header+'<div class="image-stage"><div class="image-toolbar"><span class="file-chip" id="imageScale">100%</span></div><div class="image-preview"><img id="imagePreview" src="'+rawUrl(data.path)+'" alt="'+esc(data.path)+'"></div></div>');
  bindHeaderActions(data.path);
  document.querySelectorAll('[data-image-zoom]').forEach(btn=>btn.addEventListener('click',()=>{
    const action=btn.dataset.imageZoom;
    if(action==='in')activeImageScale=Math.min(5,activeImageScale+.25);
    else if(action==='out')activeImageScale=Math.max(.25,activeImageScale-.25);
    else activeImageScale=1;
    const img=document.getElementById('imagePreview');
    const scale=document.getElementById('imageScale');
    if(img)img.style.transform='scale('+activeImageScale+')';
    if(scale)scale.textContent=Math.round(activeImageScale*100)+'%';
  }));
}
function renderPdf(data){
  const header=fileHeader(data);
  renderViewer(header+'<div class="frame-preview"><iframe src="'+rawUrl(data.path)+'" title="'+esc(data.path)+'"></iframe></div>');
  bindHeaderActions(data.path);
}
function renderMarkdownFile(data,text){
  const header=fileHeader(data,{language:'markdown',truncated:Boolean(data.preview&&data.preview.truncated)});
  renderViewer(header+'<div class="markdown-preview">'+markdown(text)+'</div>');
  bindHeaderActions(data.path);
  renderMermaidBlocks();
}
function renderMermaidFile(data,text){
  const header=fileHeader(data,{language:'markdown',truncated:Boolean(data.preview&&data.preview.truncated)});
  renderViewer(header+'<div class="diagram-preview">'+mermaidCard(text)+'</div>');
  bindHeaderActions(data.path);
  renderMermaidBlocks();
}
function renderDrawioFile(data,text){
  const pages=countDrawioPages(text);
  const title=pages>0?'Draw.io diagram with '+pages+' page'+(pages===1?'':'s'):'Draw.io diagram';
  const body=text?renderCode(text):'<div class="viewer-note"><div class="viewer-note-card"><div class="viewer-note-title">'+title+'</div><div class="viewer-note-body">This diagram file is available to the local agent, but the browser renderer is not bundled yet. Use Ask agent to inspect or convert it.</div></div></div>';
  const header=fileHeader(data,{language:text?'xml':null,truncated:Boolean(data.preview&&data.preview.truncated)});
  renderViewer(header+(text?'<div class="diagram-preview"><div class="viewer-note-card"><div class="viewer-note-title">'+title+'</div><div class="viewer-note-body">Source preview shown for now. A bundled Draw.io renderer can be added without exposing raw binary content.</div></div>'+body+'</div>':body));
  bindHeaderActions(data.path);
}
function countDrawioPages(text){
  const value=String(text||'');
  const matches=value.match(/<diagram\\b/g);
  return matches?matches.length:0;
}
function renderTableFile(data,text){
  const ext=extname(data.path);
  const header=fileHeader(data,{language:ext==='csv'?'plaintext':'plaintext',truncated:Boolean(data.preview&&data.preview.truncated)});
  renderViewer(header+renderTable(text,ext==='tsv'?'\\t':','));
  bindHeaderActions(data.path);
}
function renderUnsupportedFile(data,kind){
  const file=data.file||{};
  const title={
    spreadsheet:'Spreadsheet preview',
    document:'Document preview',
    presentation:'Presentation preview',
    unsupported:'Preview unavailable'
  }[kind]||'Preview unavailable';
  const body={
    spreadsheet:'The local agent can inspect sheets, formulas, and tables. A formatted grid renderer is the next viewer to add.',
    document:'The local agent can read or convert this document locally. A formatted DOCX/PDF conversion preview is the next viewer to add.',
    presentation:'The local agent can inspect slides and embedded media. A formatted slide preview is the next viewer to add.',
    unsupported:'This file type is not rendered in the browser yet. It is still available to the local agent and CLI tools.'
  }[kind]||'This file type is not rendered in the browser yet.';
  const header=fileHeader(data);
  renderViewer(header+'<div class="viewer-note"><div class="viewer-note-card"><div class="viewer-note-title">'+esc(title)+'</div><div class="viewer-note-body">'+esc(body)+'<br><br>'+esc(file.label||kind)+' · '+(file.size!=null?esc(formatBytes(file.size)):'unknown size')+'</div><div class="viewer-note-actions"><button class="file-action" type="button" data-ask-file="'+esc(data.path)+'" data-ask-kind="'+esc(kind)+'">Ask agent to inspect</button></div></div></div>');
  bindHeaderActions(data.path);
}
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
  return '<div class="table-preview"><div class="table-meta">'+esc(rows.length-1)+' rows shown, '+esc(head.length)+' columns</div><table><thead><tr>'+head.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+body.map(r=>'<tr>'+head.map((_,i)=>'<td>'+esc(r[i]||'')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}
function markdown(text){
  const lines=String(text||'').split('\\n');
  let out='';let inUl=false;let inPre=false;let preLang='';let preLines=[];
  const fence=String.fromCharCode(96,96,96);
  for(const raw of lines){const line=String(raw).trimEnd();
    if(line.startsWith(fence)){
      if(inUl){out+='</ul>';inUl=false;}
      if(inPre){
        const code=preLines.join('\\n');
        out+=preLang==='mermaid'?mermaidCard(code):'<pre><code>'+esc(code)+'</code></pre>';
        inPre=false;preLang='';preLines=[];
      }else{
        preLang=line.slice(fence.length).trim().toLowerCase();
        inPre=true;preLines=[];
      }
      continue;
    }
    if(inPre){preLines.push(line);continue;}
    if(!line.trim()){if(inUl){out+='</ul>';inUl=false;}continue;}
    const h=line.match(/^(#{1,3})\\s+(.*)$/);if(h){if(inUl){out+='</ul>';inUl=false;}out+='<h'+h[1].length+'>'+inlineMd(h[2])+'</h'+h[1].length+'>';continue;}
    const li=line.match(/^[-*]\\s+(.*)$/);if(li){if(!inUl){out+='<ul>';inUl=true;}out+='<li>'+inlineMd(li[1])+'</li>';continue;}
    if(inUl){out+='</ul>';inUl=false;}out+='<p>'+inlineMd(line)+'</p>';
  }
  if(inUl)out+='</ul>';if(inPre)out+='<pre><code>'+esc(preLines.join('\\n'))+'</code></pre>';return out;
}
function inlineMd(s){const tick=String.fromCharCode(96);return s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(new RegExp(tick+'([^'+tick+']+)'+tick,'g'),'<code>$1</code>');}
function mermaidCard(source){
  return '<div class="mermaid-card" data-mermaid-card><div class="mermaid-output" data-mermaid-output>Rendering diagram...</div><pre class="mermaid-source">'+esc(source)+'</pre></div>';
}
async function renderMermaidBlocks(){
  const cards=[...document.querySelectorAll('[data-mermaid-card]')];
  if(!cards.length)return;
  try{
    const mermaid=await loadMermaid();
    for(const card of cards){
      const source=card.querySelector('.mermaid-source')?.textContent||'';
      const output=card.querySelector('[data-mermaid-output]');
      if(!output||!source.trim())continue;
      mermaidSeq+=1;
      const result=await mermaid.render('bahulam_mermaid_'+mermaidSeq,source);
      output.innerHTML=result.svg;
      result.bindFunctions?.(output);
    }
  }catch(err){
    for(const card of cards){
      const output=card.querySelector('[data-mermaid-output]');
      if(output)output.innerHTML='<span class="error">Mermaid preview failed: '+esc(err.message||err)+'</span>';
    }
  }
}
function addTrace(type, detail){
  const el = document.createElement('div');
  el.className = 'trace-row';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
  el.innerHTML = '<b>' + esc(type) + '</b> ' + esc(text || '');
  const events = document.getElementById('events');
  events.appendChild(el);
  events.scrollTop = events.scrollHeight;
  traceCount += 1;
  const traceTab=document.getElementById('traceTab');
  if(traceTab) traceTab.textContent='Trace ' + traceCount;
}
function resetThread(emptyText='Ask about this local workspace.'){
  activeTurn=null;
  document.getElementById('threadInner').innerHTML='<div class="empty-chat" id="emptyChat">'+esc(emptyText)+'</div>';
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
function renderHistorySnapshot(history){
  resetThread(history.backend_session_id ? 'No chat messages in this transcript yet.' : 'Ask about this local workspace.');
  const messages=Array.isArray(history.messages)?history.messages:[];
  const trace=Array.isArray(history.trace)?history.trace:[];
  if(history.backend_session_id){
    document.getElementById('bridgeState').textContent='resumed';
    document.getElementById('sendStatus').textContent='Resumed '+compactId(history.backend_session_id);
    setSessionButtonLabel('Chat: '+compactId(history.backend_session_id));
  } else {
    document.getElementById('bridgeState').textContent='new session';
    document.getElementById('sendStatus').textContent='';
    setSessionButtonLabel('Chat: New');
  }
  for(const item of trace){
    addTrace(item.type || 'history_tool', {tool:item.tool, kind:item.kind, content:item.content});
  }
  for(const msg of messages){
    if(msg.role==='user')addUserMessage(msg.content||'');
    else if(msg.role==='assistant')addAssistantMessage(msg.content||'');
  }
  scrollThread();
  setAgentTab('chat');
}
function setSessionButtonLabel(label){
  const button=document.getElementById('sessionMenuButton');
  if(button) button.textContent=label;
}
function setSessionMenuOpen(open){
  sessionMenuOpen=!!open;
  const modal=document.getElementById('sessionModal');
  const button=document.getElementById('sessionMenuButton');
  if(modal) modal.hidden=!sessionMenuOpen;
  if(button) button.setAttribute('aria-expanded', String(sessionMenuOpen));
  if(sessionMenuOpen){
    const first=document.querySelector('#sessionMenu button');
    if(first) first.focus();
  } else if(document.activeElement && modal && modal.contains(document.activeElement)) {
    button?.focus();
  }
}
function setApprovalModalOpen(open){
  const modal=document.getElementById('approvalModal');
  if(modal) modal.hidden=!open;
}
function showApprovalModal(data){
  pendingApproval=data||null;
  if(!pendingApproval)return;
  const prompt=pendingApproval.prompt||{};
  document.getElementById('approvalTitle').textContent=prompt.title||('Approval · '+(pendingApproval.tool||'tool'));
  document.getElementById('approvalSubtitle').textContent=(pendingApproval.tier||pendingApproval.risk||'approval') + ' · ' + (pendingApproval.approval_id||'');
  document.getElementById('approvalSubject').textContent=prompt.subject || pendingApproval.tool || 'Tool request';
  document.getElementById('approvalReason').textContent=prompt.reason || pendingApproval.reason || '';
  const options=Array.isArray(pendingApproval.options)&&pendingApproval.options.length
    ? pendingApproval.options
    : [{label:'approve once',value:'approve',hint:'run this call'},{label:'cancel',value:'reject',hint:'do not run'}];
  const actions=document.getElementById('approvalActions');
  actions.innerHTML=options.map(option=>{
    const danger=option.value==='reject'?' danger':'';
    const primary=option.value==='approve'?' primary-action':'';
    const hint=option.hint?' title="'+esc(option.hint)+'"':'';
    return '<button class="icon-button'+danger+primary+'" type="button" data-approval-decision="'+esc(option.value)+'"'+hint+'>'+esc(option.label)+'</button>';
  }).join('');
  actions.querySelectorAll('[data-approval-decision]').forEach(btn=>btn.addEventListener('click',()=>submitApproval(btn.dataset.approvalDecision)));
  setAgentTab('trace');
  setApprovalModalOpen(true);
  const first=actions.querySelector('[data-approval-decision]');
  if(first) first.focus();
}
async function submitApproval(decision){
  if(!pendingApproval?.approval_id)return;
  const approval=pendingApproval;
  try {
    await api('/api/approvals/'+encodeURIComponent(approval.approval_id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision})});
    addTrace('approval_decision', {approval_id:approval.approval_id, decision});
  } catch (err) {
    addTrace('approval_error', {approval_id:approval.approval_id, message:err.message});
  } finally {
    pendingApproval=null;
    setApprovalModalOpen(false);
  }
}
function renderSessionMenu(sessions){
  historySessions=Array.isArray(sessions)?sessions:[];
  const menu=document.getElementById('sessionMenu');
  if(!menu)return;
  const rows=historySessions.slice(0,8).map(s=>{
    const tools=(Array.isArray(s.tools)?s.tools:[]).map(t=>'<span class="session-chip">'+esc(t)+'</span>').join('');
    const prompt=s.first_prompt || 'Untitled session';
    const meta=[formatSessionTime(s.last_activity_at||s.started_at), (s.user_messages||0)+' user', (s.assistant_messages||0)+' assistant', s.status||'unknown', compactId(s.session_id)].filter(Boolean).join(' · ');
    return '<div class="session-row"><div class="session-main"><div class="session-prompt">'+esc(prompt)+'</div><div class="session-meta">'+esc(meta)+'</div>'+(tools?'<div class="session-tools">'+tools+'</div>':'')+'</div><button class="icon-button" type="button" data-resume-session="'+esc(s.session_id)+'">Resume</button></div>';
  }).join('');
  const empty=historySessions.length?'':'<div class="session-menu-empty">No previous sessions for this folder.</div>';
  menu.innerHTML='<div class="session-list"><div class="session-row"><div class="session-main"><div class="session-prompt">New chat</div><div class="session-meta">Start without loading prior folder history</div></div><button class="icon-button" type="button" id="newHistorySession">Start</button></div>'+empty+rows+'</div>';
  menu.querySelector('#newHistorySession').addEventListener('click',startNewChat);
  menu.querySelectorAll('[data-resume-session]').forEach(btn=>btn.addEventListener('click',()=>resumeChat(btn.dataset.resumeSession)));
  if(historySessions.length){
    document.getElementById('bridgeState').textContent='choose session';
    setSessionButtonLabel('Chat: Choose '+historySessions.length);
  } else {
    document.getElementById('bridgeState').textContent='new session';
    setSessionButtonLabel('Chat: New');
  }
  historySelectionReady=true;
  setSessionMenuOpen(true);
}
async function loadSessionChoices(){
  try {
    const result=await api('/api/chat/sessions');
    renderSessionMenu(result.sessions || []);
  } catch (err) {
    addTrace('history_error', {message:err.message});
    historySelectionReady=true;
  }
}
async function resumeChat(sessionId){
  if(!sessionId)return;
  document.getElementById('sendStatus').textContent='Resuming...';
  try {
    const history=await api('/api/chat/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sessionId})});
    setSessionMenuOpen(false);
    renderHistorySnapshot(history);
  } catch (err) {
    document.getElementById('sendStatus').textContent=err.message;
    addTrace('history_error', {message:err.message, session_id:sessionId});
  }
}
async function startNewChat(){
  document.getElementById('sendStatus').textContent='Starting new chat...';
  try {
    const history=await api('/api/chat/new',{method:'POST'});
    setSessionMenuOpen(false);
    renderHistorySnapshot(history);
  } catch (err) {
    document.getElementById('sendStatus').textContent=err.message;
    addTrace('history_error', {message:err.message});
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
function setAgentTab(tab){
  const next=tab==='trace'?'trace':'chat';
  document.getElementById('chatPane')?.classList.toggle('active', next==='chat');
  document.getElementById('tracePane')?.classList.toggle('active', next==='trace');
  document.querySelectorAll('[data-agent-tab]').forEach(btn=>{
    const active=btn.dataset.agentTab===next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}
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
  if (type === 'agent_history_loaded') {
    document.getElementById('bridgeState').textContent = 'resumed';
    if(data.backend_session_id) setSessionButtonLabel('Chat: '+compactId(data.backend_session_id));
    return;
  }
  if (type === 'agent_history_new') {
    document.getElementById('bridgeState').textContent = 'new session';
    setSessionButtonLabel('Chat: New');
    return;
  }
  if (type === 'agent_approval_required') {
    document.getElementById('bridgeState').textContent = 'approval required';
    showApprovalModal(data);
    return;
  }
  if (type === 'agent_approval_resolved') {
    if(pendingApproval?.approval_id===data.approval_id){
      pendingApproval=null;
      setApprovalModalOpen(false);
    }
    document.getElementById('bridgeState').textContent = data.approved ? 'running' : 'approval denied';
    return;
  }
  if (type === 'agent_session') {
    if(data.session_id) setSessionButtonLabel('Chat: '+compactId(data.session_id));
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
  'agent_history_loaded','agent_history_new','agent_approval_required','agent_approval_resolved','agent_session','agent_status','agent_reasoning','agent_content','agent_tool_call',
  'agent_tool_result','agent_activity','agent_complete','agent_error','agent_event'
].forEach(type => {
  es.addEventListener(type, evt => { try { handleRelayEvent(type, JSON.parse(evt.data)); } catch {} });
});
document.getElementById('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;
  setSessionMenuOpen(false);
  if(!historySelectionReady) historySelectionReady=true;
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
document.querySelectorAll('[data-agent-tab]').forEach(btn=>btn.addEventListener('click',()=>setAgentTab(btn.dataset.agentTab)));
document.getElementById('sessionMenuButton').addEventListener('click',(e)=>{e.stopPropagation();setSessionMenuOpen(!sessionMenuOpen);});
document.getElementById('sessionModalClose').addEventListener('click',()=>setSessionMenuOpen(false));
document.getElementById('sessionModal').addEventListener('click',(e)=>{if(e.target.id==='sessionModal')setSessionMenuOpen(false);});
document.getElementById('approvalDenyTop').addEventListener('click',()=>submitApproval('reject'));
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'&&pendingApproval){submitApproval('reject');return;}if(e.key==='Escape'&&sessionMenuOpen)setSessionMenuOpen(false);});
document.getElementById('refreshFiles').addEventListener('click',()=>{dirCache.clear();loadDir('.');});
document.getElementById('toggleExplorer').addEventListener('click',()=>{let prefs={explorerVisible:true};try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}saveLayoutPatch({explorerVisible:!prefs.explorerVisible});});
document.getElementById('toggleAgent').addEventListener('click',()=>{let prefs={agentVisible:true};try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}saveLayoutPatch({agentVisible:!prefs.agentVisible});});
applyLayout();
setupResizers();
renderTabs();
renderEmptyViewer();
loadSessionChoices();
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
