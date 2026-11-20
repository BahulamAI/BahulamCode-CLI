/**
 * `bahulam graph` — visualize the per-repo code reference graph in a browser.
 *
 * Zero npm dependencies: node:http + inline HTML/JS. The renderer is a
 * vanilla-JS port of the auto-ontology frontend's MemoryGraphView
 * (deterministic radial "sunflower" layout, no physics/WebGL).
 *
 * Data source: ~/.bahulam/projects/{hash}/index/graph.json produced by
 * GraphIndexer (src/context/graph-indexer.mjs). Repo identity comes from the
 * sibling project-resource.json (src/tools/project-overview.mjs).
 *
 * Usage:
 *   bahulam graph                  Open the graph for the current repo
 *   bahulam graph --project <dir>  Open a specific repo
 *   bahulam graph --list           List indexed repos and exit
 *   bahulam graph --port 4320 --no-open
 */

import http from 'node:http';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { listIndexedGraphs, loadGraphJson, adaptGraph } from './adapter.mjs';

const DEFAULT_PORT = 4320;

function parseGraphArgs(argv) {
  const parsed = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    open: true,
    list: false,
    project: null,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h': parsed.help = true; break;
      case '--port': parsed.port = Number(argv[++i]) || DEFAULT_PORT; break;
      case '--host': parsed.host = argv[++i] || '127.0.0.1'; break;
      case '--no-open': parsed.open = false; break;
      case '--list': case '-l': parsed.list = true; break;
      case '--project': case '-p': parsed.project = argv[++i]; break;
      default:
        if (!arg.startsWith('-')) positional.push(arg);
        break;
    }
  }
  if (!parsed.project && positional.length > 0) parsed.project = positional[0];
  return parsed;
}

function openBrowser(url) {
  try {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execSync(`${cmd} "${url}"`, { stdio: 'ignore', timeout: 3000 });
  } catch { /* browser open is best-effort */ }
}

function writeJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * CLI entry: `bahulam graph ...`
 * @param {string[]} subcommandArgs
 */
export async function runGraphCommand(subcommandArgs) {
  const args = parseGraphArgs(subcommandArgs);

  if (args.help) {
    process.stdout.write(
      'Usage: bahulam graph [path] [--project <dir>] [--port <n>] [--host <ip>] [--no-open] [--list]\n' +
      '  bahulam graph             Visualize the current repo code graph in a browser\n' +
      '  bahulam graph --list      List repos with an indexed code graph\n' +
      '  bahulam graph --project <dir>  Open a specific project\'s graph\n'
    );
    return;
  }

  // ── --list: print indexed repos, no server ──
  if (args.list) {
    const repos = listIndexedGraphs();
    if (repos.length === 0) {
      process.stdout.write('No indexed code graphs found. Run `bahulam` in a project once so the context indexer builds graph.json.\n');
      return;
    }
    process.stdout.write('hash             nodes  edges  repo\n');
    for (const r of repos) {
      process.stdout.write(`${r.hash.padEnd(16)} ${String(r.nodeCount).padEnd(6)} ${String(r.edgeCount).padEnd(6)} ${r.name}\n`);
    }
    return;
  }

  // ── resolve target repo ──
  const repos = listIndexedGraphs();
  let target = null;
  const cwd = process.cwd();
  if (args.project) {
    const proj = path.resolve(args.project);
    target = repos.find(r => r.root === proj) || null;
    if (!target) {
      // Maybe the caller passed a repo name/hash
      target = repos.find(r => r.name === args.project || r.hash === args.project) || null;
    }
  } else {
    target = repos.find(r => {
      try { return path.resolve(r.root) === cwd; } catch { return false; }
    }) || null;
    // fall back to the most recent graph when the cwd isn't indexed
    if (!target && repos.length > 0) {
      target = repos[0];
      process.stderr.write(`\x1b[2mNo index for ${cwd}; opening most recent: ${target.name}\x1b[0m\n`);
    }
  }

  if (!target) {
    process.stderr.write('\x1b[33m! No graph index found. Run `bahulam` in the project once so the context indexer builds the code graph.\x1b[0m\n');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/graphs') {
      writeJson(res, { repos: repos.map(r => ({ ...r })) });
      return;
    }
    if (url.pathname === '/api/graph') {
      const hash = url.searchParams.get('hash');
      const projPath = url.searchParams.get('path');
      let repo = repos.find(r => r.hash === hash);
      if (!repo && projPath) {
        const resolved = path.resolve(projPath);
        repo = repos.find(r => path.resolve(r.root) === resolved) || null;
      }
      if (!repo) {
        writeJson(res, { error: 'no_graph_index' }, 404);
        return;
      }
      const raw = loadGraphJson(repo.root);
      const payload = adaptGraph(raw, repo);
      payload.repos = repos.map(r => ({ ...r }));
      writeJson(res, payload);
      return;
    }
    if (url.pathname === '/health') {
      writeJson(res, { ok: true });
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(GRAPH_HTML());
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.host, resolve);
  });

  const url = `http://${args.host}:${server.address().port}/?hash=${encodeURIComponent(target.hash)}`;
  process.stderr.write(`\x1b[2mCode graph: ${target.name} (${target.nodeCount} files, ${target.edgeCount} edges)\x1b[0m\n`);
  process.stderr.write(`\x1b[2mOpen: \x1b[36m${url}\x1b[0m\n`);
  if (args.open) openBrowser(url);
  process.stderr.write('\x1b[2mPress Ctrl+C to stop\x1b[0m\n');
  server.on('close', () => process.exit(0));
}

// ── Inline viewer (vanilla JS port of MemoryGraphView) ──────────────────

function GRAPH_HTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Bahulam Code Graph</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#c9d1d9;
  --dim:#8b949e;--green:#3fb950;--cyan:#58a6ff;--yellow:#d29922;--red:#f85149;--brand:#58a6ff}
body{background:var(--bg);color:var(--text);font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:15px;font-weight:600;color:var(--brand);margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h1 small{font-size:11px;color:var(--dim);font-weight:400}
select,input{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:3px 6px;font-size:12px;font-family:inherit}
label{color:var(--dim);font-size:11px;margin-right:4px}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.toolbar .sep{border-left:1px solid var(--border);height:18px}
button{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit}
button.active{background:var(--brand);color:#fff;border-color:var(--brand)}
#stats{color:var(--dim);font-size:11px;margin-bottom:8px}
#stats b{color:var(--brand)}
.layout{display:flex;gap:12px;align-items:flex-start}
#svgWrap{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:auto;min-width:0}
svg{display:block;width:100%;height:auto}
.edge{stroke:var(--border)}
.edge-unresolved{stroke:var(--red);stroke-dasharray:4 3}
.edge-dim{opacity:0.15}
.edge-lit{opacity:0.9}
.node{cursor:pointer}
.node text{fill:var(--text);font-size:10px;pointer-events:none}
.node-ghost{stroke-dasharray:3 2}
#side{width:280px;flex-shrink:0;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px;max-height:720px;overflow-y:auto;font-size:12px}
#side h2{font-size:11px;text-transform:uppercase;color:var(--dim);letter-spacing:0.5px;margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:4px}
#side .kv{display:flex;gap:6px;margin-bottom:4px}
#side .kv .k{color:var(--dim);min-width:70px}
#side .rel{border-top:1px solid #1c2128;padding:4px 0;font-size:11px}
#side .rel .dir{color:var(--dim)}
#side .rel .kind{color:var(--cyan)}
.empty{color:var(--dim);padding:8px 0}
a{color:var(--brand)}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<h1>🌐 Code Graph <small id="repoLabel">loading…</small></h1>
<div class="toolbar">
  <select id="repoSelect" title="repo"></select>
  <span class="sep"></span>
  <input id="search" type="search" placeholder="search files…" style="width:180px">
  <span class="sep"></span>
  <label>type</label><select id="typeFilter"><option value="">all</option></select>
  <label>status</label><select id="statusFilter"><option value="">all</option><option value="connected">connected</option><option value="isolated">isolated</option><option value="has-unresolved">has-unresolved</option></select>
  <label>edge</label><select id="kindFilter"><option value="">all</option></select>
  <label>edge st</label><select id="edgeStatusFilter"><option value="">all</option><option value="resolved">resolved</option><option value="unresolved">unresolved</option></select>
  <span class="sep"></span>
  <button id="btnConnected">only connected</button>
  <button id="btnFocus">focus 1-hop</button>
  <span class="sep"></span>
  <label>limit</label><select id="nodeLimit"><option>100</option><option>250</option><option selected>500</option><option>1000</option></select>
</div>
<div id="stats"></div>
<div class="layout">
  <div id="svgWrap"><svg id="graph" viewBox="0 0 1100 720" preserveAspectRatio="xMidYMid meet"></svg></div>
  <div id="side"><h2>Selection</h2><div class="empty">Click a node to inspect it.</div></div>
</div>
<script>
(function(){
'use strict';
var W = 1100, H = 720;
var PALETTE = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#39c5cf','#f778ba','#7ee787'];
var state = { nodes: [], edges: [], repos: [], hash: null,
  search: '', type: '', status: '', kind: '', edgeStatus: '',
  onlyConnected: false, focus: false, limit: 500, selected: null };

function stableColor(kind){
  var h = 0, s = String(kind || 'file');
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(m){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]; }); }

function setOptions(sel, values){
  var cur = sel.value;
  sel.innerHTML = '<option value="">all</option>';
  values.forEach(function(v){ var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
  if (values.indexOf(cur) >= 0) sel.value = cur;
}

function applyFilters(){
  var nodes = state.nodes, edges = state.edges;
  var q = state.search.toLowerCase();
  var visible = nodes.filter(function(n){
    if (state.type && n.type !== state.type) return false;
    if (state.status && n.status !== state.status) return false;
    if (state.onlyConnected && n.status === 'isolated') return false;
    if (q && (n.label.toLowerCase().indexOf(q) < 0) && (n.fullPath.toLowerCase().indexOf(q) < 0)) return false;
    return true;
  });
  var visibleSet = new Set(visible.map(function(n){ return n.id; }));

  // focus 1-hop on selection
  if (state.focus && state.selected && visibleSet.has(state.selected)) {
    var neigh = new Set([state.selected]);
    edges.forEach(function(e){
      if (e.source === state.selected) neigh.add(e.target);
      if (e.target === state.selected) neigh.add(e.source);
    });
    visible = visible.filter(function(n){ return neigh.has(n.id); });
    visibleSet = new Set(visible.map(function(n){ return n.id; }));
  }

  var edgeVisible = edges.filter(function(e){
    if (state.kind && e.kind !== state.kind) return false;
    if (state.edgeStatus && e.status !== state.edgeStatus) return false;
    return visibleSet.has(e.source) && visibleSet.has(e.target);
  });

  visible = visible.slice(0, state.limit);
  visibleSet = new Set(visible.map(function(n){ return n.id; }));
  edgeVisible = edgeVisible.filter(function(e){ return visibleSet.has(e.source) && visibleSet.has(e.target); });
  return { visible: visible, edges: edgeVisible };
}

function layout(visible){
  var groups = {};
  visible.forEach(function(n){
    (groups[n.type] = groups[n.type] || []).push(n);
  });
  var types = Object.keys(groups).sort();
  var cx = W / 2, cy = H / 2;
  var baseR = Math.min(W, H) * 0.36;
  var id2pos = {};
  types.forEach(function(t, gi){
    var ga = (2 * Math.PI * gi) / types.length - Math.PI / 2;
    var gx = cx + Math.cos(ga) * baseR;
    var gy = cy + Math.sin(ga) * baseR;
    groups[t].forEach(function(n, i){
      var a = i * 2.399963;
      var r = 16 * Math.sqrt(i + 1);
      id2pos[n.id] = { x: gx + Math.cos(a) * r, y: gy + Math.sin(a) * r };
    });
  });
  return id2pos;
}

function render(){
  var f = applyFilters();
  var pos = layout(f.visible);
  var svg = document.getElementById('graph');
  var html = '';
  // edges first
  f.edges.forEach(function(e){
    var s = pos[e.source], t = pos[e.target];
    if (!s || !t) return;
    var cls = 'edge' + (e.status === 'unresolved' ? ' edge-unresolved' : '');
    if (state.selected && (e.source === state.selected || e.target === state.selected)) cls += ' edge-lit';
    else if (state.selected) cls += ' edge-dim';
    var tip = 'predicate ' + esc(e.kind) + ' · ' + esc(e.status) + (e.spec ? ' · ' + esc(e.spec) : '') + (e.candidates && e.candidates.length ? ' · candidates: ' + esc(e.candidates.join(', ')) : '');
    html += '<line class="' + cls + '" x1="' + s.x.toFixed(1) + '" y1="' + s.y.toFixed(1) + '" x2="' + t.x.toFixed(1) + '" y2="' + t.y.toFixed(1) + '" stroke-width="1"><title>' + tip + '</title></line>';
  });
  // nodes
  var showLabels = f.visible.length < 90;
  f.visible.forEach(function(n){
    var p = pos[n.id];
    if (!p) return;
    var r = n.id === state.selected ? 9 : 6;
    var fill = state.selected && n.id === state.selected ? '#fff' : stableColor(n.type);
    var extra = n.ghost ? ' node-ghost' : '';
    var title = esc(n.fullPath) + ' · ' + esc(n.type) + ' · ' + esc(n.status);
    html += '<circle class="node' + extra + '" data-id="' + esc(n.id) + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r + '" fill="' + fill + '" stroke="' + (n.ghost ? 'var(--red)' : 'var(--border)') + '" stroke-width="1.5" opacity="' + (n.ghost ? 0.85 : 1) + '"><title>' + title + '</title></circle>';
    if (showLabels) {
      html += '<text x="' + (p.x + r + 4).toFixed(1) + '" y="' + (p.y + 3).toFixed(1) + '">' + esc(n.label) + '</text>';
    }
  });
  svg.innerHTML = html;
  var nCount = f.visible.length, eCount = f.edges.length;
  var unResolved = f.edges.filter(function(e){ return e.status === 'unresolved'; }).length;
  document.getElementById('stats').innerHTML =
    '<b>' + nCount + '</b> nodes · <b>' + eCount + '</b> edges · <b>' + unResolved + '</b> unresolved — ' + state.repoName;
}

function populateSide(node){
  var side = document.getElementById('side');
  if (!node) { side.innerHTML = '<h2>Selection</h2><div class="empty">Click a node to inspect it.</div>'; return; }
  var rels = state.edges.filter(function(e){ return e.source === node.id || e.target === node.id; })
    .slice(0, 60);
  var html = '<h2>Selection</h2>';
  html += '<div class="kv"><span class="k">file</span><span>' + esc(node.fullPath) + '</span></div>';
  html += '<div class="kv"><span class="k">type</span><span>' + esc(node.type) + '</span></div>';
  html += '<div class="kv"><span class="k">status</span><span>' + esc(node.status) + '</span></div>';
  if (node.ghost) html += '<div class="kv"><span class="k">note</span><span class="empty">unresolved target (not a repo file)</span></div>';
  html += '<div style="margin-top:8px"><h2>Relationships (' + rels.length + ')</h2>';
  if (!rels.length) html += '<div class="empty">(none)</div>';
  rels.forEach(function(e){
    var dir = e.source === node.id ? '→' : '←';
    var other = e.source === node.id ? e.target : e.source;
    html += '<div class="rel"><span class="dir">' + dir + '</span> <span class="kind">' + esc(e.kind) + '</span> ' + esc(other) +
      ' <span class="empty">(' + esc(e.status) + (e.line ? ' L' + e.line : '') + ')</span></div>';
  });
  html += '</div>';
  side.innerHTML = html;
}

// ── events ──
document.getElementById('graph').addEventListener('click', function(ev){
  var c = ev.target.closest('circle.node');
  if (!c) { state.selected = null; }
  else {
    var id = c.getAttribute('data-id');
    state.selected = state.selected === id ? null : id;
  }
  render();
  var node = state.nodes.filter(function(n){ return n.id === state.selected; })[0] || null;
  populateSide(node);
});

['search','typeFilter','statusFilter','kindFilter','edgeStatusFilter'].forEach(function(id){
  document.getElementById(id).addEventListener('input', function(e){
    if (id === 'search') state.search = e.target.value;
    if (id === 'typeFilter') state.type = e.target.value;
    if (id === 'statusFilter') state.status = e.target.value;
    if (id === 'kindFilter') state.kind = e.target.value;
    if (id === 'edgeStatusFilter') state.edgeStatus = e.target.value;
    render();
  });
});
document.getElementById('nodeLimit').addEventListener('change', function(e){
  state.limit = Number(e.target.value); render();
});
document.getElementById('btnConnected').addEventListener('click', function(){
  state.onlyConnected = !state.onlyConnected;
  this.classList.toggle('active', state.onlyConnected);
  render();
});
document.getElementById('btnFocus').addEventListener('click', function(){
  state.focus = !state.focus;
  this.classList.toggle('active', state.focus);
  render();
});
document.getElementById('repoSelect').addEventListener('change', function(e){
  var hash = e.target.value;
  if (hash) loadGraph(hash);
});

// ── data ──
function loadGraph(hash){
  fetch('/api/graph?hash=' + encodeURIComponent(hash)).then(function(r){ return r.json(); }).then(function(payload){
    if (payload.error){ document.getElementById('stats').textContent = 'No graph index for this repo yet. Run bahulam once in the project to build it.'; return; }
    state.nodes = payload.nodes || [];
    state.edges = payload.edges || [];
    state.hash = hash;
    state.repoName = payload.repo ? payload.repo.name : hash;
    document.getElementById('repoLabel').textContent = payload.repo ? (payload.repo.name + ' — ' + payload.repo.root) : hash;
    setOptions(document.getElementById('typeFilter'), payload.nodeTypes || []);
    setOptions(document.getElementById('kindFilter'), payload.predicates || []);
    state.selected = null;
    populateSide(null);
    render();
  }).catch(function(){ document.getElementById('stats').textContent = 'Failed to load graph.'; });
}

fetch('/api/graphs').then(function(r){ return r.json(); }).then(function(data){
  state.repos = data.repos || [];
  var sel = document.getElementById('repoSelect');
  sel.innerHTML = '';
  state.repos.forEach(function(r){
    var o = document.createElement('option');
    o.value = r.hash;
    o.textContent = r.name + ' (' + r.nodeCount + ' files)';
    sel.appendChild(o);
  });
  var params = new URLSearchParams(location.search);
  var initial = params.get('hash') || (state.repos[0] && state.repos[0].hash);
  if (initial) { sel.value = initial; loadGraph(initial); }
  else document.getElementById('stats').textContent = 'No indexed repos found. Run bahulam in a project to build its code graph.';
});
})();
</script>
</body>
</html>`;
}