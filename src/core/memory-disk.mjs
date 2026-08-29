/**
 * Disk-backed cross-session memory for the CLI runtime.
 *
 * Cross-session memory lives on the user's disk (not Supabase) whenever a
 * request originates from the CLI. Chat, cloud-IDE, and workspace surfaces
 * continue to use the Supabase `agent_memory` table via the existing
 * SupabaseMemoryBackend — this module is CLI-only.
 *
 * Files:
 *   ~/.bahulam/memory.md          — user-global. Loaded for every session.
 *   <cwd>/.bahulam/memory.md      — project-scoped. Merged on top of global
 *                                    when the CLI is running inside a
 *                                    directory that has one.
 *
 * Format (round-trippable with the Supabase agent_memory schema):
 *
 *   # Bahulam memory · <optional title>
 *
 *   <!-- fact:<slug> type:<fact_type> conf:<0..1> scope:<global|project>
 *        source:<origin> tags:<a,b,c> project:<id-or-null>
 *        created:<iso> updated:<iso> -->
 *   <content body — one or more prose paragraphs until the next `<!-- fact:`
 *   header or end of file>
 *
 * HTML comments carry the metadata so GitHub renders the file cleanly.
 * Body text is the `content` field. Unknown metadata keys pass through
 * verbatim (round-trip preserves anything the backend added).
 *
 * Reads are idempotent + tolerant: missing files return an empty list, a
 * malformed fact block is skipped with a warning rather than throwing.
 * Writes are append-only (new facts) or overwrite-in-place (updates to an
 * existing fact_id) — see appendFacts() and its callers.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FACT_HEADER_RE = /<!--\s*fact:([A-Za-z0-9._-]+)\s*([^>]*)-->/g;

/** Where the global memory file lives. */
export function globalMemoryPath() {
  return path.join(os.homedir(), '.bahulam', 'memory.md');
}

/** Where the project memory file lives, if the cwd has a .bahulam dir. */
export function projectMemoryPath(cwd = process.cwd()) {
  return path.join(cwd, '.bahulam', 'memory.md');
}

/**
 * Ensure `.bahulam/` exists at the requested root, creating it if missing.
 * `scope='global'` → ~/.bahulam/; `scope='project'` → <cwd>/.bahulam/.
 * Returns the directory path. Idempotent — safe to call on every access.
 */
export function ensureBahulamDir(scope = 'global', cwd = process.cwd()) {
  const dir = scope === 'project'
    ? path.join(cwd, '.bahulam')
    : path.join(os.homedir(), '.bahulam');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Parse `key:value key:value` from the header comment. Values are strings;
// callers coerce as needed. `tags:a,b,c` → array, `project:null` → null.
function _parseMeta(raw) {
  const meta = {};
  const trimmed = String(raw || '').trim();
  if (!trimmed) return meta;
  // Simple space-separated key:value tokenizer. Values cannot contain
  // spaces — matches how appendFacts() serializes below.
  for (const tok of trimmed.split(/\s+/)) {
    const idx = tok.indexOf(':');
    if (idx < 0) continue;
    const key = tok.slice(0, idx);
    let value = tok.slice(idx + 1);
    if (value === 'null' || value === '') value = null;
    else if (key === 'tags') value = value.split(',').filter(Boolean);
    else if (key === 'conf' || key === 'confidence') {
      const n = Number(value);
      value = Number.isFinite(n) ? n : null;
    }
    meta[key] = value;
  }
  return meta;
}

/**
 * Parse one memory.md file into an array of Fact records matching the
 * Supabase schema shape. Missing file → []. Malformed blocks are skipped.
 */
export function parseMemoryFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const facts = [];
  // Reset regex state — using .exec in a loop.
  FACT_HEADER_RE.lastIndex = 0;
  const headers = [];
  let m;
  while ((m = FACT_HEADER_RE.exec(text)) !== null) {
    headers.push({
      slug: m[1],
      metaRaw: m[2],
      commentStart: m.index,
      commentEnd: m.index + m[0].length,
    });
  }

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const bodyStart = h.commentEnd;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].commentStart : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    const meta = _parseMeta(h.metaRaw);
    facts.push({
      fact_id: h.slug,
      content: body,
      fact_type: meta.type || 'other',
      confidence: typeof meta.conf === 'number'
        ? meta.conf
        : (typeof meta.confidence === 'number' ? meta.confidence : null),
      source: meta.source || 'disk',
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      metadata: {},
      project_id: meta.project || null,
      memory_scope: meta.scope || (meta.project ? 'project' : 'global'),
      created_at: meta.created || null,
      updated_at: meta.updated || null,
      _source_file: filePath,
    });
  }
  return facts;
}

/**
 * Load global + project memory, merging by fact_id. Project entries
 * shadow global entries with the same fact_id, matching how the
 * Supabase project_only scope shadows global scope.
 */
export function loadDiskMemory(cwd = process.cwd()) {
  // Self-heal: create ~/.bahulam/ on first read so subsequent writes
  // don't race on the mkdir. Silent if it already exists.
  try { ensureBahulamDir('global'); } catch { /* ignore mkdir errors */ }
  const globalFacts = parseMemoryFile(globalMemoryPath());
  const projectFacts = parseMemoryFile(projectMemoryPath(cwd));
  const merged = new Map();
  for (const f of globalFacts) merged.set(f.fact_id, f);
  for (const f of projectFacts) merged.set(f.fact_id, f);
  return Array.from(merged.values());
}

// Serialize one fact to the wire format described at the top of this file.
export function serializeFact(fact) {
  const parts = [];
  if (fact.fact_type) parts.push(`type:${fact.fact_type}`);
  if (typeof fact.confidence === 'number') parts.push(`conf:${fact.confidence}`);
  if (fact.memory_scope) parts.push(`scope:${fact.memory_scope}`);
  if (fact.source) parts.push(`source:${fact.source}`);
  if (Array.isArray(fact.tags) && fact.tags.length) parts.push(`tags:${fact.tags.join(',')}`);
  parts.push(`project:${fact.project_id || 'null'}`);
  if (fact.created_at) parts.push(`created:${fact.created_at}`);
  if (fact.updated_at) parts.push(`updated:${fact.updated_at}`);
  const header = `<!-- fact:${fact.fact_id} ${parts.join(' ')} -->`;
  return `${header}\n${String(fact.content || '').trim()}\n`;
}

/**
 * Append or overwrite one or more facts on disk. Global scope → global
 * file; project scope → project file (creates .bahulam/ if needed).
 * Overwrites in place when a fact_id already exists in the target file.
 */
export function upsertFacts(facts, cwd = process.cwd()) {
  const byFile = new Map();  // filePath → Map(fact_id → fact)

  const globalPath = globalMemoryPath();
  const projectPath = projectMemoryPath(cwd);

  // Seed from existing files so we can round-trip untouched facts.
  for (const f of parseMemoryFile(globalPath)) {
    if (!byFile.has(globalPath)) byFile.set(globalPath, new Map());
    byFile.get(globalPath).set(f.fact_id, f);
  }
  for (const f of parseMemoryFile(projectPath)) {
    if (!byFile.has(projectPath)) byFile.set(projectPath, new Map());
    byFile.get(projectPath).set(f.fact_id, f);
  }

  for (const raw of facts) {
    if (!raw || !raw.fact_id) continue;
    const scope = raw.memory_scope || (raw.project_id ? 'project' : 'global');
    const target = scope === 'project' ? projectPath : globalPath;
    if (!byFile.has(target)) byFile.set(target, new Map());
    byFile.get(target).set(String(raw.fact_id), { ...raw, memory_scope: scope });
  }

  for (const [filePath, factMap] of byFile.entries()) {
    if (factMap.size === 0) continue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const title = filePath.endsWith(projectPath)
      ? '# Bahulam memory · project scope\n\n'
      : '# Bahulam memory · global\n\n';
    const body = Array.from(factMap.values()).map(serializeFact).join('\n');
    fs.writeFileSync(filePath, `${title}${body}`, 'utf-8');
  }
}
