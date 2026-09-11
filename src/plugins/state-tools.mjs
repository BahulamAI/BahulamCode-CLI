/**
 * Declared-state tool expansion.
 *
 * A plugin that declares tables in `config.state.tables` can ask the CLI
 * to generate read-only query tools for the agent, instead of hand-writing
 * a `tools/*.mjs` handler for every "let me look at my data" case. The
 * manifest block looks like:
 *
 *   state:
 *     tables:
 *       - name: questions
 *         columns: [...]
 *     context_tools:
 *       - name: list_questions
 *         table: questions
 *         description: List exam questions, optionally filtered by topic
 *         parameters:
 *           type: object
 *           properties:
 *             topic: { type: string }
 *         where: "topic = ?"
 *         params: [topic]
 *
 * `expandStateContextTools` turns that into registry tool entries. The
 * execution side (tool-executor) recognizes the `_state_tool` marker and
 * runs the query against the plugin's own state DB — so the same tool
 * flows through every existing surface: `listPluginToolSchemas()`,
 * the client_tools map, sub-agent tool allowlists, and `/tools`.
 *
 * This mirrors `pi-compose.mjs`: one expansion per composition kind, both
 * feeding the same `PluginRegistry.listTools()` contract.
 */

/** Tool names are passed to the model, so keep them in the same charset the rest of the CLI uses. */
function sanitizeToolName(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Expand a plugin's declared `config.state.context_tools` into tool entries.
 *
 * Entries carry no `tool:` module path — they are synthesized, and
 * `_state_tool` tells the executor to query the plugin's state DB rather
 * than import a handler file.
 *
 * @param {string} pluginName
 * @param {string} pluginDir
 * @param {object|null|undefined} state normalized `config.state`
 * @returns {object[]}
 */
export function expandStateContextTools(pluginName, pluginDir, state) {
  const tools = [];
  const declared = Array.isArray(state?.context_tools) ? state.context_tools : [];
  if (!pluginName || declared.length === 0) return tools;

  const tableNames = new Set((state?.tables || []).map(t => t.name));

  for (const tool of declared) {
    const name = sanitizeToolName(tool?.name);
    if (!name) continue;
    // A generated tool must never reach past the plugin's own declared
    // tables — that is the whole safety story for author-supplied `where`.
    if (!tableNames.has(tool.table)) continue;

    tools.push({
      name,
      description: tool.description || `List rows from ${tool.table}`,
      input_schema: tool.parameters || { type: 'object', properties: {} },
      // No module to load — signals "synthesized" to any consumer that
      // would otherwise try to resolve a handler file.
      tool: null,
      plugin_name: pluginName,
      _plugin_name: pluginName,
      _plugin_dir: pluginDir,
      _state_tool: {
        plugin: pluginName,
        table: tool.table,
        where: tool.where || '',
        params: Array.isArray(tool.params) ? tool.params : [],
        limit: tool.limit || 50,
      },
    });
  }

  return tools;
}
