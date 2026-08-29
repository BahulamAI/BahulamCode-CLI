/**
 * Shipped model catalog snapshot — CLI-side default list.
 *
 * The canonical source is `codekepler-backend/app/services/
 * model_catalog_snapshot.json`. That file is copied into this package at
 * publish time (see `scripts/sync-catalog.mjs`, wired to `prepublishOnly`)
 * and lives at `src/config/model-catalog-default.json` inside the shipped
 * CLI. Fresh installs see the up-to-date default catalog without needing
 * to hit the backend on first launch.
 *
 * Legacy fallback: older installs may still have the file inside an
 * `@bahulam/runtime-<platform>-<arch>` optional dep from the pre-server-
 * agent-execution era. If our own copy isn't present, we try that path
 * before giving up. This fallback can be removed once the runtime bundle
 * is no longer published.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeSnapshotPath } from '../core/bundled-runtime.mjs';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DEFAULT_CATALOG_PATH = path.join(_dirname, 'model-catalog-default.json');

let _cache = null;

// Snapshot rows are camelCase (matches how the backend delivers the
// static file); the /api/models response is snake_case. Normalize once
// here so downstream consumers can treat both sources identically.
function normalizeSnapshotRow(row) {
  const id = row.value || row.id;
  if (!id) return null;
  const category = row.category || row.modelCategory || row.model_category || 'text';
  return {
    id,
    provider: row.provider || (id.includes('/') ? id.split('/', 1)[0] : 'unknown'),
    label: row.label || id,
    category,
    input_cost_usd_per_m: row.inputCost ?? row.input_cost_usd_per_m ?? null,
    output_cost_usd_per_m: row.outputCost ?? row.output_cost_usd_per_m ?? null,
    context_length: row.context ?? row.context_length ?? null,
    max_output: row.maxOutput ?? row.max_output ?? null,
    supports_tools: row.supportsTools ?? row.supports_tools ?? false,
    supports_reasoning: row.supportsReasoning ?? row.supports_reasoning ?? false,
    harness_validated: row.harnessValidated ?? row.harness_validated ?? false,
    cache_profile: row.cacheProfile ?? row.cache_profile ?? null,
    platform_access_tier: row.platformAccessTier ?? row.platform_access_tier ?? [],
  };
}

function _readJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw);
    const rows = Array.isArray(data?.models) ? data.models : [];
    const normalized = rows.map(normalizeSnapshotRow).filter(Boolean);
    return normalized.length ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Read the shipped catalog snapshot. Tries CLI-bundled default first
 * (`src/config/model-catalog-default.json`, refreshed at publish time
 * via `scripts/sync-catalog.mjs`), then falls back to the legacy
 * `@bahulam/runtime-*` bundle path for older installs. Cached after
 * first success. Returns null if neither path yields data.
 */
export function readShippedCatalog() {
  if (_cache !== null) return _cache;

  // Preferred: CLI-bundled default catalog.
  const own = _readJson(CLI_DEFAULT_CATALOG_PATH);
  if (own) {
    _cache = own;
    return _cache;
  }

  // Legacy fallback: runtime wheel copy (pre-server-execution architecture).
  try {
    const runtime = _readJson(runtimeSnapshotPath());
    if (runtime) {
      _cache = runtime;
      return _cache;
    }
  } catch {
    // runtimeSnapshotPath() itself may throw when the optional dep is absent
  }

  _cache = null;
  return null;
}
