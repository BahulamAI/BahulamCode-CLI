import { loadBahulamSettings } from '../config/settings-loader.mjs';

// Resolve presentation settings only when attaching Rust. Do not export them
// into the Node core's process environment or change Node's visual defaults.
export function rustTuiEnvironment({ cwd, userTui = {}, env = process.env, layers } = {}) {
  layers ??= loadBahulamSettings({cwd}).layers;
  const settings = {mode:'inline', mouse:'full', clipboard:'auto', file_opener:'auto', capabilities:{}};
  for (const layer of [userTui, ...layers.filter(layer => layer.name !== 'default').map(layer => layer.data?.tui)]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    Object.assign(settings, {...layer, capabilities:{...settings.capabilities, ...layer.capabilities}});
  }
  const result = {...env};
  for (const [name, key] of Object.entries({BAHULAM_THEME:'theme', BAHULAM_TUI_MODE:'mode', BAHULAM_TUI_MOUSE:'mouse', BAHULAM_CLIPBOARD:'clipboard', BAHULAM_TUI_FILE_OPENER:'file_opener', BAHULAM_TUI_SCROLL_LINES:'scroll_lines', BAHULAM_TUI_STATUS_COMMAND:'status_command'})) {
    if (!result[name] && typeof settings[key] === 'string') result[name] = settings[key];
    if (!result[name] && Number.isFinite(settings[key])) result[name] = String(settings[key]);
  }
  if (!result.BAHULAM_TUI_STATUS_SEGMENTS && Array.isArray(settings.status_segments)) result.BAHULAM_TUI_STATUS_SEGMENTS = settings.status_segments.filter(value => typeof value === 'string').join(',');
  let overrides = {};
  try { const value = JSON.parse(env.BAHULAM_TUI_CAPABILITIES || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) overrides = value; } catch {}
  result.BAHULAM_TUI_CAPABILITIES = JSON.stringify({...settings.capabilities,...overrides});
  return result;
}
