import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadMultiWorkflowFromFile } from './multi_workflow_loader.mjs';

export const WORKFLOW_SYNC_ENDPOINT = '/api/workflows';

export function slugifyWorkflowName(value) {
  return String(value || 'workflow')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'workflow';
}

function yamlQuote(value) {
  const text = String(value ?? '');
  if (!text) return "''";
  if (/[:#\n\r\t]/.test(text) || /^\s|\s$/.test(text) || text.includes('"') || text.includes("'")) {
    return JSON.stringify(text);
  }
  return text;
}

function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `${pad}${line}`)
    .join('\n');
}

function renderScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return yamlQuote(value);
}

function renderYamlValue(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const nested = renderYamlValue(item, indent + 2).split('\n');
        return `${pad}- ${nested[0].trim()}\n${nested.slice(1).join('\n')}`;
      }
      return `${pad}- ${renderScalar(item)}`;
    }).join('\n');
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return `${pad}{}`;
    return entries.map(([key, item]) => {
      if (Array.isArray(item)) {
        if (!item.length) return `${pad}${key}: []`;
        const rendered = renderYamlValue(item, indent + 2);
        return `${pad}${key}:\n${rendered}`;
      }
      if (item && typeof item === 'object') {
        const rendered = renderYamlValue(item, indent + 2);
        return `${pad}${key}:\n${rendered}`;
      }
      return `${pad}${key}: ${renderScalar(item)}`;
    }).join('\n');
  }

  return `${pad}${renderScalar(value)}`;
}

function normalizeWorkflowAgent(agent, index) {
  if (typeof agent === 'string') {
    const slug = slugifyWorkflowName(agent);
    return {
      slug,
      label: agent,
      model: 'auto',
      tools: [],
      config: {},
    };
  }
  const slug = slugifyWorkflowName(agent?.slug || agent?.name || `agent-${index + 1}`);
  const label = agent?.label || agent?.name || slug;
  return {
    slug,
    label,
    model: agent?.model || 'auto',
    tools: Array.isArray(agent?.tools) ? agent.tools : String(agent?.tools || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
    config: agent?.config && typeof agent.config === 'object' ? agent.config : {},
  };
}

function normalizeWorkflowEdges(edges, agentSlugs) {
  if (Array.isArray(edges) && edges.length > 0) {
    return edges
      .filter(edge => edge && edge.source && edge.target)
      .map(edge => ({ source: edge.source, target: edge.target }));
  }
  const normalized = [];
  if (!agentSlugs.length) return normalized;
  normalized.push({ source: 'trigger', target: agentSlugs[0] });
  for (let i = 0; i < agentSlugs.length - 1; i++) {
    normalized.push({ source: agentSlugs[i], target: agentSlugs[i + 1] });
  }
  normalized.push({ source: agentSlugs[agentSlugs.length - 1], target: 'output' });
  return normalized;
}

export function createWorkflowFile({
  cwd = process.cwd(),
  name,
  description = '',
  pattern = 'sequential',
  agents = [],
  edges = [],
  globalParams = {},
  force = false,
} = {}) {
  if (!name || !String(name).trim()) {
    throw new Error('name is required');
  }
  const slug = slugifyWorkflowName(name);
  const dir = path.join(cwd, '.kepler', 'workflows');
  const filePath = path.join(dir, `${slug}.yaml`);
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`Workflow already exists: ${filePath}`);
  }
  const normalizedAgents = (Array.isArray(agents) ? agents : [agents])
    .filter(Boolean)
    .map((agent, index) => normalizeWorkflowAgent(agent, index));
  if (!normalizedAgents.length) {
    throw new Error('agents is required for a workflow');
  }
  const agentSlugs = normalizedAgents.map(agent => agent.slug);
  const normalizedEdges = normalizeWorkflowEdges(edges, agentSlugs);

  const lines = [
    'apiVersion: kepler.workflow/v1',
    'kind: MultiWorkflow',
    'metadata:',
    `  name: ${yamlQuote(name)}`,
  ];
  if (description) {
    lines.push(`  description: ${yamlQuote(description)}`);
  }
  lines.push(
    'orchestration:',
    `  pattern: ${yamlQuote(pattern)}`,
    'agents:'
  );

  for (const agent of normalizedAgents) {
    lines.push(`  - slug: ${yamlQuote(agent.slug)}`);
    lines.push(`    label: ${yamlQuote(agent.label)}`);
    lines.push(`    model: ${yamlQuote(agent.model || 'auto')}`);
    lines.push('    tools:');
    if (agent.tools.length === 0) {
      lines.push('      []');
    } else {
      for (const tool of agent.tools) {
        lines.push(`      - ${yamlQuote(tool)}`);
      }
    }
    const configKeys = Object.keys(agent.config || {});
    if (configKeys.length > 0) {
      lines.push('    config:');
      for (const key of configKeys.sort()) {
        const value = agent.config[key];
        if (Array.isArray(value) || (value && typeof value === 'object')) {
          lines.push(indentBlock(`${key}:`, 6));
          lines.push(renderYamlValue(value, 8));
        } else {
          lines.push(`      ${key}: ${renderScalar(value)}`);
        }
      }
    }
  }

  lines.push('edges:');
  for (const edge of normalizedEdges) {
    lines.push('  - source: ' + yamlQuote(edge.source));
    lines.push('    target: ' + yamlQuote(edge.target));
  }

  lines.push('global_params:');
  const globalKeys = Object.keys(globalParams || {});
  if (globalKeys.length === 0) {
    lines.push('  {}');
  } else {
    for (const key of globalKeys.sort()) {
      const value = globalParams[key];
      if (Array.isArray(value) || (value && typeof value === 'object')) {
        lines.push(indentBlock(`${key}:`, 2));
        lines.push(renderYamlValue(value, 4));
      } else {
        lines.push(`  ${key}: ${renderScalar(value)}`);
      }
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, { mode: 0o600 });

  return {
    slug,
    filePath,
    pattern,
    agent_count: normalizedAgents.length,
    edge_count: normalizedEdges.length,
  };
}

export function listLocalWorkflows(cwd = process.cwd()) {
  const dir = path.join(cwd, '.kepler', 'workflows');
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!['.yaml', '.yml'].includes(path.extname(entry.name).toLowerCase())) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const payload = loadMultiWorkflowFromFile(filePath);
        results.push({
          filePath,
          slug: slugifyWorkflowName(payload.name || entry.name),
          ...payload,
          agent_count: (payload.graph?.nodes || []).filter(node => node.type === 'agent').length,
          edge_count: (payload.graph?.edges || []).length,
          content_hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        });
      } catch (err) {
        if (process.env.DEBUG) {
          console.error(`[workflow-scaffold] Failed to load ${filePath}: ${err.message}`);
        }
      }
    }
  } catch {
    // Directory missing
  }
  return results;
}

