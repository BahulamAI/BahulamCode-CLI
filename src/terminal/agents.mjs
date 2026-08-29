/**
 * Built-in Agents — specialized agent modes invoked via slash commands.
 *
 * Each agent wraps the same backend SSE flow but with a specialized
 * system prompt prefix that focuses the AI on a specific task type.
 *
 * Agents:
 * - explore: Code explorer — traces execution paths, maps architecture
 * - review:  Code reviewer — finds bugs, security issues, quality problems
 * - architect: Feature architect — designs implementations, file plans
 */

import { c } from './ansi.mjs';
import { BahulamStreamClient } from '../core/stream-client.mjs';

// ── Agent Definitions ────────────────────────────────────────

export const BUILTIN_AGENTS = [
  {
    command: 'explore',
    name: 'Code Explorer',
    description: 'Deeply analyze codebase features and architecture',
    detail: 'Traces execution paths, maps layers, documents dependencies',
    icon: '🔭',
    systemPrompt: `You are a Code Explorer agent. Your job is to deeply analyze the codebase to answer the user's question.

Your approach:
1. Start by understanding what the user wants to know
2. Search for relevant files using search_code and list_files
3. Read the key files to trace the execution path
4. Map the architecture layers (entry points → business logic → data layer)
5. Document dependencies between components
6. Provide a clear, structured answer with file references

Rules:
- ONLY use read-only tools: read_file, search_code, list_files, search_files, get_file_info
- NEVER modify any files
- NEVER run shell commands that modify state
- Include file paths and line numbers in your references
- Structure your response with clear sections: Overview, Key Files, Execution Flow, Dependencies
- Be thorough but concise — focus on what matters for the user's question`,
    readOnly: true,
  },
  {
    command: 'review',
    name: 'Code Reviewer',
    description: 'Review code for bugs, security issues, and quality',
    detail: 'Scans for OWASP top 10, logic errors, code smells',
    icon: '🔍',
    systemPrompt: `You are a Code Review agent. Your job is to review code for issues.

Your approach:
1. Read the files or directories the user specifies
2. Check for:
   - Security vulnerabilities (OWASP top 10: injection, XSS, auth bypass, etc.)
   - Logic errors and edge cases
   - Error handling gaps
   - Performance issues (N+1 queries, memory leaks, blocking operations)
   - Code quality (naming, complexity, duplication)
3. Rate each finding by severity: CRITICAL / HIGH / MEDIUM / LOW
4. Provide specific fix suggestions with code

Rules:
- ONLY use read-only tools: read_file, search_code, list_files, search_files
- NEVER modify any files
- Focus on HIGH and CRITICAL issues first
- Include file:line references
- Structure: Summary → Critical Issues → Other Findings → Recommendations
- Be specific — "line 42 has SQL injection via string interpolation" not "check for SQL injection"`,
    readOnly: true,
  },
  {
    command: 'architect',
    name: 'Feature Architect',
    description: 'Design feature implementations with file plans',
    detail: 'Analyzes patterns, designs components, maps data flows',
    icon: '📐',
    systemPrompt: `You are a Feature Architect agent. Your job is to design how a feature should be implemented.

Your approach:
1. Understand the feature requirements from the user
2. Analyze existing codebase patterns and conventions:
   - File organization and naming
   - Import patterns and module structure
   - Error handling patterns
   - Testing patterns
3. Design the implementation:
   - List all files to create/modify
   - Component/module design with interfaces
   - Data flow (request → processing → response)
   - Database schema changes if needed
4. Provide implementation order (what to build first)

Rules:
- ONLY use read-only tools: read_file, search_code, list_files, search_files
- NEVER modify any files — you DESIGN, you don't implement
- Follow existing project conventions
- Structure: Requirements → Architecture → File Plan → Implementation Order → Risks
- Include code sketches for key interfaces
- Call out edge cases and potential pitfalls`,
    readOnly: true,
  },
];

// ── Agent Runner ─────────────────────────────────────────────

const TOOL_ALIASES = new Map([
  ['bash', 'shell'],
  ['shell_command', 'shell'],
  ['read', 'read_file'],
  ['write', 'write_file'],
  ['edit', 'edit_file'],
  ['grep', 'search_code'],
]);

function canonicalToolName(value) {
  const key = String(value || '').trim().toLowerCase();
  return TOOL_ALIASES.get(key) || key;
}

const RUNTIME_PLACEHOLDER_CWDS = new Set([
  '/workspace',
  '/workspace/kepler-code',
]);

function normalizeScopedArgs(toolName, args = {}, { projectRoot = null } = {}) {
  if (canonicalToolName(toolName) !== 'shell' || !projectRoot) return args;
  const next = { ...(args || {}) };
  const cwd = String(next.cwd || '').trim();
  if (!cwd || RUNTIME_PLACEHOLDER_CWDS.has(cwd)) {
    next.cwd = projectRoot;
  }
  return next;
}

function createScopedToolExecutor(baseExecutor, agent, { projectRoot = null } = {}) {
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const allowed = new Set(tools.map(canonicalToolName).filter(Boolean));
  if (!allowed.size) return baseExecutor;

  return {
    ...baseExecutor,
    execute: async (toolName, args = {}, options = {}) => {
      const canonical = canonicalToolName(toolName);
      if (!allowed.has(canonical)) {
        return {
          success: false,
          output: `Tool '${toolName}' is not allowed for agent '${agent.name}'. Allowed tools: ${tools.join(', ')}`,
        };
      }
      return baseExecutor.execute.call(
        baseExecutor,
        toolName,
        normalizeScopedArgs(toolName, args, { projectRoot }),
        options,
      );
    },
  };
}

export function findBuiltinAgent(agentName) {
  const target = String(agentName || '').trim().toLowerCase();
  return BUILTIN_AGENTS.find(agent => agent.command === target || agent.name.toLowerCase() === target) || null;
}

export function localAgentMatches(agent, target) {
  const needle = String(target || '').trim().toLowerCase();
  if (!needle) return false;
  return [
    agent.slug,
    agent.id,
    agent.name,
  ].some(value => String(value || '').trim().toLowerCase() === needle);
}

function normalizeRunnableAgent(agent) {
  const spec = agent?.spec || {};
  const config = agent?.config || spec.config || agent?.raw_config || {};
  const configAgent = config.agent || {};
  const tools = Array.isArray(agent?.tools)
    ? agent.tools
    : Array.isArray(spec.tools)
      ? spec.tools
      : Array.isArray(config.tools)
        ? config.tools
        : [];

  const name = agent?.name || spec.name || agent?.slug || agent?.command || 'agent';
  return {
    command: agent?.command || agent?.slug || spec.slug || name,
    slug: agent?.slug || spec.slug || agent?.command || name,
    name,
    description: agent?.description || spec.description || '',
    role: agent?.role || spec.role || 'specialist',
    icon: agent?.icon || '◇',
    systemPrompt: agent?.systemPrompt || agent?.system_prompt || agent?.prompt || spec.system_prompt || configAgent.system_prompt || '',
    readOnly: Boolean(agent?.readOnly),
    model: agent?.model || spec.model || configAgent.model || null,
    models: agent?.models || spec.models || configAgent.models || null,
    tools,
    source: agent?.source || spec.source || '',
  };
}

function agentInstructionPrefix(agent, execContext = {}) {
  const lines = [];
  if (agent.systemPrompt) {
    lines.push(agent.systemPrompt);
  } else {
    lines.push(`You are ${agent.name}, a Bahulam Code sub-agent.`);
  }
  if (agent.description) lines.push(`\nAgent description: ${agent.description}`);
  if (agent.role) lines.push(`Agent role: ${agent.role}`);
  if (agent.tools.length) {
    lines.push(
      `Allowed tools for this sub-agent: ${agent.tools.join(', ')}. ` +
      'Do not request tools outside this list.',
    );
  }
  if (execContext.project_root) {
    lines.push(`Runtime project root: ${execContext.project_root}. Use this as the cwd for shell commands unless the task explicitly requires a different registered project root.`);
  }
  return lines.join('\n');
}

function displayEventForDirectAgent(event, agent) {
  if (!event || !event.type) return event;
  if (!['tool_call', 'tool_request', 'tool_result', 'tool_done', 'sub_agent_tool'].includes(event.type)) {
    return event;
  }
  return {
    ...event,
    data: {
      ...(event.data || {}),
      internal: true,
      sub_agent: event.data?.sub_agent || agent.slug || agent.command || agent.name || 'agent',
    },
  };
}

/**
 * Run a normalized agent definition with the given instruction.
 * @param {Object} agentDefinition - Built-in or .bahulam/agents definition
 * @param {string} instruction - User's instruction
 * @param {Object} ctx - { auth, toolExecutor, approval }
 * @param {Object} session - Session state
 * @param {Function} renderEvent - Event renderer function
 * @param {Object} [options]
 */
export async function runAgentDefinition(agentDefinition, instruction, ctx, session, renderEvent, options = {}) {
  const agent = normalizeRunnableAgent(agentDefinition);
  const userInstruction = String(instruction || '').trim() || 'Run your assigned task now.';
  const suppliedContext = options.execContext || options.context || {};
  const baseCwd = suppliedContext.cwd || options.cwd || process.cwd();
  const suppliedSubAgent = suppliedContext.sub_agent && typeof suppliedContext.sub_agent === 'object'
    ? suppliedContext.sub_agent
    : {};
  const projectRoot = suppliedContext.project_root || null;
  const execContext = {
    ...suppliedContext,
    cwd: suppliedContext.cwd || baseCwd,
    ...(projectRoot ? { project_root: projectRoot } : {}),
    sub_agent: {
      ...suppliedSubAgent,
      name: agent.name,
      slug: agent.slug,
      role: agent.role,
      description: agent.description,
      tools: agent.tools,
      source: agent.source,
    },
  };

  const creds = ctx.auth.loadCredentials();
  if (!creds.token) {
    process.stderr.write(`  ${c.red('Not logged in. Run /login first.')}\n`);
    return;
  }

  // Header
  process.stderr.write(`\n  ${agent.icon} ${c.bold(c.brand(agent.name))}\n`);
  process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
  if (agent.description) process.stderr.write(`  ${c.gray(agent.description)}\n`);
  if (agent.source) process.stderr.write(`  ${c.dim(agent.source)}\n`);
  process.stderr.write(`  ${c.gray(userInstruction)}\n\n`);

  // Prepend agent system prompt to instruction
  const fullInstruction = `${agentInstructionPrefix(agent, execContext)}\n\n---\n\nUser request: ${userInstruction}`;

  // For read-only agents, use a restricted approval manager
  const { ApprovalManager } = await import('../core/approval.mjs');
  const agentApproval = agent.readOnly
    ? new ApprovalManager({ planMode: true })  // planMode blocks all writes
    : ctx.approval;
  const toolExecutor = createScopedToolExecutor(ctx.toolExecutor, agent, {
    projectRoot: execContext.project_root || null,
  });

  const client = new BahulamStreamClient({
    baseUrl: creds.backendUrl,
    token: creds.token,
    toolExecutor,
    approvalManager: agentApproval,
  });

  session.turns++;
  session.toolCalls = 0;
  let assistantContent = '';
  if (agent.model) execContext.model_override = agent.model;
  if (agent.models && typeof agent.models === 'object' && Object.keys(agent.models).length) {
    execContext.model_overrides = agent.models;
  }

  try {
    for await (const event of client.execute(fullInstruction, execContext)) {
      renderEvent(displayEventForDirectAgent(event, agent));

      if (event.type === 'content' || event.type === 'content_partial') {
        const text = event.data?.text || '';
        if (text) assistantContent += text;
      }
    }
  } catch (err) {
    process.stderr.write(`  ${c.red('Agent error: ' + err.message)}\n`);
  }

  // Save to conversation history
  if (assistantContent) {
    session.history.push(
      { role: 'user', content: `[${agent.name}] ${userInstruction}` },
      { role: 'assistant', content: assistantContent }
    );
  }

  process.stderr.write('\n');
}

/**
 * Run a built-in agent with the given instruction.
 * @param {string} agentName - e.g. 'explore', 'review', 'architect'
 * @param {string} instruction - User's instruction
 * @param {Object} ctx - { auth, toolExecutor, approval }
 * @param {Object} session - Session state
 * @param {Function} renderEvent - Event renderer function
 */
export async function runAgent(agentName, instruction, ctx, session, renderEvent) {
  const agent = findBuiltinAgent(agentName);
  if (!agent) {
    process.stderr.write(`  ${c.red('Unknown agent: ' + agentName)}\n`);
    return;
  }
  return runAgentDefinition(agent, instruction, ctx, session, renderEvent);
}
