import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BAHULAM_SHIFT_ENTER_BINDING = Object.freeze({
  key: 'shift+enter',
  command: 'workbench.action.terminal.sendSequence',
  when: 'terminalFocus',
  args: { text: '\n' },
});

// VS Code assigns Ctrl+Q to Quick Open View on macOS and Windows. When the
// terminal owns focus, pass the control character to the TUI instead. The
// Rust client deliberately does not treat Ctrl+Q as a quit key.
export const BAHULAM_TERMINAL_CTRL_Q_BINDING = Object.freeze({
  key: 'ctrl+q',
  command: 'workbench.action.terminal.sendSequence',
  when: 'terminalFocus',
  args: { text: '\u0011' },
});

const BAHULAM_TERMINAL_BINDINGS = [BAHULAM_SHIFT_ENTER_BINDING, BAHULAM_TERMINAL_CTRL_Q_BINDING];

export function vscodeKeybindingsPath({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.BAHULAM_VSCODE_KEYBINDINGS) return path.resolve(env.BAHULAM_VSCODE_KEYBINDINGS);
  const launchPath = [env.VSCODE_GIT_ASKPASS_NODE, env.VSCODE_CWD, env.VSCODE_IPC_HOOK_CLI]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const appDirectory = launchPath.includes('insiders') ? 'Code - Insiders' : 'Code';
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (platform === 'win32') return path.join(appData, appDirectory, 'User', 'keybindings.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', appDirectory, 'User', 'keybindings.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), appDirectory, 'User', 'keybindings.json');
}

function maskJsoncComments(source) {
  const chars = source.split('');
  let inString = false;
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && next === '/') {
      chars[i] = chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && chars[i] !== '\n') chars[i++] = ' ';
      i--;
      continue;
    }
    if (ch === '/' && next === '*') {
      chars[i] = chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
        i++;
      }
      if (i < chars.length) chars[i] = chars[i + 1] = ' ';
      i++;
    }
  }
  return chars.join('');
}

function removeTrailingCommas(source) {
  const chars = source.split('');
  let inString = false;
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== ',') continue;
    let next = i + 1;
    while (next < chars.length && /\s/.test(chars[next])) next++;
    if (chars[next] === ']' || chars[next] === '}') chars[i] = ' ';
  }
  return chars.join('');
}

function findRootArrayEnd(source) {
  const clean = maskJsoncComments(source);
  let inString = false;
  let escaped = false;
  let depth = 0;
  let started = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (!started) {
      if (/\s/.test(ch)) continue;
      if (ch !== '[') throw new Error('VS Code keybindings.json must contain a top-level array.');
      started = true;
      depth = 1;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('VS Code keybindings.json has an unterminated array.');
}

function parseKeybindings(source) {
  const masked = maskJsoncComments(source);
  const json = removeTrailingCommas(masked);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('VS Code keybindings.json must contain a top-level array.');
  return parsed;
}

export function mergeBahulamShiftEnterKeybinding(source) {
  const current = String(source || '[]\n');
  const keybindings = parseKeybindings(current);
  const additions = [];
  const conflicts = [];
  for (const binding of BAHULAM_TERMINAL_BINDINGS) {
    const matching = keybindings.filter(item => String(item?.key || '').toLowerCase() === binding.key);
    if (!matching.length) {
      additions.push(binding);
      continue;
    }
    const installed = matching.some(item => item.command === binding.command
      && item.when === binding.when
      && item.args?.text === binding.args.text);
    if (!installed) conflicts.push(binding.key);
  }

  if (!additions.length) return {
    changed: false,
    content: current,
    reason: conflicts.length ? 'conflict' : 'already-installed',
    conflicts,
  };

  const closing = findRootArrayEnd(current);
  const cleanInside = maskJsoncComments(current.slice(0, closing)).trimEnd();
  const hasItems = keybindings.length > 0;
  const hasTrailingComma = cleanInside.endsWith(',');
  const entries = additions.map(binding => JSON.stringify(binding, null, 2)
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n'));
  const separator = hasItems && !hasTrailingComma ? ',' : '';
  const trailingComma = hasTrailingComma ? ',' : '';
  const addition = `${separator}\n${entries.join(',\n')}${trailingComma}\n`;
  return {
    changed: true,
    content: `${current.slice(0, closing)}${addition}${current.slice(closing)}`,
    reason: conflicts.length ? 'partial' : 'added',
    conflicts,
  };
}

export function installBahulamShiftEnterKeybinding({ filePath = vscodeKeybindingsPath() } = {}) {
  let current = '[]\n';
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error('Refusing to replace a symlinked keybindings.json.');
    current = fs.readFileSync(filePath, 'utf8');
    mode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const result = mergeBahulamShiftEnterKeybinding(current);
  if (!result.changed) return { ...result, filePath };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.bahulam-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, result.content, { flag: 'wx', mode });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* No temporary file was created. */ }
    throw error;
  }
  return { ...result, filePath };
}

export function terminalSetupSnippet() {
  return BAHULAM_TERMINAL_BINDINGS.map(binding => JSON.stringify(binding, null, 2)).join(',\n');
}
