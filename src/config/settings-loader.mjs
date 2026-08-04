import * as fs from 'node:fs';
import * as path from 'node:path';
import { deepMerge } from '../core/policy-resolver.mjs';

export const DEFAULT_KEPLER_SETTINGS = Object.freeze({
  env: {},
  permissions: {
    shellAllowlist: [],
    editDenylist: [],
  },
  hooks: {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  },
});

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { __error: err.message };
  }
}

export function loadKeplerSettings({ cwd = process.cwd() } = {}) {
  const base = path.join(cwd, '.bahulam');
  const layers = [
    { name: 'default', path: null, data: DEFAULT_KEPLER_SETTINGS },
  ];
  for (const [name, file] of [
    ['project', path.join(base, 'settings.json')],
    ['local', path.join(base, 'settings.local.json')],
  ]) {
    const data = readJson(file);
    if (data && !data.__error) layers.push({ name, path: file, data });
    else if (data?.__error) layers.push({ name, path: file, error: data.__error, data: {} });
  }

  let settings = {};
  for (const layer of layers) settings = deepMerge(settings, layer.data || {});
  return { settings, layers };
}
