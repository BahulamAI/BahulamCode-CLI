import assert from 'node:assert/strict';
import { capabilityGraphForManifest, parsePluginManifest, validatePluginManifest } from '../src/plugins/manifest.mjs';

const manifest = parsePluginManifest(`
apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: capability-fixture
  version: 1.0.0
config:
  tools:
    - name: read_status
      description: Read the current status.
      tool: ./tools/read-status.mjs
  skills:
    - id: status-analysis
      source: ./skills/status/SKILL.md
      applies_to: [analyst]
      availability: [chat, ide, cli]
  connectors:
    - id: remote-status
      transport: remote-mcp
      connection_scope: user
      auth: { type: oauth2, required_scopes: [status.read] }
      permissions: { read: [status.read], write: [] }
      availability: [chat, ide, cli-remote]
      secret_residency: hosted-vault
  outcome_runtime:
    state: { mode: hosted, schema_version: 1 }
    artifacts: ./artifacts.yaml
    workplane:
      source: ./workplane/status.json
      renderers: [metric, table]
      availability: [chat, ide, plugin]
  policy:
    data_classification: internal
    egress: connector-declared-only
    audit: required
    operations:
      - id: status.write
        approval: explicit
        billing_class: connector_write
`);

assert.ok(manifest, 'fixture manifest parses');
assert.deepEqual(validatePluginManifest(manifest), { valid: true, errors: [] });
assert.deepEqual(manifest.config.skills.map(item => item.id), ['status-analysis']);
assert.equal(manifest.config.connectors[0].transport, 'remote-mcp');
assert.equal(manifest.config.outcome_runtime.state.mode, 'hosted');
assert.equal(manifest.config.policy.operations[0].approval, 'explicit');

const graph = capabilityGraphForManifest(manifest);
assert.equal(graph.version, 1);
assert.equal(graph.plugin.id, 'capability-fixture');
assert.deepEqual(graph.capabilities.tools.map(item => item.id), ['read_status']);
assert.equal(graph.connectors[0].auth.type, 'oauth2');
assert.equal(graph.outcome_runtime.workplane.renderers[1], 'table');
assert.equal(graph.policy.operations[0].id, 'status.write');
assert.equal(JSON.stringify(graph).includes('tools/read-status.mjs'), false, 'graph does not disclose local module paths');

const bad = parsePluginManifest(`
apiVersion: bahulam.plugin/1
metadata: { name: bad-capability }
config:
  connectors:
    - id: broken
      transport: unknown
      connection_scope: user
      auth: { type: oauth2 }
      availability: [chat]
`);
assert.ok(bad);
assert.equal(validatePluginManifest(bad).valid, false, 'bad connector declaration fails validation');

console.log('plugin capability graph tests passed');
