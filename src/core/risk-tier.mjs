/**
 * Risk tier classifier — Mission Control (PRD-055 §8.1).
 *
 *   import { classify, TIERS, behavior } from './risk-tier.mjs';
 *   const tier = classify('shell', { command: 'rm -rf node_modules' });
 *   // → 'shell-dangerous'
 *
 * Pure: no I/O, no async. Tested in isolation; the rest of the CLI relies on
 * the return value to decide whether to auto-approve, auto-approve with
 * checkpoint, or hold for explicit approval.
 *
 * The CLI never asks the backend for the tier. The backend's job is to say
 * "this is what I want to run"; we map that to a tier locally so dangerous
 * intent can't be hidden behind a friendly description.
 */

import { isApprovalRequiredWritePath, isSensitiveConfigPath } from './safety.mjs';

// ── Tier enum ────────────────────────────────────────────────────────────

export const TIERS = Object.freeze({
  READ:            'read',
  SENSITIVE_READ:  'sensitive-read',
  LOCAL_EDIT:      'local-edit',
  PROTECTED_EDIT:  'protected-edit',
  SHELL_SAFE:      'shell-safe',
  SHELL_MEDIUM:    'shell-medium',
  SHELL_DANGEROUS: 'shell-dangerous',
  DESTRUCTIVE:     'destructive',
  NETWORK:         'network',
});

/**
 * Default behavior by tier:
 *   auto              — proceed silently
 *   auto-with-undo    — proceed but record a checkpoint first
 *   prompt-safe       — prompt with Enter=approve default
 *   prompt-explicit   — magenta-bordered prompt, no default
 */
export const BEHAVIOR = Object.freeze({
  [TIERS.READ]:            'auto',
  [TIERS.SENSITIVE_READ]:  'prompt-explicit',
  [TIERS.LOCAL_EDIT]:      'auto-with-undo',
  [TIERS.PROTECTED_EDIT]:  'prompt-explicit',
  [TIERS.SHELL_SAFE]:      'auto',
  [TIERS.SHELL_MEDIUM]:    'prompt-safe',
  [TIERS.SHELL_DANGEROUS]: 'prompt-explicit',
  [TIERS.DESTRUCTIVE]:     'prompt-explicit',
  [TIERS.NETWORK]:         'prompt-safe',
});

export function behavior(tier) {
  return BEHAVIOR[tier] || 'prompt-safe';
}

// ── Tool → tier (non-shell) ─────────────────────────────────────────────

const READ_TOOLS = new Set([
  'read_file', 'read_files',
  'search_code', 'search_files', 'grep',
  'list_files', 'get_file_info', 'get_project_overview',
  'git_status', 'git_diff',
  'analyze_code',
  'validate_file', 'validate_structure',
  'agents_list', 'workflow_list',
  'bahulam_info', 'job_output',
]);

const READ_PATH_KEYS = [
  'path', 'file_path', 'file', 'target',
  'pattern', 'glob',
];

const READ_PATH_ARRAY_KEYS = [
  'paths', 'file_paths', 'files', 'targets', 'patterns', 'globs',
];

const LOCAL_EDIT_TOOLS = new Set([
  'edit_file', 'write_file', 'write_project',
  'skill_install', 'skill_update',
  'agent_create', 'agent_sync',
  'workflow_create_multi', 'workflow_sync_multi',
]);

const WRITE_PATH_KEYS = [
  'path', 'file_path', 'file', 'target',
];

const WRITE_PATH_ARRAY_KEYS = [
  'paths', 'file_paths', 'targets',
];

const DESTRUCTIVE_TOOLS = new Set([
  'delete_file', 'skill_remove',
]);

const NETWORK_TOOLS = new Set([
  'WebFetch', 'fetch_url',
  'workflow_run_multi',
]);

// ── Shell sub-classifier ────────────────────────────────────────────────

const SHELL_SAFE_RE = [
  // Inspection / read-only + harmless shell navigation built-ins.
  // `cd` / `pushd` / `popd` only change the process working directory; if
  // chained with something dangerous, the multi-segment classifier still
  // catches the danger (`cd /x && rm -rf .` → SHELL_DANGEROUS).
  /^\s*(cd|pushd|popd|ls|cat|head|tail|less|more|wc|file|stat|tree|find|grep|rg|ag|fd|sed|echo|printf|pwd|whoami|date|which|type|env|printenv|uname|hostname|id|df|du|uptime|free|top|ps|lsof)\b/i,
  // mkdir -p / touch are creation primitives but harmless in scope.
  /^\s*mkdir\s+-p\b/i,
  /^\s*touch\s/i,
  /^\s*git\s+(status|log|diff|show|branch|tag|remote|stash\s+list|blame|shortlog|describe|rev-parse|ls-files|ls-tree|config\s+--get)\b/i,
  // Test-only invocations
  /^\s*(npm|pnpm|yarn)\s+(test|run\s+test|run\s+lint|list|ls|view|info|outdated)\b/i,
  /^\s*node\s+--check\b/i,
  /^\s*python3?\s+-m\s+py_compile\b/i,
  /^\s*pytest\b(?!.*--?(delete|rm|destructive))/i,
  /^\s*cargo\s+(check|test|clippy|build)\b/i,
  /^\s*go\s+(test|vet|build)\b/i,
  /^\s*make\s+(test|check|lint|build)\b/i,
];

const SHELL_DANGEROUS_RE = [
  /\brm\s/i,
  /\brm\s+-r/i,
  /\brm\s+--recursive/i,
  /\brm\s+-rf?\b/i,
  /\bunlink\s/i,
  /\brmdir\s+-/i,
  /\bgit\s+push.*--force/i,
  /\bgit\s+push.*-f\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-f/i,
  /\bgit\s+checkout\s+\./i,
  /\bgit\s+stash\s+drop/i,
  /\bgit\s+branch\s+-D/i,
  /\bgit\s+filter-branch/i,
  /\bsudo\b/i,
  /\bsu\s+-/i,
  /\bcurl\b.*\|\s*(sh|bash|zsh)/i,
  /\bwget\b.*\|\s*(sh|bash|zsh)/i,
  /\beval\s+["'$(]/i,
  /\bfind\s+\/(?:\s|$)/i,
  /\bfind\b.*\s-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fls|fprintf)\b/i,
  /\bkubectl\s+delete/i,
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|network\s+rm)/i,
  /\bdrop\s+(table|database|schema)/i,
  /\btruncate\s+table/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\s*\(\s*\)\s*\{.*:\|/i, // fork bomb
  />\s*\/dev\/sda/i,
];

const SHELL_MEDIUM_RE = [
  /^\s*(npm|pnpm|yarn)\s+(install|i|add|remove|uninstall|update|upgrade|publish|deploy)\b/i,
  /^\s*pip\s+(install|uninstall|--upgrade)\b/i,
  /^\s*pipx\s+(install|uninstall)\b/i,
  /^\s*brew\s+(install|uninstall|upgrade|update)\b/i,
  /^\s*apt(-get)?\s+(install|remove|upgrade|update)\b/i,
  /^\s*cargo\s+(install|uninstall|publish|run)\b/i,
  /^\s*go\s+(install|get|mod\s+tidy|mod\s+download)\b/i,
  /^\s*make(\s|$)/i,
  /^\s*git\s+(commit|push|pull|merge|rebase|fetch|checkout(?!\s+\.)|cherry-pick|revert|tag|stash(?!\s+drop))/i,
  /^\s*docker\s+(build|run|exec|compose|pull|push|tag)/i,
  /^\s*sed\b.*\s-i\S*(?:\s|$)/i,
  /^\s*sed\b.*\s--in-place(?:=|\s|$)/i,
];

export function classifyShell(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return TIERS.SHELL_MEDIUM;

  // Dangerous wins over safe — never let a safe-looking prefix mask `&& rm -rf`.
  if (SHELL_DANGEROUS_RE.some(re => re.test(cmd))) return TIERS.SHELL_DANGEROUS;

  if (hasUnsafeOutputRedirection(cmd)) return TIERS.SHELL_MEDIUM;

  // For a chained command, classify each segment and take the riskiest —
  // never let a safe-looking prefix mask `&& npm install` or worse.
  if (/&&|\|\||;|\|(?!\|)/.test(cmd)) {
    const segments = splitShellSegments(cmd);
    if (segments.length > 1) {
      let worst = TIERS.SHELL_SAFE;
      for (const seg of segments) {
        const t = classifyShell(seg);
        worst = riskier(worst, t);
        if (worst === TIERS.SHELL_DANGEROUS) return worst;
      }
      return worst;
    }
  }

  if (SHELL_MEDIUM_RE.some(re => re.test(cmd))) return TIERS.SHELL_MEDIUM;
  if (SHELL_SAFE_RE.some(re => re.test(cmd)))   return TIERS.SHELL_SAFE;
  return TIERS.SHELL_MEDIUM;
}

function hasUnsafeOutputRedirection(cmd) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && !inSingle) { escaped = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble || ch !== '>') continue;

    const prev = cmd[i - 1] || '';
    const next = cmd[i + 1] || '';
    if (next === '&') continue;
    let cursor = next === '>' ? i + 2 : i + 1;
    while (/\s/.test(cmd[cursor] || '')) cursor++;
    const target = cmd.slice(cursor).match(/^[^\s;&|]+/)?.[0] || '';
    if (target === '/dev/null') continue;
    if (prev === '2' && target === '/dev/null') continue;
    return true;
  }
  return false;
}

function splitShellSegments(cmd) {
  // Split on top-level &&, ||, ;, | — naive but enough for the classifier.
  return cmd.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);
}

const TIER_ORDER = [
  TIERS.READ,
  TIERS.SENSITIVE_READ,
  TIERS.SHELL_SAFE,
  TIERS.LOCAL_EDIT,
  TIERS.PROTECTED_EDIT,
  TIERS.NETWORK,
  TIERS.SHELL_MEDIUM,
  TIERS.DESTRUCTIVE,
  TIERS.SHELL_DANGEROUS,
];

function riskier(a, b) {
  return TIER_ORDER.indexOf(b) > TIER_ORDER.indexOf(a) ? b : a;
}

// ── Top-level classify ──────────────────────────────────────────────────

/**
 * Classify a tool call into a risk tier. Always returns one of TIERS.
 *
 * @param {string} tool   Tool name (e.g. 'shell', 'edit_file')
 * @param {object} args   Tool arguments (e.g. { command: 'rm -rf x' })
 */
export function classify(tool, args = {}) {
  if (!tool) return TIERS.SHELL_MEDIUM;

  if (READ_TOOLS.has(tool)) {
    return isSensitiveRead(args) ? TIERS.SENSITIVE_READ : TIERS.READ;
  }
  if (LOCAL_EDIT_TOOLS.has(tool)) {
    return isApprovalRequiredWrite(args) ? TIERS.PROTECTED_EDIT : TIERS.LOCAL_EDIT;
  }
  if (DESTRUCTIVE_TOOLS.has(tool)) return TIERS.DESTRUCTIVE;
  if (NETWORK_TOOLS.has(tool))     return TIERS.NETWORK;

  if (tool === 'shell' || tool === 'run_tests' || tool === 'validate_build' || tool === 'lint_check') {
    return classifyShell(args.command || args.cmd || '');
  }

  // Sub-agents inherit their parent's risk (read-ish by default).
  if (['explore', 'plan', 'verify', 'debug', 'refactor', 'analyze_code'].includes(tool)) {
    return TIERS.READ;
  }

  // MCP tools: assume network unless the name implies read.
  if (tool.startsWith('mcp')) {
    return /(?:read|get|list|search|describe|info|status)/i.test(tool) ? TIERS.READ : TIERS.NETWORK;
  }

  return TIERS.SHELL_MEDIUM;
}

/**
 * Convenience: human label for a tier (used in approval prompts and the
 * status bar). Returned strings already uppercased / hyphenated.
 */
export function label(tier) {
  switch (tier) {
    case TIERS.READ:            return 'READ';
    case TIERS.SENSITIVE_READ:  return 'SENSITIVE-READ';
    case TIERS.LOCAL_EDIT:      return 'LOCAL-EDIT';
    case TIERS.PROTECTED_EDIT:  return 'PROTECTED-EDIT';
    case TIERS.SHELL_SAFE:      return 'SHELL-SAFE';
    case TIERS.SHELL_MEDIUM:    return 'SHELL-MEDIUM';
    case TIERS.SHELL_DANGEROUS: return 'SHELL-DANGEROUS';
    case TIERS.DESTRUCTIVE:     return 'DESTRUCTIVE';
    case TIERS.NETWORK:         return 'NETWORK';
    default:                    return String(tier || '').toUpperCase();
  }
}

/**
 * Whether the tool needs an explicit human keystroke before running.
 */
export function requiresExplicitApproval(tier) {
  return behavior(tier) === 'prompt-explicit';
}

/**
 * Whether the tier should auto-create an undo checkpoint before running.
 */
export function requiresCheckpoint(tier) {
  return behavior(tier) === 'auto-with-undo';
}

export function isSensitiveRead(args = {}) {
  return extractReadPaths(args).some(isSensitiveReadPath);
}

export function isSensitiveReadPath(filePath = '') {
  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .trim();
  if (!normalized) return false;

  const parts = normalized.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || normalized;
  if (isSensitiveConfigPath(base)) return true;
  if (/\.pem$/i.test(base)) return true;
  return parts.includes('secrets');
}

export function isApprovalRequiredWrite(args = {}) {
  return extractWritePaths(args).some(isApprovalRequiredWritePath);
}

function extractReadPaths(args = {}) {
  const paths = [];
  for (const key of READ_PATH_KEYS) {
    if (typeof args[key] === 'string') paths.push(args[key]);
  }
  for (const key of READ_PATH_ARRAY_KEYS) {
    const value = args[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') {
        paths.push(item);
      } else if (item && typeof item === 'object') {
        for (const nestedKey of READ_PATH_KEYS) {
          if (typeof item[nestedKey] === 'string') paths.push(item[nestedKey]);
        }
      }
    }
  }
  return paths;
}

function extractWritePaths(args = {}) {
  const paths = [];
  for (const key of WRITE_PATH_KEYS) {
    if (typeof args[key] === 'string') paths.push(args[key]);
  }
  for (const key of WRITE_PATH_ARRAY_KEYS) {
    const value = args[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') {
        paths.push(item);
      } else if (item && typeof item === 'object') {
        for (const nestedKey of WRITE_PATH_KEYS) {
          if (typeof item[nestedKey] === 'string') paths.push(item[nestedKey]);
        }
      }
    }
  }
  if (Array.isArray(args.files)) {
    for (const item of args.files) {
      if (typeof item === 'string') paths.push(item);
      else if (item && typeof item === 'object') {
        for (const nestedKey of WRITE_PATH_KEYS) {
          if (typeof item[nestedKey] === 'string') paths.push(item[nestedKey]);
        }
      }
    }
  }
  return paths;
}
