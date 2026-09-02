/**
 * scaffoldPiPack — generate a full Bahulam pack directory from an
 * installed pi ingredient. The generated pack composes the pi package's
 * tools, adds a persistent state layer (append-only records), a single
 * agent that has both toolsets, and a workspace panel that reads the
 * state live via SSE.
 *
 * The pack is written into ~/.bahulam/plugins/<slug>/ (or the target
 * dir the caller provides) so `bahulam install pi:<pkg>` is one command
 * and the pack is immediately installed + preflight-approved.
 *
 * Design tenets:
 *   - Zero authoring cost. All content templated from the pi tools cache.
 *   - Composed pi tools ARE the surface — no need to wrap each one.
 *   - Native tools are limited to the state layer (save/list/drop item).
 *     This bridges the pi surface (stateless) to the workspace panel.
 *   - Everything is overridable. The user can edit the generated files
 *     after the fact — they live in ~/.bahulam/plugins/<slug>/ and won't
 *     be regenerated on re-install.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMPOSED_TOOL_SEPARATOR } from '../pi-compose.mjs';

/**
 * Derive a pack slug from a pi package name.
 *   pi-web-access → web-access-studio
 *   pi-redmine    → redmine-studio
 *   @ffmpeg/transitions → transitions-studio
 *   plain-name    → plain-name-studio
 */
export function deriveSlug(packageName) {
  let base = String(packageName || '').trim();
  const scoped = base.match(/^@[^/]+\/(.+)$/);
  if (scoped) base = scoped[1];
  base = base.replace(/^pi-/, '');
  base = base.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (!base) base = 'pi-pack';
  return `${base}-studio`;
}

/**
 * Derive a short namespace prefix from the pi package name. Used as
 * `as:` in the composes block. Kept short so composed tool names stay
 * readable: `web__web_search`, `fx__add_transitions` (double underscore
 * matches Claude Code / MCP naming and passes Anthropic's tool-name regex).
 */
export function deriveNamespace(packageName) {
  let base = String(packageName || '').trim();
  const scoped = base.match(/^@([^/]+)\/(.+)$/);
  if (scoped) base = scoped[2];
  base = base.replace(/^pi-/, '');
  const first = base.split(/[-_.]/)[0] || 'pi';
  return first.slice(0, 8).toLowerCase();
}

function yamlString(s) {
  const str = String(s || '');
  if (str === '' || /[:#{}\[\],&*!|>'"%@`\n]/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

function yamlBlock(text, indent) {
  const pad = ' '.repeat(indent);
  const clean = String(text || '').trim().replace(/\r\n/g, '\n');
  if (!clean) return '""';
  const lines = clean.split('\n').map(l => l.trimEnd());
  return '|\n' + lines.map(l => pad + l).join('\n');
}

function truncate(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (str.length <= n) return str;
  return str.slice(0, n - 1) + '…';
}

/**
 * Compose an agent system prompt from the pi package + its tools.
 * Focused on WHAT the agent should do, not step-by-step recipes — the
 * generic template can't know the pack's domain. Users are expected to
 * edit the prompt after generation.
 */
function generatePrompt(packageName, namespace, toolNames, hasState) {
  const composed = toolNames.map(t => `${namespace}${COMPOSED_TOOL_SEPARATOR}${t}`);
  const stateLines = hasState
    ? [
        '',
        'Persistence:',
        '- Call `list_items` first when the user references prior work — the notebook',
        '  survives across turns and populates the workspace panel.',
        '- After any meaningful tool call, `save_item` with a title, source, and short note',
        '  so the finding is durable and visible in the panel.',
        '- `drop_item` removes an entry by id.',
      ]
      : [];
  const lines = [
    `You are the ${packageName} specialist.`,
    `You have direct access to ${toolNames.length} composed tool${toolNames.length === 1 ? '' : 's'} from the pi package \`${packageName}\`.`,
    '',
    'Available composed tools:',
    ...composed.map(t => `- \`${t}\``),
    ...stateLines,
    '',
    'Rules:',
    '- Use the composed tools directly — do not describe what you would do, DO it.',
    '- If a tool fails, report the exact error message. Do NOT fall back to general',
    '  knowledge for tasks the tool was meant to answer.',
    '- Cite sources or IDs from tool responses whenever you make a claim.',
  ];
  return lines.join('\n');
}

/**
 * Emit plugin.yaml as a hand-crafted string. YAML libraries add noise
 * (quoted keys, over-escaping); a small emitter here yields a diff-
 * friendly manifest the user can edit.
 */
function renderManifest({ slug, packageName, versionRange, namespace, exposeTools, agentSlug, agentDescription, hasState, hasWorkspace, systemPrompt }) {
  const versionSpec = versionRange ? `${packageName}@${versionRange}` : packageName;
  const tools = hasState ? [
    '  tools:',
    '    - name: save_item',
    '      description: >',
    `        Persist an item to the ${slug} notebook — a title, an optional source URL,`,
    '        and freeform notes. The workspace panel and future turns see it immediately.',
    `      tool: ./tools/save-item.mjs`,
    '      parameters:',
    '        type: object',
    '        properties:',
    '          title:  { type: string, description: "Short headline for the item" }',
    '          source: { type: string, description: "Source URL or identifier (optional)" }',
    '          notes:  { type: string, description: "Freeform notes (optional)" }',
    '          topic:  { type: string, description: "Topic tag for filtering (optional)" }',
    '        required: [title]',
    '',
    '    - name: list_items',
    '      description: >',
    '        Read persisted items from the notebook. Use this first when the user',
    '        references prior work, before re-running composed tools.',
    `      tool: ./tools/list-items.mjs`,
    '      parameters:',
    '        type: object',
    '        properties:',
    '          topic: { type: string, description: "Filter by topic tag (exact match). Omit for all." }',
    '          limit: { type: integer, description: "Max rows, default 50" }',
    '',
    '    - name: drop_item',
    '      description: Remove a persisted item by its id.',
    `      tool: ./tools/drop-item.mjs`,
    '      parameters:',
    '        type: object',
    '        properties:',
    '          id: { type: integer, description: "Item id (from list_items)" }',
    '        required: [id]',
    '',
  ] : ['  tools: []', ''];

  const composesBlock = [
    '  composes:',
    `    - source: pi:${versionSpec}`,
    `      as: ${namespace}`,
    '      expose:',
    ...exposeTools.map(t => `        - ${t}`),
    '      verified: true',
    '',
  ];

  const agentToolRefs = [
    ...(hasState ? ['save_item', 'list_items', 'drop_item'] : []),
    ...exposeTools.map(t => `${namespace}${COMPOSED_TOOL_SEPARATOR}${t}`),
  ];

  const agentBlock = [
    '  agents:',
    `    - slug: ${agentSlug}`,
    `      name: ${yamlString(agentSlug.replace(/-/g, ' '))}`,
    '      role: specialist',
    '      description: >',
    `        ${agentDescription}`,
    '      tools:',
    ...agentToolRefs.map(t => `        - ${t}`),
    `      system_prompt: ${yamlBlock(systemPrompt, 8)}`,
    '',
  ];

  const workspaceBlock = hasWorkspace ? [
    '  workspace:',
    '    views:',
    '      - type: panel',
    `        name: ${yamlString(slug.replace(/-/g, ' '))}`,
    '        source: ./workspace/panel.html',
    '',
  ] : [];

  return [
    'apiVersion: bahulam.plugin/1',
    'kind: Plugin',
    'metadata:',
    `  name: ${slug}`,
    '  version: 0.1.0',
    '  description: >',
    `    Auto-scaffolded pack composing pi:${packageName}.`,
    `    Edit tools/, workspace/, and this manifest to customize.`,
    '',
    'spec:',
    ...tools,
    ...composesBlock,
    ...agentBlock,
    ...workspaceBlock,
  ].join('\n');
}

const SAVE_ITEM_TOOL = `/**
 * save_item — persist a single item to the pack's notebook.
 * Append-style records so a topic can accumulate many entries over time.
 * The workspace panel binds to this stream.
 */
export async function call(args = {}, options = {}) {
  const title = String(args.title || '').trim();
  if (!title) return { success: false, output: 'title is required' };

  const state = options.state ? await options.state : null;
  if (!state) return { success: false, output: 'Shared blackboard unavailable' };

  const item = {
    title,
    source: String(args.source || '').trim(),
    notes: String(args.notes || '').slice(0, 1000),
    topic: String(args.topic || '').trim(),
    at: new Date().toISOString(),
  };
  const record = state.append('items', item);
  return {
    success: true,
    output: \`Saved item #\${record?.id || ''}: \${title}\`,
    item: { ...item, id: record?.id },
  };
}
`;

const LIST_ITEMS_TOOL = `/**
 * list_items — read persisted items from the pack notebook, most recent first.
 */
export async function call(args = {}, options = {}) {
  const state = options.state ? await options.state : null;
  if (!state) return { success: false, output: 'Shared blackboard unavailable' };

  const topic = String(args.topic || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));
  const rows = state.list('items', { limit, order: 'desc' }) || [];
  const filtered = topic
    ? rows.filter(r => String(r.payload?.topic || '').toLowerCase() === topic)
    : rows;
  const summary = filtered.map(r => \`#\${r.id} · \${r.payload?.title || ''}\${r.payload?.topic ? ' (' + r.payload.topic + ')' : ''}\`).join('\\n');
  return {
    success: true,
    output: filtered.length ? summary : (topic ? \`No items for topic '\${topic}'\` : 'No items yet'),
    items: filtered.map(r => ({ id: r.id, ...(r.payload || {}), created_at: r.created_at })),
  };
}
`;

const DROP_ITEM_TOOL = `/**
 * drop_item — remove a persisted item by id.
 */
export async function call(args = {}, options = {}) {
  const id = Number(args.id);
  if (!Number.isInteger(id) || id <= 0) {
    return { success: false, output: 'id must be a positive integer' };
  }
  const state = options.state ? await options.state : null;
  if (!state) return { success: false, output: 'Shared blackboard unavailable' };

  const info = state.db.prepare('DELETE FROM records WHERE stream = ? AND id = ?').run('items', id);
  return {
    success: info.changes > 0,
    output: info.changes > 0 ? \`Dropped item #\${id}\` : \`No item with id \${id}\`,
  };
}
`;

function renderPanel(slug, packageName, composedToolNames) {
  const example = composedToolNames[0] || 'example_tool';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${slug}</title>
<style>
  :root { --bg:#FBFAF7; --fg:#1F2328; --muted:#8A8F98; --ok:#1A7F37; --err:#C0392B; --brand:#0891B2; --mono:ui-monospace,Menlo,monospace; }
  body { margin:0; padding:20px 24px; background:var(--bg); color:var(--fg); font:14px/1.55 -apple-system,system-ui,sans-serif; }
  h1 { font-size:17px; margin:0 0 2px; } .lede { color:var(--muted); font-size:12px; margin:0 0 14px; max-width:900px; }
  .row { display:flex; gap:8px; align-items:center; margin:12px 0 12px; flex-wrap:wrap; }
  input, button, select { font:inherit; padding:6px 10px; border:1px solid #D5D3CB; border-radius:4px; background:#fff; }
  button { cursor:pointer; } button.danger { color:var(--err); }
  #live { color:var(--muted); font-size:11px; }
  #status { color:var(--muted); font-size:11px; min-height:16px; }
  #status.err { color:var(--err); } #status.ok { color:var(--ok); }
  .item { border-bottom:1px solid #F0EFEA; padding:10px 0; }
  .idPill { display:inline-block; padding:1px 6px; border-radius:10px; font-size:10px; background:#F0EFEA; color:var(--muted); font-family:var(--mono); margin-right:6px; }
  .topicPill { display:inline-block; padding:1px 7px; border-radius:10px; font-size:10px; background:#E0F2FE; color:var(--brand); margin-right:6px; }
  .title { font-weight:600; }
  .src { color:var(--muted); font-size:12px; word-break:break-all; }
  .notes { color:#4a4d52; font-size:13px; margin-top:4px; }
  .meta { color:var(--muted); font-size:11px; font-family:var(--mono); margin-top:2px; }
  .btnDrop { float:right; font-size:11px; }
</style>
</head>
<body>
<h1>${slug} <span id="live">· connecting…</span></h1>
<p class="lede">Items the agent saves via <code>save_item</code> land here — live. Composed from <code>pi:${packageName}</code>. Cross-process pulse updates the panel even when the agent runs in another terminal.</p>

<div class="row">
  <input id="topic" placeholder="Filter by topic…" />
  <span id="count" class="muted"></span>
  <span id="status" style="margin-left:auto"></span>
</div>

<div id="items"><p class="muted" style="padding:14px">loading…</p></div>

<script>
const token = new URLSearchParams(location.search).get('token') || '';
const PLUGIN = ${JSON.stringify(slug)};

function setStatus(msg, tone) {
  const el = document.getElementById('status');
  el.textContent = msg || ''; el.className = tone || '';
}
async function state(op, extra = {}) {
  const res = await fetch('/api/plugin-state/' + PLUGIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bahulam-Local-Token': token },
    body: JSON.stringify({ op, ...extra }),
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || body.message || 'state op failed');
  return body.result;
}
async function tool(name, args = {}) {
  const res = await fetch('/api/tools/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bahulam-Local-Token': token },
    body: JSON.stringify({ name, args }),
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || 'tool call failed');
  if (body.result?.success === false) throw new Error(String(body.result.output));
  return body.result;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(iso) { return (iso || '').replace('T', ' ').slice(0, 19); }

async function reload() {
  const container = document.getElementById('items');
  try {
    const filter = document.getElementById('topic').value.trim().toLowerCase();
    const rows = await state('list', { stream: 'items', limit: 500, order: 'desc' });
    const items = (rows || []).filter(r => !filter || String(r.payload?.topic || '').toLowerCase() === filter);
    document.getElementById('count').textContent = \`\${items.length} item\${items.length === 1 ? '' : 's'}\`;
    if (!items.length) {
      container.innerHTML = '<p class="muted" style="padding:14px">no items yet — ask the ${slug} agent</p>';
      return;
    }
    container.innerHTML = items.map(r => {
      const p = r.payload || {};
      return \`<div class="item">
        <button class="btnDrop danger" data-drop="\${r.id}">Drop</button>
        <span class="idPill">#\${r.id}</span>\${p.topic ? \`<span class="topicPill">\${escapeHtml(p.topic)}</span>\` : ''}
        <span class="title">\${escapeHtml(p.title || '')}</span>
        \${p.source ? \`<div class="src"><a href="\${escapeHtml(p.source)}" target="_blank" rel="noreferrer">\${escapeHtml(p.source)}</a></div>\` : ''}
        \${p.notes ? \`<div class="notes">\${escapeHtml(p.notes)}</div>\` : ''}
        <div class="meta">\${fmtTime(r.created_at || p.at)}</div>
      </div>\`;
    }).join('');
    container.querySelectorAll('button[data-drop]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await tool('drop_item', { id: Number(btn.getAttribute('data-drop')) }); setStatus('dropped', 'ok'); }
        catch (err) { setStatus(err.message, 'err'); }
      });
    });
  } catch (err) {
    container.innerHTML = \`<p style="padding:14px;color:var(--err)">\${escapeHtml(err.message)}</p>\`;
  }
}

let _t = null;
const scheduleReload = () => { clearTimeout(_t); _t = setTimeout(reload, 200); };
document.getElementById('topic').addEventListener('input', scheduleReload);

try {
  const es = new EventSource('/api/events?token=' + encodeURIComponent(token));
  es.addEventListener('open',  () => { document.getElementById('live').textContent = '· live'; });
  es.addEventListener('error', () => { document.getElementById('live').textContent = '· reconnecting…'; });
  es.addEventListener('plugin_state_changed', (ev) => {
    let evt = {}; try { evt = JSON.parse(ev.data || '{}'); } catch {}
    if (evt.plugin !== PLUGIN) return;
    scheduleReload();
  });
} catch { /* SSE unavailable; still load-only */ }

reload();
</script>
</body>
</html>
`;
}

/**
 * Scaffold a full pack directory from an installed pi ingredient.
 *
 * @param {Object} opts
 * @param {string} opts.packageName        — pi package name (e.g. "pi-web-access")
 * @param {string} [opts.versionRange]     — pi package version range
 * @param {string} opts.piDir              — dir where pi package is installed (~/.bahulam/plugins-pi/<safe>/)
 * @param {string} opts.targetDir          — parent dir for the generated pack
 * @param {Object} opts.discoveredTools    — parsed .bahulam-tools.json
 * @param {boolean} [opts.state=true]      — include persistent state layer + native tools
 * @param {boolean} [opts.workspace=true]  — include reactive panel
 * @param {string} [opts.slug]             — override the derived slug
 * @param {boolean} [opts.force=false]     — overwrite an existing pack
 * @returns {{ dest: string, slug: string, namespace: string, exposeTools: string[] }}
 */
export function scaffoldPiPack({
  packageName,
  versionRange,
  piDir,
  targetDir,
  discoveredTools,
  state = true,
  workspace = true,
  slug: slugOverride,
  force = false,
}) {
  const slug = slugOverride || deriveSlug(packageName);
  const namespace = deriveNamespace(packageName);
  const toolNames = (discoveredTools?.tools || []).map(t => t.name).filter(Boolean);
  if (!toolNames.length) {
    throw new Error(`pi package ${packageName} has no discoverable tools — cannot scaffold`);
  }

  const dest = path.join(targetDir, slug);
  if (fs.existsSync(dest)) {
    if (!force) throw new Error(`pack already exists: ${dest} (use --force to overwrite)`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  const agentSlug = `${namespace}-specialist`;
  const agentDescription = truncate(
    `Specialist agent for ${packageName}. Composes ${toolNames.length} tool${toolNames.length === 1 ? '' : 's'} exposed as ${namespace}${COMPOSED_TOOL_SEPARATOR}*.`,
    240,
  );
  const systemPrompt = generatePrompt(packageName, namespace, toolNames, state);

  const manifest = renderManifest({
    slug,
    packageName,
    versionRange,
    namespace,
    exposeTools: toolNames,
    agentSlug,
    agentDescription,
    hasState: state,
    hasWorkspace: workspace,
    systemPrompt,
  });
  fs.writeFileSync(path.join(dest, 'plugin.yaml'), manifest);

  if (state) {
    const toolsDir = path.join(dest, 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'save-item.mjs'), SAVE_ITEM_TOOL);
    fs.writeFileSync(path.join(toolsDir, 'list-items.mjs'), LIST_ITEMS_TOOL);
    fs.writeFileSync(path.join(toolsDir, 'drop-item.mjs'), DROP_ITEM_TOOL);
  }

  if (workspace) {
    const wsDir = path.join(dest, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'panel.html'), renderPanel(slug, packageName, toolNames));
  }

  return { dest, slug, namespace, exposeTools: toolNames, agentSlug };
}
