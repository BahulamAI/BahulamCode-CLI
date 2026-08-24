import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { daemonSessionDir } from '../core/paths.mjs';

export async function stopDaemonSession(sessionId) {
  if (!sessionId) {
    process.stderr.write('Usage: bahulam stop <session-id>\n');
    return;
  }
  const pidFile = join(daemonSessionDir(sessionId), 'daemon.pid');
  try {
    const pid = parseInt((await readFile(pidFile, 'utf-8')).trim(), 10);
    process.kill(pid, 'SIGTERM');
    process.stderr.write(`Sent SIGTERM to daemon ${sessionId} (pid ${pid})\n`);
  } catch (err) {
    process.stderr.write(`Failed to stop daemon ${sessionId}: ${err.message}\n`);
  }
}
