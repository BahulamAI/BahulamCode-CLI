import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { daemonSessionsRoot } from '../core/paths.mjs';

export async function listDaemonSessions() {
  const dir = daemonSessionsRoot();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('sess_')) continue;
      try {
        const meta = JSON.parse(await readFile(join(dir, entry.name, 'meta.json'), 'utf-8'));
        sessions.push({ id: entry.name, ...meta });
      } catch { /* no meta.json, skip */ }
    }
    if (sessions.length === 0) {
      process.stderr.write('No daemon sessions.\n');
      return;
    }
    for (const s of sessions) {
      const pid = s.pid ? ` (pid ${s.pid})` : '';
      const cwd = s.cwd || '?';
      const model = s.model || '?';
      process.stderr.write(`  ${s.id}  ${cwd}  ${model}${pid}\n`);
    }
  } catch (err) {
    process.stderr.write(`No daemon sessions: ${err.message}\n`);
  }
}
