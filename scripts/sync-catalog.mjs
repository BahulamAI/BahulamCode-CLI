#!/usr/bin/env node
/**
 * Refresh the CLI-shipped model catalog default from codekepler-backend.
 *
 * Reads from `codekepler-backend/main` (the deployed source of truth after
 * PR merges) and writes to `src/config/model-catalog-default.json`. Wired
 * to `prepublishOnly` so `npm publish` always ships the latest catalog.
 *
 * Local runs (`npm run sync-catalog`) work too — useful before commits
 * that follow a catalog PR merge on the backend side.
 *
 * Fallback: if the network fetch fails and a local checkout of
 * codekepler-backend is present as a sibling of this repo, copy from
 * disk instead. Keeps publish flows working offline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REMOTE_URL = 'https://raw.githubusercontent.com/raviakasapu/codekepler-backend/main/app/services/model_catalog_snapshot.json';
const DEFAULTS_REMOTE_URL = 'https://raw.githubusercontent.com/raviakasapu/codekepler-backend/main/app/services/model_defaults.py';
const _dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'src', 'config', 'model-catalog-default.json');
const DEFAULTS_OUT_PATH = path.join(REPO_ROOT, 'src', 'config', 'model-defaults-default.json');
const LOCAL_FALLBACK = path.resolve(REPO_ROOT, '..', 'codekepler-backend', 'app', 'services', 'model_catalog_snapshot.json');
const DEFAULTS_LOCAL_FALLBACK = path.resolve(REPO_ROOT, '..', 'codekepler-backend', 'app', 'services', 'model_defaults.py');

async function fetchRemote(url = REMOTE_URL) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      console.warn(`[sync-catalog] remote HTTP ${resp.status}, trying local fallback`);
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.warn(`[sync-catalog] remote fetch failed (${err.message}), trying local fallback`);
    return null;
  }
}

function readLocalFallback(file = LOCAL_FALLBACK) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function pythonStringConstant(source, name) {
  const match = new RegExp(`^${name}\\s*=\\s*["']([^"']+)["']`, 'm').exec(source);
  return match?.[1] || null;
}

function modelDefaultsFromPython(source) {
  const reasoning = pythonStringConstant(source, 'FALLBACK_REASONING_MODEL');
  const fast = pythonStringConstant(source, 'FALLBACK_FAST_MODEL');
  const planning = pythonStringConstant(source, 'FALLBACK_PLAN_MODEL');
  if (!reasoning || !fast || !planning) {
    throw new Error('missing FALLBACK_* model constants');
  }
  return {
    schema: 'bahulam.model_defaults.v1',
    source: 'codekepler-backend/app/services/model_defaults.py',
    defaults: { reasoning, fast, planning },
  };
}

const remote = await fetchRemote();
const raw = remote ?? readLocalFallback();
if (!raw) {
  console.error('[sync-catalog] no catalog source available (remote unreachable AND no local codekepler-backend checkout)');
  process.exit(1);
}

// Sanity-check the JSON before writing
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(`[sync-catalog] invalid JSON from source: ${err.message}`);
  process.exit(1);
}
const models = Array.isArray(parsed.models) ? parsed.models : [];
if (!models.length) {
  console.error('[sync-catalog] refused to write empty catalog');
  process.exit(1);
}
const flagged = models.filter(m => m?.harnessValidated).length;

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, raw);
console.log(`[sync-catalog] wrote ${path.relative(REPO_ROOT, OUT_PATH)}`);
console.log(`  ${models.length} models, ${flagged} harness_validated`);
console.log(`  source: ${remote ? 'remote (github raw)' : 'local (../codekepler-backend)'}`);
console.log(`  generated_at: ${parsed.generated_at ?? 'unknown'}`);

const defaultsRemote = await fetchRemote(DEFAULTS_REMOTE_URL);
const defaultsRaw = defaultsRemote ?? readLocalFallback(DEFAULTS_LOCAL_FALLBACK);
if (!defaultsRaw) {
  console.error('[sync-catalog] no model defaults source available (remote unreachable AND no local codekepler-backend checkout)');
  process.exit(1);
}
let defaults;
try {
  defaults = modelDefaultsFromPython(defaultsRaw);
} catch (err) {
  console.error(`[sync-catalog] invalid model defaults source: ${err.message}`);
  process.exit(1);
}
fs.writeFileSync(DEFAULTS_OUT_PATH, JSON.stringify(defaults, null, 2) + '\n');
console.log(`[sync-catalog] wrote ${path.relative(REPO_ROOT, DEFAULTS_OUT_PATH)}`);
console.log(`  reasoning=${defaults.defaults.reasoning}`);
console.log(`  fast=${defaults.defaults.fast}`);
console.log(`  planning=${defaults.defaults.planning}`);
