/**
 * Bahulam local service.
 *
 * Localhost-only HTTP surface for browser workspaces. This module intentionally
 * does not depend on the terminal REPL daemon.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BahulamAuth } from '../auth/bahulam-auth.mjs';
import { resolveWebUrl } from '../core/backend-url.mjs';
import { LocalAgentRelay } from './agent-relay.mjs';
import {
  DEFAULT_MAX_RAW_BYTES,
  contentTypeForPath,
  listWorkspacePath,
  readWorkspaceFile,
  resolveWorkspacePath,
} from './file-access.mjs';
import {
  createOfficePdfPreview,
  createSpreadsheetPreview,
  resolvePreviewCacheFile,
} from './preview-converters.mjs';
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

const LOCAL_UPLOAD_DIR = 'bahulam-uploads';
const DEFAULT_MAX_UPLOAD_FILES = 20;
const DEFAULT_MAX_UPLOAD_FILE_BYTES = DEFAULT_MAX_RAW_BYTES;
const DEFAULT_MAX_UPLOAD_BODY_BYTES = 140 * 1024 * 1024;
const DEFAULT_MAX_SAVE_BYTES = 2 * 1024 * 1024;

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

  if (req.method === 'GET' && url.pathname.startsWith('/vendor/katex/')) {
    sendPackageAsset({
      res,
      root: fileURLToPath(new URL('../../node_modules/katex/dist/', import.meta.url)),
      pathname: url.pathname,
      prefix: '/vendor/katex/',
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

  if (req.method === 'GET' && url.pathname === '/api/approvals/mode') {
    const relay = getAgentRelay(session);
    sendJson(res, 200, relay.approvalMode());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/approvals/mode') {
    const body = await readJsonBody(req);
    const relay = getAgentRelay(session);
    const result = relay.setApprovalAutoMode(Boolean(body.auto ?? body.enabled));
    sendJson(res, 200, result);
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

  if (req.method === 'POST' && url.pathname === '/api/files/upload') {
    const body = await readJsonBody(req, envInt('BAHULAM_LOCAL_UPLOAD_MAX_BODY_BYTES', DEFAULT_MAX_UPLOAD_BODY_BYTES));
    const result = saveUploadedFiles(session, body);
    emit('file_uploaded', {
      count: result.files.length,
      directory: result.directory,
      files: result.files.map((file) => ({
        name: file.name,
        path: file.path,
        size: file.size,
        viewer: file.viewer,
        kind: file.kind,
      })),
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/file/save') {
    const body = await readJsonBody(req, envInt('BAHULAM_LOCAL_SAVE_MAX_BODY_BYTES', DEFAULT_MAX_SAVE_BYTES + 64 * 1024));
    const result = saveWorkspaceTextFile(session, body);
    emit('file_saved', {
      path: result.path,
      size: result.file?.size ?? null,
      viewer: result.file?.viewer ?? null,
      kind: result.file?.kind ?? null,
    });
    sendJson(res, 200, result);
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

  if (req.method === 'GET' && url.pathname === '/api/file/spreadsheet-preview') {
    const requestedPath = url.searchParams.get('path') || session.focus_path;
    if (!requestedPath) {
      const err = new Error('path is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    const preview = createSpreadsheetPreview(session, requestedPath);
    emit('file_previewed', { path: requestedPath, viewer: 'spreadsheet', sheets: preview.sheet_count });
    sendJson(res, 200, preview);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/file/office-preview') {
    const requestedPath = url.searchParams.get('path') || session.focus_path;
    if (!requestedPath) {
      const err = new Error('path is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    const preview = createOfficePdfPreview(session, requestedPath);
    if (preview.ok) {
      preview.preview_url = `/api/preview-cache/${encodeURIComponent(preview.cache_id)}/${encodeURIComponent(preview.file_name)}?token=${encodeURIComponent(token)}`;
    }
    emit('file_previewed', { path: requestedPath, viewer: 'office_pdf', ok: preview.ok, code: preview.code || null });
    sendJson(res, 200, preview);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/preview-cache/')) {
    const cachePath = decodeURIComponent(url.pathname.slice('/api/preview-cache/'.length));
    const asset = resolvePreviewCacheFile(session, cachePath);
    res.writeHead(200, {
      'Content-Type': contentTypeForPath(asset.path),
      'Content-Length': asset.stat.size,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(asset.path).pipe(res);
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
        attachments: body.attachments || [],
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

  if (req.method === 'POST' && url.pathname === '/api/agent/followup') {
    const body = await readJsonBody(req);
    const instruction = String(body.prompt || body.instruction || '').slice(0, 500);
    emit('agent_followup_requested', { instruction });
    const relay = getAgentRelay(session);
    const result = await relay.sendFollowup({ instruction: body.prompt || body.instruction });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/cancel') {
    const body = await readJsonBody(req);
    const relay = getAgentRelay(session);
    const result = await relay.cancelTurn(body.reason || 'Cancelled by user');
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/execute') {
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim();
    const args = body.args || {};
    if (!name) {
      sendJson(res, 400, { ok: false, error: 'tool name is required' });
      return;
    }
    emit('tool_execution_requested', { name });
    try {
      const relay = getAgentRelay(session);
      const result = await relay.executeTool(name, args);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
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

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function saveWorkspaceTextFile(session, body = {}) {
  const requestedPath = String(body.path || '').trim();
  const content = body.content;
  if (!requestedPath) {
    const err = new Error('path is required');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (typeof content !== 'string') {
    const err = new Error('content must be a string');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const before = listWorkspacePath(session, requestedPath);
  if (before.type !== 'file') {
    const err = new Error('Requested path is not a file');
    err.code = 'NOT_FILE';
    throw err;
  }
  if (!before.file?.text_like || !before.preview) {
    const err = new Error('Only text-backed files can be edited in the browser preview');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (before.preview.truncated) {
    const err = new Error('Large truncated previews are read-only in the browser');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > envInt('BAHULAM_LOCAL_SAVE_MAX_BYTES', DEFAULT_MAX_SAVE_BYTES)) {
    const err = new Error(`Saved content exceeds ${envInt('BAHULAM_LOCAL_SAVE_MAX_BYTES', DEFAULT_MAX_SAVE_BYTES)} bytes`);
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  const target = resolveWorkspacePath(session, requestedPath);
  fs.writeFileSync(target, content, 'utf8');
  return listWorkspacePath(session, requestedPath);
}

function saveUploadedFiles(session, body = {}) {
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) {
    const err = new Error('files[] is required');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (files.length > DEFAULT_MAX_UPLOAD_FILES) {
    const err = new Error(`Too many files; max is ${DEFAULT_MAX_UPLOAD_FILES}`);
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const root = fs.realpathSync(session.root_path);
  const group = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const directory = path.posix.join(LOCAL_UPLOAD_DIR, safePathSegment(session.id), group);
  const uploadDir = path.join(root, ...directory.split('/'));
  fs.mkdirSync(uploadDir, { recursive: true });

  const uploaded = files.map((file, index) => {
    const name = safeFileName(file?.name || `upload-${index + 1}.bin`);
    const encoded = normalizeBase64Payload(file?.data_base64 || file?.base64 || '');
    if (!encoded) {
      const err = new Error(`Uploaded file ${name} is empty or missing data_base64`);
      err.code = 'BAD_REQUEST';
      throw err;
    }
    let bytes;
    try {
      bytes = Buffer.from(encoded, 'base64');
    } catch {
      const err = new Error(`Uploaded file ${name} is not valid base64`);
      err.code = 'BAD_REQUEST';
      throw err;
    }
    if (!bytes.length) {
      const err = new Error(`Uploaded file ${name} is empty`);
      err.code = 'BAD_REQUEST';
      throw err;
    }
    if (bytes.length > DEFAULT_MAX_UPLOAD_FILE_BYTES) {
      const err = new Error(`Uploaded file ${name} exceeds ${DEFAULT_MAX_UPLOAD_FILE_BYTES} bytes`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }

    const target = uniqueUploadTarget(uploadDir, name);
    fs.writeFileSync(target, bytes);
    const rel = path.relative(root, target).split(path.sep).join('/');
    const listing = listWorkspacePath(session, rel);
    return {
      ...listing.file,
      mime_type: file?.mime_type || file?.type || contentTypeForPath(target),
      upload_path: listing.path,
      uploaded: true,
    };
  });

  return {
    ok: true,
    directory,
    files: uploaded,
  };
}

function normalizeBase64Payload(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const comma = raw.indexOf(',');
  return raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw;
}

function safePathSegment(value) {
  return String(value || 'session').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function safeFileName(value) {
  const base = path.basename(String(value || 'upload.bin')).replace(/[\u0000-\u001f\u007f]/g, '');
  const safe = base.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._() -]+/g, '_').trim();
  if (!safe || safe === '.' || safe === '..') return 'upload.bin';
  return safe.length > 180 ? `${safe.slice(0, 120)}${path.extname(safe).slice(0, 40)}` : safe;
}

function uniqueUploadTarget(uploadDir, fileName) {
  const parsed = path.parse(fileName);
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? '' : `-${i + 1}`;
    const candidate = path.join(uploadDir, `${parsed.name}${suffix}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(uploadDir, `${parsed.name}-${crypto.randomBytes(4).toString('hex')}${parsed.ext}`);
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
    const credentials = new BahulamAuth().loadCredentials();
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
.auto-toggle{height:26px;display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(27,27,27,.10);border-radius:999px;background:#fff;padding:0 8px 0 6px;color:rgba(27,27,27,.55);font-size:11px;font-weight:650;cursor:pointer;white-space:nowrap}.auto-toggle:hover{background:#F7F5EF;color:rgba(27,27,27,.76)}.auto-toggle input{position:absolute;opacity:0;pointer-events:none}.toggle-track{width:28px;height:16px;border-radius:999px;background:#D6D3CB;position:relative;transition:background .15s ease}.toggle-track:before{content:"";position:absolute;width:12px;height:12px;border-radius:999px;left:2px;top:2px;background:#fff;box-shadow:0 1px 2px rgba(27,27,27,.25);transition:transform .15s ease}.auto-toggle input:checked+.toggle-track{background:#0891B2}.auto-toggle input:checked+.toggle-track:before{transform:translateX(12px)}.auto-toggle input:focus-visible+.toggle-track{outline:2px solid rgba(8,145,178,.35);outline-offset:2px}
.menubar{height:28px;display:flex;align-items:center;gap:2px;border-bottom:1px solid rgba(27,27,27,.06);background:#F7F5EF;padding:0 12px;flex:0 0 auto;user-select:none;position:relative;z-index:20}.menu-item{height:22px;border:0;background:transparent;border-radius:5px;padding:0 8px;color:rgba(27,27,27,.58);font-size:12px;cursor:pointer}.menu-item:hover{background:var(--ws-hover);color:rgba(27,27,27,.86)}.menubar-spacer{flex:1}.session-menu-wrap{display:flex;align-items:center}.session-menu-button{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-modal-backdrop,.approval-modal-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-start;justify-content:center;background:rgba(27,27,27,.28);padding:92px 16px 24px}.approval-modal-backdrop{z-index:90;background:rgba(27,27,27,.36)}.session-modal-backdrop[hidden],.approval-modal-backdrop[hidden]{display:none}.session-dialog,.approval-dialog{width:min(620px,100%);max-height:min(620px,calc(100vh - 128px));display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(27,27,27,.12);border-radius:8px;background:#FFFDF7;box-shadow:0 24px 70px rgba(27,27,27,.22)}.approval-dialog{width:min(680px,100%)}.session-dialog-head,.approval-dialog-head{height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--ws-border-subtle);padding:0 12px}.session-dialog-title,.approval-dialog-title{font-size:13px;font-weight:750;color:rgba(27,27,27,.80)}.session-dialog-subtitle,.approval-dialog-subtitle{margin-top:1px;font:10px var(--mono);color:rgba(27,27,27,.38);max-width:560px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-menu{display:block;overflow:auto;padding:6px}.session-menu-empty{padding:10px;color:rgba(27,27,27,.42);font-size:12px}.approval-body{padding:12px;overflow:auto}.approval-subject{border:1px solid var(--ws-border);border-radius:7px;background:#fff;padding:10px;font:12px/1.45 var(--mono);color:rgba(27,27,27,.72);white-space:pre-wrap;overflow-wrap:anywhere}.approval-reason{margin-top:10px;color:rgba(27,27,27,.58);font-size:12px;line-height:1.5}.approval-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid var(--ws-border-subtle);padding:10px 12px;background:#F7F5EF}.approval-actions .danger{border-color:rgba(185,28,28,.24);color:#B91C1C}.approval-actions .primary-action{background:#1B1B1B;color:#FFFDF7;border-color:#1B1B1B}.approval-inline{width:100%;max-width:960px;border:1px solid rgba(217,119,6,.22);border-radius:10px;background:#FFFBEB;overflow:hidden;box-shadow:0 8px 24px rgba(146,64,14,.08)}.approval-inline.done{border-color:rgba(27,27,27,.08);background:#F7F5EF;box-shadow:none}.approval-inline-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border-bottom:1px solid rgba(217,119,6,.14)}.approval-inline-title{font-size:12px;font-weight:800;color:#92400E}.approval-inline-meta{font:10px var(--mono);color:rgba(146,64,14,.62);white-space:nowrap}.approval-inline-subject{margin:10px 11px 0;border:1px solid rgba(217,119,6,.18);border-radius:7px;background:#fff;padding:9px;font:11px/1.45 var(--mono);color:rgba(27,27,27,.74);white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}.approval-inline-reason{padding:8px 11px 10px;color:rgba(27,27,27,.58);font-size:12px;line-height:1.45}.approval-inline-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:9px 11px;border-top:1px solid rgba(217,119,6,.12);background:rgba(255,255,255,.58)}
main{--left-w:256px;--right-w:480px;display:grid;grid-template-columns:var(--left-w) 6px minmax(360px,1fr) 6px var(--right-w);flex:1;min-height:0}.panel{min-width:0;background:var(--ws-panel);overflow:hidden}.files{background:rgba(255,255,255,.52)}.work{display:flex;flex-direction:column;background:#fff}.agent{background:rgba(255,255,255,.58);display:flex;flex-direction:column}.resizer{background:transparent;border-left:1px solid var(--ws-border-subtle);border-right:1px solid transparent;cursor:col-resize;position:relative}.resizer:hover,.resizer.dragging{background:rgba(8,145,178,.08);border-left-color:rgba(8,145,178,.25)}
main.hide-files{grid-template-columns:0 0 minmax(360px,1fr) 6px var(--right-w)}main.hide-files .files,main.hide-files .left-resizer{display:none}main.hide-agent{grid-template-columns:var(--left-w) 6px minmax(360px,1fr) 0 0}main.hide-agent .agent,main.hide-agent .right-resizer{display:none}
.section-head{height:36px;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:var(--ws-faint);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;background:rgba(255,255,255,.45)}.section-actions{display:flex;align-items:center;gap:4px}.section-button{height:20px;border:0;background:transparent;border-radius:5px;color:rgba(27,27,27,.35);cursor:pointer;padding:0 4px}.section-button:hover{background:var(--ws-hover);color:rgba(27,27,27,.70)}
.file-list{padding:6px;overflow:auto;height:calc(100% - 36px)}.row{display:flex;align-items:center;gap:5px;width:100%;height:27px;border:0;background:transparent;text-align:left;border-radius:6px;padding:0 8px;color:rgba(27,27,27,.62);cursor:pointer;font-size:12px;line-height:1}.row:hover{background:var(--ws-hover);color:rgba(27,27,27,.84)}.row.selected{background:var(--ws-active);color:var(--ws-foreground)}.row:focus-visible{outline:2px solid rgba(8,145,178,.35);outline-offset:1px}.chev{width:12px;text-align:center;color:rgba(27,27,27,.32);font:11px var(--mono)}.icon{width:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--ws-faint);font-size:11px;font-family:var(--mono)}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sub{color:rgba(27,27,27,.28);font:10px var(--mono);margin-left:auto}.loading-row{height:24px;padding-left:32px;color:rgba(27,27,27,.30);font:11px var(--mono)}
.tabbar{height:36px;display:flex;align-items:center;border-bottom:1px solid var(--ws-border-subtle);background:var(--ws-tab);flex:0 0 auto;overflow-x:auto}.tab{height:100%;display:flex;align-items:center;gap:7px;border:0;border-right:1px solid var(--ws-border-subtle);padding:0 9px;background:transparent;color:rgba(27,27,27,.45);font-size:11px;cursor:pointer;max-width:220px;min-width:90px}.tab.active{background:#fff;color:var(--ws-foreground);box-shadow:inset 0 -1.5px 0 var(--ws-foreground)}.tab:hover{background:rgba(27,27,27,.03);color:rgba(27,27,27,.75)}.tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tab-close{border:0;background:transparent;border-radius:4px;color:rgba(27,27,27,.28);cursor:pointer;padding:0 2px}.tab-close:hover{background:rgba(27,27,27,.07);color:rgba(27,27,27,.70)}.tab-muted{flex:1;height:100%;border-left:1px solid var(--ws-border-subtle);min-width:24px}
.viewer{flex:1;min-height:0;overflow:hidden;background:#fff;display:flex;flex-direction:column}.file-header{min-height:34px;flex:0 0 auto;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 12px;background:rgba(27,27,27,.015);font:12px var(--mono);color:rgba(27,27,27,.50)}.path{min-width:120px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(27,27,27,.08);border-radius:999px;background:#fff;padding:1px 7px;font:10px var(--sans);color:rgba(27,27,27,.48);white-space:nowrap}.file-chip.warn{border-color:#FDE68A;background:#FFFBEB;color:#92400E}.file-actions{margin-left:auto;display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}.file-action{font:11px var(--sans);color:rgba(27,27,27,.50);text-decoration:none;border:1px solid var(--ws-border);border-radius:6px;padding:2px 7px;background:#fff;cursor:pointer}.file-action:hover{color:var(--ws-foreground);background:var(--ws-surface)}.file-icon-action{width:24px;height:24px;min-width:24px;padding:0;display:inline-flex;align-items:center;justify-content:center}.file-icon-action svg{width:13px;height:13px;display:block}select.file-action{height:23px;max-width:190px;padding:1px 24px 1px 7px}.empty{color:var(--ws-faint);padding:24px;font-size:12px}.error{color:var(--ws-error)}
.monaco-host{flex:1;min-height:0}.code-fallback{flex:1;min-height:0;overflow:auto}.code-wrap{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;min-height:100%;font:12px/1.55 var(--mono)}.line-nums{user-select:none;text-align:right;padding:14px 10px 14px 14px;color:rgba(27,27,27,.25);background:#FAF9F5;border-right:1px solid var(--ws-border-subtle);white-space:pre}.code-pre{margin:0;padding:14px;white-space:pre;overflow:auto;color:#1F2937;background:#fff;min-height:100%}.markdown-preview{flex:1;min-height:0;overflow:auto;max-width:920px;padding:24px 28px;color:rgba(27,27,27,.86);font-size:14px;line-height:1.65}.markdown-preview h1,.markdown-preview h2,.markdown-preview h3{line-height:1.2;margin:18px 0 8px}.markdown-preview p{margin:0 0 12px}.markdown-preview code,.message-content code{font-family:var(--mono);font-size:.92em;background:rgba(27,27,27,.06);border-radius:4px;padding:1px 4px}.markdown-preview pre,.message-content pre{overflow:auto;background:#0D1117;color:#E5E7EB;border-radius:7px;padding:12px}.image-stage{flex:1;min-height:0;display:flex;flex-direction:column;background:#F8F7F2}.image-toolbar{height:34px;flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:0 10px;border-bottom:1px solid var(--ws-border-subtle);background:#fff}.image-preview{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto}.image-preview img{max-width:100%;max-height:100%;object-fit:contain;border:1px solid var(--ws-border);background:#fff;box-shadow:0 10px 30px rgba(27,27,27,.10);transform-origin:center center}.frame-preview{flex:1;min-height:0;background:#F8F7F2}.frame-preview iframe{width:100%;height:100%;border:0;background:#fff}.table-preview{flex:1;min-height:0;padding:18px;overflow:auto}.table-preview .table-meta{margin:0 0 10px;color:rgba(27,27,27,.42);font:11px var(--mono)}.table-preview table{border-collapse:collapse;font-size:12px;background:#fff}.table-preview th,.table-preview td{border:1px solid var(--ws-border);padding:5px 7px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.table-preview th{background:#F7F5EF;text-align:left;color:rgba(27,27,27,.65);position:sticky;top:0}.table-preview td.formula-cell{background:#F0F9FF;color:#075985}.diagram-preview{flex:1;min-height:0;padding:18px;display:grid;gap:14px;max-width:none;overflow:auto}.mermaid-card{border:1px solid var(--ws-border);border-radius:8px;background:#fff;overflow:hidden;display:flex;flex-direction:column}.mermaid-output{padding:18px;overflow:auto;min-height:220px;display:flex;align-items:center;justify-content:center}.mermaid-output svg{width:100%;max-width:100%;height:auto;display:block}.mermaid-source{margin:0;border-top:1px solid var(--ws-border-subtle);border-radius:0;background:#FAF9F5;color:rgba(27,27,27,.68);font:11px/1.45 var(--mono);max-height:220px;overflow:auto;padding:10px 12px;white-space:pre}.viewer-note{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:24px;background:#FAF9F5}.viewer-note-card{width:min(520px,100%);max-height:100%;overflow:auto;border:1px solid var(--ws-border);border-radius:8px;background:#fff;padding:18px;box-shadow:0 10px 34px rgba(27,27,27,.05)}.viewer-note-title{font-size:14px;font-weight:750;color:rgba(27,27,27,.84)}.viewer-note-body{margin-top:8px;color:rgba(27,27,27,.56);font-size:12px;line-height:1.55}.viewer-note-actions{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}.binary-preview{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:24px;color:rgba(27,27,27,.50);text-align:center}
.chat-head{height:36px;border-bottom:1px solid var(--ws-border-subtle);display:flex;align-items:center;gap:8px;padding:0 12px;background:rgba(255,255,255,.55)}.chat-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:rgba(27,27,27,.35)}.chat-subtitle{min-width:0;flex:1;font-size:10px;color:rgba(27,27,27,.28);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-tabs{height:32px;display:flex;align-items:center;border-bottom:1px solid var(--ws-border-subtle);background:#F7F5EF;padding:0 8px;gap:3px}.agent-tab{height:24px;border:0;border-radius:6px;background:transparent;color:rgba(27,27,27,.45);font-size:11px;font-weight:650;padding:0 9px;cursor:pointer}.agent-tab:hover{background:var(--ws-hover);color:rgba(27,27,27,.76)}.agent-tab.active{background:#fff;color:var(--ws-foreground);box-shadow:0 0 0 1px rgba(27,27,27,.06)}.chat-body{display:flex;flex-direction:column;flex:1;min-height:0}.chat-pane{display:none;flex-direction:column;flex:1;min-height:0}.chat-pane.active{display:flex}.thread{flex:1;min-height:0;overflow:auto;padding:16px 14px 10px;background:rgba(255,255,255,.40)}.thread-inner{display:flex;flex-direction:column;gap:12px}.empty-chat{display:flex;height:100%;align-items:center;justify-content:center;text-align:center;color:rgba(27,27,27,.35);font-size:12px}.session-list{display:flex;flex-direction:column;gap:2px}.session-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border-radius:6px;padding:8px}.session-row:hover{background:rgba(27,27,27,.035)}.session-main{min-width:0}.session-prompt{font-size:12px;color:rgba(27,27,27,.82);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-meta{margin-top:3px;font:10px/1.4 var(--mono);color:rgba(27,27,27,.38);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-tools{margin-top:5px;display:flex;gap:4px;flex-wrap:wrap}.session-chip{border-radius:999px;border:1px solid rgba(27,27,27,.07);background:#F7F5EF;padding:1px 6px;font:10px var(--mono);color:rgba(27,27,27,.48)}.msg{display:flex}.msg.user{justify-content:flex-end}.msg.assistant{justify-content:flex-start}.bubble{max-width:86%;border-radius:16px;padding:10px 12px;font-size:13px;line-height:1.55;word-break:break-word}.user .bubble{background:#1B1B1B;color:#FFFDF7}.message-attachments{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.message-attachment{max-width:100%;display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(255,255,255,.20);border-radius:999px;background:rgba(255,255,255,.10);color:#FFFDF7;padding:2px 7px;cursor:pointer}.message-attachment span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}.message-attachment small{font:10px var(--mono);opacity:.68}.message-attachment:hover{background:rgba(255,255,255,.17)}.assistant-stack{width:100%;max-width:960px;display:flex;flex-direction:column;gap:8px}.assistant-bubble{display:none;max-width:94%;border-radius:16px;background:#F7F5EF;padding:11px 13px;color:rgba(27,27,27,.86);font-size:13px;line-height:1.6}.assistant-bubble:not(:empty){display:block}.message-content p{margin:0 0 10px}.message-content p:last-child{margin-bottom:0}.message-content ul{margin:0 0 10px 18px;padding:0}.message-content li{margin:2px 0}
.activity-card{display:none;overflow:hidden;border:1px solid var(--ws-border);border-radius:8px;background:#FFFDF7;font-size:12px}.activity-card.active{display:block}.activity-head{height:28px;width:100%;border:0;background:transparent;display:flex;align-items:center;gap:8px;padding:0 9px;cursor:pointer;color:rgba(27,27,27,.68)}.activity-head:hover{background:#F7F5EF}.activity-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:11px;font-weight:650}.activity-rollup{font-size:10px;color:rgba(27,27,27,.38)}.activity-rows{border-top:1px solid rgba(27,27,27,.05);padding:7px 9px;max-height:96px;overflow:auto;display:flex;flex-direction:column;gap:5px}.activity-card.expanded .activity-rows{max-height:360px}.activity-row{display:flex;align-items:flex-start;gap:7px;color:rgba(27,27,27,.65);font-size:11px;line-height:1.35}.activity-row .status-dot{width:8px;height:8px;border-radius:999px;background:rgba(27,27,27,.18);margin-top:4px;flex:0 0 auto}.activity-row.running .status-dot{background:#0891B2}.activity-row.done .status-dot{background:#059669}.activity-row.error .status-dot{background:#DC2626}.activity-row.approval .status-dot{background:#D97706}.activity-row.thinking{font-style:italic;color:rgba(27,27,27,.48)}.activity-main{display:block;min-width:0;flex:1}.activity-message{display:block}.activity-row pre{display:none;margin:4px 0 0;max-height:120px;overflow:auto;border-radius:6px;background:rgba(27,27,27,.04);padding:6px;font:10px/1.4 var(--mono);color:rgba(27,27,27,.62);white-space:pre-wrap}.activity-card.expanded .activity-row pre{display:block}.activity-approval{margin-top:7px;border:1px solid rgba(217,119,6,.20);border-radius:7px;background:#FFFBEB;overflow:hidden;transition:opacity .85s ease,transform .85s ease,max-height .85s ease,margin .85s ease}.activity-approval.fading{opacity:0;transform:translateY(-4px);max-height:0;margin:0;pointer-events:none}.activity-approval-head{display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid rgba(217,119,6,.12);padding:6px 8px}.activity-approval-title{font-size:11px;font-weight:800;color:#92400E}.activity-approval-meta{font:10px var(--mono);color:rgba(146,64,14,.58);white-space:nowrap}.activity-approval-subject{margin:7px 8px 0;border:1px solid rgba(217,119,6,.14);border-radius:5px;background:#fff;padding:7px;font:10px/1.45 var(--mono);color:rgba(27,27,27,.72);white-space:pre-wrap;overflow-wrap:anywhere;max-height:130px;overflow:auto}.activity-approval-reason{padding:6px 8px 8px;color:rgba(27,27,27,.56);font-size:11px;line-height:1.45}.activity-approval-actions{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;border-top:1px solid rgba(217,119,6,.12);background:rgba(255,255,255,.58);padding:7px 8px}.activity-result{margin-top:6px}.trace{display:block;flex:1;min-height:0;overflow:auto;background:#fff;padding:8px}.trace-row{font:11px/1.45 var(--mono);border-bottom:1px solid rgba(27,27,27,.05);padding:7px 4px;color:rgba(27,27,27,.52);white-space:pre-wrap;overflow-wrap:anywhere}.trace-row b{color:var(--ws-primary)}
.notebook-preview{flex:1;min-height:0;overflow:auto;background:#F7F5EF;padding:14px 14px 40px;display:flex;flex-direction:column;gap:10px}.notebook-meta{font:11px var(--mono);color:rgba(27,27,27,.42);padding:0 6px}.notebook-cell{border:1px solid var(--ws-border-subtle);border-radius:8px;background:#fff;overflow:hidden;box-shadow:0 1px 0 rgba(27,27,27,.02)}.notebook-cell.code{display:grid;grid-template-columns:64px minmax(0,1fr);padding:0;align-items:stretch}.notebook-cell.markdown{padding:16px 20px}.notebook-cell.raw{background:#F7F5EF;padding:12px 16px}.notebook-cell.raw .notebook-cell-body{padding:0}.notebook-cell.raw pre{margin:0;white-space:pre-wrap;font:12px/1.5 var(--mono);color:rgba(27,27,27,.72)}.notebook-cell-body{padding:0}.notebook-markdown{font-size:14px;line-height:1.65;color:rgba(27,27,27,.86)}.notebook-markdown h1,.notebook-markdown h2,.notebook-markdown h3{line-height:1.2;margin:14px 0 8px;color:rgba(27,27,27,.92)}.notebook-markdown h1{font-size:22px;border-bottom:1px solid var(--ws-border-subtle);padding-bottom:4px}.notebook-markdown p{margin:0 0 10px}.notebook-markdown code{font-family:var(--mono);font-size:.92em;background:rgba(27,27,27,.06);border-radius:4px;padding:1px 4px}.notebook-markdown pre{overflow:auto;background:#0D1117;color:#E5E7EB;border-radius:6px;padding:10px}.notebook-prompt{padding:12px 10px 12px 10px;font:11px/1.4 var(--mono);text-align:right;user-select:none;color:#4B6BFB;background:transparent;border-right:1px solid var(--ws-border-subtle);white-space:nowrap;display:flex;align-items:flex-start;justify-content:flex-end}.notebook-prompt.out{color:#A21818}.notebook-prompt.empty{color:transparent;pointer-events:none}.notebook-prompt.in::before{content:"In "}.notebook-prompt.out::before{content:"Out "}.notebook-cell-monaco{background:#FAFBFC;min-height:52px;position:relative;overflow:hidden;padding:6px 0}.notebook-cell-monaco .monaco-editor,.notebook-cell-monaco .monaco-editor .overflow-guard,.notebook-cell-monaco .monaco-editor-background,.notebook-cell-monaco .margin{background:#FAFBFC!important}.notebook-code-fallback{margin:0;padding:8px 12px;background:transparent;color:#1F2937;font:12px/1.5 var(--mono);white-space:pre;overflow:auto}.notebook-cell-outputs{grid-column:1 / -1;display:grid;grid-template-columns:64px minmax(0,1fr);background:#fff;border-top:1px solid var(--ws-border-subtle)}.notebook-output-item{display:contents}.notebook-output-item+.notebook-output-item>.notebook-prompt,.notebook-output-item+.notebook-output-item>.notebook-output-body{border-top:1px solid var(--ws-border-subtle)}.notebook-output-body{padding:8px 12px;overflow:auto;min-width:0;background:#fff}.notebook-stream{margin:0;font:12px/1.5 var(--mono);color:#1F2937;white-space:pre-wrap;word-break:break-word;background:transparent;padding:0}.notebook-stream.stderr{color:#7F1D1D;background:#FEF2F2;padding:6px 8px;border-radius:5px}.notebook-error{margin:0;font:12px/1.5 var(--mono);color:#7F1D1D;background:#FEF2F2;padding:8px 10px;border-radius:5px;white-space:pre-wrap;word-break:break-word;overflow:auto}.notebook-plain{margin:0;font:12px/1.5 var(--mono);color:#1F2937;white-space:pre-wrap;word-break:break-word;background:transparent;padding:0}.notebook-json{margin:0;font:12px/1.5 var(--mono);color:#0F172A;background:#F8FAFC;padding:8px 10px;border-radius:5px;white-space:pre;overflow:auto}.notebook-output-body img{max-width:100%;height:auto;display:block;background:#fff;border-radius:4px}.notebook-output-body iframe{width:100%;min-height:220px;border:1px solid var(--ws-border-subtle);border-radius:5px;background:#fff}.notebook-latex{font-size:14px;color:rgba(27,27,27,.90);padding:6px 0;overflow:auto}.katex-display{margin:6px 0!important}.viewer.maximized{position:fixed;inset:12px;z-index:70;border:1px solid rgba(27,27,27,.12);border-radius:8px;box-shadow:0 24px 80px rgba(27,27,27,.28);background:#fff}.viewer.maximized .diagram-preview,.viewer.maximized .markdown-preview{max-width:none}.viewer.maximized .mermaid-output{min-height:calc(100vh - 220px)}.composer{border-top:1px solid var(--ws-border-subtle);background:#FFFDF7;padding:10px 12px}.composer-box{border:1px solid var(--ws-border);border-radius:10px;background:#fff;overflow:hidden}.upload-tray{display:flex;gap:6px;flex-wrap:wrap;padding:8px 9px 0}.upload-tray[hidden]{display:none}.upload-chip{height:24px;display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid rgba(8,145,178,.18);border-radius:999px;background:#F0F9FF;color:#075985;padding:0 4px 0 8px;font-size:11px}.upload-chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}.upload-chip-meta{font:10px var(--mono);color:rgba(7,89,133,.58)}.upload-chip button{width:18px;height:18px;border:0;border-radius:999px;background:transparent;color:rgba(7,89,133,.52);cursor:pointer;padding:0}.upload-chip button:hover{background:rgba(8,145,178,.12);color:#075985}textarea{display:block;width:100%;min-height:84px;max-height:240px;resize:vertical;border:0;padding:10px 11px;background:#fff;color:var(--ws-foreground);outline:none}.composer-actions{height:34px;border-top:1px solid var(--ws-border-subtle);display:flex;align-items:center;justify-content:space-between;padding:0 8px}.composer-left,.composer-right{display:flex;align-items:center;gap:6px;min-width:0}.composer-right{margin-left:auto}.status{font-size:11px;color:var(--ws-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px}.stop-button{height:24px;border:1px solid rgba(185,28,28,.20);border-radius:6px;background:#FEF2F2;color:#B91C1C;font-size:11px;font-weight:750;padding:0 8px;display:inline-flex;align-items:center;gap:5px;cursor:pointer}.stop-button svg{width:12px;height:12px}.stop-button:hover{background:#FEE2E2;border-color:rgba(185,28,28,.30)}.stop-button:disabled{opacity:.55;cursor:not-allowed}.stop-button[hidden]{display:none}button.primary{height:24px;border:0;border-radius:6px;background:var(--ws-foreground);color:#fff;font-size:11px;font-weight:750;padding:0 10px;cursor:pointer}button.primary:hover{background:#2B2B2B}button.primary:disabled{opacity:.45;cursor:not-allowed}
.approval-inline{transition:opacity .85s ease,transform .85s ease,max-height .85s ease,margin .85s ease}.approval-inline.fading{opacity:0;transform:translateY(-4px);max-height:0;margin:0;pointer-events:none}.approval-inline-actions .approval-approve{background:#ECFDF5;border-color:#A7F3D0;color:#047857}.approval-inline-actions .approval-approve:hover{background:#D1FAE5;color:#065F46}.approval-inline-actions .approval-reject{background:#FEF2F2;border-color:#FECACA;color:#B91C1C}.approval-inline-actions .approval-reject:hover{background:#FEE2E2;color:#991B1B}.approval-inline-actions .approval-secondary{background:#EFF6FF;border-color:#BFDBFE;color:#1D4ED8}.approval-inline-actions .approval-secondary:hover{background:#DBEAFE;color:#1E40AF}.approval-result-line{display:inline-flex;max-width:100%;align-items:center;gap:7px;border:1px solid rgba(27,27,27,.08);border-radius:999px;background:#F7F5EF;color:rgba(27,27,27,.58);padding:5px 9px;font:11px/1.2 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.approval-result-line.approved{background:#ECFDF5;border-color:#A7F3D0;color:#047857}.approval-result-line.denied{background:#FEF2F2;border-color:#FECACA;color:#B91C1C}.approval-result-tool{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.file-action:disabled{opacity:.38;cursor:not-allowed}.file-action.unsaved{border-color:rgba(8,145,178,.28);background:#ECFEFF;color:#0E7490}.tab-dirty{width:6px;height:6px;border-radius:999px;background:#0891B2;flex:0 0 auto}.notebook-preview{overflow-y:auto;overflow-x:hidden}.notebook-cell,.notebook-output-body{min-width:0}.notebook-code-fallback,.notebook-json{white-space:pre-wrap;overflow:hidden;overflow-wrap:anywhere}.notebook-output-body{overflow-x:hidden;overflow-y:visible}.notebook-error,.notebook-latex{overflow:hidden;overflow-wrap:anywhere}.notebook-markdown pre,.markdown-preview pre,.message-content pre{white-space:pre-wrap;overflow-wrap:anywhere}
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
      <label class="auto-toggle" id="approvalAutoWrap" title="Auto-approve routine tool approvals for this browser session">
        <input id="approvalAuto" type="checkbox">
        <span class="toggle-track"></span>
        <span id="approvalAutoLabel">Auto off</span>
      </label>
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
            <div class="upload-tray" id="uploadTray" hidden></div>
            <textarea id="prompt" placeholder="Ask about this local workspace"></textarea>
            <div class="composer-actions">
              <div class="composer-left">
                <button class="icon-button" id="attachFiles" type="button" title="Attach files" aria-label="Attach files"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg></button>
                <input id="fileUpload" type="file" multiple hidden>
                <div class="status" id="sendStatus"></div>
              </div>
              <div class="composer-right">
                <button class="stop-button" id="stopAgent" type="button" title="Stop current agent run" aria-label="Stop current agent run" hidden><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg><span>Stop</span></button>
                <button class="primary" id="send" type="submit">Send</button>
              </div>
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
let turnRunning = false;
let turnCancelling = false;
const queuedFollowups = [];
const queuedFollowupIds = new Set();
let historySelectionReady = false;
let historySessions = [];
let sessionMenuOpen = false;
let traceCount = 0;
let pendingApproval = null;
let pendingApprovalEl = null;
let approvalAutoMode = false;
let monacoReady = null;
let activeEditor = null;
let activeEditorPath = null;
let activeEditorOriginal = '';
let activeNotebookState = null;
let activeImageScale = 1;
let mermaidReady = null;
let mermaidSeq = 0;
let pendingAttachments = [];
let previewMaximized = false;
const unsavedFiles = new Map();
const dirtyPaths = new Set();

const LANGUAGE_OPTIONS = [
  ['plaintext','Plain text'],['javascript','JavaScript'],['typescript','TypeScript'],['json','JSON'],
  ['html','HTML'],['css','CSS'],['scss','SCSS'],['markdown','Markdown'],['yaml','YAML'],['toml','TOML'],
  ['xml','XML'],['python','Python'],['ruby','Ruby'],['go','Go'],['rust','Rust'],['java','Java'],
  ['c','C'],['cpp','C++'],['csharp','C#'],['php','PHP'],['kotlin','Kotlin'],['swift','Swift'],
  ['dart','Dart'],['scala','Scala'],['r','R'],['lua','Lua'],['perl','Perl'],['elixir','Elixir'],
  ['clojure','Clojure'],['fsharp','F#'],['shell','Shell'],['powershell','PowerShell'],['bat','Batch'],
  ['sql','SQL'],['graphql','GraphQL'],['dockerfile','Dockerfile'],['hcl','HCL/Terraform'],
  ['powerquery','Power Query'],['msdax','DAX'],['ini','INI']
];
const NOTEBOOK_LANGUAGE = ['notebook','Jupyter Notebook (.ipynb)'];
const LANGUAGES = LANGUAGE_OPTIONS.slice().sort((a,b)=>a[1].localeCompare(b[1],undefined,{sensitivity:'base'}));

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
function attachmentHint(file){
  const kind=String(file?.kind||file?.viewer||'').toLowerCase();
  const mime=String(file?.mime_type||'').toLowerCase();
  const ext=extname(file?.path||file?.name||'');
  if(kind==='image'||mime.startsWith('image/'))return 'vision';
  if(kind==='spreadsheet'||kind==='table'||['csv','tsv','xlsx','xls','ods'].includes(ext))return 'table';
  if(['pdf','markdown','text','code','config','notebook'].includes(kind)||['txt','md','mdx','pdf','json','yaml','yml','toml','html','xml','ipynb','log','rst','sql','sh'].includes(ext))return 'read';
  return 'file';
}
function fileToDataBase64(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||'').split(',').pop()||'');
    reader.onerror=()=>reject(reader.error||new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}
function renderUploadTray(){
  const tray=document.getElementById('uploadTray');
  if(!tray)return;
  if(!pendingAttachments.length){tray.hidden=true;tray.innerHTML='';return;}
  tray.hidden=false;
  tray.innerHTML=pendingAttachments.map((file,index)=>'<span class="upload-chip" title="'+esc(file.path)+'"><span class="upload-chip-name">'+esc(file.name||basename(file.path))+'</span><span class="upload-chip-meta">'+esc(attachmentHint(file))+' · '+esc(formatBytes(file.size))+'</span><button type="button" data-remove-upload="'+index+'" aria-label="Remove attachment">×</button></span>').join('');
  tray.querySelectorAll('[data-remove-upload]').forEach(btn=>btn.addEventListener('click',()=>{
    pendingAttachments.splice(Number(btn.dataset.removeUpload),1);
    renderUploadTray();
  }));
}
async function uploadFiles(fileList){
  const files=[...fileList];
  if(!files.length)return;
  document.getElementById('sendStatus').textContent='Uploading...';
  const payload=[];
  for(const file of files){
    payload.push({name:file.name||'upload.bin',mime_type:file.type||'',size:file.size||0,data_base64:await fileToDataBase64(file)});
  }
  const result=await api('/api/files/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:payload})});
  pendingAttachments.push(...(result.files||[]));
  renderUploadTray();
  document.getElementById('sendStatus').textContent='Attached '+pendingAttachments.length+' file'+(pendingAttachments.length===1?'':'s');
  dirCache.clear();
  await loadDir('.');
  if(result.files?.[0]?.path)openFile(result.files[0].path);
}
function parentPath(p){const parts=String(p||'.').split('/').filter(Boolean);parts.pop();return parts.length?parts.join('/'):'.';}
function compactId(id){const value=String(id||'');return value.length>16?value.slice(0,8)+'...'+value.slice(-5):value;}
function formatSessionTime(value){if(!value)return 'unknown';try{return new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch{return String(value);}}
let notebookCellEditors=[];
let katexReady=null;
function disposeActiveEditor(){try{activeEditor?.dispose?.();}catch{}activeEditor=null;activeEditorPath=null;activeEditorOriginal='';activeNotebookState=null;disposeNotebookCellEditors();}
function disposeNotebookCellEditors(){for(const item of notebookCellEditors){try{(item.editor||item)?.dispose?.();}catch{}}notebookCellEditors=[];}
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
async function importWithoutAmdDefine(url){
  const globalObj=window;
  const hadDefine=Object.prototype.hasOwnProperty.call(globalObj,'define');
  const previousDefine=globalObj.define;
  try{
    try{Object.defineProperty(globalObj,'define',{value:undefined,writable:true,configurable:true});}
    catch{try{globalObj.define=undefined;}catch{}}
    return await import(url);
  }finally{
    try{
      if(hadDefine)Object.defineProperty(globalObj,'define',{value:previousDefine,writable:true,configurable:true});
      else delete globalObj.define;
    }catch{
      try{globalObj.define=previousDefine;}catch{}
    }
  }
}
async function loadMermaid(){
  if(mermaidReady)return mermaidReady;
  mermaidReady=importWithoutAmdDefine('/vendor/mermaid/mermaid.esm.min.mjs').then(mod=>{
    const mermaid=mod.default||mod;
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',themeVariables:{primaryColor:'#F7F5EF',primaryTextColor:'#1B1B1B',primaryBorderColor:'#D7D3C8',lineColor:'#64748B',fontFamily:'ui-sans-serif, system-ui, sans-serif'}});
    return mermaid;
  }).catch(err=>{mermaidReady=null;throw err;});
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
  if(ext==='ipynb')return 'notebook';
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
  const byExt={js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',json:'json',jsonl:'json',ipynb:'json',css:'css',scss:'scss',html:'html',htm:'html',md:'markdown',mdx:'markdown',yaml:'yaml',yml:'yaml',toml:'toml',xml:'xml',py:'python',rb:'ruby',go:'go',rs:'rust',java:'java',c:'c',h:'c',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'cpp',sh:'shell',bash:'shell',zsh:'shell',sql:'sql',graphql:'graphql',gql:'graphql',dockerfile:'dockerfile',tf:'hcl',hcl:'hcl',dax:'msdax',pq:'powerquery',m:'powerquery',ini:'ini'};
  const name=basename(data.path).toLowerCase();
  if(name==='dockerfile')return 'dockerfile';
  if(name.startsWith('.env'))return 'plaintext';
  return byExt[ext]||'plaintext';
}
function languageLabel(id){
  const match=(id===NOTEBOOK_LANGUAGE[0]?NOTEBOOK_LANGUAGE:null)||LANGUAGES.find(([value])=>value===id);
  return match?match[1]:(id||'Plain text');
}
function languageSelect(current,path,auto=false,{includeNotebook=false}={}){
  const autoOpt='<option value="__auto" '+(auto?'selected':'')+'>Auto detect ('+esc(languageLabel(current))+')</option>';
  const options=includeNotebook?[NOTEBOOK_LANGUAGE,...LANGUAGES]:LANGUAGES;
  const opts=options.map(([id,label])=>'<option value="'+esc(id)+'" '+(!auto&&id===current?'selected':'')+'>'+esc(label)+'</option>').join('');
  return '<select class="file-action" data-language-select="'+esc(path)+'" title="Preview language">'+autoOpt+opts+'</select>';
}
function detectNotebookLanguage(notebook){
  const metadata=notebook&&notebook.metadata?notebook.metadata:{};
  const info=metadata.language_info||{};
  const kernel=metadata.kernelspec||{};
  return String(info.name||kernel.language||kernel.display_name||metadata.language||'').toLowerCase();
}
function monacoLanguageForNotebook(value){
  const lang=String(value||'').toLowerCase();
  if(lang.includes('python')||['py','ipython'].includes(lang))return 'python';
  if(lang.includes('javascript')||['js','node'].includes(lang))return 'javascript';
  if(lang.includes('typescript')||lang==='ts')return 'typescript';
  if(lang==='r'||lang.includes('r-language'))return 'r';
  if(lang.includes('sql'))return 'sql';
  if(lang.includes('julia'))return 'julia';
  if(['bash','shell','sh','zsh'].includes(lang)||lang.includes('bash'))return 'shell';
  if(lang==='notebook')return 'python';
  return lang||'plaintext';
}
function iconSvg(name){
  const attrs='viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const icons={
    maximize:'<svg '+attrs+'><path d="M15 3h6v6"></path><path d="m21 3-7 7"></path><path d="M9 21H3v-6"></path><path d="m3 21 7-7"></path></svg>',
    minimize:'<svg '+attrs+'><path d="M14 10h6V4"></path><path d="m20 10-7-7"></path><path d="M4 20h6v-6"></path><path d="m4 20 7-7"></path></svg>',
    external:'<svg '+attrs+'><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>',
    raw:'<svg '+attrs+'><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M10 13h4"></path><path d="M10 17h4"></path></svg>',
    ask:'<svg '+attrs+'><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path><path d="M9 9h6"></path><path d="M9 13h4"></path></svg>',
    save:'<svg '+attrs+'><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path></svg>',
    edit:'<svg '+attrs+'><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
    plus:'<svg '+attrs+'><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>',
    minus:'<svg '+attrs+'><path d="M5 12h14"></path></svg>',
    reset:'<svg '+attrs+'><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 3v6h6"></path></svg>'
  };
  return icons[name]||icons.raw;
}
function fileIconButton(attr,name,label){
  return '<button class="file-action file-icon-action" type="button" '+attr+' title="'+esc(label)+'" aria-label="'+esc(label)+'">'+iconSvg(name)+'</button>';
}
function fileIconLink(href,name,label){
  return '<a class="file-action file-icon-action" href="'+esc(href)+'" target="_blank" rel="noreferrer" title="'+esc(label)+'" aria-label="'+esc(label)+'">'+iconSvg(name)+'</a>';
}
function canEditFile(data){
  return Boolean(data?.file?.text_like && data?.preview && data.preview.content != null && !data.preview.truncated);
}
function currentSavedText(data){
  return String(data?.preview?.content ?? '');
}
function sourceTextForRender(data){
  return unsavedFiles.has(data.path) ? unsavedFiles.get(data.path) : currentSavedText(data);
}
function renderEditableSource(data,language=null,{auto=true}={}){
  renderCodeEditor(data,sourceTextForRender(data),language||fileLanguage(data),{auto,originalText:currentSavedText(data)});
}
function setPreviewMaximized(open){
  previewMaximized=!!open;
  const viewer=document.getElementById('viewer');
  if(viewer)viewer.classList.toggle('maximized',previewMaximized);
  document.querySelectorAll('[data-preview-maximize]').forEach(btn=>{
    const label=previewMaximized?'Exit full screen preview':'Maximize preview';
    btn.innerHTML=iconSvg(previewMaximized?'minimize':'maximize');
    btn.title=label;
    btn.setAttribute('aria-label',label);
  });
  setTimeout(()=>activeEditor?.layout?.(),0);
}
function openCurrentPreviewTab(path){
  const content=document.querySelector('#viewer [data-preview-content]');
  if(!content||content.classList.contains('monaco-host')){
    window.open(rawUrl(path),'_blank','noopener,noreferrer');
    return;
  }
  const popup=window.open('','_blank');
  if(!popup){
    window.open(rawUrl(path),'_blank','noopener,noreferrer');
    return;
  }
  const styles=[...document.querySelectorAll('style')].map(style=>style.textContent||'').join('\\n');
  popup.document.open();
  popup.document.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="'+esc(location.origin)+'/"><title>'+esc(basename(path))+'</title><style>'+styles+'body{margin:0;background:#fff}.standalone-preview{height:100vh;overflow:hidden}.standalone-preview>[data-preview-content]{height:100%;max-width:none}</style></head><body><div class="viewer standalone-preview">'+content.outerHTML+'</div></body></html>');
  popup.document.close();
}
function bindHeaderActions(path){
  document.querySelectorAll('[data-ask-file]').forEach(btn=>btn.addEventListener('click',()=>askAgentForFile(btn.dataset.askFile,btn.dataset.askKind)));
  document.querySelectorAll('[data-save-file]').forEach(btn=>btn.addEventListener('click',()=>saveCurrentFile(btn.dataset.saveFile)));
  document.querySelectorAll('[data-edit-source]').forEach(btn=>btn.addEventListener('click',()=>{
    const data=fileCache.get(btn.dataset.editSource);
    if(data)renderEditableSource(data,fileKind(data)==='notebook'?'json':fileLanguage(data),{auto:false});
  }));
  document.querySelectorAll('[data-preview-maximize]').forEach(btn=>btn.addEventListener('click',()=>setPreviewMaximized(!previewMaximized)));
  document.querySelectorAll('[data-preview-new-tab]').forEach(btn=>btn.addEventListener('click',()=>openCurrentPreviewTab(btn.dataset.previewNewTab)));
  document.querySelectorAll('[data-language-select]').forEach(sel=>sel.addEventListener('change',()=>{
    const data=fileCache.get(sel.dataset.languageSelect);
    if(!data)return;
    const auto=sel.value==='__auto';
    if(fileKind(data)==='notebook'&&(!auto&&sel.value==='json'))renderEditableSource(data,'json',{auto:false});
    else if(fileKind(data)==='notebook')renderNotebookFile(data,sourceTextForRender(data),auto?null:sel.value,{auto});
    else renderEditableSource(data,auto?fileLanguage(data):sel.value,{auto});
  }));
  updateSaveButtons(path);
}
function askAgentForFile(path,kind){
  const prompt=document.getElementById('prompt');
  const label=kind==='image'?'Analyze this image':kind==='pdf'?'Summarize this PDF':kind==='spreadsheet'?'Inspect this spreadsheet':kind==='document'?'Inspect this document':kind==='presentation'?'Inspect this presentation':'Inspect this file';
  prompt.value=label+' at '+path+'. Explain what it contains and call the right local tools if needed.';
  prompt.focus();
}
function fileHeader(data,{language=null,languageAuto=false,truncated=false,extraActions='',editSource=false,save=false}={}){
  const file=data.file||{};
  const kind=fileKind(data);
  const label=file.label||kind;
  const chips=[
    '<span class="file-chip">'+esc(label)+'</span>',
    file.size!=null?'<span class="file-chip">'+formatBytes(file.size)+'</span>':'',
    truncated?'<span class="file-chip warn">truncated preview</span>':''
  ].filter(Boolean).join('');
  const lang=language?languageSelect(language,data.path,languageAuto,{includeNotebook:kind==='notebook'}):'';
  const saveAction=save?fileIconButton('data-save-file="'+esc(data.path)+'" disabled','save','Save file'):'';
  const editAction=editSource?fileIconButton('data-edit-source="'+esc(data.path)+'"','edit','Edit source'):'';
  const maximize=fileIconButton('data-preview-maximize="'+esc(data.path)+'"',previewMaximized?'minimize':'maximize',previewMaximized?'Exit full screen preview':'Maximize preview');
  const newTab=fileIconButton('data-preview-new-tab="'+esc(data.path)+'"','external','Open preview in new tab');
  const ask=fileIconButton('data-ask-file="'+esc(data.path)+'" data-ask-kind="'+esc(kind)+'"','ask','Ask agent');
  const raw=fileIconLink(rawUrl(data.path),'raw','Open raw file');
  return '<div class="file-header"><span>◇</span><span class="path">'+esc(data.path)+'</span>'+chips+'<span class="file-actions">'+lang+extraActions+saveAction+editAction+maximize+newTab+ask+raw+'</span></div>';
}
function renderViewer(html){
  disposeActiveEditor();
  const viewer=document.getElementById('viewer');
  viewer.innerHTML=html;
  viewer.classList.toggle('maximized',previewMaximized);
}
function setFileDirty(path,dirty,content=null){
  if(!path)return;
  if(dirty){
    dirtyPaths.add(path);
    if(content!=null)unsavedFiles.set(path,content);
  }else{
    dirtyPaths.delete(path);
    unsavedFiles.delete(path);
  }
  renderTabs();
  updateSaveButtons(path);
}
function updateSaveButtons(path=null){
  document.querySelectorAll('[data-save-file]').forEach(btn=>{
    if(path&&btn.dataset.saveFile!==path)return;
    const dirty=dirtyPaths.has(btn.dataset.saveFile);
    btn.disabled=!dirty;
    btn.classList.toggle('unsaved',dirty);
  });
}
function serializeNotebook(notebook){
  return JSON.stringify(notebook||{},null,2)+'\\n';
}
function syncNotebookEditorSources(){
  if(!activeNotebookState)return;
  for(const item of notebookCellEditors){
    if(!item?.cell||!item?.editor)continue;
    setNotebookCellSource(item.cell,item.editor.getValue());
  }
}
function activeEditableContent(path){
  if(activeEditor&&activeEditorPath===path)return activeEditor.getValue();
  if(activeNotebookState&&activeNotebookState.path===path){
    syncNotebookEditorSources();
    return serializeNotebook(activeNotebookState.notebook);
  }
  if(unsavedFiles.has(path))return unsavedFiles.get(path);
  return null;
}
async function saveCurrentFile(path){
  const data=fileCache.get(path);
  if(!data||!canEditFile(data)){
    document.getElementById('sendStatus').textContent='This file cannot be saved from the browser preview.';
    return;
  }
  const content=activeEditableContent(path);
  if(content==null)return;
  const buttons=[...document.querySelectorAll('[data-save-file]')].filter(btn=>btn.dataset.saveFile===path);
  buttons.forEach(btn=>{btn.disabled=true;});
  document.getElementById('sendStatus').textContent='Saving '+basename(path)+'...';
  try{
    const saved=await api('/api/file/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,content})});
    fileCache.set(saved.path,saved);
    if(saved.path!==path)fileCache.delete(path);
    setFileDirty(saved.path,false);
    if(activeEditorPath===path)activeEditorOriginal=content;
    if(activeNotebookState?.path===path)activeNotebookState.originalText=content;
    document.getElementById('sendStatus').textContent='Saved '+basename(saved.path);
    const parent=parentPath(saved.path);
    dirCache.delete(parent);
    if(parent==='.')dirCache.delete('.');
    await loadDir(parent);
  }catch(err){
    document.getElementById('sendStatus').textContent=err.message;
    addTrace('file_save_failed',{path,message:err.message});
    updateSaveButtons(path);
  }
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
  const tabs=openTabs.map(tab=>'<button class="tab '+(tab.path===activePath?'active':'')+'" data-tab="'+esc(tab.path)+'" title="'+esc(tab.path)+'">'+(dirtyPaths.has(tab.path)?'<span class="tab-dirty" title="Unsaved changes"></span>':'')+'<span>◇</span><span class="tab-name">'+esc(tab.name)+'</span><span class="tab-close" data-close="'+esc(tab.path)+'">×</span></button>').join('');
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
  const text=data.preview&&data.preview.content!=null?sourceTextForRender(data):null;
  const kind=fileKind(data);
  if(kind==='image'){renderImage(data);return;}
  if(kind==='pdf'){renderPdf(data);return;}
  if(kind==='markdown'&&text!=null){renderMarkdownFile(data,text);return;}
  if(kind==='mermaid'&&text!=null){renderMermaidFile(data,text);return;}
  if(kind==='drawio'){renderDrawioFile(data,text);return;}
  if(kind==='table'&&text!=null){renderTableFile(data,text);return;}
  if(kind==='notebook'&&text!=null){renderNotebookFile(data,text);return;}
  if(kind==='spreadsheet'){renderSpreadsheetFile(data);return;}
  if(kind==='document'||kind==='presentation'){renderOfficeFile(data,kind);return;}
  if(text!=null){
    renderCodeEditor(data,text,fileLanguage(data),{originalText:currentSavedText(data)});
    return;
  }
  renderUnsupportedFile(data,kind);
}
function renderCodeEditor(data,text,language,{auto=true,originalText=null}={}){
  const editable=canEditFile(data);
  const savedText=String(originalText ?? currentSavedText(data));
  const value=unsavedFiles.has(data.path)?unsavedFiles.get(data.path):String(text||'');
  const header=fileHeader(data,{language,languageAuto:auto,truncated:Boolean(data.preview&&data.preview.truncated),save:editable});
  const hostId='monaco_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
  renderViewer(header+'<div class="monaco-host" data-preview-content id="'+hostId+'"></div>');
  bindHeaderActions(data.path);
  loadMonaco().then(monaco=>{
    const host=document.getElementById(hostId);
    if(!host)return;
    activeEditorPath=data.path;
    activeEditorOriginal=savedText;
    activeEditor=monaco.editor.create(host,{
      value,
      language:language||'plaintext',
      theme:'vs',
      readOnly:!editable,
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
    activeEditor.onDidChangeModelContent(()=>{
      const next=activeEditor.getValue();
      setFileDirty(data.path,next!==activeEditorOriginal,next);
    });
    updateSaveButtons(data.path);
  }).catch(err=>{
    addTrace('preview_editor_fallback',{path:data.path,message:err.message});
    const viewer=document.getElementById('viewer');
    if(viewer) viewer.innerHTML=header+'<div class="code-fallback" data-preview-content>'+renderCode(value)+'</div>';
    bindHeaderActions(data.path);
  });
}
function renderCode(text){
  const lines=String(text||'').split('\\n');
  const nums=lines.map((_,i)=>i+1).join('\\n');
  return '<div class="code-wrap"><pre class="line-nums">'+nums+'</pre><pre class="code-pre">'+esc(text)+'</pre></div>';
}
function notebookSource(value){
  if(Array.isArray(value))return value.map(notebookSource).join('');
  if(value&&typeof value==='object')return JSON.stringify(value,null,2);
  return String(value ?? '');
}
function splitNotebookSource(value){
  const text=String(value ?? '');
  if(!text)return [];
  const lines=text.split('\\n');
  return lines.map((line,index)=>index<lines.length-1?line+'\\n':line).filter((line,index)=>line||index<lines.length-1);
}
function setNotebookCellSource(cell,value){
  if(!cell||typeof cell!=='object')return;
  const key=cell.source!=null?'source':cell.input!=null?'input':cell.text!=null?'text':'source';
  const previous=cell[key];
  cell[key]=Array.isArray(previous)?splitNotebookSource(value):String(value ?? '');
}
function renderNotebookFile(data,text,overrideLanguage=null,{auto=true}={}){
  let notebook;
  const notebookText=sourceTextForRender(data);
  try{notebook=JSON.parse(notebookText||'{}');}catch{
    renderCodeEditor(data,notebookText,fileLanguage(data),{originalText:currentSavedText(data)});
    return;
  }
  const cells=notebookCells(notebook);
  const notebookMode=overrideLanguage==='notebook';
  const detected=monacoLanguageForNotebook((notebookMode?null:overrideLanguage)||detectNotebookLanguage(notebook)||'python');
  const language=detected||'python';
  const selectedLanguage=notebookMode?'notebook':language;
  const header=fileHeader(data,{language:selectedLanguage,languageAuto:auto,truncated:Boolean(data.preview&&data.preview.truncated),extraActions:'<span class="file-chip">'+cells.length+' cells</span>',save:canEditFile(data),editSource:canEditFile(data)});
  const meta=[
    notebookVersionLabel(notebook),
    languageLabel(language),
    cells.length+' cells'
  ].join(' · ');
  const visible=cells.slice(0,200);
  const cellDescriptors=[];
  const body=visible.length?visible.map((cell,index)=>renderNotebookCell(cell,index,language,cellDescriptors,canEditFile(data))).join(''):'<div class="empty">No cells.</div>';
  const truncated=cells.length>200?'<div class="viewer-note-card"><div class="viewer-note-title">Notebook truncated</div><div class="viewer-note-body">Showing first 200 cells in the browser preview.</div></div>':'';
  renderViewer(header+'<div class="notebook-preview" data-preview-content><div class="notebook-meta">'+meta+'</div>'+body+truncated+'</div>');
  bindHeaderActions(data.path);
  activeNotebookState={path:data.path,notebook,cells,originalText:currentSavedText(data)};
  renderMermaidBlocks();
  void mountNotebookCells(cellDescriptors);
  void renderLatexIn(document.getElementById('viewer'));
}
function notebookCells(notebook){
  if(Array.isArray(notebook?.cells))return notebook.cells;
  if(Array.isArray(notebook?.worksheets)){
    return notebook.worksheets.flatMap(sheet=>Array.isArray(sheet?.cells)?sheet.cells:[]);
  }
  return [];
}
function notebookVersionLabel(notebook){
  if(notebook?.nbformat)return 'nbformat '+esc(notebook.nbformat)+'.'+esc(notebook.nbformat_minor||0);
  return 'notebook';
}
function renderNotebookCell(cell,index,language,cellDescriptors,editable=false){
  const type=String(cell?.cell_type||'raw').toLowerCase();
  const source=notebookSource(cell?.source ?? cell?.input ?? cell?.text);
  const execCount=cell?.execution_count!=null?String(cell.execution_count):cell?.prompt_number!=null?String(cell.prompt_number):'';
  if(type==='markdown'||type==='heading'){
    const markdownSource=type==='heading'?'#'.repeat(Math.max(1,Math.min(6,Number(cell?.level)||1)))+' '+source:source;
    return '<section class="notebook-cell markdown" data-cell-type="markdown"><div class="notebook-cell-body notebook-markdown" data-katex-scan>'+markdown(markdownSource)+'</div></section>';
  }
  if(type==='raw'){
    return '<section class="notebook-cell raw" data-cell-type="raw"><div class="notebook-cell-body notebook-raw"><pre>'+esc(source)+'</pre></div></section>';
  }
  const hostId='nbc_'+Date.now().toString(36)+'_'+index+'_'+Math.random().toString(36).slice(2,6);
  cellDescriptors.push({hostId,source,language,cell,editable});
  const promptText=execCount?'['+esc(execCount)+']':'[ ]';
  const inPrompt='<div class="notebook-prompt in" title="Execution '+esc(execCount||'n/a')+'">'+promptText+':</div>';
  const codeBlock='<div class="notebook-cell-monaco" id="'+hostId+'"><pre class="notebook-code-fallback">'+esc(source)+'</pre></div>';
  const outputs=renderCellOutputs(cell?.outputs||[],execCount);
  return '<section class="notebook-cell code" data-cell-type="code">'+inPrompt+codeBlock+outputs+'</section>';
}
function renderCellOutputs(outputs,execCount){
  if(!Array.isArray(outputs)||!outputs.length)return '';
  const items=outputs.slice(0,12).map(o=>renderNotebookOutput(o,execCount)).join('');
  return '<div class="notebook-cell-outputs">'+items+'</div>';
}
function renderNotebookOutput(output,execCount){
  const type=String(output?.output_type||'output');
  const isResult=type==='execute_result'||type==='pyout';
  const prompt=isResult&&execCount
    ?'<div class="notebook-prompt out">['+esc(execCount)+']:</div>'
    :'<div class="notebook-prompt empty">&nbsp;</div>';
  const body=renderNotebookOutputBody(output,type);
  return '<div class="notebook-output-item">'+prompt+'<div class="notebook-output-body">'+body+'</div></div>';
}
function renderNotebookOutputBody(output,type){
  if(type==='stream'){
    const name=String(output.name||'stdout').toLowerCase();
    const cls=name==='stderr'?'notebook-stream stderr':'notebook-stream';
    return '<pre class="'+cls+'">'+ansiToHtml(notebookSource(output.text))+'</pre>';
  }
  if(type==='error'||type==='pyerr'){
    const traceback=Array.isArray(output.traceback)?output.traceback.join('\\n'):notebookSource(output.traceback);
    const fallback=(output.ename||'Error')+': '+(output.evalue||'');
    return '<pre class="notebook-error">'+ansiToHtml(traceback||fallback)+'</pre>';
  }
  const data=notebookOutputData(output);
  const png=data['image/png'];
  const jpeg=data['image/jpeg'];
  const svg=data['image/svg+xml'];
  const html=data['text/html'];
  const latex=data['text/latex'];
  const md=data['text/markdown'];
  const plain=data['text/plain'];
  const json=data['application/json'];
  if(png)return '<img alt="Notebook output" src="data:image/png;base64,'+esc(notebookSource(png))+'">';
  if(jpeg)return '<img alt="Notebook output" src="data:image/jpeg;base64,'+esc(notebookSource(jpeg))+'">';
  if(svg)return '<iframe sandbox="" srcdoc="'+esc(notebookSource(svg))+'" title="svg output"></iframe>';
  if(html)return '<iframe sandbox="allow-same-origin" srcdoc="'+esc(notebookSource(html))+'" title="html output"></iframe>';
  if(latex)return '<div class="notebook-latex">'+esc(notebookSource(latex))+'</div>';
  if(md)return '<div class="notebook-markdown" data-katex-scan>'+markdown(notebookSource(md))+'</div>';
  if(json)return '<pre class="notebook-json">'+esc(JSON.stringify(json,null,2))+'</pre>';
  if(plain)return '<pre class="notebook-plain">'+ansiToHtml(notebookSource(plain))+'</pre>';
  return '<pre class="notebook-plain">'+esc(JSON.stringify(output||{},null,2))+'</pre>';
}
function notebookOutputData(output){
  const data=output?.data&&typeof output.data==='object'?{...output.data}:{};
  if(output?.png!=null)data['image/png']=output.png;
  if(output?.jpeg!=null)data['image/jpeg']=output.jpeg;
  if(output?.svg!=null)data['image/svg+xml']=output.svg;
  if(output?.html!=null)data['text/html']=output.html;
  if(output?.markdown!=null)data['text/markdown']=output.markdown;
  if(output?.text!=null)data['text/plain']=output.text;
  return data;
}
function renderImage(data){
  activeImageScale=1;
  const zoomActions=fileIconButton('data-image-zoom="out"','minus','Zoom out')+fileIconButton('data-image-zoom="reset"','reset','Reset zoom')+fileIconButton('data-image-zoom="in"','plus','Zoom in');
  const header=fileHeader(data,{extraActions:zoomActions});
  renderViewer(header+'<div class="image-stage" data-preview-content><div class="image-toolbar"><span class="file-chip" id="imageScale">100%</span></div><div class="image-preview"><img id="imagePreview" src="'+rawUrl(data.path)+'" alt="'+esc(data.path)+'"></div></div>');
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
  renderViewer(header+'<div class="frame-preview" data-preview-content><iframe src="'+rawUrl(data.path)+'" title="'+esc(data.path)+'"></iframe></div>');
  bindHeaderActions(data.path);
}
function renderMarkdownFile(data,text){
  const header=fileHeader(data,{language:'markdown',truncated:Boolean(data.preview&&data.preview.truncated),save:canEditFile(data),editSource:canEditFile(data)});
  renderViewer(header+'<div class="markdown-preview" data-preview-content>'+markdown(text)+'</div>');
  bindHeaderActions(data.path);
  renderMermaidBlocks();
}
function renderMermaidFile(data,text){
  const header=fileHeader(data,{language:'markdown',truncated:Boolean(data.preview&&data.preview.truncated),save:canEditFile(data),editSource:canEditFile(data)});
  renderViewer(header+'<div class="diagram-preview" data-preview-content>'+mermaidCard(text)+'</div>');
  bindHeaderActions(data.path);
  renderMermaidBlocks();
}
function renderDrawioFile(data,text){
  const pages=countDrawioPages(text);
  const title=pages>0?'Draw.io diagram with '+pages+' page'+(pages===1?'':'s'):'Draw.io diagram';
  const body=text?renderCode(text):'<div class="viewer-note" data-preview-content><div class="viewer-note-card"><div class="viewer-note-title">'+title+'</div><div class="viewer-note-body">This diagram file is available to the local agent, but the browser renderer is not bundled yet. Use Ask agent to inspect or convert it.</div></div></div>';
  const header=fileHeader(data,{language:text?'xml':null,truncated:Boolean(data.preview&&data.preview.truncated),save:canEditFile(data),editSource:canEditFile(data)});
  renderViewer(header+(text?'<div class="diagram-preview" data-preview-content><div class="viewer-note-card"><div class="viewer-note-title">'+title+'</div><div class="viewer-note-body">Source preview shown for now. A bundled Draw.io renderer can be added without exposing raw binary content.</div></div>'+body+'</div>':body));
  bindHeaderActions(data.path);
}
function countDrawioPages(text){
  const value=String(text||'');
  const matches=value.match(/<diagram\\b/g);
  return matches?matches.length:0;
}
function renderTableFile(data,text){
  const ext=extname(data.path);
  const header=fileHeader(data,{language:ext==='csv'?'plaintext':'plaintext',truncated:Boolean(data.preview&&data.preview.truncated),save:canEditFile(data),editSource:canEditFile(data)});
  renderViewer(header+renderTable(text,ext==='tsv'?'\\t':','));
  bindHeaderActions(data.path);
}
async function renderSpreadsheetFile(data){
  const header=fileHeader(data);
  renderViewer(header+'<div class="table-preview" data-preview-content><div class="table-meta">Loading workbook preview...</div></div>');
  bindHeaderActions(data.path);
  try{
    const preview=await api('/api/file/spreadsheet-preview?path='+encodeURIComponent(data.path));
    renderSpreadsheetSheet(data,preview,0);
  }catch(err){
    renderPreviewError(data,'Spreadsheet preview failed',err.message||String(err),'spreadsheet');
  }
}
function renderSpreadsheetSheet(data,preview,index){
  const sheets=Array.isArray(preview.sheets)?preview.sheets:[];
  const sheet=sheets[index]||sheets[0];
  if(!sheet){
    renderPreviewError(data,'Spreadsheet preview','No sheets were found in this workbook.','spreadsheet');
    return;
  }
  const select=sheets.length>1?'<select class="file-action" id="sheetSelect" title="Sheet">'+sheets.map((s,i)=>'<option value="'+i+'" '+(i===index?'selected':'')+'>'+esc(s.name)+'</option>').join('')+'</select>':'';
  const header=fileHeader(data,{extraActions:select});
  const meta=[
    esc(sheet.name),
    esc(sheet.row_count)+' rows',
    esc(sheet.column_count)+' columns',
    sheet.truncated_rows?'rows truncated':'',
    sheet.truncated_columns?'columns truncated':'',
    preview.truncated_sheets?'sheets truncated':''
  ].filter(Boolean).join(' · ');
  renderViewer(header+'<div class="table-preview" data-preview-content><div class="table-meta">'+meta+'</div>'+renderWorkbookTable(sheet)+'</div>');
  bindHeaderActions(data.path);
  document.getElementById('sheetSelect')?.addEventListener('change',e=>renderSpreadsheetSheet(data,preview,Number(e.target.value)||0));
}
function renderWorkbookTable(sheet){
  const columns=Array.isArray(sheet.columns)?sheet.columns:[];
  const rows=Array.isArray(sheet.rows)?sheet.rows:[];
  if(!columns.length||!rows.length)return '<div class="empty">No visible cells.</div>';
  return '<table><thead><tr><th></th>'+columns.map(col=>'<th>'+esc(col)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>{
    const cells=Array.isArray(row.cells)?row.cells:[];
    return '<tr><th>'+esc(row.number)+'</th>'+columns.map((_,i)=>{
      const cell=cells[i]||{};
      const value=cell.value||'';
      const formula=cell.formula;
      const cls=formula?' class="formula-cell"':'';
      const title=formula?' title="'+esc(formula)+'"':'';
      return '<td'+cls+title+'>'+esc(value)+'</td>';
    }).join('')+'</tr>';
  }).join('')+'</tbody></table>';
}
async function renderOfficeFile(data,kind){
  const label=kind==='presentation'?'Presentation preview':'Document preview';
  const header=fileHeader(data);
  renderViewer(header+'<div class="viewer-note" data-preview-content><div class="viewer-note-card"><div class="viewer-note-title">'+label+'</div><div class="viewer-note-body">Converting locally for preview...</div></div></div>');
  bindHeaderActions(data.path);
  try{
    const preview=await api('/api/file/office-preview?path='+encodeURIComponent(data.path));
    if(preview.ok&&preview.preview_url){
      renderOfficePdf(data,preview);
      return;
    }
    renderPreviewError(data,label,preview.message||'Conversion preview is unavailable.',kind,preview.install_hint||'');
  }catch(err){
    renderPreviewError(data,label,err.message||String(err),kind);
  }
}
function renderOfficePdf(data,preview){
  const header=fileHeader(data,{extraActions:'<span class="file-chip">converted PDF</span>'});
  renderViewer(header+'<div class="frame-preview" data-preview-content><iframe src="'+esc(preview.preview_url)+'" title="'+esc(data.path)+' preview"></iframe></div>');
  bindHeaderActions(data.path);
}
function renderPreviewError(data,title,message,kind,hint=''){
  const header=fileHeader(data);
  renderViewer(header+'<div class="viewer-note" data-preview-content><div class="viewer-note-card"><div class="viewer-note-title">'+esc(title)+'</div><div class="viewer-note-body">'+esc(message)+(hint?'<br><br>'+esc(hint):'')+'</div><div class="viewer-note-actions"><button class="file-action" type="button" data-ask-file="'+esc(data.path)+'" data-ask-kind="'+esc(kind)+'">Ask agent to inspect</button></div></div></div>');
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
  renderViewer(header+'<div class="viewer-note" data-preview-content><div class="viewer-note-card"><div class="viewer-note-title">'+esc(title)+'</div><div class="viewer-note-body">'+esc(body)+'<br><br>'+esc(file.label||kind)+' · '+(file.size!=null?esc(formatBytes(file.size)):'unknown size')+'</div><div class="viewer-note-actions"><button class="file-action" type="button" data-ask-file="'+esc(data.path)+'" data-ask-kind="'+esc(kind)+'">Ask agent to inspect</button></div></div></div>');
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
  return '<div class="table-preview" data-preview-content><div class="table-meta">'+esc(rows.length-1)+' rows shown, '+esc(head.length)+' columns</div><table><thead><tr>'+head.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+body.map(r=>'<tr>'+head.map((_,i)=>'<td>'+esc(r[i]||'')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
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
async function loadKatex(){
  if(katexReady)return katexReady;
  if(!document.querySelector('link[data-katex]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/vendor/katex/katex.min.css';
    link.setAttribute('data-katex','1');
    document.head.appendChild(link);
  }
  katexReady=importWithoutAmdDefine('/vendor/katex/contrib/auto-render.mjs')
    .then(mod=>mod.default||mod.renderMathInElement||mod)
    .catch(err=>{katexReady=null;throw err;});
  return katexReady;
}
async function renderLatexIn(root){
  if(!root)return;
  const inline=[...root.querySelectorAll('[data-katex-scan]')];
  const blocks=[...root.querySelectorAll('.notebook-latex')];
  if(!inline.length&&!blocks.length)return;
  try{
    const renderMathInElement=await loadKatex();
    for(const el of inline){
      renderMathInElement(el,{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\\\[',right:'\\\\]',display:true},{left:'$',right:'$',display:false},{left:'\\\\(',right:'\\\\)',display:false}],throwOnError:false});
    }
    for(const el of blocks){
      const raw=(el.textContent||'').trim();
      const wrapped=/^\\$\\$[\\s\\S]*\\$\\$$|^\\$[\\s\\S]*\\$$/.test(raw)?raw:'$$'+raw+'$$';
      el.textContent=wrapped;
      renderMathInElement(el,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false});
    }
  }catch(err){
    addTrace('katex_render_failed',{message:err.message||String(err)});
  }
}
const ANSI_COLORS={30:'#374151',31:'#DC2626',32:'#059669',33:'#B45309',34:'#2563EB',35:'#7C3AED',36:'#0891B2',37:'#4B5563',90:'#6B7280',91:'#EF4444',92:'#10B981',93:'#F59E0B',94:'#3B82F6',95:'#8B5CF6',96:'#06B6D4',97:'#111827'};
function ansiToHtml(text){
  const s=String(text??'');
  if(!s)return '';
  const re=/\\u001b\\[([0-9;]*)m/g;
  let html='',last=0,openTags=0,m;
  const closeAll=()=>{while(openTags>0){html+='</span>';openTags--;}};
  while((m=re.exec(s))!==null){
    if(m.index>last)html+=esc(s.slice(last,m.index));
    const codes=m[1].split(';').filter(x=>x!=='').map(Number);
    if(!codes.length||codes.includes(0)){closeAll();}
    else{
      let color=null,bg=null,bold=false,italic=false,underline=false;
      for(const n of codes){
        if(n===1)bold=true;
        else if(n===3)italic=true;
        else if(n===4)underline=true;
        else if(ANSI_COLORS[n])color=ANSI_COLORS[n];
        else if(n>=40&&n<=47)bg=ANSI_COLORS[n-10];
        else if(n>=100&&n<=107)bg=ANSI_COLORS[n-10];
      }
      const styles=[];
      if(color)styles.push('color:'+color);
      if(bg)styles.push('background:'+bg);
      if(bold)styles.push('font-weight:600');
      if(italic)styles.push('font-style:italic');
      if(underline)styles.push('text-decoration:underline');
      if(styles.length){html+='<span style="'+styles.join(';')+'">';openTags++;}
    }
    last=re.lastIndex;
  }
  if(last<s.length)html+=esc(s.slice(last));
  closeAll();
  return html;
}
async function mountNotebookCells(descriptors){
  if(!descriptors||!descriptors.length)return;
  let monaco;
  try{monaco=await loadMonaco();}catch{return;}
  for(const {hostId,source,language,cell,editable} of descriptors){
    const host=document.getElementById(hostId);
    if(!host)continue;
    host.querySelector('.notebook-code-fallback')?.remove();
    // Rough initial height so the page doesn't jump when Monaco settles.
    // Real height comes from onDidContentSizeChange once tokenization + wrap
    // are computed. Line count without wrap is a good lower bound.
    const lineCount=Math.max(1,String(source||'').split('\\n').length);
    const preHeight=Math.min(1200,Math.max(80,lineCount*19+22));
    host.style.height=preHeight+'px';
    let editor;
    try{
      editor=monaco.editor.create(host,{
        value:String(source||''),
        language:language||'plaintext',
        theme:'vs',
        readOnly:!editable,
        minimap:{enabled:false},
        fontSize:13,
        fontFamily:'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        lineNumbers:'off',
        scrollBeyondLastLine:false,
        wordWrap:'on',
        wrappingStrategy:'advanced',
        padding:{top:8,bottom:8},
        tabSize:4,
        renderWhitespace:'none',
        bracketPairColorization:{enabled:true},
        automaticLayout:true,
        scrollbar:{alwaysConsumeMouseWheel:false,verticalScrollbarSize:0,horizontalScrollbarSize:0,handleMouseWheel:false},
        guides:{indentation:false},
        renderLineHighlight:'none',
        overviewRulerLanes:0,
        hideCursorInOverviewRuler:true,
        occurrencesHighlight:false,
        contextmenu:false,
        stickyScroll:{enabled:false},
      });
    }catch(err){
      const pre=document.createElement('pre');
      pre.className='notebook-code-fallback';
      pre.textContent=String(source||'');
      host.replaceChildren(pre);
      continue;
    }
    notebookCellEditors.push({editor,cell});
    editor.onDidChangeModelContent(()=>{
      if(!activeNotebookState)return;
      setNotebookCellSource(cell,editor.getValue());
      const next=serializeNotebook(activeNotebookState.notebook);
      setFileDirty(activeNotebookState.path,next!==activeNotebookState.originalText,next);
    });
    // Auto-size cell to its FULL content — no in-cell vertical scrollbar,
    // no clip. The outer .notebook-preview handles page-level scrolling.
    let lastAppliedHeight=-1;
    const syncHeight=()=>{
      const raw=editor.getContentHeight();
      if(raw<=0)return;
      const target=Math.max(60,raw);
      if(Math.abs(target-lastAppliedHeight)<2)return;
      lastAppliedHeight=target;
      host.style.height=target+'px';
      try{editor.layout();}catch{}
    };
    editor.onDidContentSizeChange(syncHeight);
    // Kick off after first paint so tokenization + wrap have run.
    setTimeout(syncHeight,0);
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
function attachmentHtml(attachments){
  const files=Array.isArray(attachments)?attachments:[];
  if(!files.length)return '';
  return '<div class="message-attachments">'+files.map(file=>'<button type="button" class="message-attachment" data-open-upload="'+esc(file.path)+'"><span>'+esc(file.name||basename(file.path))+'</span><small>'+esc(attachmentHint(file))+' · '+esc(formatBytes(file.size))+'</small></button>').join('')+'</div>';
}
function addUserMessage(text, attachments=[]){
  document.getElementById('emptyChat')?.remove();
  const el=document.createElement('div');
  el.className='msg user';
  el.innerHTML='<div class="bubble">'+esc(text)+attachmentHtml(attachments)+'</div>';
  document.getElementById('threadInner').appendChild(el);
  el.querySelectorAll('[data-open-upload]').forEach(btn=>btn.addEventListener('click',()=>openFile(btn.dataset.openUpload)));
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
  if(modal) modal.hidden=true;
}
function showApprovalModal(data){
  pendingApproval=data||null;
  if(!pendingApproval)return;
  setApprovalModalOpen(false);
  pendingApprovalEl=attachApprovalToActivity(pendingApproval);
  setAgentTab('chat');
  scrollThread();
  const first=document.querySelector('[data-approval-decision]');
  if(first) first.focus();
}
function approvalActivityKey(approval){
  return approval?.call_id || approval?.tool_id || approval?.request_id || approval?.approval_id || approval?.tool || 'approval';
}
function attachApprovalToActivity(approval){
  const turn=ensureAssistantTurn();
  const key=approvalActivityKey(approval);
  let row=turn.byKey.get(key);
  const prompt=approval?.prompt||{};
  if(!row){
    row={key,level:'approval',message:approval?.tool || prompt.subject || 'Tool approval',ts:Date.now(),kind:'tool',detail:approval?.args?JSON.stringify(approval.args,null,2):''};
    turn.activity.push(row);
    turn.byKey.set(key,row);
  }
  row.level='approval';
  row.kind='tool';
  row.message=row.message || approval?.tool || prompt.subject || 'Tool approval';
  row.approval=approval;
  row.approvalResult=null;
  row.approvalFading=false;
  renderActivity(turn);
  return {turn,key};
}
function approvalButtonClass(value){
  const decision=String(value||'');
  if(decision==='reject')return ' approval-reject';
  if(decision==='approve')return ' approval-approve';
  return ' approval-secondary';
}
function approvalOptions(approval){
  return Array.isArray(approval?.options)&&approval.options.length
    ? approval.options.filter(option=>['approve','reject'].includes(String(option.value||'')))
    : [{label:'approve once',value:'approve',hint:'run this call'},{label:'cancel',value:'reject',hint:'do not run'}];
}
function activityApprovalHtml(approval,fading=false){
  if(!approval)return '';
  const prompt=approval.prompt||{};
  const options=approvalOptions(approval);
  const actions=options.map(option=>{
    const intent=approvalButtonClass(option.value);
    const hint=option.hint?' title="'+esc(option.hint)+'"':'';
    return '<button class="icon-button'+intent+'" type="button" data-approval-id="'+esc(approval.approval_id||'')+'" data-approval-decision="'+esc(option.value)+'"'+hint+'>'+esc(option.label)+'</button>';
  }).join('');
  return '<div class="activity-approval '+(fading?'fading':'')+'" data-inline-approval="'+esc(approval.approval_id||'')+'"><div class="activity-approval-head"><div class="activity-approval-title">'+esc(prompt.title||('Approval · '+(approval.tool||'tool')))+'</div><div class="activity-approval-meta">'+esc((approval.tier||approval.risk||'approval') + ' · ' + compactId(approval.approval_id||''))+'</div></div><div class="activity-approval-subject">'+esc(prompt.subject || approval.tool || 'Tool request')+'</div><div class="activity-approval-reason">'+esc(prompt.reason || approval.reason || '')+'</div><div class="activity-approval-actions">'+actions+'</div></div>';
}
function approvalLineHtml(approval,decision,message=''){
  const approved=decision!=='reject';
  const prompt=approval?.prompt||{};
  const tool=approval?.tool||prompt.subject||'tool';
  const scope=approval?.scope?(' · '+approval.scope):'';
  const label=approved?'approved':'denied';
  const reason=message?(' · '+message):'';
  return '<div class="approval-result-line '+(approved?'approved':'denied')+'" title="'+esc(prompt.subject||tool)+'"><span>'+label+'</span><span class="approval-result-tool">'+esc(tool+scope+reason)+'</span></div>';
}
function findApprovalRow(approval){
  const key=approvalActivityKey(approval);
  if(activeTurn?.byKey?.has(key))return {turn:activeTurn,row:activeTurn.byKey.get(key)};
  return null;
}
function resolveInlineApproval(decision,message,approval=pendingApproval){
  const found=findApprovalRow(approval);
  if(!found)return;
  pendingApprovalEl=null;
  found.row.approvalFading=true;
  renderActivity(found.turn);
  setTimeout(()=>{
    found.row.approval=null;
    found.row.approvalFading=false;
    found.row.approvalResult={approval,decision,message};
    found.row.level=decision==='reject'?'error':'running';
    renderActivity(found.turn);
    scrollThread();
  },850);
}
async function submitApproval(decision){
  if(!pendingApproval?.approval_id)return;
  const approval=pendingApproval;
  document.querySelectorAll('[data-approval-decision]').forEach(btn=>{btn.disabled=true;});
  try {
    await api('/api/approvals/'+encodeURIComponent(approval.approval_id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision})});
    addTrace('approval_decision', {approval_id:approval.approval_id, decision});
    resolveInlineApproval(decision,'',approval);
  } catch (err) {
    addTrace('approval_error', {approval_id:approval.approval_id, message:err.message});
    resolveInlineApproval('reject', err.message || 'Approval decision failed.', approval);
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
  else{row={key,level,message,ts:Date.now(),...opts};turn.activity.push(row);if(key)turn.byKey.set(key,row);}
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
  card.querySelector('.activity-rows').innerHTML=rows.slice(card.classList.contains('expanded')?0:-4).map(r=>{
    const approval=r.approval?activityApprovalHtml(r.approval,r.approvalFading):'';
    const result=r.approvalResult?'<div class="activity-result">'+approvalLineHtml(r.approvalResult.approval,r.approvalResult.decision,r.approvalResult.message)+'</div>':'';
    const detail=r.detail?'<pre>'+esc(r.detail)+'</pre>':'';
    return '<div class="activity-row '+esc(r.level||'')+'" data-activity-key="'+esc(r.key||'')+'"><span class="status-dot"></span><span class="activity-main"><span class="activity-message">'+esc(r.message)+'</span>'+approval+result+detail+'</span></div>';
  }).join('');
  card.querySelectorAll('[data-approval-decision]').forEach(btn=>btn.addEventListener('click',()=>submitApproval(btn.dataset.approvalDecision)));
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
function setTurnRunning(running){
  turnRunning=Boolean(running);
  if(!turnRunning)turnCancelling=false;
  const send=document.getElementById('send');
  const stop=document.getElementById('stopAgent');
  const prompt=document.getElementById('prompt');
  if(send){send.textContent=turnRunning?'Follow up':'Send';send.disabled=turnCancelling;}
  if(stop){stop.hidden=!turnRunning;stop.disabled=turnCancelling;}
  if(prompt)prompt.placeholder=turnRunning?'Send a follow-up to the running agent':'Ask about this local workspace';
}
function setTurnCancelling(cancelling){
  turnCancelling=Boolean(cancelling);
  const send=document.getElementById('send');
  const stop=document.getElementById('stopAgent');
  if(send)send.disabled=turnCancelling;
  if(stop)stop.disabled=turnCancelling;
}
function finishCancelledTurn(data={}){
  addActivity('error', data.reason || 'Cancelled by user', {key:'turn-cancelled', kind:'status'});
  if(activeTurn){activeTurn.active=false;renderActivity(activeTurn);activeTurn=null;}
  setTurnRunning(false);
  setTurnCancelling(false);
  document.getElementById('bridgeState').textContent='cancelled';
  document.getElementById('sendStatus').textContent='Cancelled';
}
async function stopAgentTurn(){
  if(!turnRunning||turnCancelling)return;
  setTurnCancelling(true);
  document.getElementById('sendStatus').textContent='Cancelling...';
  addActivity('thinking','Cancellation requested', {key:'turn-cancel-request', kind:'status'});
  try{
    const result=await api('/api/agent/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'Cancelled by user'})});
    if(result.status==='idle'){
      setTurnRunning(false);
      setTurnCancelling(false);
      document.getElementById('sendStatus').textContent='No running task';
    }else{
      addActivity('thinking','Cancellation sent', {key:'turn-cancel-request', kind:'status'});
    }
  }catch(err){
    setTurnCancelling(false);
    document.getElementById('sendStatus').textContent=err.message;
    addActivity('error','Cancellation failed',{key:'turn-cancel-request',kind:'status',detail:err.message});
  }
}
function setApprovalAutoUi(enabled){
  approvalAutoMode=Boolean(enabled);
  const input=document.getElementById('approvalAuto');
  const label=document.getElementById('approvalAutoLabel');
  if(input)input.checked=approvalAutoMode;
  if(label)label.textContent=approvalAutoMode?'Auto on':'Auto off';
}
async function loadApprovalMode(){
  try{
    const result=await api('/api/approvals/mode');
    setApprovalAutoUi(Boolean(result.auto));
  }catch(err){
    addTrace('approval_mode_error',{message:err.message});
  }
}
async function setApprovalAutoMode(enabled){
  setApprovalAutoUi(enabled);
  try{
    const result=await api('/api/approvals/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auto:enabled})});
    setApprovalAutoUi(Boolean(result.auto));
    addTrace('approval_mode',{mode:result.mode});
  }catch(err){
    setApprovalAutoUi(!enabled);
    addTrace('approval_mode_error',{message:err.message});
  }
}
async function handleLocalSlashCommand(rawPrompt){
  const text=String(rawPrompt||'').trim();
  if(!text.startsWith('/'))return false;
  const parts=text.split(/\\s+/).filter(Boolean);
  const command=String(parts[0]||'').toLowerCase();
  if(command!=='/auto')return false;
  const mode=String(parts[1]||'on').toLowerCase();
  if(['on','enable','enabled','true','1'].includes(mode)){
    await setApprovalAutoMode(true);
    document.getElementById('sendStatus').textContent='Auto mode on';
    addTrace('command',{command:'/auto on',mode:'auto'});
    return true;
  }
  if(['off','disable','disabled','false','0'].includes(mode)){
    await setApprovalAutoMode(false);
    document.getElementById('sendStatus').textContent='Auto mode off';
    addTrace('command',{command:'/auto off',mode:'ask'});
    return true;
  }
  if(mode==='status'){
    const modeLabel=approvalAutoMode?'auto':'ask';
    document.getElementById('sendStatus').textContent='Approval mode: '+modeLabel;
    addTrace('command',{command:'/auto status',mode:modeLabel});
    return true;
  }
  if(['full','dangerous','yolo'].includes(mode)){
    document.getElementById('sendStatus').textContent='/auto full is available only in the terminal CLI';
    addTrace('command_ignored',{command:text,reason:'full auto is not exposed in the browser workspace'});
    return true;
  }
  document.getElementById('sendStatus').textContent='Usage: /auto [on|off|status]';
  addTrace('command_error',{command:text,message:'Usage: /auto [on|off|status]'});
  return true;
}
function followupMessage(data){
  const status=String(data?.status||'');
  if(status==='accepted')return 'Follow-up sent to running agent';
  if(status==='delivered')return 'Follow-up delivered to agent';
  if(status==='queued')return 'Follow-up queued';
  if(status==='waiting_for_task')return 'Follow-up waiting for agent task';
  if(status==='duplicate')return 'Follow-up already sent';
  if(status==='queued_next_turn')return 'Follow-up queued for next turn';
  if(status==='error')return 'Follow-up failed';
  return 'Follow-up status: '+(status||'unknown');
}
function shouldQueueFollowup(result){
  const status=String(result?.status||'');
  return status==='queued_next_turn'||status==='no_task';
}
function queueFollowupNextTurn(prompt,attachments=[],path=currentPath,reason='',id=''){
  prompt=String(prompt||'').trim();
  if(!prompt)return;
  const key=id||prompt;
  if(queuedFollowupIds.has(key))return;
  queuedFollowupIds.add(key);
  queuedFollowups.push({prompt,attachments,path,id:key});
  document.getElementById('sendStatus').textContent=reason||'Queued for next turn';
}
async function runAgentTurn(prompt,attachments=[],path=currentPath,{displayed=false}={}){
  if(!displayed)addUserMessage(prompt,attachments);
  activeTurn=null;
  setTurnRunning(true);
  document.getElementById('sendStatus').textContent='Sending...';
  try{
    await api('/api/agent/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,path,attachments})});
  }catch(err){
    document.getElementById('sendStatus').textContent=err.message;
    document.getElementById('bridgeState').textContent=err.status===401?'auth required':'error';
    setTurnRunning(false);
    addActivity('error',(err.status?err.status+' ':'')+err.message);
    pendingAttachments=attachments.concat(pendingAttachments);
    renderUploadTray();
  }
}
function runNextQueuedFollowup(){
  if(turnRunning||!queuedFollowups.length)return;
  const next=queuedFollowups.shift();
  queuedFollowupIds.delete(next.id);
  document.getElementById('sendStatus').textContent='Running queued follow-up...';
  runAgentTurn(next.prompt,next.attachments,next.path,{displayed:true});
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
    if(data.approval_mode)setApprovalAutoUi(data.approval_mode==='auto');
    return;
  }
  if (type === 'agent_approval_mode') {
    setApprovalAutoUi(Boolean(data.auto));
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
  if (type === 'agent_approval_event') {
    if(data.state==='required'){
      addActivity('approval', data.tool || 'Tool approval', {key:data.call_id||data.approval_id||data.tool, kind:'tool', detail:data.args?JSON.stringify(data.args,null,2):''});
    } else if(data.state==='granted'||data.state==='denied') {
      addActivity(data.state==='granted'?'running':'error', (data.tool||'tool')+' '+data.state, {key:data.call_id||data.approval_id||data.tool, kind:'tool'});
    }
    return;
  }
  if (type === 'agent_approval_resolved') {
    if(pendingApproval?.approval_id===data.approval_id){
      resolveInlineApproval(data.approved?'approve':'reject', data.reason || '', {...pendingApproval,...data});
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
    setTurnRunning(true);
    document.getElementById('bridgeState').textContent = 'running';
    return;
  }
  if (type === 'agent_cancel_requested') {
    setTurnCancelling(true);
    document.getElementById('bridgeState').textContent = 'cancelling';
    document.getElementById('sendStatus').textContent = 'Cancelling...';
    addActivity('thinking','Cancellation requested', {key:'turn-cancel-request', kind:'status'});
    return;
  }
  if (type === 'agent_turn_cancelled' || type === 'cancelled') {
    finishCancelledTurn(data);
    return;
  }
  if (type === 'agent_turn_complete') {
    if(activeTurn){activeTurn.active=false;renderActivity(activeTurn);activeTurn=null;}
    setTurnRunning(false);
    document.getElementById('bridgeState').textContent = 'ready';
    document.getElementById('sendStatus').textContent = 'Done';
    runNextQueuedFollowup();
    return;
  }
  if (type === 'agent_error') {
    setTurnRunning(false);
    document.getElementById('bridgeState').textContent = 'error';
    document.getElementById('sendStatus').textContent = data.message || data.error || 'Agent error';
    addActivity('error', data.message || data.error || 'Agent error', {detail: data.code || ''});
    return;
  }
  if (type === 'agent_followup_status') {
    addActivity(data.ok===false?'error':'thinking', followupMessage(data), {key:data.intervention_id||'followup', kind:'followup', detail:data.error||data.instruction||''});
    if(shouldQueueFollowup(data))queueFollowupNextTurn(data.instruction||'',[],currentPath,followupMessage(data),data.intervention_id||'');
    document.getElementById('sendStatus').textContent=followupMessage(data);
    return;
  }
  if (type === 'agent_followup_event') {
    const inner=data.data||{};
    addActivity('done', followupMessage({status:String(data.type||'').replace('user_intervention_',''), intervention_id:inner.intervention_id}), {key:inner.intervention_id||data.type, kind:'followup', detail:inner.delivered_at_tool||''});
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
  'session_started','file_browsed','file_read','file_uploaded','file_saved','tool_execution_requested','session_stopped',
  'agent_turn_requested','agent_relay_ready','agent_turn_started','agent_cancel_requested','agent_turn_cancelled','agent_turn_complete','cancelled',
  'agent_history_loaded','agent_history_new','agent_approval_mode','agent_approval_event','agent_approval_required','agent_approval_resolved','agent_followup_requested','agent_followup_status','agent_followup_event','agent_session','agent_status','agent_reasoning','agent_content','agent_tool_call',
  'agent_tool_result','agent_activity','agent_complete','agent_error','agent_event'
].forEach(type => {
  es.addEventListener(type, evt => { try { handleRelayEvent(type, JSON.parse(evt.data)); } catch {} });
});
document.getElementById('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rawPrompt = document.getElementById('prompt').value.trim();
  if(await handleLocalSlashCommand(rawPrompt)){
    document.getElementById('prompt').value='';
    return;
  }
  const attachments = pendingAttachments.slice();
  const prompt = rawPrompt || (attachments.length ? 'Review the attached files.' : '');
  if (!prompt && !attachments.length) return;
  if(turnCancelling){document.getElementById('sendStatus').textContent='Cancelling...';return;}
  setSessionMenuOpen(false);
  if(!historySelectionReady) historySelectionReady=true;
  addUserMessage(prompt, attachments);
  document.getElementById('prompt').value='';
  pendingAttachments=[];
  renderUploadTray();
  const followup=turnRunning;
  if(followup){
    const attachmentLines=attachments.length?('\\n\\nAttached files for this follow-up:\\n'+attachments.map(file=>'- '+(file.name||basename(file.path))+' path='+file.path).join('\\n')):'';
    document.getElementById('sendStatus').textContent = 'Sending follow-up...';
    try {
      const result=await api('/api/agent/followup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt: prompt+attachmentLines }) });
      document.getElementById('sendStatus').textContent = followupMessage(result);
      if(shouldQueueFollowup(result))queueFollowupNextTurn(prompt+attachmentLines,attachments,currentPath,followupMessage(result),result.intervention_id||'');
      if(result.ok===false)addActivity('error', followupMessage(result), {key:result.intervention_id||'followup', kind:'followup', detail:result.error||''});
    } catch (err) {
      document.getElementById('sendStatus').textContent = err.message;
      addActivity('error', (err.status ? err.status + ' ' : '') + err.message);
      pendingAttachments=attachments.concat(pendingAttachments);
      renderUploadTray();
    }
    return;
  }
  activeTurn=null;
  setTurnRunning(true);
  document.getElementById('sendStatus').textContent = 'Sending...';
  try {
    await api('/api/agent/turn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt, path: currentPath, attachments }) });
  } catch (err) {
    document.getElementById('sendStatus').textContent = err.message;
    document.getElementById('bridgeState').textContent = err.status === 401 ? 'auth required' : 'error';
    setTurnRunning(false);
    addActivity('error', (err.status ? err.status + ' ' : '') + err.message);
    pendingAttachments=attachments.concat(pendingAttachments);
    renderUploadTray();
  }
});
document.getElementById('prompt').addEventListener('keydown', e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();document.getElementById('composer').requestSubmit();}});
document.getElementById('attachFiles').addEventListener('click',()=>document.getElementById('fileUpload').click());
document.getElementById('stopAgent').addEventListener('click',stopAgentTurn);
document.getElementById('fileUpload').addEventListener('change',async(e)=>{
  try{await uploadFiles(e.target.files||[]);}catch(err){document.getElementById('sendStatus').textContent=err.message;addActivity('error','Upload failed',{detail:err.message});}
  finally{e.target.value='';}
});
document.querySelectorAll('[data-agent-tab]').forEach(btn=>btn.addEventListener('click',()=>setAgentTab(btn.dataset.agentTab)));
document.getElementById('sessionMenuButton').addEventListener('click',(e)=>{e.stopPropagation();setSessionMenuOpen(!sessionMenuOpen);});
document.getElementById('sessionModalClose').addEventListener('click',()=>setSessionMenuOpen(false));
document.getElementById('sessionModal').addEventListener('click',(e)=>{if(e.target.id==='sessionModal')setSessionMenuOpen(false);});
document.getElementById('approvalDenyTop').addEventListener('click',()=>submitApproval('reject'));
document.getElementById('approvalAuto').addEventListener('change',e=>setApprovalAutoMode(e.target.checked));
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'&&pendingApproval){submitApproval('reject');return;}if(e.key==='Escape'&&sessionMenuOpen){setSessionMenuOpen(false);return;}if(e.key==='Escape'&&previewMaximized)setPreviewMaximized(false);});
document.getElementById('refreshFiles').addEventListener('click',()=>{dirCache.clear();loadDir('.');});
document.getElementById('toggleExplorer').addEventListener('click',()=>{let prefs={explorerVisible:true};try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}saveLayoutPatch({explorerVisible:!prefs.explorerVisible});});
document.getElementById('toggleAgent').addEventListener('click',()=>{let prefs={agentVisible:true};try{prefs={...prefs,...JSON.parse(localStorage.getItem(layoutKey)||'{}')};}catch{}saveLayoutPatch({agentVisible:!prefs.agentVisible});});
applyLayout();
setupResizers();
renderTabs();
renderEmptyViewer();
loadApprovalMode();
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
