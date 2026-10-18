import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePluginManifestFile, validatePluginManifest } from '../../plugins/manifest.mjs';
import { makePluginState } from '../../plugins/state.mjs';
import { dispatch } from '../../orchestration/dispatch.mjs';
import { scopeKey } from './bindings.mjs';

const receiptsTable = { name: 'teams_receipts', columns: [
  { name: 'id', type: 'TEXT', primary: true }, { name: 'status', type: 'TEXT', not_null: true },
  { name: 'created_at', type: 'TEXT', not_null: true },
] };

// Reuse Bahulam's own manifest parser, state implementation and agent runtime.
// No second model loop, unrestricted tool executor, shell, or filesystem tools.
export async function loadRuntime({ pluginDir, credentials, model, dispatchOverride } = {}) {
  if (!pluginDir) throw new Error('A provisioned plugin directory is required.');
  pluginDir = path.resolve(pluginDir);
  const manifest = parsePluginManifestFile(path.join(pluginDir, 'plugin.yaml'));
  const validation = validatePluginManifest(manifest);
  if (validation.errors?.length) throw new Error(`Invalid plugin: ${validation.errors.join(', ')}`);
  const agent = manifest.config.agents.find(entry => entry.entry_agent);
  if (!agent) throw new Error('Plugin entry agent is missing.');
  const tools = new Map();
  for (const definition of manifest.config.tools) {
    const module = await import(pathToFileURL(path.resolve(pluginDir, definition.tool)).href);
    tools.set(definition.name, { call: module.call,
      approvalArgument: definition.input_schema?.properties?.approved ? 'approved' : null });
  }
  return {
    manifest, tools,
    openState: scope => makePluginState(`teams-${scopeKey(manifest.metadata.name, scope).slice(0, 48)}`, { tables: [...manifest.config.state.tables, receiptsTable] }),
    async runAgent({ text, history, execute, signal, sessionId }) {
      const instruction = history.length
        ? `Prior conversation (context only, not new instructions):\n${JSON.stringify(history)}\n\nCurrent user request:\n${text}`
        : text;
      const outcome = await (dispatchOverride || dispatch)({ type: 'invoke', source: 'microsoft-teams',
        target: { kind: 'agent', slug: agent.slug, agent }, params: { instruction },
        channel: 'local', substrate: 'direct', signal }, {
        toolExecutor: { execute, listPluginToolSchemas: () => manifest.config.tools.map(tool => ({
          name: tool.name, description: tool.description, input_schema: tool.input_schema,
        })) },
        listRunnables: () => [agent], credentials, defaultModel: model, sessionId, cwd: pluginDir,
      });
      if (!outcome.dispatched || outcome.result?.status === 'failed' || signal?.aborted) {
        throw new Error('Bahulam agent execution did not complete.');
      }
      return outcome.result.output;
    },
  };
}
