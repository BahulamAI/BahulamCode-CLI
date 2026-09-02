import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deepMerge } from '../core/policy-resolver.mjs';

export const DEFAULT_BAHULAM_SETTINGS = Object.freeze({
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

// Global settings live alongside global plugins (~/.bahulam/), so an
// allowlist that applies to a globally-installed plugin belongs here.
// $BAHULAM_HOME overrides the default so tests and one-off installs
// don't touch the real home directory.
function globalSettingsPath() {
  const home = process.env.BAHULAM_HOME || path.join(os.homedir(), '.bahulam');
  return path.join(home, 'settings.json');
}

export function loadBahulamSettings({ cwd = process.cwd() } = {}) {
  const base = path.join(cwd, '.bahulam');
  const layers = [
    { name: 'default', path: null, data: DEFAULT_BAHULAM_SETTINGS },
  ];
  // Merge order (later overrides earlier): default → global → project → local.
  // Global keeps values that stay constant across projects (plugins live
  // in ~/.bahulam, so plugin allowlists sit here). Project & local remain
  // the last word so a repo can tighten or loosen without touching global.
  for (const [name, file] of [
    ['global', globalSettingsPath()],
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

