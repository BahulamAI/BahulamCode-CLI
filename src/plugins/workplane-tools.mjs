/**
 * Declarative workplane tool expansion.
 *
 * Plugins opt in with `config.workplane: true`. The generated tool lets an
 * agent upsert validated widget data without ever sending HTML or JavaScript
 * to a workspace panel. Rendering remains owned by the trusted client.
 */

function toolName(pluginName) {
  return `${String(pluginName || '').replace(/[^A-Za-z0-9_]/g, '_')}_workplane_update`;
}

export function expandWorkplaneTools(pluginName, pluginDir, workplane) {
  if (!pluginName || !workplane?.enabled) return [];
  return [{
    name: toolName(pluginName),
    description: 'Update this plugin\'s live workplane with typed widgets. Supported types: metric, bar_chart, line_chart, donut_chart, table, alert, three_scene. Use data only; HTML and JavaScript are not supported.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional workplane title.' },
        widgets: { type: 'array', description: 'Widgets to create or replace by id. Every widget needs id and type.' },
      },
      required: ['widgets'],
    },
    tool: null,
    plugin_name: pluginName,
    _plugin_name: pluginName,
    _plugin_dir: pluginDir,
    _workplane_tool: { plugin: pluginName },
  }];
}
