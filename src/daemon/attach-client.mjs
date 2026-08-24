/**
 * PRD-092 Slice C — Attach client (stub).
 *
 * Connects to a daemon's Unix socket and mirrors the event stream.
 * Full implementation pending: session discovery, socket connect,
 * event rendering, command relay (approve/deny/interrupt/send_message).
 */

export async function attachToSession(sessionId) {
  if (!sessionId) {
    process.stderr.write('Usage: bahulam attach <session-id>\n');
    process.stderr.write('Run \x1b[1mbahulam list\x1b[0m to see available sessions.\n');
    return;
  }
  process.stderr.write(`\x1b[33m! attach ${sessionId}: not yet implemented (PRD-092 Slice C)\x1b[0m\n`);
}
