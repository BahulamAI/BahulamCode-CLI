import * as fs from 'node:fs';
import * as path from 'node:path';

function safeArgs(args) {
  if (args?.command) return String(args.command).slice(0, 500);
  if (args?.file_path || args?.path) return String(args.file_path || args.path).slice(0, 500);
  try { return JSON.stringify(args || {}).slice(0, 500); }
  catch { return String(args || '').slice(0, 500); }
}

export class ApprovalLog {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
    this.filePath = path.join(cwd, '.kepler', 'approvals.log');
  }

  append(entry) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        tier: entry.tier,
        tool: entry.tool,
        args: safeArgs(entry.args),
        decision: entry.decision,
        scope: entry.scope || 'once',
        rule_id: entry.rule_id || null,
        reason: entry.reason || undefined,
      });
      fs.appendFileSync(this.filePath, line + '\n');
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
