/**
 * Plugin Executor — dynamic import() of plugin tool handler modules.
 *
 * Plugin tools are .mjs / .js files that export at minimum a `call(input)` function.
 * They are loaded relative to the plugin directory.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'path';

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
export async function createPluginToolExecutor(manifest) {
  const pluginDir = manifest._dir || '';
  const tools = manifest.spec?.tools || [];
  const handlers = new Map(); // name → { handler, toolDef }

  for (const toolDef of tools) {
    if (!toolDef.handler) continue;
    const handler = await loadPluginTool(pluginDir, toolDef.handler);
    if (handler) {
      handlers.set(toolDef.name, { handler, toolDef });
    }
  }

  return {
    execute: async (name, args, options = {}) => {
      const entry = handlers.get(name);
      if (!entry) {
        return { success: false, output: `Plugin tool not found: ${name}` };
      }
      try {
        const result = await entry.handler.call(args || {}, options);
        return result?.success !== false
          ? { success: true, output: result?.output ?? result, _tool: name, _plugin: manifest.metadata?.name }
          : { success: false, output: result?.output ?? String(result), _tool: name, _plugin: manifest.metadata?.name };
      } catch (err) {
        return { success: false, output: `Plugin tool error (${name}): ${err.message}`, _tool: name, _plugin: manifest.metadata?.name };
      }
    },
    list: () => [...handlers.keys()],
  };
}