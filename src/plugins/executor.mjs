/**
 * Plugin Executor — dynamic import() of plugin tool handler modules.
 *
 * Plugin tools are .mjs / .js files that export at minimum a `call(input)` function.
 * They are loaded relative to the plugin directory.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'path';
import { makePluginState } from './state.mjs';

/**
 * Load a plugin tool handler by resolving its path relative to the plugin directory.
 * @param {string} pluginDir - Absolute path to the plugin directory
 * @param {string} handlerPath - Relative path from plugin.yaml (e.g. ./tools/my-tool.mjs)
 * @returns {Promise<object|null>} { name, description, inputSchema, call } or null
 */
export async function loadPluginTool(pluginDir, handlerPath) {
  try {
    const absPath = path.resolve(pluginDir, handlerPath);
    const fileUrl = pathToFileURL(absPath).href;

    // Cache-busting for development: append timestamp
    const url = `${fileUrl}?t=${Date.now()}`;
    const mod = await import(url);

    // The module should export at minimum: call(input) => { success, output }
    if (typeof mod.call !== 'function') {
      if (process.env.DEBUG) {
        console.error(`Plugin handler ${handlerPath} does not export a call() function`);
      }
      return null;
    }

    return {
      name: mod.name || path.basename(handlerPath, path.extname(handlerPath)),
      description: mod.description || '',
      inputSchema: mod.inputSchema || mod.input_schema || { type: 'object', properties: {} },
      call: mod.call,
      validateInput: mod.validateInput || null,
    };
  } catch (err) {
    if (process.env.DEBUG) {
      console.error(`Failed to load plugin tool handler ${handlerPath}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Create a plugin tool executor for a given plugin directory.
 * Loads all tool handlers and returns an execute function.
 *
 * @param {object} manifest - Normalized plugin manifest
 * @returns {Promise<{ execute(name, args): Promise<object>, list(): string[] }>}
 */
/**
 * Create a plugin tool executor for a given plugin directory.
 * Loads all tool handlers and returns an execute function.
 *
 * @param {object} manifest - Normalized plugin manifest
 * @param {object} [opts]
 * @param {(evt: {plugin: string, op: string, kind: string, target: string, at: string}) => void} [opts.stateEmit]
 *   Called (debounced) after every state write commits. The workspace
 *   server threads this in so state changes turn into SSE events for
 *   live view updates — the Shared Blackboard's reactive pulse.
 * @returns {Promise<{ execute(name, args): Promise<object>, list(): string[], state: object|null }>}
 */
export async function createPluginToolExecutor(manifest, opts = {}) {
  const pluginDir = manifest._dir || '';
  const tools = manifest.config?.tools || [];
  const handlers = new Map(); // name → { handler, toolDef }
  const pluginName = manifest.metadata?.name || '';

  for (const toolDef of tools) {
    if (!toolDef.tool) continue;
    const handler = await loadPluginTool(pluginDir, toolDef.tool);
    if (handler) {
      handlers.set(toolDef.name, { handler, toolDef });
    }
  }

  // One state instance per plugin, opened lazily so plugins that never
  // touch state don't create empty ~/.bahulam/data/<name> directories.
  let _state = null;
  function getState() {
    if (!pluginName) return null; // no name → no isolation → refuse state
    if (_state) return _state;
    _state = makePluginState(pluginName, { emit: opts.stateEmit || null });
    return _state;
  }

  return {
    execute: async (name, args, options = {}) => {
      const entry = handlers.get(name);
      if (!entry) {
        return { success: false, output: `Plugin tool not found: ${name}` };
      }
      // Inject the shared-blackboard handle. Handlers opt in by naming
      // it in their signature: `async call(args, { state })`. The
      // getter defers opening the SQLite file until the first access,
      // so handlers that don't use state pay no cost.
      const handlerOpts = {
        ...options,
        get state() { return getState(); },
        pluginName,
      };
      try {
        const result = await entry.handler.call(args || {}, handlerOpts);
        return result?.success !== false
          ? { success: true, output: result?.output ?? result, _tool: name, _plugin: pluginName }
          : { success: false, output: result?.output ?? String(result), _tool: name, _plugin: pluginName };
      } catch (err) {
        return { success: false, output: `Plugin tool error (${name}): ${err.message}`, _tool: name, _plugin: pluginName };
      }
    },
    list: () => [...handlers.keys()],
    /** Get (or open) the plugin's state handle — used by the view API. */
    get state() { return getState(); },
  };
}
