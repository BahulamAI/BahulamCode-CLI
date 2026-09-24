/**
 * Workplane agent tools.
 *
 * Plugins opt in with `config.workplane: true`. The generated tools let an agent
 * inspect and change a Workplane document through the host authority — the same
 * gateway a browser panel commits through, so the agent and the user are editing
 * one document rather than two that look alike.
 *
 * An agent never receives HTML, JavaScript, or a renderer it can define. It
 * names a renderer from the catalog and supplies data; the authority validates
 * the whole transaction before anything is persisted.
 */
import { PROTOCOL_VERSION } from '@bahulam/workplane-ui';
import { legacyWidgetToBlock } from '@bahulam/workplane-ui/bahulam';
import { agentActor, createWorkplaneAuthority } from './workplane-authority.mjs';

function base(pluginName) {
  return String(pluginName || '').replace(/[^A-Za-z0-9_]/g, '_');
}

export function workplaneToolNames(pluginName) {
  const prefix = base(pluginName);
  return {
    update: `${prefix}_workplane_update`,
    inspect: `${prefix}_workplane_inspect`,
    commit: `${prefix}_workplane_commit`,
  };
}

/**
 * Renderers the host ships, with the spec fields each accepts.
 *
 * This is the agent's catalog. It is deliberately a fixed list on the host side:
 * a plugin cannot add a renderer by describing one, and an agent cannot invoke a
 * renderer that is not here.
 */
const CATALOG = [
  { rendererId: 'workplane.metric', accepts: 'query: {queryId, column} | inline: {value (integer minor units), currency}' },
  { rendererId: 'workplane.text', accepts: '{text, generated?}' },
  { rendererId: 'workplane.fact', accepts: '{template} with {name} placeholders resolved from bindings' },
  { rendererId: 'workplane.table', accepts: 'query: {queryId, columns[], pageSize} | inline: {columns[], rows[][], moneyColumns[], currency, pageSize}' },
  { rendererId: 'workplane.form', accepts: '{fields[{name,label,control,path,options?,min?,max?}], submitLabel}' },
  { rendererId: 'workplane.echarts', accepts: 'query: {chartType: bar|line|pie, queryId, categoryColumn, valueColumn} | inline: {chartType, data[{label,value,id?}], currency}' },
];

const OPERATIONS_DOC =
  'Supported operations: scene.add, scene.update, scene.remove, scene.move, ' +
  'block.add, block.update, block.remove, block.move, state.set. ' +
  'Anchors: omit afterSceneId/afterBlockId to append, pass null to prepend, ' +
  'pass an id to insert after it. state.set paths are relative to shared state ' +
  'and must be declared writable by the plugin.';

export function expandWorkplaneTools(pluginName, pluginDir, workplane) {
  if (!pluginName || !workplane?.enabled) return [];
  const names = workplaneToolNames(pluginName);
  const shared = { plugin_name: pluginName, _plugin_name: pluginName, _plugin_dir: pluginDir, tool: null };

  return [
    {
      ...shared,
      name: names.inspect,
      description:
        'Read the current Workplane document: revision, scenes, blocks, committed ' +
        'state, the renderer catalog, and which state paths are writable. Call this ' +
        'before committing so the expectedRevision is current.',
      input_schema: { type: 'object', properties: {} },
      _workplane_tool: { plugin: pluginName, action: 'inspect' },
    },
    {
      ...shared,
      name: names.commit,
      description:
        'Commit one atomic transaction to the Workplane document. Either every ' +
        'operation applies or none does. ' + OPERATIONS_DOC + ' ' +
        'A stale expectedRevision returns CONFLICT — re-inspect and issue a NEW ' +
        'commandId rather than replaying.',
      input_schema: {
        type: 'object',
        properties: {
          expectedRevision: { type: 'integer', description: 'Revision from workplane_inspect.' },
          operations: { type: 'array', description: 'Operations to apply, in order.' },
          commandId: { type: 'string', description: 'Optional idempotency key.' },
        },
        required: ['expectedRevision', 'operations'],
      },
      _workplane_tool: { plugin: pluginName, action: 'commit' },
    },
    {
      ...shared,
      name: names.update,
      description:
        'Publish typed widgets to the Workplane as a convenience wrapper around ' +
        'workplane_commit. Widgets are upserted by id into one scene. Supported ' +
        'types: metric, bar_chart, line_chart, donut_chart, table, alert. ' +
        'Values are data only — HTML and JavaScript are not supported. Money ' +
        'values are plain amounts and are converted for you. Prefer ' +
        `${names.commit} when you need scenes, forms, or query-backed blocks.`,
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Optional scene title.' },
          widgets: { type: 'array', description: 'Widgets to create or replace by id. Each needs id and type.' },
        },
        required: ['widgets'],
      },
      _workplane_tool: { plugin: pluginName, action: 'update' },
    },
  ];
}

const AGENT_SCENE = 'agent';

/**
 * Convert an upsert of widgets into add/update operations against the CURRENT
 * document, so calling twice with the same id replaces rather than duplicates.
 */
function widgetOperations(document, widgets, title) {
  const operations = [];
  if (!document.scenes[AGENT_SCENE]) {
    operations.push({
      op: 'scene.add',
      scene: { id: AGENT_SCENE, title: title || 'Agent additions', layout: 'grid' },
    });
  } else if (title) {
    operations.push({ op: 'scene.update', sceneId: AGENT_SCENE, patch: { title } });
  }

  for (const widget of widgets) {
    if (!widget || typeof widget !== 'object' || !widget.id || !widget.type) {
      throw new Error('every widget needs an id and a type');
    }
    const block = legacyWidgetToBlock(widget, { provenance: 'published by the plugin agent' });
    if (document.blocks[block.id]) {
      // Replace the spec and title; never silently change which scene owns it.
      operations.push({
        op: 'block.update',
        blockId: block.id,
        patch: { title: block.title, spec: block.spec, fallback: block.fallback },
      });
    } else {
      operations.push({ op: 'block.add', sceneId: AGENT_SCENE, block });
    }
  }
  return operations;
}

function projectDocument(document, policy) {
  return {
    documentId: document.id,
    revision: document.revision,
    title: document.title,
    scenes: document.sceneOrder.map((sceneId) => ({
      id: sceneId,
      title: document.scenes[sceneId]?.title,
      blocks: (document.scenes[sceneId]?.blockOrder ?? []).map((blockId) => ({
        id: blockId,
        title: document.blocks[blockId]?.title,
        rendererId: document.blocks[blockId]?.rendererId,
      })),
    })),
    state: document.shared,
    writablePaths: policy.writablePaths.map((rule) => ({ path: rule.path, schema: rule.schema })),
    queries: Object.keys(document.queries),
    catalog: CATALOG,
    operations: OPERATIONS_DOC,
  };
}

let commandCounter = 0;

/**
 * Execute one Workplane tool. Returns the `{ success, output }` envelope.
 *
 * `state` is the plugin state proxy the caller already built; the authority is
 * constructed around it so the agent writes exactly where the panel reads.
 */
export async function runWorkplaneTool(pluginName, action, input, { state, workplane }) {
  const { authority, documentId, policy } = createWorkplaneAuthority(pluginName, { state, workplane });
  const actor = agentActor(pluginName);

  const snapshot = async () => {
    const existing = await authority.snapshot(documentId);
    if (existing) return existing;
    // First touch: an empty commit would be rejected, so seed by committing a
    // no-op scene only when the agent is actually writing.
    return undefined;
  };

  if (action === 'inspect') {
    const document = (await snapshot()) ?? null;
    if (!document) {
      return {
        success: true,
        output: {
          documentId,
          revision: 0,
          empty: true,
          writablePaths: policy.writablePaths.map((r) => ({ path: r.path, schema: r.schema })),
          catalog: CATALOG,
          operations: OPERATIONS_DOC,
        },
      };
    }
    return { success: true, output: projectDocument(document, policy) };
  }

  const document = await snapshot();
  if (!document) {
    return { success: false, output: 'The Workplane document could not be opened.' };
  }

  let operations;
  let expectedRevision;
  if (action === 'update') {
    if (!Array.isArray(input?.widgets)) {
      return { success: false, output: 'widgets must be an array' };
    }
    try {
      operations = widgetOperations(document, input.widgets, input.title);
    } catch (error) {
      return { success: false, output: error.message };
    }
    // The wrapper reads the revision itself, so an agent cannot get it wrong.
    expectedRevision = document.revision;
  } else if (action === 'commit') {
    if (!Array.isArray(input?.operations) || input.operations.length === 0) {
      return { success: false, output: 'operations must be a non-empty array' };
    }
    operations = input.operations;
    expectedRevision = Number.isInteger(input.expectedRevision) ? input.expectedRevision : document.revision;
  } else {
    return { success: false, output: `unknown workplane action: ${action}` };
  }

  if (operations.length === 0) {
    return { success: true, output: { revision: document.revision, applied: 0, note: 'nothing to change' } };
  }

  const transaction = {
    protocolVersion: PROTOCOL_VERSION,
    documentId,
    commandId: typeof input?.commandId === 'string' && input.commandId
      ? input.commandId
      : `agent_${Date.now().toString(36)}_${(++commandCounter).toString(36)}`,
    expectedRevision,
    operations,
  };

  const result = await authority.commit(transaction, actor);
  if (!result.ok) {
    // Hand the agent the error code, the path, and the current revision so it can
    // repair the proposal instead of guessing.
    return {
      success: false,
      output: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.path ? { path: result.error.path } : {}),
        ...(result.error.detail ? { detail: result.error.detail } : {}),
        retry: result.error.retry,
      },
    };
  }

  return {
    success: true,
    output: {
      revision: result.revision,
      applied: operations.length,
      replayed: result.replayed,
      scenes: result.document.sceneOrder,
      blocks: Object.keys(result.document.blocks),
    },
  };
}
