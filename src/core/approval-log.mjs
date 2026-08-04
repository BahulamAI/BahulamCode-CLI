import * as fs from 'node:fs';
import * as path from 'node:path';

const REDACTED = 'REDACTED';
const SENSITIVE_KEY_RE = /^(?:authorization|api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|pwd|access[-_]?key|secret[-_]?access[-_]?key)$|(?:^|[-_])(?:api[-_]?key|apikey|token|secret|password|passwd|pwd|access[-_]?key|secret[-_]?access[-_]?key)(?:$|[-_])/i;
const SENSITIVE_ASSIGNMENT_KEY = String.raw`[A-Z0-9_-]*(?:API[-_]?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|ACCESS[-_]?KEY|SECRET[-_]?ACCESS[-_]?KEY)[A-Z0-9_-]*`;
const SENSITIVE_JSON_KEY = String.raw`(?:authorization|api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|pwd|access[-_]?key|secret[-_]?access[-_]?key|[A-Z0-9_-]*(?:API[-_]?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|ACCESS[-_]?KEY|SECRET[-_]?ACCESS[-_]?KEY)[A-Z0-9_-]*)`;

export function redactSensitive(str) {
  let s = String(str ?? '');

  // Authorization headers in shell commands, curl args, and copied HTTP snippets.
  s = s.replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)(?:"[^"]*"|'[^']*'|[^\s"',;]+)/gi, `$1${REDACTED}`);

  // Secret-bearing query/form parameters.
  s = s.replace(/([?&](?:api_key|apikey|api-key|key|token|access_token|refresh_token|password|secret)=)([^&\s"']+)/gi, `$1${REDACTED}`);

  // Env-style assignments, including quoted values.
  s = s.replace(
    new RegExp(`(^|[\\s;,])(${SENSITIVE_ASSIGNMENT_KEY}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"',;]+)`, 'gi'),
    (_match, prefix, key) => `${prefix}${key}${REDACTED}`
  );

  // JSON fragments that arrive as strings rather than structured objects.
  s = s.replace(
    new RegExp(`("(?:${SENSITIVE_JSON_KEY})"\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|[^,}\\s]+)`, 'gi'),
    `$1"${REDACTED}"`
  );

  return s;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ''));
}

function sanitizeForLog(value, depth = 0) {
  if (depth > 12) return '[MaxDepth]';
  if (typeof value === 'string') return redactSensitive(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeForLog(item, depth + 1));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeForLog(item, depth + 1);
  }
  return out;
}

function safeArgs(args) {
  if (args?.command) return redactSensitive(String(args.command)).slice(0, 500);
  if (args?.file_path || args?.path) return redactSensitive(String(args.file_path || args.path)).slice(0, 500);
  try { return JSON.stringify(sanitizeForLog(args || {})).slice(0, 500); }
  catch { return redactSensitive(String(args || '')).slice(0, 500); }
}

function safeText(value, max = 500) {
  if (!value) return undefined;
  return redactSensitive(String(value)).slice(0, max);
}

export class ApprovalLog {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
    this.filePath = path.join(cwd, '.bahulam', 'approvals.log');
  }

  append(entry) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        tier: entry.tier,
        tool: entry.tool,
        args: safeArgs(entry.args),
        decision: entry.decision,
        scope: entry.scope || 'once',
        rule_id: entry.rule_id || null,
        reason: safeText(entry.reason),
      });
      fs.appendFileSync(this.filePath, line + '\n', { mode: 0o600 });
      try { fs.chmodSync(this.filePath, 0o600); } catch {}
    } catch { /* approval logging must not block execution */ }
  }

  readRecent(limit = 20) {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      return fs.readFileSync(this.filePath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map(line => {
          try { return JSON.parse(line); }
          catch { return null; }
        })
        .filter(Boolean)
        .reverse();
    } catch {
      return [];
    }
  }
}
