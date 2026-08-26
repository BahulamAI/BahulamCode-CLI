/**
 * HTTP + WebSocket dashboard — mirrors the CLI session in a browser.
 *
 * Uses ONLY Node built-ins (http, crypto, buffer). No npm dependencies.
 * Serves an inline single-page HTML dashboard with a WebSocket-backed event
 * stream showing agent/sub-agent activity, tool calls, handoffs, spawns.
 *
 * Architecture (matching socket-server.mjs):
 *   startHttpDashboard({ sessionId, port }) -> { url, broadcastEvent, close }
 *   - Registers itself via registerBroadcaster(fn) from event-tap.mjs
 *   - Binds to 127.0.0.1 only
 *   - WebSocket at /ws (RFC 6455 handshake)
 *   - Dashboard HTML served at /
 *   - Auth token in URL path for basic access control
 *
 * @module
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { registerBroadcaster } from './event-tap.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {number} [opts.port=0]        — 0 = OS-assigned
 * @param {string} [opts.secret]         — random token for URL path
 * @returns {Promise<{url:string, port:number, broadcastEvent:(obj:any)=>void, close:()=>void}>}
 */
export async function startHttpDashboard({ sessionId, port = 0, secret } = {}) {
  const token = secret || crypto.randomBytes(12).toString('hex');
  const pathPrefix = `/dashboard/${token}`;

  /** @type {Set<import('net').Socket>} */
  const wsClients = new Set();

  const server = http.createServer((req, res) => {
    // WebSocket upgrade
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      return handleWebSocketUpgrade(req, res, wsClients);
    }
    // Serve the HTML dashboard
    if (req.url.startsWith(pathPrefix) || req.url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(DASHBOARD_HTML(token));
      return;
    }
    // Health endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId, clients: wsClients.size }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  // Bind to localhost only
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(addr);
    });
    server.once('error', reject);
  });

  const addr = server.address();
  const actualPort = addr.port;
  const url = `http://127.0.0.1:${actualPort}/${pathPrefix}`;

  // Register as event broadcaster so tapSseEvent pushes to us
  const unregister = registerBroadcaster((event) => {
    broadcastEvent(event);
  });

  function broadcastEvent(obj) {
    if (wsClients.size === 0) return;
    const frame = encodeWSFrame(JSON.stringify(obj));
    for (const sock of wsClients) {
      try { sock.write(frame); } catch { /* single-client failure doesn't cascade */ }
    }
  }

  function close() {
    unregister();
    for (const sock of wsClients) {
      try { sock.end(); } catch { /* no-op */ }
    }
    wsClients.clear();
    server.close();
  }

  return { url, port: actualPort, broadcastEvent, close };
}

// ── WebSocket helpers (RFC 6455, text frames only) ──

function handleWebSocketUpgrade(req, sock, clients) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    sock.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );
  clients.add(sock);
  sock.once('close', () => clients.delete(sock));
  sock.once('error', () => clients.delete(sock));
}

function encodeWSFrame(payload) {
  const data = Buffer.from(payload, 'utf-8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

// ── Inline Dashboard HTML ──

function DASHBOARD_HTML(token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Bahulam Agent Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#c9d1d9;
  --dim:#8b949e;--green:#3fb950;--cyan:#58a6ff;--yellow:#d29922;
  --red:#f85149;--brand:#58a6ff}
body{background:var(--bg);color:var(--text);font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
  font-size:13px;line-height:1.5;padding:16px;overflow-y:scroll}
h1{font-size:16px;font-weight:600;color:var(--brand);margin-bottom:8px;display:flex;align-items:center;gap:8px}
h1 small{font-size:11px;color:var(--dim);font-weight:400}
#status{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 12px;font-size:12px}
.stat .num{color:var(--brand);font-weight:600}
.stat .lbl{color:var(--dim)}
.toolbar{margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap}
.toolbar button{background:var(--surface);border:1px solid var(--border);color:var(--text);
  padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit}
.toolbar button.active{background:var(--brand);color:#fff;border-color:var(--brand)}
.toolbar button:hover{background:var(--border)}
.split{display:flex;gap:12px;height:calc(100vh - 160px)}
.panel{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:6px;
  overflow-y:auto;padding:4px 0;min-width:0}
.panel h2{font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;
  letter-spacing:0.5px;padding:6px 10px;border-bottom:1px solid var(--border);position:sticky;top:0;
  background:var(--surface);z-index:1}
.event-line{padding:2px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;border-bottom:1px solid #1c2128}
.event-line:hover{background:#1c2128}
.tag{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:600;margin-right:4px}
.tag-spawn{background:#1b3628;color:var(--green)}
.tag-active{background:#1c2d45;color:var(--cyan)}
.tag-done{background:#1b3628;color:var(--green)}
.tag-tool{background:#26242b;color:var(--dim)}
.tag-handoff{background:#2a2318;color:var(--yellow)}
.tag-error{background:#2d1b1b;color:var(--red)}
.time{color:var(--dim);font-size:11px;margin-left:6px}
.detail{color:var(--dim)}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<h1>⚡ Agent Dashboard <small id="sessionLabel">connecting…</small></h1>
<div id="status">
  <div class="stat"><span class="num" id="statEvents">0</span> <span class="lbl">events</span></div>
  <div class="stat"><span class="num" id="statSubAgents">0</span> <span class="lbl">sub-agents</span></div>
  <div class="stat"><span class="num" id="statTools">0</span> <span class="lbl">tools</span></div>
  <div class="stat"><span class="num" id="statHandoffs">0</span> <span class="lbl">handoffs</span></div>
  <div class="stat"><span class="lbl" id="connStatus">● disconnected</span></div>
</div>
<div class="toolbar">
  <button data-filter="all" class="active">All</button>
  <button data-filter="sub_agent_start,sub_agent_complete">Sub-Agents</button>
  <button data-filter="delegation">Handoffs</button>
  <button data-filter="tool_call,tool_done">Tools</button>
  <button data-filter="error">Errors</button>
  <button id="btnAutoScroll" class="active">Auto-scroll</button>
  <button id="btnClear">Clear</button>
</div>
<div class="split">
  <div class="panel" id="eventLog"><h2>Event Log</h2></div>
  <div class="panel" id="subAgentTree"><h2>Sub-Agent Activity</h2></div>
</div>
<script>
(function(){
const token = '${token}';
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = wsProto + '//' + location.host + '/ws';
let ws;
let filters = ['all'];
let autoScroll = true;
let eventCount = 0;
let subAgentCount = 0;
let toolCount = 0;
let handoffCount = 0;
// Sub-agent state: id -> { id, type, query, startTime, tools, status }
const subAgents = new Map();

function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => { document.getElementById('connStatus').textContent = '● connected'; };
  ws.onclose = () => {
    document.getElementById('connStatus').textContent = '● disconnected';
    setTimeout(connect, 3000);
  };
  ws.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      handleEvent(ev);
    } catch(e) { /* ignore parse errors */ }
  };
}

function handleEvent(ev) {
  eventCount++;
  updateStats();
  const line = renderEventLine(ev);
  if (line) appendEvent(line);
  updateSubAgentTree(ev);
}

function renderEventLine(ev) {
  const type = ev.type || 'unknown';
  const data = ev.data || {};
  const now = Date.now();
  let tag, label, detail = '';

  switch(type) {
    case 'sub_agent_start':
      tag = '<span class="tag tag-spawn">spawn</span>';
      label = (data.type || 'agent') + (data.query ? ' "' + data.query.slice(0, 60) + '"' : '');
      subAgentCount++; toolCount++; break;
    case 'sub_agent_complete':
      tag = '<span class="tag tag-done">done</span>';
      label = (data.type || 'agent');
      detail = data.tool_calls != null ? ' · ' + data.tool_calls + ' tools' : '';
      if (data.duration_s) detail += ' · ' + data.duration_s.toFixed(1) + 's';
      break;
    case 'delegation':
      tag = '<span class="tag tag-handoff">handoff</span>';
      label = (data.from || '?') + ' → ' + (data.to || '?');
      if (data.instruction) detail = ' "' + data.instruction.slice(0, 50) + '"';
      handoffCount++; break;
    case 'tool_call':
    case 'tool_request':
      tag = '<span class="tag tag-tool">▶ tool</span>';
      label = (data.tool || '?') + (data.args && data.args.file_path ? ' ' + data.args.file_path : '');
      toolCount++; break;
    case 'tool_done':
    case 'tool_result':
      tag = '<span class="tag tag-tool">✓ tool</span>';
      label = (data.tool || '?');
      if (data.duration_s) detail = ' · ' + data.duration_s.toFixed(1) + 's';
      break;
    case 'error':
      tag = '<span class="tag tag-error">error</span>';
      label = (data.message || '').slice(0, 80);
      break;
    case 'complete':
      tag = '<span class="tag tag-done">complete</span>';
      label = 'Agent finished';
      if (data.tool_calls) detail = ' · ' + data.tool_calls + ' tools';
      break;
    case 'thinking':
      return null; // too noisy
    case 'content':
    case 'content_partial':
      return null;
    default:
      tag = '<span class="tag tag-active">' + type.slice(0, 8) + '</span>';
      label = type;
  }

  eventCount++;
  updateStats();
  return '<div class="event-line">' + tag + esc(label) + '<span class="detail">' + esc(detail) + '</span></div>';
}

function appendEvent(html) {
  if (!html) return;
  const log = document.getElementById('eventLog');
  log.insertAdjacentHTML('beforeend', html);
  if (autoScroll) log.scrollTop = log.scrollHeight;
}

function updateSubAgentTree(ev) {
  const type = ev.type;
  const data = ev.data || {};
  const container = document.getElementById('subAgentTree');
  let changed = false;

  if (type === 'sub_agent_start') {
    const id = data.id || 'sa-' + Date.now();
    subAgents.set(id, { id, type: data.type || 'agent', query: data.query || '', startTime: Date.now(), tools: 0, status: 'active' });
    changed = true;
  } else if (type === 'sub_agent_complete') {
    const id = data.id;
    if (id && subAgents.has(id)) {
      const sa = subAgents.get(id);
      sa.status = 'done';
      sa.tools = data.tool_calls || sa.tools;
      changed = true;
    }
  } else if (type === 'sub_agent_tool') {
    const agentType = data.type || '';
    // Find the most recent active sub-agent of this type
    let found = null;
    for (const [id, sa] of subAgents) {
      if (sa.type === agentType && sa.status === 'active') { found = sa; }
    }
    if (found) { found.tools++; changed = true; }
  }

  if (changed) {
    let html = '<h2>Sub-Agent Activity</h2>';
    if (subAgents.size === 0) { html += '<div class="event-line" style="color:var(--dim)">(none yet)</div>'; }
    else {
      for (const [id, sa] of subAgents) {
        const elapsed = ((Date.now() - sa.startTime) / 1000).toFixed(1);
        const statusTag = sa.status === 'active'
          ? '<span class="tag tag-active">active</span>'
          : '<span class="tag tag-done">done</span>';
        html += '<div class="event-line">' + statusTag + ' <b>' + esc(sa.type) + '</b>';
        if (sa.query) html += ' ' + esc(sa.query.slice(0, 40));
        html += ' · <span class="time">' + sa.tools + ' tools · ' + elapsed + 's</span></div>';
      }
    }
    container.innerHTML = html;
  }
}

function updateStats() {
  document.getElementById('statEvents').textContent = eventCount;
  document.getElementById('statSubAgents').textContent = subAgents.size;
  document.getElementById('statTools').textContent = toolCount;
  document.getElementById('statHandoffs').textContent = handoffCount;
}

function esc(s) { return String(s || '').replace(/[&<>"]/g, function(m) {
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]; });
}

// Toolbar filter buttons
document.querySelectorAll('[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filters = btn.dataset.filter === 'all' ? ['all'] : btn.dataset.filter.split(',');
  });
});

document.getElementById('btnAutoScroll').addEventListener('click', function() {
  autoScroll = !autoScroll;
  this.classList.toggle('active');
});

document.getElementById('btnClear').addEventListener('click', () => {
  document.getElementById('eventLog').innerHTML = '<h2>Event Log</h2>';
  document.getElementById('subAgentTree').innerHTML = '<h2>Sub-Agent Activity</h2>';
  subAgents.clear();
  eventCount = 0; subAgentCount = 0; toolCount = 0; handoffCount = 0;
  updateStats();
});

connect();
})();
</script>
</body>
</html>`;
}