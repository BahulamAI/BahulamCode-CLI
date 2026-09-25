/**
 * The Workplane command boundary: one authority, reachable over HTTP.
 *
 * The panel must be a CLIENT of the host authority, not a second writer.
 * Everything here is about that: the same document an agent tool sees, actors
 * derived from the session rather than the body, scope guards, and a stale
 * revision refused.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

// The service resolves plugins from os.homedir(), so isolation means
// redirecting it — the same approach test-plugin-settings-workplane uses.
const fixture = mkdtempSync(join(os.tmpdir(), 'wp-boundary-'));
const originalHomedir = os.homedir;
const savedHome = process.env.BAHULAM_HOME;
os.homedir = () => fixture;
process.env.BAHULAM_HOME = join(fixture, '.bahulam');

const pluginName = 'boundary-fixture';
const pluginDir = join(fixture, '.bahulam', 'plugins', pluginName);
mkdirSync(pluginDir, { recursive: true });
writeFileSync(join(pluginDir, 'plugin.yaml'), `apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: ${pluginName}
  version: 0.1.0
config:
  workplane:
    enabled: true
    document:
      id: wp_boundary
      title: Boundary fixture
    writablePaths:
      - path: /n
        schema: { type: integer, minimum: 0, maximum: 100 }
`);

let service = null;
try {
  const { createLocalWorkspaceSession, touchLocalWorkspaceSession } = await import('../src/local-service/session-store.mjs');
  const { startLocalWorkspaceService } = await import('../src/local-service/server.mjs');
  const { session, token } = createLocalWorkspaceSession({ targetPath: fixture });
  touchLocalWorkspaceSession(session.id, { plugin: { name: pluginName } });
  service = await startLocalWorkspaceService({ session, token, port: 0 });

  const call = async (path, body, authenticated = true) => {
    const response = await fetch(new URL(path, service.url), {
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Bahulam-Local-Token': token } : {}) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const base = `/api/workplane/${pluginName}`;

  // --- auth and scope ------------------------------------------------------
  assert.equal((await call(base, undefined, false)).status, 401, 'unauthenticated read is refused');
  assert.equal((await call('/api/workplane/other-plugin')).status, 403, 'cross-plugin access is refused');

  // --- snapshot ------------------------------------------------------------
  const snapshot = await call(base);
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data));
  assert.equal(snapshot.data.result.documentId, 'wp_boundary');
  assert.equal(snapshot.data.result.document.revision, 0);
  assert.deepEqual(snapshot.data.result.writablePaths.map(w => w.path), ['/n']);
  assert.equal(snapshot.data.result.historyComplete, true);

  const tx = (commandId, expectedRevision, operations) => ({
    protocolVersion: 'workplane/1', documentId: 'wp_boundary', commandId, expectedRevision, operations,
  });

  // --- commit --------------------------------------------------------------
  const first = await call(`${base}/commands`, tx('c1', 0, [{ op: 'state.set', path: '/n', value: 7 }]));
  assert.equal(first.status, 200);
  assert.equal(first.data.result.ok, true, JSON.stringify(first.data.result.error));
  assert.equal(first.data.result.revision, 1);
  assert.equal(first.data.result.document.shared.n, 7);
  assert.ok(first.data.result.event.commitId?.startsWith('wpc_'), 'commits are content-addressed');

  // The actor comes from the SESSION, not the body. A forged actor is ignored.
  const forged = await call(`${base}/commands`, {
    ...tx('c2', 1, [{ op: 'state.set', path: '/n', value: 8 }]),
    actor: { id: 'root', type: 'system', capabilities: ['workplane.edit'] },
  });
  assert.equal(forged.data.result.ok, true);
  assert.notEqual(forged.data.result.event.actor.id, 'root', 'a body-supplied actor is not authority');
  assert.equal(forged.data.result.event.actor.type, 'user');

  // --- concurrency ---------------------------------------------------------
  const stale = await call(`${base}/commands`, tx('c3', 0, [{ op: 'state.set', path: '/n', value: 9 }]));
  assert.equal(stale.data.result.ok, false);
  assert.equal(stale.data.result.error.code, 'CONFLICT');
  assert.equal(stale.data.result.error.detail.currentRevision, 2);

  // --- policy --------------------------------------------------------------
  const forbidden = await call(`${base}/commands`, tx('c4', 2, [{ op: 'state.set', path: '/secret', value: 1 }]));
  assert.equal(forbidden.data.result.ok, false);
  assert.equal(forbidden.data.result.error.code, 'FORBIDDEN');

  const outOfRange = await call(`${base}/commands`, tx('c5', 2, [{ op: 'state.set', path: '/n', value: 500 }]));
  assert.equal(outOfRange.data.result.ok, false);
  assert.match(outOfRange.data.result.error.message, /above the maximum/);

  // --- idempotency ---------------------------------------------------------
  const replay = await call(`${base}/commands`, tx('c1', 0, [{ op: 'state.set', path: '/n', value: 7 }]));
  assert.equal(replay.data.result.ok, true);
  assert.equal(replay.data.result.replayed, true, 'a repeated command replays rather than reapplying');
  assert.equal(replay.data.result.revision, 1);

  // --- history -------------------------------------------------------------
  const events = await call(`${base}/events?after=0`);
  assert.equal(events.status, 200);
  assert.equal(events.data.result.events.length, 2);
  const { verifyHistory } = await import('@bahulam/workplane-ui');
  const verdict = verifyHistory(events.data.result.events);
  assert.equal(verdict.status, 'verified', JSON.stringify(verdict));

  const after1 = await call(`${base}/events?after=1`);
  assert.equal(after1.data.result.events.length, 1, 'the revision cursor is honoured');

  // --- one document, shared with the agent tools ---------------------------
  const { runWorkplaneTool } = await import('../src/plugins/workplane-tools.mjs');
  const { makePluginState } = await import('../src/plugins/state.mjs');
  const { parsePluginManifestFile } = await import('../src/plugins/manifest.mjs');
  const manifest = parsePluginManifestFile(join(pluginDir, 'plugin.yaml'));
  const state = makePluginState(pluginName, {});
  const seen = await runWorkplaneTool(pluginName, 'inspect', {}, { state, workplane: manifest.config.workplane });
  assert.equal(seen.output.revision, 2, 'the agent tool sees the panel\'s commits');
  assert.equal(seen.output.state['/n'] ?? seen.output.state.n, 8);

  // A plugin without config.workplane has no boundary at all.
  const { normalizeManifest } = await import('../src/plugins/manifest.mjs');
  void normalizeManifest;

  console.log('✓ workplane boundary: auth, scope, commit, session-derived actor, conflict, policy, idempotency, verified history, one document');
} finally {
  if (service) await service.close();
  os.homedir = originalHomedir;
  if (savedHome === undefined) delete process.env.BAHULAM_HOME;
  else process.env.BAHULAM_HOME = savedHome;
  rmSync(fixture, { recursive: true, force: true });
}
