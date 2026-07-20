import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AgentLoader } from './loader.mjs';

export const AGENT_SYNC_ENDPOINT = '/api/user/agents/sync';

export function slugifyAgentName(value) {
  return String(value || 'agent')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'agent';
}

export function agentContentHash(agent) {
  const body = JSON.stringify(agentToSpec(agent));
  return crypto.createHash('sha256').update(body).digest('hex');
}

export function agentToSpec(agent) {
  const slug = slugifyAgentName(agent.slug || agent.id || agent.name);
  const config = agent.raw_config || {
    apiVersion: 'agent.framework/v1',
    kind: 'SubAgent',
    metadata: {
      name: agent.name || slug,
      role: agent.role || 'specialist',
      description: agent.description || '',
      capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
      domains: Array.isArray(agent.domains) ? agent.domains : [],
    },
    agent: {
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.maxTokens ? { max_tokens: agent.maxTokens } : { max_tokens: 4096 }),
      max_iterations: agent.max_iterations || agent.maxTurns || 10,
      system_prompt: agent.prompt || agent.system_prompt || '',
    },
    tools: Array.isArray(agent.tools) ? agent.tools : [],
  };
  const spec = {
    id: slug,
    slug,
    name: agent.name || slug,
    description: agent.description || '',
    role: agent.role || 'specialist',
    model: agent.model || undefined,
    models: agent.models && Object.keys(agent.models).length ? agent.models : undefined,
    tools: Array.isArray(agent.tools) ? agent.tools : [],
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
    domains: Array.isArray(agent.domains) ? agent.domains : [],
    system_prompt: agent.prompt || agent.system_prompt || '',
    config,
    max_iterations: agent.max_iterations || agent.maxTurns || 10,
    can_delegate: agent.can_delegate ?? false,
    can_be_delegated_to: agent.can_be_delegated_to ?? true,
    source: 'cli',
  };
  return Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== undefined));
}

export function listLocalAgents(cwd = process.cwd()) {
  return new AgentLoader().load(cwd).list().map(agent => {
    const spec = agentToSpec(agent);
    return {
      ...agent,
      slug: spec.slug,
      spec,
      content_hash: agentContentHash(agent),
      source_scope: String(agent.source || '').includes(`${path.sep}.kepler${path.sep}agents${path.sep}`)
        ? (String(agent.source).startsWith(path.join(cwd, '.kepler')) ? 'project' : 'global')
        : 'unknown',
    };
  });
}

function splitCommand(value) {
  return String(value || '')
    .match(/"[^"]+"|'[^']+'|\S+/g)
    ?.map(part => part.replace(/^["']|["']$/g, '')) || [];
}

function commandExists(command, env = process.env) {
  if (!command) return false;
  if (command.includes(path.sep)) return fs.existsSync(command);

  const pathValue = env.PATH || '';
  const extensions = process.platform === 'win32'
    ? ['', '.cmd', '.exe', '.bat']
    : [''];
  return pathValue.split(path.delimiter).some(dir => (
    extensions.some(ext => fs.existsSync(path.join(dir, `${command}${ext}`)))
  ));
}

export function isVsCodeTerminal(env = process.env) {
  return env.TERM_PROGRAM === 'vscode' || Boolean(env.VSCODE_PID);
}

export function resolveAgentEditor({
  env = process.env,
  allowConfiguredEditor = true,
} = {}) {
  if (isVsCodeTerminal(env) && commandExists('code', env)) {
    return { command: 'code', args: ['-r'], label: 'VS Code' };
  }

  if (!allowConfiguredEditor) return null;
  const configured = env.VISUAL || env.EDITOR || '';
  const [command, ...args] = splitCommand(configured);
  if (command && commandExists(command, env)) {
    return { command, args, label: command };
  }
  return null;
}

export function openAgentFile(filePath, {
  env = process.env,
  allowConfiguredEditor = true,
} = {}) {
  const editor = resolveAgentEditor({ env, allowConfiguredEditor });
  if (!editor) {
    return {
      opened: false,
      reason: isVsCodeTerminal(env)
        ? 'VS Code terminal detected, but the code command is unavailable.'
        : 'No editor command found. Set VISUAL or EDITOR, or open the file manually.',
    };
  }

  const child = spawn(editor.command, [...editor.args, filePath], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.on('error', () => {});
  child.unref();
  return { opened: true, editor: editor.label };
}

export function createAgentFile({
  cwd = process.cwd(),
  name,
  description = '',
  role = 'specialist',
  model = '',
  tools = [],
  prompt = '',
  force = false,
} = {}) {
  const slug = slugifyAgentName(name);
  const dir = path.join(cwd, '.kepler', 'agents');
  const filePath = path.join(dir, `${slug}.yaml`);
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`Agent already exists: ${filePath}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const toolList = Array.isArray(tools) ? tools : String(tools || '').split(',').map(s => s.trim()).filter(Boolean);
  const body = prompt || `You are ${name}, a project-local Kepler sub-agent.\n\nFocus on the assigned task and return a concise handoff with evidence.`;
  const indentedPrompt = body.trim().split('\n').map(line => `    ${line}`).join('\n');
  const lines = [
    'apiVersion: agent.framework/v1',
    'kind: SubAgent',
    'metadata:',
    `  name: ${name}`,
    `  role: ${role}`,
    `  description: ${description || `${name} project agent`}`,
    'agent:',
    '  max_tokens: 4096',
    '  max_iterations: 10',
    ...(model ? [`  model: ${model}`] : []),
    '  system_prompt: |',
    indentedPrompt,
    'tools:',
    ...toolList.map(tool => `  - ${tool}`),
    '',
  ];
  fs.writeFileSync(filePath, lines.join('\n'), { mode: 0o600 });
  return { slug, filePath };
}

export async function syncAgentsToBackend({
  backendUrl,
  token,
  agents,
  timeoutMs = 15_000,
} = {}) {
  if (!backendUrl) throw new Error('Missing backend URL');
  if (!token) throw new Error('Not logged in. Run /login first.');
  const payload = {
    agents: agents.map(agent => ({
      slug: agent.slug,
      name: agent.name,
      description: agent.description || '',
      source: agent.source_scope || 'cli',
      spec: agent.spec || agentToSpec(agent),
      content_hash: agent.content_hash || agentContentHash(agent),
    })),
  };
  const resp = await fetch(`${backendUrl}${AGENT_SYNC_ENDPOINT}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const data = await resp.json();
      detail = data.detail || data.error || JSON.stringify(data);
    } catch {
      detail = await resp.text().catch(() => '');
    }
    throw new Error(`Agent sync failed (${resp.status})${detail ? `: ${detail}` : ''}`);
  }
  return await resp.json();
}
