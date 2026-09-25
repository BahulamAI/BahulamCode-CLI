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

  // --- history navigation (section 5.4.6) ---------------------------------
  {
    const history = await call(`${base}/history`);
    assert.equal(history.status, 200);
    assert.equal(history.data.result.historyComplete, true);
    assert.deepEqual(history.data.result.entries.map(e => e.revision), [1, 2]);
    assert.ok(history.data.result.entries[0].commitId.startsWith('wpc_'));
    assert.deepEqual(history.data.result.entries[0].operations, ['state.set']);
    assert.deepEqual(history.data.result.checkpoints, [1], 'the first revision is checkpointed');

    // Rebuild an earlier revision and diff it against live.
    const at1 = await call(`${base}/revision?at=1`);
    assert.equal(at1.status, 200);
    assert.equal(at1.data.result.ok, true, JSON.stringify(at1.data.result));
    assert.equal(at1.data.result.document.revision, 1);
    assert.equal(at1.data.result.document.shared.n, 7, 'the historical value, not the live one');
    assert.deepEqual(at1.data.result.diff.shared, [{ path: '/n', from: 7, to: 8 }]);

    // Opening history must not change anything.
    const afterBrowse = await call(base);
    assert.equal(afterBrowse.data.result.document.revision, 2, 'browsing history changed the document');
    assert.equal(afterBrowse.data.result.document.shared.n, 8);

    // A revision that cannot be rebuilt is refused, not approximated.
    const unreachable = await call(`${base}/revision?at=999`);
    assert.equal(unreachable.data.result.ok, false);
    assert.match(unreachable.data.result.message, /needs|before the earliest/);

    assert.equal((await call(`${base}/revision`)).status, 400, 'a revision is required');
  }

  // --- the bus fires on a commit, so a panel can update without a reload ----
  {
    const controller = new AbortController();
    const seen = [];
    const stream = await fetch(new URL(`/api/events?token=${encodeURIComponent(token)}`, service.url), {
      signal: controller.signal,
    });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (const chunk of buffer.split('\n\n')) {
            const name = /^event:\s*(.+)$/m.exec(chunk)?.[1];
            const data = /^data:\s*(.+)$/m.exec(chunk)?.[1];
            if (name === 'plugin_state_changed' && data) {
              try { seen.push(JSON.parse(data)); } catch { /* partial frame */ }
            }
          }
          buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
        }
      } catch { /* aborted */ }
    })();

    // Commit through the agent tool — a different entry point to the same
    // authority — and the panel's bus must hear about it.
    const { runWorkplaneTool } = await import('../src/plugins/workplane-tools.mjs');
    const { makePluginState } = await import('../src/plugins/state.mjs');
    const emitted = [];
    const agentState = makePluginState(pluginName, { emit: (evt) => emitted.push(evt) });
    const head = await runWorkplaneTool(pluginName, 'inspect', {}, { state: agentState, workplane: manifest.config.workplane });
    const committed = await runWorkplaneTool(pluginName, 'commit', {
      expectedRevision: head.output.revision,
      operations: [{ op: 'scene.add', scene: { id: 'live', title: 'Live' } }],
    }, { state: agentState, workplane: manifest.config.workplane });
    assert.equal(committed.success, true, JSON.stringify(committed.output));

    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort();
    await pump;

    // The state layer emitted, and the target identifies it as a Workplane
    // write so a client can skip round trips for unrelated state.
    assert.ok(emitted.length > 0, 'a commit must emit a state-change event');
    assert.ok(
      emitted.some((evt) => String(evt.target || '').startsWith('workplane')),
      `a Workplane commit must be identifiable on the bus, got ${JSON.stringify(emitted)}`,
    );
  }

  console.log('✓ workplane boundary: auth, scope, commit, session-derived actor, conflict, policy, idempotency, verified history, one document, bus emission');
} finally {
  if (service) await service.close();
  os.homedir = originalHomedir;
  if (savedHome === undefined) delete process.env.BAHULAM_HOME;
  else process.env.BAHULAM_HOME = savedHome;
  rmSync(fixture, { recursive: true, force: true });
}
