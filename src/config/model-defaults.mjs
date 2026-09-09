/**
 * Shipped npm-side model defaults.
 *
 * Source of truth is backend `app/services/model_defaults.py`; release sync
 * writes `model-defaults-default.json` next to the shipped catalog.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FALLBACK_MODEL_DEFAULTS = Object.freeze({
  reasoning: 'deepseek/deepseek-v4-flash',
  fast: 'deepseek/deepseek-v4-flash',
  planning: 'deepseek/deepseek-v4-pro',
});

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = path.join(_dirname, 'model-defaults-default.json');

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readShippedModelDefaults() {
  try {
    const data = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf-8'));
    const defaults = data?.defaults && typeof data.defaults === 'object' ? data.defaults : {};
    return {
      reasoning: clean(defaults.reasoning) || FALLBACK_MODEL_DEFAULTS.reasoning,
      fast: clean(defaults.fast) || FALLBACK_MODEL_DEFAULTS.fast,
      planning: clean(defaults.planning) || FALLBACK_MODEL_DEFAULTS.planning,
    };
  } catch {
    return { ...FALLBACK_MODEL_DEFAULTS };
  }
}

export const SHIPPED_MODEL_DEFAULTS = readShippedModelDefaults();
export const DEFAULT_REASONING_MODEL = SHIPPED_MODEL_DEFAULTS.reasoning;
export const DEFAULT_FAST_MODEL = SHIPPED_MODEL_DEFAULTS.fast;
export const DEFAULT_PLANNING_MODEL = SHIPPED_MODEL_DEFAULTS.planning;
