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

import { c, spinner, inPlace, hr } from './ansi.mjs';
import { TarangStreamClient } from '../core/stream-client.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';

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

/**
 * Run a built-in agent with the given instruction.
 * @param {string} agentName - e.g. 'explore', 'review', 'architect'
 * @param {string} instruction - User's instruction
 * @param {Object} ctx - { auth, toolExecutor, approval }
 * @param {Object} session - Session state
 * @param {Function} renderEvent - Event renderer function
 */
export async function runAgent(agentName, instruction, ctx, session, renderEvent) {
  const agent = BUILTIN_AGENTS.find(a => a.command === agentName);
  if (!agent) {
    process.stderr.write(`  ${c.red('Unknown agent: ' + agentName)}\n`);
    return;
  }

  const creds = ctx.auth.loadCredentials();
  if (!creds.token) {
    process.stderr.write(`  ${c.red('Not logged in. Run /login first.')}\n`);
    return;
  }

  // Header
  process.stderr.write(`\n  ${agent.icon} ${c.bold(c.brand(agent.name))}\n`);
  process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
  process.stderr.write(`  ${c.gray(instruction)}\n\n`);

  // Prepend agent system prompt to instruction
  const fullInstruction = `${agent.systemPrompt}\n\n---\n\nUser request: ${instruction}`;

  // For read-only agents, use a restricted approval manager
  const { ApprovalManager } = await import('../core/approval.mjs');
  const agentApproval = agent.readOnly
    ? new ApprovalManager({ planMode: true })  // planMode blocks all writes
    : ctx.approval;

  const client = new TarangStreamClient({
    baseUrl: creds.backendUrl,
    token: creds.token,
    toolExecutor: ctx.toolExecutor,
    approvalManager: agentApproval,
  });

  session.turns++;
  session.toolCalls = 0;
  let assistantContent = '';

  try {
    for await (const event of client.execute(fullInstruction, { cwd: process.cwd() })) {
      renderEvent(event);

      if (event.type === 'content' || event.type === 'content_partial') {
        const text = event.data?.text || '';
        if (text) assistantContent = text;
      }
    }
  } catch (err) {
    inPlace('');
    process.stderr.write(`  ${c.red('Agent error: ' + err.message)}\n`);
  }

  // Save to conversation history
  if (assistantContent) {
    session.history.push(
      { role: 'user', content: `[${agent.name}] ${instruction}` },
      { role: 'assistant', content: assistantContent }
    );
  }

  process.stderr.write('\n');
}
