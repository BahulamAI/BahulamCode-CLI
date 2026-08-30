import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  context: {
    loadEveryTurn: ['BAHULAM.md', 'project.md', 'style.md', 'goal.md', 'plan.md', 'tasks/*.md'],
    showReloadNotice: true,
    injectCommandOptions: true,
    injectActionableTips: true,
    tipTtlTurns: 2,
  },
  planning: {
    owner: 'auto',
    allowedOwners: ['main_agent', 'planner_subagent', 'auto', 'manual'],
    delegateWhen: {
      taskCountGte: 4,
      estimatedFilesGte: 6,
      touchesMultiplePackages: true,
    },
    onUserEditedPlan: 'prefer_user_plan',
  },
  tasks: {
    storage: 'project_markdown',
    syncTodoWrite: true,
    resumePrompt: true,
  },
  commands: {
    enabled: ['map', 'probe', 'footprint', 'heal', 'align', 'distill', 'brief', 'rewind'],
    defaultMode: 'interactive',
    dryRunDefault: false,
    suggestions: true,
    suggestOnlyWhenActionable: true,
    timeouts: {
      defaultSeconds: 300,
      healSeconds: 600,
      probeSeconds: 180,
      briefSeconds: 60,
    },
    aliases: {
      fix: 'heal',
      repair: 'heal',
      search: 'probe',
      summarize: 'brief',
    },
  },
  hitl: {
    defaultScope: 'once',
    allowSessionTrust: true,
    allowProjectTrust: false,
    reaskAfterMinutes: 30,
    reaskOnCommandShapeChange: true,
    reaskOnRiskIncrease: true,
    reaskOnPathBoundaryChange: true,
    alwaysAskForDangerous: true,
  },
  hooks: {
    timeoutSeconds: 5,
  },
  ui: {
    recentActions: true,
    verbosity: 'normal',
  },
});

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return deepClone(target);
  const result = Array.isArray(target) ? [...target] : { ...(target || {}) };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = deepClone(value);
    }
  }
  return result;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { __error: err.message };
  }
}

function projectConfigPath(cwd) {
  return path.join(cwd, '.bahulam', 'config.json');
}

function globalPolicyPath() {
  return path.join(os.homedir(), '.bahulam', 'policy.json');
}

function flatten(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj || {})) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, dotted, out);
    else out.push([dotted, value]);
  }
  return out;
}

export function loadEffectivePolicy({ cwd = process.cwd(), cli = {}, session = {} } = {}) {
  const layers = [
    { name: 'default', path: null, data: deepClone(DEFAULT_POLICY) },
  ];

  const global = readJson(globalPolicyPath());
  if (global && !global.__error) layers.push({ name: 'global', path: globalPolicyPath(), data: global });
  else if (global?.__error) layers.push({ name: 'global', path: globalPolicyPath(), error: global.__error, data: {} });

  const project = readJson(projectConfigPath(cwd));
  if (project && !project.__error) layers.push({ name: 'project', path: projectConfigPath(cwd), data: project });
  else if (project?.__error) layers.push({ name: 'project', path: projectConfigPath(cwd), error: project.__error, data: {} });

  if (session && Object.keys(session).length > 0) layers.push({ name: 'session', path: null, data: session });
  if (cli && Object.keys(cli).length > 0) layers.push({ name: 'cli', path: null, data: cli });

  let policy = {};
  const sources = {};
  for (const layer of layers) {
    policy = deepMerge(policy, layer.data || {});
    for (const [key, value] of flatten(layer.data || {})) {
      sources[key] = { source: layer.name, path: layer.path, value };
    }
  }

  return { policy, sources, layers };
}

export function formatPolicySourceRows(effective) {
  const rows = [];
  for (const [key, meta] of Object.entries(effective?.sources || {}).sort()) {
    rows.push({
      key,
      source: meta.source,
      path: meta.path || '',
      value: meta.value,
    });
  }
  return rows;
}
