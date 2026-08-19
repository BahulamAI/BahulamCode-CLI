/**
 * Shipped model catalog snapshot — Node side of PRD-076 W7.
 *
 * The canonical source is `codekepler-backend/app/services/
 * model_catalog_snapshot.json` (admin dashboard edits it and publishes to
 * Supabase). `stage-runtime-app.sh` copies that file into every runtime
 * wheel at `runtime/app/services/model_catalog_snapshot.json`, so when
 * `@bahulam/runtime-<platform>-<arch>` is installed as a sibling optional
 * dep of `@bahulam/code`, the file is already on disk — we read from
 * there instead of maintaining a third copy in the CLI package.
 */

import * as fs from 'node:fs';
import { runtimeSnapshotPath } from '../core/bundled-runtime.mjs';

let _cache = null;

// Snapshot rows are camelCase (matches how the backend delivers the
// static file); the /api/models response is snake_case. Normalize once
// here so downstream consumers can treat both sources identically.
function normalizeSnapshotRow(row) {
  const id = row.value || row.id;
  if (!id) return null;
  return {
    id,
    provider: row.provider || (id.includes('/') ? id.split('/', 1)[0] : 'unknown'),
    label: row.label || id,
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

/**
 * Read the shipped catalog snapshot from the installed runtime bundle.
 * Returns an array of normalized rows (API-shape) or null if the runtime
 * isn't installed / the file is unreadable. Cached after first success.
 */
export function readShippedCatalog() {
  if (_cache !== null) return _cache;
  try {
    const raw = fs.readFileSync(runtimeSnapshotPath(), 'utf-8');
    const data = JSON.parse(raw);
    const rows = Array.isArray(data?.models) ? data.models : [];
    _cache = rows.map(normalizeSnapshotRow).filter(Boolean);
    return _cache;
  } catch {
    _cache = null;
    return null;
  }
}
