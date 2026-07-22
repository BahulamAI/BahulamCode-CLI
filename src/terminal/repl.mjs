/**
 * Kepler REPL — Full Claude-like terminal UX.
 *
 * Pure ANSI. No React. No Ink. No flickering.
 *
 * Features:
 * - Persistent status bar (model, cost, context, elapsed)
 * - Streaming content with live partial updates
 * - Tool execution display (transparent, collapsible)
 * - File diff display with +/- highlighting
 * - Phase/worker progress indicators
 * - Built-in agents (explore, review, architect)
 * - Permission prompts (Y/n/a/t)
 * - Input history & Tab autocomplete
 * - Safety guardrails on all tool execution
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { c, progressBar, spinner, inPlace, renderMarkdown, renderDiff, formatElapsed, formatCost, stripAnsi } from './ansi.mjs';
import { calculateCost, formatCostValue, formatTokens, costToCredits, formatCredits } from '../core/pricing.mjs';
import { TarangStreamClient, EVENT_TYPES } from '../core/stream-client.mjs';
import { AgentHistoryTurnBuilder } from '../core/agent-history.mjs';
import { JsonlWriter } from '../core/jsonl-writer.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { buildWorkScope, promptProjectRoots } from '../core/work-scope.mjs';
import { CheckpointManager } from '../core/checkpoints.mjs';
import { HookRunner } from '../config/hook-runner.mjs';
import { runPreflight } from '../onboarding/preflight.mjs';
import { printBanner as printBrandedBanner } from '../ui/banner.mjs';
import { renderMissionReport, saveReport, toMarkdown as missionMarkdown } from '../ui/mission-report.mjs';
import {
  getVerbosity,
  setVerbosity,
  label as verbosityLabel,
  MODES as V_MODES,
} from '../state/verbosity.mjs';
import { persistProjectArtifacts } from '../core/project-artifacts.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';
import { formatMessageWindow, lowWindowStatus, messagesRemaining } from '../core/rate-limit-display.mjs';
import { formatAgentErrorGuidance } from '../core/error-guidance.mjs';
import { BUILTIN_AGENTS, runAgent } from './agents.mjs';
import { createAgentFile, isVsCodeTerminal, listLocalAgents, openAgentFile, syncAgentsToBackend } from '../agents/scaffold.mjs';
import { SessionManager } from '../core/session-manager.mjs';
import { parseArgs } from '../config/cli-args.mjs';
import { loadEffectivePolicy, formatPolicySourceRows } from '../core/policy-resolver.mjs';
import { loadProjectContext } from '../core/project-context-loader.mjs';
import { buildContextEnvelope } from '../core/context-envelope.mjs';
import { buildResumeHistory, combineResumeSummaries, getRecentSessions, getSessionDetail, getTranscriptProjectRoots } from '../core/local-store.mjs';
import { decideResumeMode, projectedTokensForChoice, formatTokens as formatCtxTokens } from '../core/resume-mode.mjs';
import { appendTask, ensureTaskFiles, loadTaskBoard, moveTask, removeTask, taskCounts, TASK_FILES, updateTask } from '../core/tasks.mjs';
import { applyCompactSummary, localCompactSummary, parseCompactTailCount, prepareCompactHistory } from '../core/compact-history.mjs';
import {
  appendVisionAnalysisToInstruction,
  attachmentSummaryLine,
  prepareImageAttachments,
  publicAttachmentMetadata,
  resolveAttachmentPath,
  writeClipboardImageToTemp,
} from '../core/attachments.mjs';
import { toolDisplayLabel, toolDisplaySummary } from './tool-display.mjs';
import { exploreCategory, exploreCollapseEnabled, isExploreTool } from './repl-explore.mjs';
import { session, orbitRef, sessionMgrRef, runtime } from './repl-state.mjs';
import { safeCwd } from './repl-utils.mjs';
import {
  appendContent,
  clearPendingHead,
  clippedThinking,
  expandIndex,
  expandLast,
  flushContent,
  flushExploreRun,
  flushPendingHead,
  isInlineOutcomeTool,
  renderBlockBoundary,
  renderExploreRun,
  renderStagnation,
  renderToolCall,
  renderToolResult,
  startContentStream,
  startSpinner,
  stopSpinner,
  thinkingPrefix,
  updateSpinner,
} from './repl-render.mjs';
import {
  chooseResumeHistoryMode,
  chooseThresholdMode,
  compactCurrentSession,
  confirmCwdSwitch,
  formatResumeCheckpointStatus,
  formatResumeContextStatus,
  listResumableSessions,
  pickResumableSession,
  previewResumeSession,
  renderResumePreview,
  summarizeResumeTranscript,
} from './repl-resume.mjs';
import {
  endStatusMarker,
  filterResumeReplayEvents,
  fitAnsiLine,
  formatRelativeTime,
  formatSessionCost,
  historyRoleLabel,
  mergeResumeReplayItems,
  messageCountLabel,
  normalizeResumableSession,
  oneLineInstruction,
  renderHistoryEntries,
  replayStartOrderForMode,
  resumeModeLabel,
  resumeProgressBar,
  resumeTailTurnCount,
  sessionListTimestamp,
  startResumeProgress,
} from './repl-format.mjs';
import {
  COMMANDS,
  HELP_GROUPS,
  HELP_GROUP_ALIASES,
  LEGACY_COMMAND_HINTS,
  NAMESPACED_COMMANDS,
  normalizeCommandInput,
} from '../ui/slash-commands.mjs';
import { createOrbit } from '../state/orbit.mjs';
import {
  clearInputPrompt,
  focusDockInput,
  isInputDockMounted,
  mountInputDock,
  moveToContent,
  prepareInputPrompt,
  redrawDockFrame,
  renderDockInput,
  unmountInputDock,
} from '../ui/input-dock.mjs';
import { term } from '../ui/term.mjs';
import { transcriptHeader, transcriptLine } from '../ui/transcript-block.mjs';
import {
  formatCardHead,
  formatCompactFileDiff,
  summarizeResult,
  recordCard,
  lastCard,
  getCard,
  allCards,
  clearCards,
} from '../ui/tool-card.mjs';
import { detailFor } from '../ui/tool-details.mjs';
import { paint } from '../ui/palette.mjs';
import {
  renderSubAgentOpen,
  renderSubAgentClose,
  subAgentIndent,
  inSubAgent as inSubAgentBlock,
  resetSubAgents,
} from '../ui/sub-agent.mjs';

import { createRequire } from 'node:module';
const __require = createRequire(import.meta.url);
const VERSION = __require('../../package.json').version;

// ── Safe CWD ──
// If the working directory gets deleted (by a rogue tool call),
// process.cwd() throws ENOENT. Detect and recover.

// safeCwd() moved to ./repl-utils.mjs.

// messageCountLabel, sessionListTimestamp, oneLineInstruction, fitAnsiLine
// moved to ./repl-format.mjs. Imported at the top of this file.

// normalizeResumableSession moved to ./repl-format.mjs.


// resumeTailTurnCount, replayStartOrderForMode, filterResumeReplayEvents,
// mergeResumeReplayItems, resumeProgressBar moved to ./repl-format.mjs.

// startResumeProgress moved to ./repl-format.mjs.

// ── Session State ──

// sessionMgrRef.current + orbitRef.current live in ./repl-state.mjs;
// assigned below at startup by startTerminalRepl().

// The `session` object lives in repl-state.mjs so other repl-* modules
// (resume helpers, tool renderers, streaming, etc.) can import it during
// the ongoing split. Everything below still references `session.<field>`
// directly; only the declaration site moved.

// ── Commands ──

// COMMANDS + HELP_GROUPS + HELP_GROUP_ALIASES + LEGACY_COMMAND_HINTS +
// NAMESPACED_COMMANDS + normalizeCommandInput are now the canonical
// catalog in ui/slash-commands.mjs. See imports at the top of this file.


function renderHelp(topic = '') {
  const key = String(topic || '').trim().toLowerCase();
  if (!key) {
    process.stderr.write(`\n  ${c.bold('Kepler Commands')}\n`);
    process.stderr.write(`  ${c.gray('─'.repeat(52))}\n`);
    const top = [
      ['/help', 'Grouped command help'],
      ['/status', 'Session snapshot'],
      ['/plan', 'Task list and plan'],
      ['/tasks', 'Project task files'],
      ['/history', 'Transcript, approvals, undo'],
      ['/settings', 'Policy, auth, verbosity'],
      ['/why', 'Explain last reasoning'],
    ];
    for (const [name, desc] of top) {
      process.stderr.write(`  ${c.brand(name.padEnd(14))} ${desc}\n`);
    }
    process.stderr.write(`\n  ${c.bold('Categories')}\n`);
    for (const group of HELP_GROUPS) {
      process.stderr.write(`  ${c.brand(('/help ' + group.key).padEnd(20))} ${c.dim(group.summary)}\n`);
    }
    process.stderr.write(`\n  ${c.dim('Use /help all for legacy command aliases.')}\n`);
    renderKeyboardHelp();
    return;
  }

  if (key === 'all' || key === 'commands') {
    process.stderr.write(`\n  ${c.bold('All Commands')}\n`);
    process.stderr.write(`  ${c.gray('─'.repeat(52))}\n`);
    for (const [name, desc] of Object.entries(COMMANDS)) {
      const alias = LEGACY_COMMAND_HINTS[name] ? c.dim(`  alias for ${LEGACY_COMMAND_HINTS[name]}`) : '';
      process.stderr.write(`  ${c.brand(name.padEnd(14))} ${desc}${alias}\n`);
    }
    process.stderr.write('\n');
    return;
  }

  const group = HELP_GROUP_ALIASES.get(key);
  if (!group) {
    process.stderr.write(`  ${c.gray(`Unknown help category: ${key}. Use /help.`)}\n`);
    return;
  }

  process.stderr.write(`\n  ${c.bold(group.title)} ${c.dim(group.summary)}\n`);
  process.stderr.write(`  ${c.gray('─'.repeat(52))}\n`);
  for (const [name, desc] of group.commands) {
    process.stderr.write(`  ${c.brand(name.padEnd(30))} ${desc}\n`);
  }
  process.stderr.write('\n');
}

function renderKeyboardHelp() {
  process.stderr.write(`\n  ${c.bold('Keyboard')}\n`);
  process.stderr.write(`  ${c.gray('Ctrl+C')}  exit   ${c.gray('↑↓')}  history   ${c.gray('Tab')}  autocomplete\n`);
  process.stderr.write(`  ${c.gray('Ctrl+D')}  expand last tool   ${c.gray('Space')}  pause/resume   ${c.gray('Esc')}  interrupt\n\n`);
}

const MODEL_ROLE_ALIASES = new Map([
  ['reasoning', 'reasoning'],
  ['main', 'reasoning'],
  ['coder', 'reasoning'],
  ['coding', 'reasoning'],
  ['smart', 'reasoning'],
  ['fast', 'fast'],
  ['explorer', 'fast'],
  ['orchestrator', 'orchestrator'],
  ['planner', 'orchestrator'],
  ['local', 'local'],
  ['worker', 'worker'],
  ['explore', 'explore'],
  ['plan', 'plan'],
  ['verify', 'verify'],
  ['debug', 'debug'],
  ['refactor', 'refactor'],
]);

const MODEL_ROLE_LABELS = {
  reasoning: 'coding',
  fast: 'fast',
  orchestrator: 'orchestrator',
  local: 'local',
  worker: 'worker',
  explore: 'explore',
  plan: 'plan',
  verify: 'verify',
  debug: 'debug',
  refactor: 'refactor',
};

const MODEL_ROLE_ORDER = [
  'reasoning',
  'fast',
  'orchestrator',
  'local',
  'worker',
  'explore',
  'plan',
  'verify',
  'debug',
  'refactor',
];

function normalizeModelRole(value) {
  return MODEL_ROLE_ALIASES.get(String(value || '').trim().toLowerCase()) || null;
}

function sessionModelOverrideEntries() {
  return Object.entries(session.modelOverrides || {})
    .filter(([, model]) => typeof model === 'string' && model.trim())
    .sort(([a], [b]) => MODEL_ROLE_ORDER.indexOf(a) - MODEL_ROLE_ORDER.indexOf(b));
}

function printModelCommandUsage() {
  process.stderr.write(`  ${c.gray('Usage:')} /model [model]\n`);
  process.stderr.write(`         /model <role> <model>\n`);
  process.stderr.write(`         /model clear [role]\n`);
  process.stderr.write(`  ${c.gray('Roles:')} ${MODEL_ROLE_ORDER.map(role => MODEL_ROLE_LABELS[role]).join(', ')}\n`);
}

function printModelStatus() {
  process.stderr.write(`\n  ${c.bold('Models')}\n`);
  process.stderr.write(`  ${c.gray('─'.repeat(44))}\n`);
  process.stderr.write(`  ${c.gray('Active coding')} ${session.model || 'backend default'}\n`);

  const limits = session.modelLimits || {};
  const rows = [
    ['coder', limits.coder?.model],
    ['explorer', limits.explorer?.model],
    ['orchestrator', limits.orchestrator?.model],
  ].filter(([, model]) => model);
  if (rows.length) {
    process.stderr.write(`\n  ${c.bold('Backend roles')}\n`);
    for (const [role, model] of rows) {
      process.stderr.write(`  ${c.brand(role.padEnd(14))} ${c.dim(model)}\n`);
    }
  }

  const overrides = sessionModelOverrideEntries();
  process.stderr.write(`\n  ${c.bold('Session overrides')}\n`);
  if (!overrides.length) {
    process.stderr.write(`  ${c.dim('(none)')}\n`);
  } else {
    for (const [role, model] of overrides) {
      process.stderr.write(`  ${c.brand((MODEL_ROLE_LABELS[role] || role).padEnd(14))} ${model}\n`);
    }
  }
  process.stderr.write('\n');
  printModelCommandUsage();
}

function handleModelCommand(rest = '') {
  const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    printModelStatus();
    return;
  }

  if (parts[0] === 'clear' || parts[0] === 'reset') {
    if (parts.length === 1) {
      session.modelOverrides = {};
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Cleared all session model overrides.')}\n`);
      return;
    }
    const role = normalizeModelRole(parts[1]);
    if (!role) {
      process.stderr.write(`  ${c.yellow('!')} ${c.dim(`Unknown model role: ${parts[1]}`)}\n`);
      printModelCommandUsage();
      return;
    }
    delete session.modelOverrides[role];
    process.stderr.write(`  ${c.green('✓')} ${c.dim(`Cleared ${MODEL_ROLE_LABELS[role] || role} model override.`)}\n`);
    return;
  }

  let role = 'reasoning';
  let model = parts.join(' ');
  const maybeRole = normalizeModelRole(parts[0]);
  if (maybeRole && parts.length >= 2) {
    role = maybeRole;
    model = parts.slice(1).join(' ');
  }

  if (!model || normalizeModelRole(model)) {
    printModelCommandUsage();
    return;
  }

  session.modelOverrides = { ...(session.modelOverrides || {}), [role]: model };
  if (role === 'reasoning') session.model = model;
  process.stderr.write(`  ${c.green('✓')} ${c.dim(`Session ${MODEL_ROLE_LABELS[role] || role} model override:`)} ${c.brand(model)}\n`);
  process.stderr.write(`  ${c.dim('Use /model clear or /model clear <role> to return to backend settings.')}\n`);
}

function stripPathQuotes(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function pendingVisionPaths(ctx) {
  if (!Array.isArray(ctx.pendingVisionPaths)) ctx.pendingVisionPaths = [];
  return ctx.pendingVisionPaths;
}

function printPendingAttachments(ctx) {
  const pending = pendingVisionPaths(ctx);
  if (!pending.length) {
    process.stderr.write(`  ${c.gray('No pending image attachments.')}\n`);
    return;
  }
  process.stderr.write(`\n  ${c.bold('Pending Attachments')}\n`);
  for (const filePath of pending) {
    process.stderr.write(`  ${c.brand('◇')} ${filePath}\n`);
  }
  process.stderr.write(`  ${c.dim('They will be sent for vision analysis with your next prompt.')}\n`);
}

function handleAttachCommand(rest = '', ctx) {
  const pending = pendingVisionPaths(ctx);
  const value = stripPathQuotes(rest);
  if (!value) {
    process.stderr.write(`  ${c.yellow('Usage:')} /attach <image-path> ${c.dim('or')} /attach clipboard\n`);
    return;
  }
  if (value === 'clear') {
    pending.length = 0;
    process.stderr.write(`  ${c.green('✓')} ${c.dim('Cleared pending image attachments.')}\n`);
    return;
  }
  if (['clipboard', '--clipboard', 'paste', '--paste'].includes(value.toLowerCase())) {
    try {
      const filePath = writeClipboardImageToTemp();
      pending.push(filePath);
      process.stderr.write(`  ${c.green('✓')} ${c.dim('attached clipboard image for next prompt:')} ${c.brand(path.basename(filePath))}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red('✗')} ${c.dim(err.message || String(err))}\n`);
    }
    return;
  }
  const resolved = resolveAttachmentPath(value, safeCwd());
  pending.push(resolved);
  process.stderr.write(`  ${c.green('✓')} ${c.dim('attached for next prompt:')} ${c.brand(path.basename(resolved))}\n`);
}

function handleAttachmentsCommand(rest = '', ctx) {
  const action = String(rest || '').trim().toLowerCase();
  if (action === 'clear') {
    pendingVisionPaths(ctx).length = 0;
    process.stderr.write(`  ${c.green('✓')} ${c.dim('Cleared pending image attachments.')}\n`);
    return;
  }
  printPendingAttachments(ctx);
}

async function confirmVisionUpload(ctx, attachments, { skip = false } = {}) {
  if (skip || process.env.KEPLER_VISION_CONFIRM === '0' || process.env.KEPLER_VISION_CONFIRM === 'false') {
    return true;
  }
  if (!ctx?._rl || !process.stdin.isTTY) return false;
  const names = attachments.map(a => a.name).join(', ');
  return await new Promise(resolve => {
    ctx._rl.question(`  ${c.yellow('Upload image for Kepler vision analysis?')} ${c.dim(names)} ${c.dim('[y/N]')} `, answer => {
      resolve(/^y(?:es)?$/i.test(String(answer || '').trim()));
    });
  });
}

function parseSimpleFlags(parts) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('--')) {
      const key = part.slice(2);
      const next = parts[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(part);
    }
  }
  return { flags, positional };
}

function printAgentsUsage() {
  process.stderr.write(`  ${c.gray('Usage:')} /agents\n`);
  process.stderr.write(`         /agents create <name> [--description text] [--role specialist] [--model id] [--tools a,b] [--open|--no-open]\n`);
  process.stderr.write(`         /agents edit <name>\n`);
  process.stderr.write(`         /agents sync [name]\n`);
}

function printAgentsList() {
  const local = listLocalAgents(safeCwd());
  process.stderr.write(`\n  ${c.bold('Built-in Agents')}\n`);
  process.stderr.write(`  ${c.gray('─'.repeat(44))}\n`);
  for (const agent of BUILTIN_AGENTS) {
    process.stderr.write(`  ${c.brand(('/' + agent.command).padEnd(14))} ${agent.description}\n`);
  }

  process.stderr.write(`\n  ${c.bold('Local Agents')} ${c.dim('.kepler/agents + ~/.kepler/agents')}\n`);
  process.stderr.write(`  ${c.gray('─'.repeat(44))}\n`);
  if (!local.length) {
    process.stderr.write(`  ${c.dim('(none)')}\n`);
  } else {
    for (const agent of local) {
      const scope = agent.source_scope === 'project' ? c.green('project') : c.dim(agent.source_scope);
      const model = agent.model ? c.dim(` · ${agent.model}`) : '';
      process.stderr.write(`  ${c.brand(agent.slug.padEnd(18))} ${scope} ${agent.description || ''}${model}\n`);
    }
  }
  process.stderr.write('\n');
  printAgentsUsage();
}

async function handleAgentsCommand(rest = '', ctx) {
  const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
  const action = (parts.shift() || 'list').toLowerCase();

  if (action === 'list' || action === 'ls') {
    printAgentsList();
    return;
  }

  if (action === 'create' || action === 'new') {
    const { flags, positional } = parseSimpleFlags(parts);
    const name = positional[0];
    if (!name) {
      printAgentsUsage();
      return;
    }
    try {
      const created = createAgentFile({
        cwd: safeCwd(),
        name,
        description: flags.description || flags.desc || '',
        role: flags.role || 'specialist',
        model: flags.model || '',
        tools: flags.tools || 'read_file,search_code,list_files',
        force: Boolean(flags.force),
      });
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Created local agent:')} ${created.filePath}\n`);
      const shouldOpen = !flags['no-open'] && (Boolean(flags.open) || isVsCodeTerminal());
      if (shouldOpen) {
        const opened = openAgentFile(created.filePath, {
          allowConfiguredEditor: Boolean(flags.open),
        });
        if (opened.opened) {
          process.stderr.write(`  ${c.dim('Opened in:')} ${opened.editor}\n`);
        } else {
          process.stderr.write(`  ${c.dim(opened.reason)}\n`);
        }
      }
      process.stderr.write(`  ${c.dim('Sync explicitly with:')} /agents sync ${created.slug}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
    }
    return;
  }

  if (action === 'edit' || action === 'open') {
    const target = parts.find(p => !p.startsWith('--'));
    if (!target) {
      printAgentsUsage();
      return;
    }
    const local = listLocalAgents(safeCwd());
    const agent = local.find(item => item.slug === target || item.name === target);
    if (!agent?.source) {
      process.stderr.write(`  ${c.yellow('!')} ${c.dim(`No local agent found: ${target}`)}\n`);
      return;
    }
    const opened = openAgentFile(agent.source, { allowConfiguredEditor: true });
    if (opened.opened) {
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`Opened ${agent.slug} in ${opened.editor}.`)}\n`);
    } else {
      process.stderr.write(`  ${c.yellow('!')} ${c.dim(opened.reason)}\n`);
      process.stderr.write(`  ${c.dim('Agent file:')} ${agent.source}\n`);
    }
    process.stderr.write(`  ${c.dim('Sync after editing:')} /agents sync ${agent.slug}\n`);
    return;
  }

  if (action === 'sync') {
    const target = parts.find(p => !p.startsWith('--'));
    const local = listLocalAgents(safeCwd());
    const selected = target
      ? local.filter(agent => agent.slug === target || agent.name === target)
      : local;
    if (!selected.length) {
      process.stderr.write(`  ${c.yellow('!')} ${c.dim(target ? `No local agent found: ${target}` : 'No local agents to sync.')}\n`);
      return;
    }
    try {
      const creds = ctx.auth.loadCredentials();
      const result = await syncAgentsToBackend({
        backendUrl: creds.backendUrl,
        token: creds.token,
        agents: selected,
      });
      const synced = result.synced ?? selected.length;
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`Synced ${synced} agent${synced === 1 ? '' : 's'} to Supabase.`)}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
    }
    return;
  }

  printAgentsUsage();
}

function commandCompletions(line) {
  if (line.startsWith('/help ')) {
    const topic = line.slice('/help '.length).toLowerCase();
    const categories = ['all', ...HELP_GROUPS.map(g => g.key)];
    const hits = categories.map(c => `/help ${c}`).filter(cmd => cmd.startsWith(`/help ${topic}`));
    return hits.length ? hits : categories.map(c => `/help ${c}`);
  }
  const top = ['/help', '/status', '/plan', '/tasks', '/history', '/settings', '/why'];
  const namespaced = HELP_GROUPS.flatMap(g => g.commands.map(([name]) => name.split(/\s+/)[0]));
  const all = [...new Set([...top, ...namespaced, ...Object.keys(COMMANDS), '/quit'])].sort();
  const hits = all.filter(cmd => cmd.startsWith(line));
  return hits.length ? hits : all;
}

function slashCommandSuggestions(line, limit = 5) {
  const text = String(line || '').trimStart();
  if (!text.startsWith('/')) return [];
  const partial = text.split(/\s+/)[0] || '/';
  return commandCompletions(partial)
    .filter(cmd => cmd.startsWith('/'))
    .slice(0, limit)
    .map(cmd => ({
      command: cmd,
      description: COMMANDS[cmd] || (cmd === '/quit' ? 'Exit CLI' : ''),
    }));
}

// ── Banner ──

function printBanner(auth) {
  // Delegate the visual block to the branded banner module (PRD-055 §4.3,
  // gradient KEPLER letters in Deep Space Purple → Stellar Magenta → Neon
  // Cyan). The trailing status line stays here because it needs `auth`.
  printBrandedBanner();

  const creds = auth.loadCredentials();
  const env = process.env.TARANG_ENV || 'production';
  const authStatus = creds.token ? c.green('authenticated') : c.red('/login to start');
  process.stderr.write(`  ${c.gray('v' + VERSION)}  ${c.dim(env)}  ${authStatus}\n\n`);
}

// ── Prompt Chrome ──
//
// Design: let the content breathe. The prompt area is a thin contextual
// strip — only shows what changed since last turn. No heavy borders.
//
// Layout after a response:
//
//   <assistant content>
//
//   ✓ 3 tools · 1.2s · $0.02                      ctx 21% · 42k tok
//   ╶─────────────────────────────────────────────────────────────────╴
//   kepler ›
//
// Layout on first prompt (no stats yet):
//
//   ╶─────────────────────────────────────────────────────────────────╴
//   kepler ›

/**
 * Build the contextual status strip — compact, one line.
 * Left side: last-turn summary (tools, time, cost)
 * Right side: session totals (ctx%, tokens)
 */
function computeCacheTotals() {
  let read = 0;
  let write = 0;
  for (const b of session.costBreakdown) {
    read += b.cache_read_tokens || 0;
    write += b.cache_creation_tokens || 0;
  }
  // OpenRouter/Anthropic/DeepSeek return `total_input_tokens` INCLUSIVE of
  // cache-read tokens. session.inputTokens is that sum, so the denominator is
  // just session.inputTokens (do NOT add `read` — would double-count).
  const hitRate = session.inputTokens > 0
    ? Math.round((read / session.inputTokens) * 100)
    : 0;
  return { read, write, hitRate };
}

function buildContextStrip() {
  const totalTokens = session.inputTokens + session.outputTokens;
  const elapsed = formatElapsed(session.startTime);
  // Cache hit % lives under /cache — keep the always-on strip focused on
  // volume + elapsed. Historical rate calc was double-counting the cache tokens
  // vs OpenRouter's convention (see computeCacheTotals) which was misleading.
  const right = [
    c.dim(`${formatTokens(totalTokens)} tok`),
    c.dim(elapsed),
  ].join(c.dim(' · '));

  return right;
}

/**
 * Print the prompt separator + prompt label.
 * Minimal horizontal rule with contextual info.
 */
function printPromptBlock() {
  const w = process.stdout.columns || 80;
  const strip = buildContextStrip();
  const stripPlain = stripAnsi(strip);

  // Rule with context strip right-aligned
  const ruleLen = Math.max(0, w - stripPlain.length - 4);
  process.stderr.write(
    c.dim('╶') + c.dim('─'.repeat(ruleLen)) + ' ' + strip + ' ' + c.dim('╴') + '\n'
  );
}

/**
 * Print a turn summary after a response completes.
 * Shows only when there's something meaningful to report.
 */
/**
 * Pull blocker bullet points from the completion payload — used by the
 * failure variant of the mission report.
 */
function extractBlockers(data) {
  const out = [];
  if (data?.error) out.push(String(data.error).slice(0, 160));
  if (Array.isArray(data?.failed_tests)) {
    for (const t of data.failed_tests.slice(0, 6)) {
      if (typeof t === 'string') out.push(t);
      else if (t?.name) out.push(`${t.name}${t.message ? ': ' + t.message : ''}`);
    }
  }
  return out;
}

function printTurnSummary(toolCount, durationS, turnCost) {
  const parts = [];
  if (toolCount > 0) parts.push(`${toolCount} tools`);
  if (durationS) parts.push(`${Number(durationS).toFixed(1)}s`);
  if (parts.length > 0) {
    renderBlockBoundary('status', { compactSame: true });
    process.stderr.write(`  ${c.green('✓')} ${c.dim(parts.join(' · '))}\n`);
    runtime.lastRenderedBlock = 'status';
  }
}

function formatMessageChip(rateLimit) {
  const remaining = messagesRemaining(rateLimit);
  if (remaining === Infinity) return 'unlimited messages';
  const limit = Number(rateLimit?.msgs_per_window);
  if (typeof remaining === 'number' && Number.isFinite(limit)) {
    return `${remaining}/${limit} messages`;
  }
  return 'messages';
}

function updateStatusBar() {
  // No-op: status is printed inline via printPromptBlock before each prompt
}

// ── Tool Display Renderer ──

/**
 * Render a tool call as the head of a Mission Control card — icon + label +
 * args. The result arrives later via `renderToolResult` and is appended as a
 * gutter line. Sub-agent calls are indented per session.inSubAgent.
 */
// Deferred-head strategy: we DON'T print the tool head when tool_call fires.
// Instead we buffer it and let renderToolResult emit one combined line
// "head  → outcome · duration\n". A spinner shows what's running in the
// meantime so the user still has feedback during slow tools.
//
// If something else needs to print before the result arrives (a streamed
// content event, a sub-agent open, an error, completion), we flush the
// buffered head as a regular two-line shape first so the interleaving
// content lands below it.
// (declaration moved to repl-state.mjs runtime.*)
// (declaration moved to repl-state.mjs runtime.*)
// Explore-run collapse: reduces bursts of list/read/search/index tool calls
// into one in-place summary line so the user sees the agent's PROGRESS
// (12 files listed, 8 read, latest name) instead of a wall of individual
// tool cards. Any non-explore event flushes it to a static line so the
// summary survives when the transcript scrolls.
// Mutable run state stays here for now — see repl-explore.mjs for the pure
// classifier. Split TBD.
// (declaration moved to repl-state.mjs runtime.*)


// ── Event Renderer ──

function renderEvent(event) {
  const { type, data } = event;

  // Push every event into the orbit state machine before rendering so phase
  // and cost state stay current for prompt/context surfaces.
  if (orbitRef.current) orbitRef.current.onEvent(event);

  // If we've been collapsing explore tools into a summary spinner, an
  // incoming event that will actually WRITE to the screen ends the run
  // and freezes the spinner into a static one-line summary. Transient
  // metadata events (thinking, spinner-only status, sub_agent_tool,
  // worker/phase updates, session_info) don't write and must NOT flush —
  // otherwise every sub-agent tool call fires a `sub_agent_tool` event
  // right before its `tool_call`, splitting each burst into a fresh line.
  if (runtime.exploreRun.lineActive) {
    const isExploreEvent =
      (type === 'tool_call' || type === 'tool_request' ||
       type === 'tool_result' || type === 'tool_done') &&
      isExploreTool(data?.tool);
    const isTransientEvent =
      type === 'thinking' ||        // may or may not render text
      type === 'status' ||           // usually just updates the spinner
      type === 'sub_agent_tool' ||   // metadata for the tool_call to follow
      type === 'worker_update' ||
      type === 'phase_update' ||
      type === 'phase_summary' ||
      type === 'phase_start' ||
      type === 'worker_start' ||
      type === 'worker_done' ||
      type === 'session_info';
    if (!isExploreEvent && !isTransientEvent) flushExploreRun();
  }

  switch (type) {
    case 'status': {
      const msg = data?.message || '';
      if (!msg || msg === 'Agent started') return;
      if (/^Stagnation:/i.test(msg)) {
        renderStagnation(data);
        break;
      }
      startSpinner(msg);
      break;
    }

    case 'stagnation':
    case 'stagnation_detected': {
      renderStagnation(data);
      break;
    }

    case 'thinking': {
      const text = data?.message || data?.text || '';
      if (text && !text.startsWith('Processing')) {
        // Surface substantive thinking text as visible prose so the user can
        // follow the agent's reasoning, not just see a spinner blip. We
        // print at most one line per distinct thought, dim italic.
        if (text.length > 12 && text !== session._lastEmittedThinking) {
          flushContent();
          flushPendingHead();
          stopSpinner();
          renderBlockBoundary('thinking');
          process.stderr.write(`  ${c.dim(thinkingPrefix(text) + ' · ')}${c.italic(c.dim(clippedThinking(text)))}\n`);
          runtime.lastRenderedBlock = 'thinking';
          session._lastEmittedThinking = text;
        }
        startSpinner(text.slice(0, 80));
        // Capture reasoning so /why can replay it.
        session.lastReasoning = text;
      }
      break;
    }

    case 'content': {
      let text = data?.text || '';
      if (text) {
        flushContent();
        stopSpinner();
        if (runtime.streamedPartialText && text.startsWith(runtime.streamedPartialText)) {
          text = text.slice(runtime.streamedPartialText.length);
        } else if (runtime.streamedPartialText.includes(text)) {
          text = '';
        }
      }
      if (text) {
        renderBlockBoundary('content');
        if (!runtime.contentHeaderPrinted) {
          process.stdout.write(`${transcriptHeader('kepler', { tone: 'assistant' })}\n`);
          runtime.contentHeaderPrinted = true;
        }
        const rendered = renderMarkdown(text);
        for (const line of rendered.split('\n')) {
          process.stdout.write(`${transcriptLine(line, { tone: 'assistant' })}\n`);
        }
        runtime.renderedContentThisTurn = true;
        runtime.lastRenderedBlock = 'content';
      }
      break;
    }

    case 'reconnecting': {
      stopSpinner();
      flushContent();
      flushPendingHead();
      renderBlockBoundary('status', { compactSame: true });
      const attempt = data?.attempt ? `attempt ${data.attempt}` : 'reconnecting';
      const delayMs = Number(data?.delay_ms || 0);
      const wait = delayMs > 0
        ? ` · retrying in ${delayMs < 1000 ? `${delayMs}ms` : `${(delayMs / 1000).toFixed(delayMs < 10_000 ? 1 : 0)}s`}`
        : '';
      const after = data?.after != null ? ` from event ${data.after}` : '';
      process.stderr.write(`  ${c.yellow('!')} ${c.dim(`connection lost; ${attempt}${wait}${after}`)}\n`);
      runtime.lastRenderedBlock = 'status';
      break;
    }

    case 'reconnected': {
      stopSpinner();
      flushContent();
      flushPendingHead();
      renderBlockBoundary('status', { compactSame: true });
      const replayed = data?.replayed != null ? ` · replayed ${data.replayed} events` : '';
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`reconnected${replayed}`)}\n`);
      runtime.lastRenderedBlock = 'status';
      break;
    }

    case 'reconnect_failed': {
      stopSpinner();
      flushContent();
      flushPendingHead();
      renderBlockBoundary('status', { compactSame: true });
      const message = data?.message || 'connection lost and reconnect failed. Use /resume to continue from saved history.';
      process.stderr.write(`  ${c.red('✗')} ${c.dim(message)}\n`);
      runtime.lastRenderedBlock = 'status';
      break;
    }

    case 'content_partial': {
      const text = data?.text || '';
      if (text) {
        stopSpinner();
        appendContent(text);
      }
      break;
    }

    case 'tool_call':
    case 'tool_request': {
      const isInternal = Boolean(data?.internal || data?.sub_agent);
      if (isInternal) {
        session.subAgentToolCalls++;
        session.totalSubAgentToolCalls++;
      } else {
        session.toolCalls++;
        session.totalPrimaryToolCalls++;
      }
      session.totalToolCalls++;
      stopSpinner();
      flushContent();
      renderToolCall(data);
      break;
    }

    // ── HITL: Framework-level approval events ──

    case 'approval_required': {
      stopSpinner();
      flushContent();
      break;
    }

    case 'approval_granted': {
      // Human approvals are rendered by approval.mjs. Auto-read grants are
      // otherwise invisible, so show one dim confirmation before the tool card.
      const scope = data?.grant_scope || data?.scope || '';
      if (scope === 'auto_read') {
        renderBlockBoundary('status', { compactSame: true });
        const toolName = data?.tool || data?.tool_name || '';
        const args = data?.args || data?.input || {};
        const summary = toolDisplaySummary(toolName, args);
        const label = toolDisplayLabel(toolName);
        const subject = summary ? `${label} ${summary}` : label;
        process.stderr.write(`  ${c.green('✓')} ${c.dim(`${subject} · auto-approved read`)}\n`);
        runtime.lastRenderedBlock = 'status';
      }
      break;
    }

    case 'approval_denied': {
      const reason = data?.reason || 'User denied';
      const toolName = data?.tool || '';
      const indent = subAgentIndent();
      renderBlockBoundary('status', { compactSame: true });
      process.stderr.write(`${indent}${c.red('✗')} ${c.dim(`Denied ${toolName}: ${reason}`)}\n`);
      runtime.lastRenderedBlock = 'status';
      break;
    }

    case 'tool_result':
    case 'tool_done': {
      stopSpinner();
      renderToolResult(data, type);
      break;
    }

    case 'plan': {
      stopSpinner();
      flushContent();
      const milestones = data?.milestones || data?.steps || [];
      const title = data?.title || 'Plan';
      renderBlockBoundary('plan');
      process.stderr.write(`  ${c.brand('▸')} ${c.bold(title)}\n`);
      for (const [index, milestone] of milestones.entries()) {
        const label = typeof milestone === 'string'
          ? milestone
          : milestone.name || milestone.title || milestone.description || `Step ${index + 1}`;
        const status = typeof milestone === 'object' ? milestone.status : '';
        const marker = status === 'complete' || status === 'completed' ? c.green('✓') : c.dim(`${index + 1}.`);
        process.stderr.write(`     ${marker} ${label}\n`);
      }
      runtime.lastRenderedBlock = 'plan';
      break;
    }

    case 'change': {
      stopSpinner();
      const changeType = data?.type || 'modify';
      const filePath = shortPath(data?.path || '');
      const icon = changeType === 'create' ? c.green('+') :
                   changeType === 'delete' ? c.red('-') : c.yellow('~');
      renderBlockBoundary('status', { compactSame: true });
      process.stderr.write(`  ${icon} ${c.dim(filePath)}\n`);
      runtime.lastRenderedBlock = 'status';
      // Track changed files
      if (filePath && !session.filesChanged.includes(filePath)) {
        session.filesChanged.push(filePath);
      }
      break;
    }

    case 'phase_start':
    case 'phase_update': {
      const phase = data?.phase || data?.stage_name || '';
      if (phase) {
        stopSpinner();
        session.phases.push({ name: phase, time: Date.now() });
        renderBlockBoundary('plan');
        process.stderr.write(`  ${c.brand('▸')} ${c.bold(phase)}\n`);
        runtime.lastRenderedBlock = 'plan';
      }
      break;
    }

    case 'phase_summary': {
      const summary = data?.summary || '';
      if (summary) {
        renderBlockBoundary('status', { compactSame: true });
        process.stderr.write(`  ${c.dim(summary.slice(0, 120))}\n`);
        runtime.lastRenderedBlock = 'status';
      }
      break;
    }

    case 'worker_start':
    case 'worker_update': {
      const worker = data?.worker || data?.name || '';
      const status = data?.status || data?.message || 'working';
      if (worker) startSpinner(`${worker}: ${status}`);
      break;
    }

    case 'worker_done': {
      stopSpinner();
      const worker = data?.worker || data?.name || '';
      if (worker) {
        renderBlockBoundary('status', { compactSame: true });
        process.stderr.write(`  ${c.green('✓')} ${c.dim(worker)}\n`);
        runtime.lastRenderedBlock = 'status';
      }
      break;
    }

    case 'delegation': {
      stopSpinner();
      clearPendingHead();
      const from = data?.from || '';
      const to = data?.to || '';
      session.delegations.push({ from, to, time: Date.now() });
      renderBlockBoundary('status', { compactSame: true });
      process.stderr.write(`  ${c.brand('↳')} ${c.dim(from)} ${c.brand('→')} ${c.bold(to)}`);
      if (data?.instruction) {
        process.stderr.write(`  ${c.dim(data.instruction.slice(0, 50))}`);
      }
      process.stderr.write('\n');
      runtime.lastRenderedBlock = 'status';
      break;
    }

    // ── Sub-Agent Activity ──

    case 'sub_agent_start': {
      stopSpinner();
      clearPendingHead();
      const agentType = data?.type || 'sub-agent';
      const query = data?.query || '';
      renderBlockBoundary('subagent');
      process.stderr.write(renderSubAgentOpen({ type: agentType, query }).replace(/^\n/, '') + '\n');
      runtime.lastRenderedBlock = 'subagent';
      session.inSubAgent = inSubAgentBlock(); // kept for legacy readers
      session.subAgentCounts[agentType] = (session.subAgentCounts[agentType] || 0) + 1;
      startSpinner(`${agentType}: working...`);
      break;
    }

    case 'sub_agent_tool': {
      // The regular tool_call event renders the card, indented by the
      // sub-agent stack depth. Just update the spinner text here.
      const agentType = data?.type || 'sub-agent';
      const tool = data?.tool || '';
      if (!tool) break;
      // Don't clobber an active explore-run spinner. "exploring · 5 read ·
      // 2 searched" is more informative than "explore → search_code", and
      // sub_agent_tool fires on every step of a sub-agent — otherwise the
      // spinner would flip-flop between the two texts and read as blank.
      if (runtime.exploreRun.lineActive && isExploreTool(tool)) break;
      updateSpinner(`${agentType} → ${tool}`);
      break;
    }

    case 'sub_agent_complete': {
      stopSpinner();
      clearPendingHead();
      const agentType = data?.type || 'sub-agent';
      const usage = data?.usage || {};
      const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      const costUsd = usage.cost_usd ?? usage.total_cost_usd ?? data?.cost_usd ?? null;
      if (typeof costUsd === 'number') session.savedUsd += costUsd;
      const summary = data?.result_summary
        || (data?.result_length > 0 ? `${agentType} returned ${data.result_length} chars` : '');
      process.stderr.write(renderSubAgentClose({
        type: agentType,
        success: data?.success !== false,
        summary,
        costUsd,
        tokens,
        durationS: data?.duration_s,
        toolCalls: data?.tool_calls,
        iterations: data?.iterations,
        error: data?.error,
      }) + '\n');
      runtime.lastRenderedBlock = 'subagent';
      session.inSubAgent = inSubAgentBlock();
      break;
    }

    case 'plan_created': {
      renderBlockBoundary('status', { compactSame: true });
      process.stderr.write(`  ${c.dim('project plan prepared')}\n`);
      runtime.lastRenderedBlock = 'status';
      break;
    }

    case 'goal_created': {
      renderBlockBoundary('status', { compactSame: true });
      process.stderr.write(`  ${c.dim('project goal prepared')}\n`);
      runtime.lastRenderedBlock = 'status';
      break;
    }

    case 'session_info': {
      if (data?.session_id) {
        session.id = data.session_id;
        // Track in session manager so conversations save to the right file
        if (sessionMgrRef.current) sessionMgrRef.current.setSessionInfo({ session_id: data.session_id });
      }
      if (data?.model) session.model = data.model;
      if (data?.models?.coder) session.model = data.models.coder;
      if (data?.model_limits && typeof data.model_limits === 'object') {
        session.modelLimits = data.model_limits;
      }
      if (data?.user) session.user = { ...session.user, ...data.user };
      // BYOK users pay their model provider directly; the platform does not
      // charge them credits. Hide cost + credits when this flag is set.
      if (typeof data?.is_byok === 'boolean') session.isByok = data.is_byok;
      // Subscription tier + credit balance — backend is authoritative.
      if (data?.subscription_tier) session.subscriptionTier = data.subscription_tier;
      if (typeof data?.credits_included_limit === 'number') session.creditsLimit = data.credits_included_limit;
      const bal = data?.credits_balance;
      if (bal && typeof bal === 'object') {
        if (typeof bal.total === 'number')     session.creditsTotal = bal.total;
        if (typeof bal.included === 'number')  session.creditsIncluded = bal.included;
        if (typeof bal.purchased === 'number') session.creditsPurchased = bal.purchased;
      }
      if (data?.rate_limit) session.rateLimit = data.rate_limit;
      break;
    }

    case 'error':
      stopSpinner();
      flushContent();
      {
        const guidance = formatAgentErrorGuidance(data || {});
        renderBlockBoundary('status', { compactSame: true });
        process.stderr.write(`  ${c.red('✗')} ${guidance.title}\n`);
        for (const line of guidance.lines) {
          process.stderr.write(`  ${c.dim(line)}\n`);
        }
        if (guidance.meta.length) {
          process.stderr.write(`  ${c.dim(guidance.meta.join(' · '))}\n`);
        }
        runtime.lastRenderedBlock = 'status';
      }
      break;

    case 'complete': {
      stopSpinner();
      flushContent();
      resetSubAgents();
      session.inSubAgent = false;

      const summary = data?.summary || '';
      if (summary && !runtime.renderedContentThisTurn) {
        renderBlockBoundary('content');
        if (!runtime.contentHeaderPrinted) {
          process.stdout.write(`${transcriptHeader('kepler', { tone: 'assistant' })}\n`);
          runtime.contentHeaderPrinted = true;
        }
        const rendered = renderMarkdown(summary);
        for (const line of rendered.split('\n')) {
          process.stdout.write(`${transcriptLine(line, { tone: 'assistant' })}\n`);
        }
        runtime.renderedContentThisTurn = true;
        runtime.lastRenderedBlock = 'content';
      }

      // Update session token counts
      const usage = data?.usage;
      let turnCost = 0;
      if (usage) {
        const inp = usage.total_input_tokens || usage.input_tokens || 0;
        const out = usage.total_output_tokens || usage.output_tokens || 0;
        session.inputTokens += inp;
        session.outputTokens += out;

        // Model-aware cost calculation
        const costResult = calculateCost(usage);
        turnCost = costResult.total;
        session.totalCost += costResult.total;
        session.costAccurate = costResult.accurate;

        // Accumulate per-model breakdown
        for (const entry of costResult.breakdown) {
          const existing = session.costBreakdown.find(b => b.model === entry.model);
          if (existing) {
            existing.input_tokens += entry.input_tokens;
            existing.output_tokens += entry.output_tokens;
            existing.cache_read_tokens += entry.cache_read_tokens || 0;
            existing.cache_creation_tokens += entry.cache_creation_tokens || 0;
            existing.cost += entry.cost;
          } else {
            session.costBreakdown.push({ ...entry });
          }
        }
      }

      session.lastTurnDuration = data?.duration_s || 0;
      if (data?.rate_limit) session.rateLimit = data.rate_limit;

      // ── Server-authoritative credits ──
      // Backend sends usage.credits_charged (this turn) + balance (remaining)
      // in the complete event. CLI uses these instead of the local
      // costToCredits estimate so /status and /cost match the dashboard.
      if (!session.isByok) {
        const msgStatus = lowWindowStatus(session.rateLimit);
        if (!session.msgsLowWarned && msgStatus !== 'ok') {
          const windowLine = formatMessageWindow(session.rateLimit);
          renderBlockBoundary('status', { compactSame: true });
          if (msgStatus === 'exhausted') {
            process.stderr.write(`  ${c.red('✗')} ${c.dim(`${windowLine}. Wait for the window to reset or upgrade at codekepler.ai/pricing.`)}\n`);
          } else {
            process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`${windowLine}. Message window is running low.`)}\n`);
          }
          runtime.lastRenderedBlock = 'status';
          session.msgsLowWarned = true;
        }

        const charged = data?.usage?.credits_charged;
        if (typeof charged === 'number') session.creditsCharged += charged;
        const bal = data?.balance;
        if (bal && typeof bal === 'object') {
          if (typeof bal.total === 'number')     session.creditsTotal = bal.total;
          if (typeof bal.included === 'number')  session.creditsIncluded = bal.included;
          if (typeof bal.purchased === 'number') session.creditsPurchased = bal.purchased;
        }
        // Warn once per turn when the remaining credits drop below 20% of the
        // tier's included limit (or below 10 absolute for tiny tiers). Credits
        // stay out of the always-on prompt strip; this warning is the exception.
        if (!session.creditsLowWarned && typeof session.creditsTotal === 'number' && session.creditsLimit) {
          const threshold = Math.max(10, Math.floor(session.creditsLimit * 0.2));
          if (session.creditsTotal <= threshold && session.creditsTotal > 0) {
            renderBlockBoundary('status', { compactSame: true });
            process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`${session.creditsTotal} of ${session.creditsLimit} credits remaining on the ${session.subscriptionTier || 'free'} plan. Upgrade or top up at codekepler.ai/pricing.`)}\n`);
            runtime.lastRenderedBlock = 'status';
            session.creditsLowWarned = true;
          } else if (session.creditsTotal <= 0) {
            renderBlockBoundary('status', { compactSame: true });
            process.stderr.write(`  ${c.red('✗')} ${c.yellow(`Credit balance exhausted on the ${session.subscriptionTier || 'free'} plan. Purchase credits at codekepler.ai/pricing or switch to BYOK.`)}\n`);
            runtime.lastRenderedBlock = 'status';
            session.creditsLowWarned = true;
          }
        }
      }

      // Sync cumulative session cost into the orbit (status bar shows it).
      if (orbitRef.current) orbitRef.current.onCost(session.totalCost);

      // Compact turn summary. Backend's tool_calls is authoritative and
      // includes primary + sub-agent internals for billing/credit rollups.
      const observedPrimaryTools = session.toolCalls;
      const observedSubAgentTools = session.subAgentToolCalls;
      const observedTurnTools = observedPrimaryTools + observedSubAgentTools;
      if (Number.isFinite(data?.primary_tool_calls)) {
        session.toolCalls = data.primary_tool_calls;
        const delta = data.primary_tool_calls - observedPrimaryTools;
        if (delta > 0) session.totalPrimaryToolCalls += delta;
      }
      if (Number.isFinite(data?.sub_agent_tool_calls)) {
        session.subAgentToolCalls = data.sub_agent_tool_calls;
        const delta = data.sub_agent_tool_calls - observedSubAgentTools;
        if (delta > 0) session.totalSubAgentToolCalls += delta;
      }
      if (Number.isFinite(data?.tool_calls)) {
        const delta = data.tool_calls - observedTurnTools;
        if (delta > 0) session.totalToolCalls += delta;
      }
      const tools = Number.isFinite(data?.tool_calls)
        ? data.tool_calls
        : (session.toolCalls + session.subAgentToolCalls);

      // Mission report — replaces the trailing "Done" when the turn did real
      // work (touched files or invoked tools). Plain chat turns keep the
      // tight printTurnSummary so the report does not feel ceremonial.
      const didRealWork = tools > 0 || session.filesChanged.length > 0;
      if (didRealWork) {
        const successOverall = data?.success !== false;
        const report = renderMissionReport({
          task: session.lastTask,
          success: successOverall,
          filesChanged: session.filesChanged,
          filesRead: session.filesRead,
          toolCounts: session.toolCounts,
          subAgents: { ...session.subAgentCounts, savedUsd: 0 },
          costUsd: null,
          durationS: data?.duration_s,
          testsPass: data?.tests_passed != null
            ? { passed: data.tests_passed, total: data.tests_total || data.tests_passed }
            : null,
          blockers: !successOverall ? (data?.blockers || extractBlockers(data)) : null,
          nextActions: [],
          cwd: safeCwd(),
        });
        renderBlockBoundary('status', { compactSame: true });
        process.stderr.write(report.replace(/^\n/, '') + '\n');
        runtime.lastRenderedBlock = 'status';
      } else {
        printTurnSummary(tools, data?.duration_s, turnCost);
      }
      break;
    }

    case 'cancelled':
      stopSpinner();
      flushContent();
      renderBlockBoundary('status', { compactSame: true });
      process.stderr.write(`  ${c.yellow('⏹')} Cancelled${data?.reason ? ': ' + c.dim(data.reason) : ''}\n`);
      runtime.lastRenderedBlock = 'status';
      break;

    case 'paused':
      stopSpinner();
      flushPendingHead();
      renderBlockBoundary('status', { compactSame: true });
      process.stderr.write(`  ${c.yellow('⏸')} Paused${data?.reason ? '  ' + c.dim(data.reason) : ''}\n`);
      runtime.lastRenderedBlock = 'status';
      break;

    case 'resumed':
      renderBlockBoundary('status', { compactSame: true });
      process.stderr.write(`  ${c.green('▶')} Resumed\n`);
      runtime.lastRenderedBlock = 'status';
      break;

    default:
      break;
  }
}

// ── Slash Commands ──

function taskListLabel(list) {
  return {
    active: 'Active',
    backlog: 'Backlog',
    blocked: 'Blocked',
    done: 'Done',
  }[list] || list;
}

function firstMeaningfulLines(content, limit = 6) {
  return String(content || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .slice(0, limit);
}

function renderTaskBoard(board, { showDone = false } = {}) {
  const order = showDone
    ? ['active', 'blocked', 'backlog', 'done']
    : ['active', 'blocked', 'backlog'];
  let any = false;
  for (const list of order) {
    const tasks = board.lists[list]?.tasks || [];
    if (!tasks.length) continue;
    any = true;
    process.stderr.write(`\n  ${c.bold(taskListLabel(list))} ${c.dim(board.lists[list].fileName)}\n`);
    for (const task of tasks.slice(0, 12)) {
      const marker = task.checked ? c.green('[x]') : c.dim('[ ]');
      const section = task.section && task.section !== taskListLabel(list) ? c.dim(` · ${task.section}`) : '';
      process.stderr.write(`  ${marker} ${task.text}${section}\n`);
    }
    if (tasks.length > 12) {
      process.stderr.write(`  ${c.dim(`+${tasks.length - 12} more`)}\n`);
    }
  }
  if (!any) {
    process.stderr.write(`  ${c.dim('No project tasks yet. Add one with /tasks add <text>.')}\n`);
  }
}

function renderPlanOverview({ ctx, mode = 'overview' } = {}) {
  const cwd = safeCwd();
  ensureTaskFiles({ cwd });
  const board = loadTaskBoard({ cwd });
  const counts = taskCounts(board);
  const planLines = firstMeaningfulLines(board.plan.content, 8);
  const goalLines = firstMeaningfulLines(board.goal.content, 3);
  const effective = ctx.effectivePolicy || loadEffectivePolicy({ cwd });
  const owner = effective.policy?.planning?.owner || 'auto';

  process.stderr.write(`\n  ${c.bold('Plan')}\n`);
  process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
  process.stderr.write(`  ${c.dim('Owner')}       ${c.brand(owner)}\n`);
  process.stderr.write(`  ${c.dim('Tasks')}       ${counts.active} active, ${counts.blocked} blocked, ${counts.backlog} backlog, ${counts.done} done\n`);
  if (mode === 'status') {
    process.stderr.write(`  ${c.dim('Plan file')}   ${board.plan.exists ? board.plan.path : c.dim('(none)')}\n`);
    process.stderr.write(`  ${c.dim('Tasks dir')}   ${board.dir}\n`);
  }

  if (goalLines.length) {
    process.stderr.write(`\n  ${c.bold('Goal')}\n`);
    for (const line of goalLines) process.stderr.write(`  ${line}\n`);
  }
  if (planLines.length) {
    process.stderr.write(`\n  ${c.bold('Current Plan')}\n`);
    for (const line of planLines) process.stderr.write(`  ${line}\n`);
  }

  renderTaskBoard(board, { showDone: mode === 'status' });
  process.stderr.write(`\n  ${c.dim('Update: /tasks add <text> · /tasks move active 1 done · /tasks edit active 1 <text>')}\n\n`);
}

function refreshTaskContext(ctx) {
  try {
    const previous = ctx.latestProjectContext || null;
    ctx.latestProjectContext = loadProjectContext({ cwd: safeCwd(), previous });
    ctx.latestEnvelope = null;
  } catch { /* best effort */ }
}

function handleTasksCommand(rest, ctx) {
  const raw = String(rest || '').trim();
  ensureTaskFiles({ cwd: safeCwd() });
  if (!raw || raw === 'list') {
    const board = loadTaskBoard({ cwd: safeCwd() });
    process.stderr.write(`\n  ${c.bold('Tasks')}\n`);
    process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
    renderTaskBoard(board, { showDone: true });
    process.stderr.write(`\n  ${c.dim('Update: /tasks add <text> · /tasks move active 1 done · /tasks edit active 1 <text>')}\n\n`);
    return;
  }

  if (raw === 'help') {
    renderHelp('plan');
    return;
  }

  const parts = raw.split(/\s+/);
  let verb = (parts.shift() || '').toLowerCase();

  if (verb === 'move') {
    try {
      const [from, index, to, ...textParts] = parts;
      const result = moveTask({ cwd: safeCwd(), from, index, to, text: textParts.join(' ') || undefined });
      refreshTaskContext(ctx);
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`moved ${result.from} #${result.index} → ${result.to}`)} ${result.text}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
      process.stderr.write(`  ${c.gray('Usage: /tasks move <active|backlog|blocked|done> <number> <active|backlog|blocked|done> [new text]')}\n`);
    }
    return;
  }

  if (verb === 'edit' || verb === 'rename') {
    try {
      const [list, index, ...textParts] = parts;
      const result = updateTask({ cwd: safeCwd(), list, index, text: textParts.join(' ') });
      refreshTaskContext(ctx);
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`updated ${result.list} #${result.index}`)} ${result.text}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
      process.stderr.write(`  ${c.gray('Usage: /tasks edit <active|backlog|blocked|done> <number> <new text>')}\n`);
    }
    return;
  }

  if (verb === 'remove' || verb === 'rm' || verb === 'delete') {
    try {
      const [list, index] = parts;
      const result = removeTask({ cwd: safeCwd(), list, index });
      refreshTaskContext(ctx);
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`removed ${result.list} #${result.index}`)} ${result.task.text}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
      process.stderr.write(`  ${c.gray('Usage: /tasks remove <active|backlog|blocked|done> <number>')}\n`);
    }
    return;
  }

  if (verb === 'finish' || verb === 'complete' || verb === 'block' || verb === 'unblock') {
    try {
      const [from, index, ...textParts] = parts;
      const to = verb === 'block' ? 'blocked' : verb === 'unblock' ? 'active' : 'done';
      const result = moveTask({ cwd: safeCwd(), from, index, to, text: textParts.join(' ') || undefined });
      refreshTaskContext(ctx);
      process.stderr.write(`  ${c.green('✓')} ${c.dim(`moved ${result.from} #${result.index} → ${result.to}`)} ${result.text}\n`);
    } catch (err) {
      process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
      process.stderr.write(`  ${c.gray(`Usage: /tasks ${verb} <active|backlog|blocked|done> <number> [new text]`)}\n`);
    }
    return;
  }

  let list = 'backlog';
  if (verb === 'add' || verb === 'new') {
    const maybeList = (parts[0] || '').toLowerCase();
    if (maybeList in TASK_FILES || ['todo', 'pending', 'current', 'doing', 'complete', 'completed'].includes(maybeList)) {
      list = parts.shift();
    }
  } else if (verb in TASK_FILES || ['todo', 'pending', 'current', 'doing', 'complete', 'completed'].includes(verb)) {
    list = verb;
  } else {
    parts.unshift(verb);
    verb = 'add';
  }

  try {
    const result = appendTask({ cwd: safeCwd(), list, text: parts.join(' ') });
    refreshTaskContext(ctx);
    process.stderr.write(`  ${c.green('✓')} ${c.dim(`added to ${result.list}`)} ${result.text}\n`);
  } catch (err) {
    process.stderr.write(`  ${c.red(err.message || String(err))}\n`);
  }
}

async function handleCommand(input, ctx) {
  const { cmd, rest, aliasTarget } = normalizeCommandInput(input);
  if (aliasTarget) {
    process.stderr.write(`  ${c.dim(`Legacy alias: use ${aliasTarget}`)}\n`);
  }

  switch (cmd) {
    case '/help': {
      renderHelp(rest);
      return;
    }

    case '/plan': {
      const mode = rest.trim().toLowerCase();
      if (mode === 'help') {
        renderHelp('plan');
        return;
      }
      if (mode === 'edit') {
        ensureTaskFiles({ cwd: safeCwd() });
        const board = loadTaskBoard({ cwd: safeCwd() });
        process.stderr.write(`\n  ${c.bold('Editable Plan Files')}\n`);
        process.stderr.write(`  ${c.dim('Plan')}      ${board.plan.path}\n`);
        process.stderr.write(`  ${c.dim('Active')}    ${board.lists.active.path}\n`);
        process.stderr.write(`  ${c.dim('Backlog')}   ${board.lists.backlog.path}\n`);
        process.stderr.write(`  ${c.dim('Blocked')}   ${board.lists.blocked.path}\n`);
        process.stderr.write(`  ${c.dim('Done')}      ${board.lists.done.path}\n\n`);
        return;
      }
      renderPlanOverview({ ctx, mode: mode === 'status' ? 'status' : 'overview' });
      return;
    }

    case '/tasks':
      handleTasksCommand(rest, ctx);
      return;

    case '/attach':
      handleAttachCommand(rest, ctx);
      return;

    case '/attachments':
      handleAttachmentsCommand(rest, ctx);
      return;

    case '/history': {
      if (rest.trim() === 'fold') {
        process.stderr.write(`  ${c.gray('Output is folded by default — there is nothing to hide. Use /history last or d to expand.')}\n`);
        return;
      }
      if (rest.trim() === 'help') {
        renderHelp('history');
        return;
      }
      if (rest.trim() === 'approvals') {
        const entries = ctx.approval?.approvalLog?.readRecent?.(20) || [];
        if (!entries.length) {
          process.stderr.write(`  ${c.gray('No approval log entries yet.')}\n`);
          return;
        }
        process.stderr.write(`\n  ${c.bold('Approval History')}\n`);
        process.stderr.write(`  ${c.gray('─'.repeat(80))}\n`);
        for (const e of entries) {
          const when = e.ts ? String(e.ts).slice(0, 19).replace('T', ' ') : '';
          const decision = e.decision?.includes('reject') || e.decision?.includes('deny') ? c.red(e.decision) : c.green(e.decision);
          process.stderr.write(`  ${c.dim(when)}  ${decision}  ${c.brand(e.tool || '?')}  ${c.dim(e.scope || 'once')}  ${c.dim(e.args || '')}\n`);
        }
        process.stderr.write('\n');
        return;
      }
      if (session.history.length === 0) { process.stderr.write(`  ${c.gray('No conversation yet.')}\n`); return; }
      renderHistoryEntries(session.history, { limit: 20, maxChars: 120 });
      return;
    }

    case '/login':
      process.stderr.write(`${c.brand('Starting login flow...')}\n`);
      try {
        await ctx.auth.login();
        process.stderr.write(`${c.green('✓ Login successful!')}\n`);
        await fetchUser(ctx);
      } catch (err) {
        process.stderr.write(`${c.red('✗ Login failed: ' + err.message)}\n`);
      }
      return;

    case '/whoami': {
      if (!session.user) await fetchUser(ctx);
      if (session.user) {
        process.stderr.write(`\n  ${c.green('✓')} ${session.user.github_username}\n`);
        process.stderr.write(`  ${c.gray('Email:')}   ${session.user.email || 'n/a'}\n`);
        process.stderr.write(`  ${c.gray('User ID:')} ${session.user.id}\n`);
        process.stderr.write(`  ${c.gray('Role:')}    ${session.user.role || 'user'}\n\n`);
      } else {
        process.stderr.write(`  ${c.red('Not logged in. Run /login.')}\n`);
      }
      return;
    }

    case '/status': {
      if (rest.trim() === 'help') {
        renderHelp('status');
        return;
      }
      if (rest.trim() === 'context') {
        const current = ctx.latestProjectContext || loadProjectContext({ cwd: safeCwd() });
        const envelope = ctx.latestEnvelope || buildContextEnvelope({
          cwd: safeCwd(),
          effectivePolicy: ctx.effectivePolicy,
          projectContext: current,
          projectResources: ctx.toolExecutor?.getProjectResources?.() || [],
          agentContext: ctx.toolExecutor?.getAgentContext?.() || {},
        });
        process.stderr.write(`\n  ${c.bold('Context')}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
        const loaded = current.loaded || [];
        if (!loaded.length) {
          process.stderr.write(`  ${c.dim('No .kepler context files loaded yet.')}\n`);
        } else {
          for (const file of loaded) {
            const changed = file.changed ? ` ${c.yellow('updated')}` : '';
            process.stderr.write(`  ${c.brand(file.label.padEnd(18))} ${c.dim(file.hash)} ${c.dim(file.path)}${changed}\n`);
          }
        }
        process.stderr.write(`\n  ${c.bold('Command Context')}\n`);
        process.stderr.write(`  ${c.dim('Active')}       ${envelope.command_context.active_command || c.dim('(none)')}\n`);
        process.stderr.write(`  ${c.dim('Source')}       ${envelope.command_context.source}\n`);
        process.stderr.write(`  ${c.dim('Timeout')}      ${envelope.command_context.runtime_limits.command_timeout_seconds}s command, ${envelope.command_context.runtime_limits.tool_timeout_seconds}s tool\n`);
        process.stderr.write(`  ${c.dim('Plan owner')}   ${envelope.effective_options.plan_owner}\n`);
        process.stderr.write(`  ${c.dim('HITL scope')}   ${envelope.effective_options.hitl_default_scope} ${c.dim(`(reask ${envelope.effective_options.reask_after_minutes}m)`)}\n`);
        if (envelope.available_skills.length) {
          process.stderr.write(`\n  ${c.bold('Skills')}\n`);
          for (const skill of envelope.available_skills.slice(0, 12)) {
            process.stderr.write(`  ${c.brand(skill.name)} ${c.dim(skill.scope)} ${c.dim(skill.description || '')}\n`);
          }
        }
        process.stderr.write('\n');
        return;
      }

      const creds = ctx.auth.loadCredentials();
      const env = process.env.TARANG_ENV || 'production';
      const os = await import('node:os');
      const mem = process.memoryUsage();
      const approvalSummary = ctx.approval.getSummary();

      process.stderr.write(`\n  ${c.bold('Session')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('ID')}           ${session.id || c.dim('(not assigned yet)')}\n`);
      process.stderr.write(`  ${c.dim('User')}         ${session.user?.github_username || '—'}\n`);
      process.stderr.write(`  ${c.dim('Model')}        ${session.model || 'backend default'}\n`);
      const modelOverrides = sessionModelOverrideEntries();
      if (modelOverrides.length) {
        const summary = modelOverrides
          .slice(0, 4)
          .map(([role, model]) => `${MODEL_ROLE_LABELS[role] || role}=${model}`)
          .join(', ');
        const more = modelOverrides.length > 4 ? ` +${modelOverrides.length - 4} more` : '';
        process.stderr.write(`  ${c.dim('Overrides')}    ${summary}${more}\n`);
      }
      if (env === 'local') {
        process.stderr.write(`  ${c.dim('Backend')}      ${creds.backendUrl}\n`);
      }
      process.stderr.write(`  ${c.dim('Env')}          ${env}\n`);
      process.stderr.write(`  ${c.dim('Turns')}        ${session.turns}\n`);
      const toolSplit = session.totalSubAgentToolCalls > 0
        ? ` ${c.dim(`(${session.totalPrimaryToolCalls} primary, ${session.totalSubAgentToolCalls} sub-agent)`)}`
        : '';
      const lastTurnSplit = session.subAgentToolCalls > 0
        ? ` ${c.dim(`(${session.toolCalls} primary, ${session.subAgentToolCalls} sub-agent)`)}`
        : '';
      process.stderr.write(`  ${c.dim('Tools')}        ${session.totalToolCalls} total${toolSplit}, ${session.toolCalls + session.subAgentToolCalls} last turn${lastTurnSplit}\n`);
      process.stderr.write(`  ${c.dim('Duration')}     ${formatElapsed(session.startTime)}\n`);
      if (session.isByok) {
        process.stderr.write(`  ${c.dim('Billing')}      ${c.green('BYOK')} ${c.dim('(provider-billed)')}\n`);
      } else {
        // Server-authoritative remaining balance; fall back to the per-session
        // charged tally when balance hasn't been pushed yet.
        if (session.subscriptionTier) {
          process.stderr.write(`  ${c.dim('Plan')}         ${c.brand(session.subscriptionTier.toUpperCase())}\n`);
        }
        const messageWindow = formatMessageWindow(session.rateLimit);
        if (messageWindow) {
          process.stderr.write(`  ${c.dim('Messages')}     ${messageWindow}\n`);
        }
        if (typeof session.creditsTotal === 'number') {
          const limit = session.creditsLimit ? ` ${c.dim('/ ' + formatCredits(session.creditsLimit))}` : '';
          const used = session.creditsCharged ? ` ${c.dim(`(${formatCredits(session.creditsCharged)} used this session)`)}` : '';
          process.stderr.write(`  ${c.dim('Credits')}      ${formatCredits(session.creditsTotal)}${limit}${used}\n`);
        } else if (session.creditsCharged) {
          process.stderr.write(`  ${c.dim('Credits')}      ${formatCredits(session.creditsCharged)} ${c.dim('(used this session)')}\n`);
        }
      }
      process.stderr.write(`  ${c.dim('CWD')}          ${safeCwd()}\n`);

      // Cache — PRD-071 §1.2. Only surface when we have data; a fresh session
      // shows nothing rather than a misleading "0%".
      const cache = computeCacheTotals();
      if (cache.read > 0 || cache.write > 0) {
        const readLabel = formatTokens(cache.read);
        const writeLabel = formatTokens(cache.write);
        process.stderr.write(`  ${c.dim('Cache')}        ${cache.hitRate}% hit ${c.dim('·')} ${readLabel} read ${c.dim('·')} ${writeLabel} write\n`);
      }

      // Permissions
      process.stderr.write(`\n  ${c.bold('Permissions')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('Approved')}     ${approvalSummary.approved}  ${c.dim('Denied')} ${approvalSummary.denied}\n`);
      if (approvalSummary.autoApproveAll) {
        process.stderr.write(`  ${c.dim('Mode')}         ${c.yellow('approve-all active')}\n`);
      }
      if (approvalSummary.autoApprovedTypes.length > 0) {
        process.stderr.write(`  ${c.dim('Auto-types')}   ${approvalSummary.autoApprovedTypes.join(', ')}\n`);
      }
      if (approvalSummary.trust) {
        process.stderr.write(`  ${c.dim('Trust')}        ${approvalSummary.trust.sessionRules} session, ${approvalSummary.trust.projectRules} project rules\n`);
      }
      process.stderr.write(`  ${c.dim('Blocked')}      ${session.blockedOps} by safety guardrails\n`);

      // Orchestration
      if (session.delegations.length > 0 || session.phases.length > 0) {
        process.stderr.write(`\n  ${c.bold('Orchestration')}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
        if (session.delegations.length > 0) {
          process.stderr.write(`  ${c.dim('Delegations')}  ${session.delegations.length}\n`);
          for (const d of session.delegations.slice(-5)) {
            process.stderr.write(`    ${c.dim(d.from)} ${c.brand('→')} ${d.to}\n`);
          }
        }
        if (session.phases.length > 0) {
          process.stderr.write(`  ${c.dim('Phases')}       ${session.phases.map(p => p.name).join(' → ')}\n`);
        }
      }

      // Files changed
      if (session.filesChanged.length > 0) {
        process.stderr.write(`\n  ${c.bold('Files Changed')} ${c.dim(`(${session.filesChanged.length})`)}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
        for (const f of session.filesChanged.slice(-10)) {
          process.stderr.write(`  ${c.dim('~')} ${f}\n`);
        }
        if (session.filesChanged.length > 10) {
          process.stderr.write(`  ${c.dim(`  ...and ${session.filesChanged.length - 10} more`)}\n`);
        }
      }

      // System
      process.stderr.write(`\n  ${c.bold('System')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('Node')}         ${process.version}\n`);
      process.stderr.write(`  ${c.dim('Platform')}     ${process.platform} ${os.arch()}\n`);
      process.stderr.write(`  ${c.dim('Heap')}         ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB\n`);
      process.stderr.write(`  ${c.dim('Memory')}       ${((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1)}G / ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}G\n\n`);
      return;
    }

    case '/settings': {
      const sub = rest.trim() || 'policy';
      if (sub === 'help') {
        renderHelp('settings');
        return;
      }
      if (sub !== 'policy') {
        process.stderr.write(`  ${c.gray('Usage: /settings policy  or  /help settings')}\n`);
        return;
      }
      const effective = loadEffectivePolicy({ cwd: safeCwd() });
      ctx.effectivePolicy = effective;
      const rows = formatPolicySourceRows(effective);
      process.stderr.write(`\n  ${c.bold('Effective Policy')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(86))}\n`);
      for (const row of rows.slice(0, 80)) {
        const value = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
        process.stderr.write(`  ${c.brand(row.key.padEnd(38))} ${c.dim(row.source.padEnd(8))} ${String(value).slice(0, 34)}\n`);
      }
      if (rows.length > 80) process.stderr.write(`  ${c.dim(`...and ${rows.length - 80} more`)}\n`);
      const projectLayer = effective.layers.find(l => l.name === 'project');
      if (projectLayer?.error) {
        process.stderr.write(`\n  ${c.yellow('Project config error:')} ${projectLayer.error}\n`);
      }
      process.stderr.write('\n');
      return;
    }

    case '/stats': {
      const os = await import('node:os');
      const mem = process.memoryUsage();
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      const totalTokens = session.inputTokens + session.outputTokens;
      const ctxPct = Math.min(100, (totalTokens / 200000) * 100);

      process.stderr.write(`\n  ${c.bold('Metrics')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${progressBar(ctxPct, 15, 'Context')} ${(totalTokens / 1000).toFixed(1)}k tok\n`);
      process.stderr.write(`  ${progressBar(Math.round((usedMem / totalMem) * 100), 15, 'Memory')} ${(usedMem / 1024 / 1024 / 1024).toFixed(1)}G\n`);
      process.stderr.write(`  ${progressBar(Math.round((mem.heapUsed / mem.heapTotal) * 100), 15, 'Heap')} ${(mem.heapUsed / 1024 / 1024).toFixed(0)}M\n`);
      process.stderr.write(`  ${c.gray('Turns:')}     ${session.turns}\n`);
      process.stderr.write(`  ${c.gray('Tools:')}     ${session.toolCalls + session.subAgentToolCalls}`);
      if (session.subAgentToolCalls > 0) {
        process.stderr.write(c.dim(` (${session.toolCalls} primary, ${session.subAgentToolCalls} sub-agent)`));
      }
      process.stderr.write('\n');
      process.stderr.write(`  ${c.gray('Blocked:')}   ${session.blockedOps}\n`);
      if (session.isByok) {
        process.stderr.write(`  ${c.gray('Billing:')}   ${c.green('BYOK')} ${c.dim('(provider-billed)')}\n`);
      } else {
        process.stderr.write(`  ${c.gray('Credits:')}   ${formatCredits(costToCredits(session.totalCost))}${session.costAccurate ? '' : c.dim(' (est)')}\n`);
      }
      process.stderr.write(`  ${c.gray('Elapsed:')}  ${formatElapsed(session.startTime)}\n\n`);
      return;
    }

    case '/cost': {
      if (session.isByok) {
        process.stderr.write(`\n  ${c.bold('Billing')}  ${c.green('BYOK')} ${c.dim('— you pay your model provider directly. Kepler does not charge credits for BYOK usage.')}\n\n`);
        return;
      }
      // Prefer server-authoritative numbers when available.
      const used = session.creditsCharged || 0;
      const usedLabel = formatCredits(used);
      process.stderr.write(`\n  ${c.bold('Session Credits')}  ${c.brand(usedLabel)}`);
      if (used > 0 && !session.creditsCharged) process.stderr.write(`  ${c.yellow('(estimated)')}`);
      process.stderr.write('\n');
      if (session.subscriptionTier && typeof session.creditsTotal === 'number') {
        const remaining = formatCredits(session.creditsTotal);
        const limit = session.creditsLimit ? ` / ${formatCredits(session.creditsLimit)}` : '';
        process.stderr.write(`  ${c.dim('Plan')}            ${c.brand(session.subscriptionTier.toUpperCase())}  ${c.dim('· remaining')} ${c.brand(remaining)}${c.dim(limit)}\n`);
      }
      const messageWindow = formatMessageWindow(session.rateLimit);
      if (messageWindow) {
        process.stderr.write(`  ${c.dim('Messages')}        ${messageWindow}\n`);
      }
      process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);

      if (session.costBreakdown.length > 0) {
        // Header
        process.stderr.write(`  ${c.dim('Model'.padEnd(36))}${c.dim('Input'.padStart(10))}${c.dim('Output'.padStart(10))}${c.dim('Cache'.padStart(10))}${c.dim('Credits'.padStart(10))}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);

        for (const b of session.costBreakdown) {
          const modelLabel = b.model === 'unknown' ? c.yellow('unknown model') : b.model;
          const roleTag = b.role && b.role !== 'unknown' ? ` ${c.dim(`(${b.role})`)}` : '';
          const cacheTokens = (b.cache_read_tokens || 0) + (b.cache_creation_tokens || 0);
          const costStr = b.free ? c.green('free') : formatCredits(costToCredits(b.cost));

          process.stderr.write(
            `  ${(modelLabel + roleTag).padEnd(36)}` +
            `${formatTokens(b.input_tokens).padStart(10)}` +
            `${formatTokens(b.output_tokens).padStart(10)}` +
            `${(cacheTokens > 0 ? formatTokens(cacheTokens) : '—').padStart(10)}` +
            `${costStr.padStart(10)}\n`
          );
        }

        process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);
      }

      process.stderr.write(
        `  ${c.bold('Total'.padEnd(36))}` +
        `${formatTokens(session.inputTokens).padStart(10)}` +
        `${formatTokens(session.outputTokens).padStart(10)}` +
        `${''.padStart(10)}` +
        `${formatCredits(costToCredits(session.totalCost)).padStart(10)}\n`
      );
      process.stderr.write(`  ${c.dim(`Turns: ${session.turns}  Duration: ${formatElapsed(session.startTime)}`)}\n\n`);
      return;
    }

    case '/last':
      expandLast();
      return;

    case '/expand': {
      const arg = rest.trim();
      if (!arg) { expandLast(); return; }
      if (arg === 'all') { expandIndex('all'); return; }
      const n = Number(arg);
      if (!Number.isFinite(n)) {
        process.stderr.write(`  ${c.gray('Usage: /expand [n|all] — n is the 1-based index from the start of the session')}\n`);
        return;
      }
      // Users pass 1-based; getCard accepts negative (-1 = last) or positive index.
      expandIndex(n > 0 ? n - 1 : n);
      return;
    }

    case '/fold':
      process.stderr.write(`  ${c.gray('Output is folded by default — there is nothing to hide. Use /last or d to expand.')}\n`);
      return;

    case '/undo': {
      const result = ctx.checkpoints?.undo();
      if (!result) {
        process.stderr.write(`  ${c.gray('No checkpoints to undo.')}\n`);
        return;
      }
      if (result.restored) {
        process.stderr.write(`  ${c.green('↩')} ${c.dim('Restored')} ${result.filePath}\n`);
      } else {
        process.stderr.write(`  ${c.red('✗')} ${c.dim('Undo failed: ' + (result.error || 'unknown error'))}\n`);
      }
      return;
    }

    case '/checkpoint': {
      const list = ctx.checkpoints?.list(10) || [];
      if (!list.length) {
        process.stderr.write(`  ${c.gray('No checkpoints recorded yet — they are taken automatically before each edit.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Recent checkpoints')}\n  ${c.gray('─'.repeat(40))}\n`);
      for (const ckpt of list) {
        const when = String(ckpt.timestamp).slice(11, 19);
        process.stderr.write(`  ${c.gray(when)}  ${c.white(ckpt.file)}  ${c.gray(formatTokens(ckpt.size) + ' bytes')}\n`);
      }
      process.stderr.write(`\n  ${c.gray('/undo restores the most recent one')}\n\n`);
      return;
    }

    case '/preflight': {
      await runPreflight({ auth: ctx.auth, cwd: safeCwd(), version: VERSION });
      return;
    }

    case '/report': {
      if (Object.keys(session.toolCounts).length === 0 && session.filesChanged.length === 0 && session.filesRead.length === 0) {
        process.stderr.write(`  ${c.gray('Nothing to report yet — run a task first.')}\n`);
        return;
      }
      const state = {
        task: session.lastTask,
        success: true,
        filesChanged: session.filesChanged,
        filesRead: session.filesRead,
        toolCounts: session.toolCounts,
        subAgents: { ...session.subAgentCounts, savedUsd: session.isByok ? 0 : session.savedUsd },
        costUsd: session.isByok ? null : session.totalCost,
        durationS: (Date.now() - session.startTime) / 1000,
        nextActions: [],
        cwd: safeCwd(),
      };
      const out = saveReport(state, { cwd: safeCwd() });
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Saved')} ${out}\n`);
      return;
    }

    case '/why': {
      if (!session.lastReasoning) {
        process.stderr.write(`  ${c.gray('No reasoning captured yet for this session.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Last reasoning')}\n  ${c.gray('─'.repeat(40))}\n`);
      for (const line of String(session.lastReasoning).split('\n')) {
        process.stderr.write(`  ${c.dim(line)}\n`);
      }
      process.stderr.write('\n');
      return;
    }

    case '/map': {
      try {
        const resources = ctx.toolExecutor?.getProjectResources?.() || [];
        if (!resources.length) {
          process.stderr.write(`  ${c.gray('No project resources registered yet. Use get_project_overview to register one.')}\n`);
          return;
        }
        process.stderr.write(`\n  ${c.bold('Registered projects')}\n  ${c.gray('─'.repeat(40))}\n`);
        for (const r of resources) {
          process.stderr.write(`  ${c.brand('•')} ${c.white(r.id || r.name || '?')}  ${c.dim(r.root || r.path || '')}\n`);
        }
        process.stderr.write('\n');
      } catch (err) {
        process.stderr.write(`  ${c.red('/map failed: ' + err.message)}\n`);
      }
      return;
    }

    case '/budget': {
      const arg = rest.trim();
      if (!arg) {
        const current = session.budgetUsd ? `$${session.budgetUsd.toFixed(2)}` : 'not set';
        process.stderr.write(`  ${c.dim('Budget cap:')} ${c.brand(current)} ${c.dim('· set with /status budget <amount> or clear with /status budget clear')}\n`);
        return;
      }
      if (arg === 'clear' || arg === 'off') {
        session.budgetUsd = null;
        session.budgetExceeded = false;
        process.stderr.write(`  ${c.gray('Budget cap cleared.')}\n`);
        return;
      }
      const n = Number(arg.replace(/^\$/, ''));
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`  ${c.gray('Usage: /budget <amount in USD>  or  /budget clear')}\n`);
        return;
      }
      session.budgetUsd = n;
      session.budgetExceeded = false;
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Budget set: ')} $${n.toFixed(2)}\n`);
      return;
    }

    case '/quiet':
    case '/verbose':
    case '/surgical': {
      const mode = cmd === '/quiet' ? V_MODES.QUIET
                : cmd === '/verbose' ? V_MODES.VERBOSE
                : V_MODES.SURGICAL;
      setVerbosity(mode);
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Verbosity: ')} ${c.brand(verbosityLabel(mode))}\n`);
      return;
    }

    case '/compact': {
      await compactCurrentSession(ctx, rest);
      return;
    }

    case '/model': {
      handleModelCommand(rest);
      return;
    }

    case '/new':
      if (ctx.startNewSession) await ctx.startNewSession();
      else process.stderr.write(`  ${c.yellow('!')} ${c.dim('New session reset is unavailable in this mode.')}\n`);
      return;

    case '/clear':
      session.history.length = 0;
      session.agentHistory.length = 0;
      session.toolCalls = 0;
      session.subAgentToolCalls = 0;
      clearCards();
      process.stderr.write(`  ${c.gray('Conversation cleared.')}\n`);
      return;

    case '/git': {
      const { execSync } = await import('node:child_process');
      try { process.stdout.write(execSync('git status --short --branch', { encoding: 'utf-8' }) + '\n'); }
      catch (e) { process.stderr.write(`  ${c.red(e.message)}\n`); }
      return;
    }

    case '/diff': {
      const { execSync } = await import('node:child_process');
      try {
        const diff = execSync('git diff --no-ext-diff --unified=3', {
          encoding: 'utf-8',
          maxBuffer: 2 * 1024 * 1024,
        });
        process.stdout.write(diff ? renderDiff(diff) + '\n' : c.dim('(no changes)') + '\n');
      }
      catch (e) { process.stderr.write(`  ${c.red(e.message)}\n`); }
      return;
    }

    case '/safety': {
      const { getSafetyRules } = await import('../core/safety.mjs');
      const rules = getSafetyRules();
      const summary = ctx.approval.getSummary();
      process.stderr.write(`\n  ${c.bold('Safety Guardrails')} ${c.green('ACTIVE')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${c.gray('Approval mode:')}  ${ctx.approval.getModeLabel()}\n`);
      process.stderr.write(`  ${c.gray('Approved:')}       ${summary.approved}  ${c.gray('Denied:')} ${summary.denied}\n`);
      process.stderr.write(`  ${c.gray('Protected files:')} ${rules.protectedNames.join(', ')}\n`);
      process.stderr.write(`  ${c.gray('Source dirs:')}     ${rules.sourceDirs.join(', ')}\n`);
      process.stderr.write(`  ${c.gray('Blocked patterns:')} ${rules.blockedPatterns}\n`);
      process.stderr.write(`  ${c.gray('High-risk patterns:')} ${rules.highRiskPatterns}\n`);
      process.stderr.write(`  ${c.gray('Ops blocked:')}     ${session.blockedOps}\n\n`);
      return;
    }

    case '/revoke': {
      const wasActive = ctx.approval.revoke();
      if (wasActive) {
        process.stderr.write(`  ${c.green('✓')} ${c.dim('Auto-approvals revoked. All tool calls will prompt again.')}\n`);
      } else {
        process.stderr.write(`  ${c.gray('No auto-approvals were active.')}\n`);
      }
      return;
    }

    case '/sessions': {
      const resumable = await listResumableSessions();
      if (resumable.length === 0) {
        process.stderr.write(`  ${c.gray('No resumable sessions found.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Resumable Sessions')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
      for (const s of resumable) {
        const date = sessionListTimestamp(s);
        const instr = oneLineInstruction(s.instruction, 72);
        const project = s.project || path.basename(s.projectPath || '') || '(unknown)';
        process.stderr.write(`  ${c.brand(s.sessionId)}  ${c.brand(project)}  ${c.dim(date)}  ${messageCountLabel(s.messageCount)}  ${c.dim(instr)}\n`);
      }
      process.stderr.write(`\n  ${c.dim('Resume with:')} kepler --resume <sessionId>\n`);
      return;
    }

    case '/resume': {
      // PRD-068 §5.14: one-prompt picker, context-length driven auto-decision,
      // direct-resume mode flags (--full, --tail10, --tail20, --summary).
      const parts = input.split(/\s+/).filter(Boolean);
      const forcedFlag = parts.find(p => /^(--full|--tail10|--tail20|--recap|--summary|-f|-1|-2|-r|-s)$/.test(p));
      const forcedMode = forcedFlag
        ? ({ '--full': 'full', '-f': 'full',
             '--tail10': 'tail-10', '-1': 'tail-10',
             '--tail20': 'tail-20', '-2': 'tail-20',
             '--recap': 'tail-20', '-r': 'tail-20',
             '--summary': 'summary', '-s': 'summary' })[forcedFlag]
        : null;
      const targetId = parts.slice(1).find(p => !p.startsWith('-'));

      const resumable = await listResumableSessions();
      if (resumable.length === 0) {
        process.stderr.write(`  ${c.gray('No resumable sessions found.')}\n`);
        return;
      }

      // 1. Resolve which session to resume.
      let picked = null;
      if (targetId) {
        picked = resumable.find(s => s.sessionId === targetId || s.sessionId?.startsWith(targetId));
        if (!picked) {
          process.stderr.write(`  ${c.yellow('!')} ${c.dim(`No session found matching id: ${targetId}`)}\n`);
          return;
        }
      } else {
        while (!picked) {
          const pickResult = await pickResumableSession(resumable, ctx);
          if (!pickResult) { process.stderr.write(`\n  ${c.dim('Cancelled.')}\n`); return; }
          if (pickResult.action === 'resume') {
            if (!pickResult.session) {
              process.stderr.write(`\n  ${c.yellow('!')} ${c.dim('Empty session — pick another.')}\n`);
              continue;
            }
            picked = pickResult.session;
            break;
          }
          if (pickResult.action === 'preview') {
            // Yield to the event loop so any queued keystrokes from the picker
            // don't spill into the preview's stdin listener (PRD-068 §5.14 bugfix).
            await new Promise(r => setImmediate(r));
            const previewResult = await previewResumeSession(pickResult.session, ctx);
            if (previewResult && previewResult.action === 'resume') {
              picked = pickResult.session;
              // Preview already committed to a mode — skip the threshold overlay.
              picked._presetMode = previewResult.mode;
              break;
            }
            if (previewResult === null) {
              // getSessionDetail failed — file missing, unreadable, or huge.
              // Tell the user why before looping back to the picker.
              process.stderr.write(`  ${c.yellow('!')} ${c.dim('Could not load transcript for preview — pick another session or press Enter to resume without preview.')}\n`);
            }
            // Yield again so the loop-back render doesn't collide with the
            // just-closed preview's stdin cleanup.
            await new Promise(r => setImmediate(r));
          }
        }
      }

      // 2. Decide the mode. Force-flag > preview-preset > auto-decide > overlay.
      let mode = forcedMode || picked._presetMode || null;
      if (!mode) {
        const currentModel = picked.modelLimits?.coder?.model
          || picked.models?.[picked.models.length - 1]
          || session?.model
          || session?.user?.default_reasoning_model
          || null;
        const decision = decideResumeMode({
          transcriptTokens: picked.contextTokens,
          model: currentModel,
          contextWindow: picked.modelLimits?.coder || session?.modelLimits?.coder || null,
          settings: ctx.effectivePolicy?.policy?.resume ? { resume: ctx.effectivePolicy.policy.resume } : {},
        });
        decision.resumeSummary = picked.resumeSummary || null;
        if (decision.mode === 'full') {
          mode = 'full';
        } else {
          // Yield before attaching the overlay listener — same race guard as
          // the preview branch above. Prevents a queued Enter from the picker
          // slipping into the overlay's stdin, which otherwise looked like a
          // duplicate picker render.
          await new Promise(r => setImmediate(r));
          const chosen = await chooseThresholdMode(ctx, decision);
          if (!chosen) { process.stderr.write(`\n  ${c.dim('Cancelled.')}\n`); return; }
          mode = chosen;
        }
      }

      // 3. Activate.
      const source = targetId ? 'direct' : 'picker';
      const progress = startResumeProgress(mode);
      let resumed;
      try {
        resumed = await ctx.activateResumedSession(picked.sessionId, source, mode, picked, {
          onProgress: progress.update,
          onProgressStop: progress.stop,
        });
      } finally {
        progress.stop();
      }
      if (!resumed.ok) {
        if (resumed.reason === 'cwd-cancelled') {
          process.stderr.write(`\n  ${c.dim('Cancelled.')}\n`);
        } else {
          process.stderr.write(`\n  ${c.yellow('!')} ${c.dim(resumed.reason || 'No messages in that session.')}\n`);
        }
        return;
      }

      // 4. Report — succinct honest single line, then optional hydration warning.
      const toolSummary = resumed.stats && resumed.stats.toolCalls
        ? `${resumed.stats.toolCalls} tool calls`
        : `${resumed.messages} msgs`;
      const summaryLabel = mode !== 'full' && resumed.summarySource
        ? ` · summary: ${resumed.summarySource}`
        : '';
      process.stderr.write(`\n  ${c.green('↺')} ${c.dim('Resumed')} ${c.brand(picked.project || path.basename(safeCwd()))} ${c.dim(`· ${resumed.messages} msgs · ${toolSummary} · mode: ${resumeModeLabel(mode)}${summaryLabel}`)}\n`);
      if (resumed.summaryWarning) {
        process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`backend summary unavailable — using local summary (${resumed.summaryWarning})`)}\n`);
      }
      if (resumed.hydrationFailures?.length) {
        for (const failure of resumed.hydrationFailures) {
          process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`could not re-read project root: ${failure}`)}\n`);
        }
      }
      if (resumed.stayedInCwd) {
        process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`resumed transcript from ${resumed.savedProjectPath} — running against ${safeCwd()}`)}\n`);
      }

      // 5. Show continuity context. Non-summary modes use the captured
      //    kepler_event stream when available so the terminal replay matches
      //    the original styled interaction; older sessions fall back to
      //    reconstructed text.
      if (mode === 'summary' && resumed.summary) {
        // In summary mode the agent gets only the summary block. Show it so
        // the user knows what continuity context was included.
        process.stderr.write(`\n  ${c.bold('Continuity Summary')}\n`);
        process.stderr.write(`  ${c.gray('─'.repeat(80))}\n`);
        for (const line of resumed.summary.split('\n')) {
          process.stderr.write(`  ${c.dim(line)}\n`);
        }
        process.stderr.write('\n');
      } else if (resumed.replayEvents?.length) {
        renderResumePreview(resumed, { renderEvent });
      } else if (resumed.history?.length) {
        // Full/tail modes feed real conversation to the agent — show
        // the tail so the user has visual context. Cap at 30 entries to avoid
        // flooding the terminal on long sessions.
        renderHistoryEntries(resumed.history, {
          limit: 30,
          maxChars: 200,
          title: mode?.startsWith('tail-') ? `Recent turns (${mode.replace('tail-', 'last ')})` : 'Conversation history (last 30 entries)',
        });
      }
      return;
    }

    case '/agents':
      await handleAgentsCommand(rest, ctx);
      return;

    case '/explore':
    case '/review':
    case '/architect': {
      if (!rest) {
        process.stderr.write(`  ${c.yellow('Usage:')} ${cmd} <instruction>\n`);
        process.stderr.write(`  ${c.gray(`Example: ${cmd} ${cmd === '/explore' ? 'how does authentication work?' : cmd === '/review' ? 'check src/core/ for bugs' : 'design a caching layer'}`)}\n`);
        return;
      }
      return await runAgent(cmd.slice(1), rest, ctx, session, renderEvent);
    }

    case '/logout': {
      const success = ctx.auth.logout();
      if (success) {
        process.stderr.write(`  ${c.green('✓')} ${c.dim('Signed out. Credentials cleared from ~/.kepler/config.json')}\n`);
        process.stderr.write(`  ${c.dim('Run /login to sign in again.')}\n`);
      } else {
        process.stderr.write(`  ${c.yellow('!')} ${c.dim('No credentials to clear.')}\n`);
      }
      return;
    }

    case '/exit':
    case '/quit':
      if (isInputDockMounted()) unmountInputDock();
      process.stderr.write(`\n  ${c.brand('Goodbye!')}\n\n`);
      process.exit(0);

    default:
      process.stderr.write(`  ${c.gray(`Unknown: ${cmd}. Type /help.`)}\n`);
  }
}

// ── Fetch User Profile ──

async function fetchUser(ctx) {
  const creds = ctx.auth.loadCredentials();
  if (!creds.token) return;
  try {
    const resp = await fetch(`${creds.backendUrl}/api/user/me`, {
      headers: { 'Authorization': `Bearer ${creds.token}` },
    });
    if (resp.ok) {
      session.user = await resp.json();
      session.model = session.user.default_reasoning_model || session.user.default_orchestrator_model || null;
    }
  } catch {}
}

// ── Main REPL ──
// Cache CWD at startup so safeCwd() has a fallback if the dir gets deleted

export async function startTerminalRepl() {
  safeCwd(); // prime the cache in repl-utils.mjs for later recovery

  const cliArgs = parseArgs(process.argv.slice(2));
  const auth = new TarangAuth();

  // Projects are registered and indexed on demand through get_project_overview.
  // CheckpointManager records per-file snapshots before edits so /undo works.
  let checkpoints = new CheckpointManager(safeCwd());
  let effectivePolicy = loadEffectivePolicy({ cwd: safeCwd() });
  let latestProjectContext = null;
  let latestEnvelope = null;
  let hookRunner = new HookRunner({ cwd: safeCwd() });
  let toolExecutor = createToolExecutor({ checkpoints, hookRunner });
  const skipPerms = cliArgs.freeswim;
  let approval = new ApprovalManager({ autoApprove: skipPerms, cwd: safeCwd(), policy: effectivePolicy.policy });

  // Session manager — persists conversation messages to .kepler/conversations/
  let sessionMgr = new SessionManager(safeCwd());
  sessionMgrRef.current = sessionMgr; // expose to renderEvent

  // Local JSONL writer — writes cc-lens compatible session data to ~/.kepler/
  let jsonlWriter = new JsonlWriter(safeCwd(), VERSION);

  // Persistent stream client — session_id captured from backend on first turn
  let streamClient = null;

  const ctx = { auth, toolExecutor, approval, jsonlWriter, sessionMgr, checkpoints, effectivePolicy, latestProjectContext, latestEnvelope, pendingVisionPaths: [] };

  async function startNewSession({ announce = true } = {}) {
    stopSpinner();
    flushContent();
    flushPendingHead();
    flushCompactReadRun();
    clearCards();

    const preserved = {
      inputHistory: session.inputHistory,
      user: session.user,
      model: session.model,
      modelLimits: session.modelLimits,
      modelOverrides: session.modelOverrides,
      isByok: session.isByok,
      subscriptionTier: session.subscriptionTier,
      creditsTotal: session.creditsTotal,
      creditsIncluded: session.creditsIncluded,
      creditsPurchased: session.creditsPurchased,
      creditsLimit: session.creditsLimit,
      rateLimit: session.rateLimit,
    };

    try { await jsonlWriter.close(); } catch {}

    checkpoints = new CheckpointManager(safeCwd());
    effectivePolicy = loadEffectivePolicy({ cwd: safeCwd() });
    hookRunner = new HookRunner({ cwd: safeCwd() });
    toolExecutor = createToolExecutor({ checkpoints, hookRunner });
    approval = new ApprovalManager({ autoApprove: skipPerms, cwd: safeCwd(), policy: effectivePolicy.policy });
    if (ctx._rl) approval.setReadline(ctx._rl);
    sessionMgr = new SessionManager(safeCwd());
    sessionMgrRef.current = sessionMgr;
    jsonlWriter = new JsonlWriter(safeCwd(), VERSION);
    streamClient = null;
    latestProjectContext = null;
    latestEnvelope = null;

    Object.assign(session, {
      id: null,
      startTime: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      subAgentToolCalls: 0,
      totalToolCalls: 0,
      totalPrimaryToolCalls: 0,
      totalSubAgentToolCalls: 0,
      turns: 0,
      history: [],
      agentHistory: [],
      inputHistory: preserved.inputHistory,
      user: preserved.user,
      model: preserved.model,
      modelLimits: preserved.modelLimits,
      modelOverrides: preserved.modelOverrides,
      blockedOps: 0,
      delegations: [],
      phases: [],
      inSubAgent: false,
      filesChanged: [],
      filesRead: [],
      lastTurnDuration: 0,
      toolCounts: {},
      subAgentCounts: {},
      savedUsd: 0,
      lastTask: '',
      lastReasoning: '',
      budgetUsd: null,
      budgetExceeded: false,
      costBreakdown: [],
      totalCost: 0,
      costAccurate: false,
      isByok: preserved.isByok,
      subscriptionTier: preserved.subscriptionTier,
      creditsTotal: preserved.creditsTotal,
      creditsIncluded: preserved.creditsIncluded,
      creditsPurchased: preserved.creditsPurchased,
      creditsLimit: preserved.creditsLimit,
      creditsCharged: 0,
      creditsLowWarned: false,
      rateLimit: preserved.rateLimit,
      msgsLowWarned: false,
      _lastEmittedThinking: '',
    });

    Object.assign(ctx, {
      toolExecutor,
      approval,
      jsonlWriter,
      sessionMgr,
      checkpoints,
      effectivePolicy,
      latestProjectContext,
      latestEnvelope,
      pendingVisionPaths: ctx.pendingVisionPaths || [],
    });

    if (announce) process.stderr.write(`  ${c.green('✓')} ${c.dim('New session started.')}\n`);
  }
  ctx.startNewSession = startNewSession;

  /**
   * Activate a previously-recorded session for continuation.
   *
   * Contract (PRD-068 §5.14 and follow-up clarification):
   *   1. Keep the same sessionId. The resumed session IS the same session,
   *      not a fork. Future turns are appended to the SAME .jsonl file that
   *      was read here.
   *   2. Do not re-write the loaded transcript back to disk. The file already
   *      contains every historical entry; the load path is read-only. Any
   *      duplication would double-count tokens on the next resume.
   *   3. Fresh sessions (kepler started without /resume) get a fresh UUID
   *      the first time jsonlWriter.writeUserTurn() runs — that path is
   *      untouched by resume, so brand-new sessions never inherit an old id.
   *   4. In-memory history (session.history / session.agentHistory) mirrors
   *      what the agent will see next turn; it is NOT written back to the
   *      transcript at activation time.
   */
  async function activateResumedSession(sessionId, source = 'resume', historyMode = 'full', resumeEntry = null, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const onProgressStop = typeof options.onProgressStop === 'function' ? options.onProgressStop : () => {};
    // PRD-068 §5.14.6: JSONL is the only source. No legacy conversation fallback.
    onProgress('reading saved transcript', 14);
    const detail = await getSessionDetail(sessionId, { filePath: resumeEntry?.transcriptPath });
    if (!detail) {
      return { ok: false, reason: `No transcript found for session ${sessionId}` };
    }
    onProgress('building resume context', 28);
    const richHistory = buildResumeHistory({ ...detail, recapTailTurns: 8 }, historyMode);
    const displayHistory = richHistory.displayHistory;
    if (!displayHistory.length) {
      return { ok: false, reason: `Session ${sessionId} has no readable messages` };
    }

    // PRD-068 §5.14.7: explicit cwd confirmation if saved path differs.
    const savedProjectPath = detail?.meta?.project || '';
    let summarySource = 'local';
    let summaryWarning = '';
    if (historyMode !== 'full' && richHistory.sourceMessages?.length) {
      onProgress('summarizing transcript', 34);
      const backendSummary = await summarizeResumeTranscript({
        auth,
        toolExecutor,
        sessionId,
        projectPath: savedProjectPath || safeCwd(),
        messages: richHistory.sourceMessages,
      });
      if (backendSummary?.summary) {
        richHistory.summary = combineResumeSummaries(richHistory.priorSummary, backendSummary.summary);
        const summaryIndex = Number.isInteger(richHistory.summaryMessageIndex)
          ? richHistory.summaryMessageIndex
          : 0;
        if (richHistory.agentHistory?.[summaryIndex]) {
          const tailTurns = resumeTailTurnCount(historyMode);
          const prefix = tailTurns
            ? `Summary of earlier turns before the retained last ${tailTurns} conversation messages:\n`
            : 'Session continuity summary:\n';
          richHistory.agentHistory[summaryIndex] = {
            ...richHistory.agentHistory[summaryIndex],
            content: `${prefix}${richHistory.summary}`,
          };
        }
        summarySource = backendSummary.source || 'backend';
      } else {
        summarySource = 'local fallback';
        summaryWarning = backendSummary?.reason || 'backend summary unavailable';
      }
    } else if (historyMode !== 'full') {
      summarySource = 'not needed';
      summaryWarning = resumeTailTurnCount(historyMode)
        ? 'retained tail covers the whole transcript'
        : 'empty transcript';
    }
    const agentHistory = richHistory.agentHistory;
    const originalCwd = safeCwd();
    let switchedProject = false;
    let projectMissing = false;
    let stayedInCwd = false;
    onProgress('checking project cwd', 40);
    if (savedProjectPath && savedProjectPath !== originalCwd) {
      if (fs.existsSync(savedProjectPath)) {
        onProgressStop();
        const choice = await confirmCwdSwitch(ctx, savedProjectPath, originalCwd);
        if (choice === 'cancel') return { ok: false, reason: 'cwd-cancelled' };
        if (choice === 'switch') {
          try {
            process.chdir(savedProjectPath);
            safeCwd(); // re-prime the cache after chdir
            switchedProject = true;
          } catch {
            projectMissing = true;
          }
        } else if (choice === 'stay') {
          stayedInCwd = true;
        }
      } else {
        projectMissing = true;
        process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(`saved project path unavailable: ${savedProjectPath} — using current cwd`)}\n`);
      }
    }

    onProgress('rebuilding local session state', 55);
    checkpoints = new CheckpointManager(safeCwd());
    effectivePolicy = loadEffectivePolicy({ cwd: safeCwd() });
    hookRunner = new HookRunner({ cwd: safeCwd(), sessionId });
    toolExecutor = createToolExecutor({ checkpoints, hookRunner });
    approval = new ApprovalManager({ autoApprove: skipPerms, cwd: safeCwd(), policy: effectivePolicy.policy });
    if (ctx._rl) approval.setReadline(ctx._rl);
    sessionMgr = new SessionManager(safeCwd());
    sessionMgr.activateSession(sessionId, {
      instruction: detail?.meta?.firstPrompt || '',
      started_at: detail?.meta?.startTime || new Date().toISOString(),
    }, displayHistory.filter(m => m.role === 'user' || m.role === 'assistant'));
    sessionMgrRef.current = sessionMgr;

    try { await jsonlWriter.close(); } catch {}
    jsonlWriter = new JsonlWriter(safeCwd(), VERSION);
    jsonlWriter.setSessionId(sessionId);
    if (
      historyMode !== 'full'
      && richHistory.summary
      && Number(richHistory.summaryCoveredMessageCount) > Number(richHistory.summaryCheckpointMessageCount || 0)
    ) {
      jsonlWriter.writeKeplerEvent({
        type: 'resume_summary',
        data: {
          session_id: sessionId,
          mode: historyMode,
          mode_label: resumeModeLabel(historyMode),
          summary: richHistory.summary,
          summary_source: summarySource,
          summary_warning: summaryWarning || null,
          source_message_count: richHistory.summaryCoveredMessageCount,
          previous_source_message_count: richHistory.summaryCheckpointMessageCount || 0,
          full_message_count: richHistory.fullMessageCount || 0,
        },
      });
    }
    jsonlWriter.writeKeplerEvent({
      type: 'resume_context',
      data: {
        session_id: sessionId,
        source,
        mode: historyMode,
        mode_label: resumeModeLabel(historyMode),
        messages: displayHistory.length,
        summary_source: summarySource,
        summary_injected: historyMode !== 'full' && Boolean(richHistory.agentHistory?.[richHistory.summaryMessageIndex ?? 0]?.content),
        summary_warning: summaryWarning || null,
        summary_source_message_count: richHistory.summaryCoveredMessageCount || 0,
        previous_summary_source_message_count: richHistory.summaryCheckpointMessageCount || 0,
        project_path: savedProjectPath || safeCwd(),
      },
    });

    streamClient = null;
    latestProjectContext = loadProjectContext({ cwd: safeCwd() });
    latestEnvelope = null;

    // PRD-068 §5.14.8: report hydration failures instead of swallowing them.
    const hydrationFailures = [];
    const resumeRoots = getTranscriptProjectRoots(detail);
    const rootsToRegister = [...new Set([safeCwd(), ...resumeRoots].filter(Boolean))];
    onProgress('hydrating project roots', 68);
    for (let i = 0; i < rootsToRegister.length; i++) {
      const root = rootsToRegister[i];
      onProgress(`hydrating project root ${i + 1}/${rootsToRegister.length}`, 68 + Math.round((i / Math.max(1, rootsToRegister.length)) * 18));
      try {
        await toolExecutor.execute('get_project_overview', { path: root });
      } catch {
        hydrationFailures.push(root);
      }
    }

    onProgress('preparing replay', 92);
    session.history = displayHistory;
    session.agentHistory = agentHistory;
    session.id = sessionId;
    session.turns = displayHistory.filter(m => m.role === 'user').length;
    session.lastTask = detail?.meta?.firstPrompt || session.history.find(m => m.role === 'user')?.content || '';

    Object.assign(ctx, {
      toolExecutor,
      approval,
      jsonlWriter,
      sessionMgr,
      checkpoints,
      effectivePolicy,
      latestProjectContext,
      latestEnvelope,
      pendingVisionPaths: ctx.pendingVisionPaths || [],
    });

    return {
      ok: true,
      messages: displayHistory.length,
      projectPath: savedProjectPath || safeCwd(),
      savedProjectPath,
      switchedProject,
      projectMissing,
      stayedInCwd,
      hydrationFailures,
      instruction: detail?.meta?.firstPrompt || '',
      historyMode,
      summary: richHistory.summary || '',
      summarySource,
      summaryWarning,
      history: displayHistory,
      replayEvents: detail.replayEvents || [],
      stats: richHistory.stats,
      source,
    };
  }
  ctx.activateResumedSession = activateResumedSession;

  // ── Print banner + preflight + init BEFORE mounting the status bar ──
  // The status bar shrinks the scroll region; if it mounts first, the
  // banner scrolls off-screen before the user ever sees it.
  printBanner(auth);

  // Preflight diagnostic (PRD-055 §9). Non-blocking; opt-out via
  // KEPLER_NO_PREFLIGHT=1 (used by tests / scripted runs).
  if (process.env.KEPLER_NO_PREFLIGHT !== '1' && !cliArgs.freeswim) {
    try { await runPreflight({ auth, cwd: safeCwd(), version: VERSION }); }
    catch { /* preflight is best-effort */ }
  }

  // ── Initialization ──
  process.stderr.write(`  ${c.brand('⠋')} ${c.dim('Initializing...')}\r`);
  await fetchUser(ctx);

  // Clear the spinner line
  process.stderr.write(`\r${' '.repeat(60)}\r`);
  process.stderr.write(`  ${c.green('✓')} ${c.dim('Ready; projects will be indexed on demand')}\n`);
  if (session.user) {
    process.stderr.write(`  ${c.green('✓')} ${c.dim(`Logged in as ${session.user.github_username || session.user.email || 'user'}`)}\n`);
  }
  // ── Resume previous session ──
  if (cliArgs.resume) {
    const lastSession = cliArgs.resumeSessionId
        ? { sessionId: cliArgs.resumeSessionId }
        : sessionMgr.getLastSession();

    if (lastSession) {
      const resumed = await activateResumedSession(lastSession.sessionId, 'startup');
      if (resumed.ok) {
        process.stderr.write(`  ${c.green('↺')} ${c.dim(`Resumed session: ${messageCountLabel(resumed.messages)}`)}`);
        process.stderr.write(` ${c.dim('· project')} ${c.brand(path.basename(safeCwd()))}`);
        process.stderr.write(` ${c.dim(`· agent ${resumed.historyMode}`)}`);
        if (resumed.switchedProject) process.stderr.write(` ${c.dim('(cwd restored)')}`);
        if (resumed.projectMissing) process.stderr.write(` ${c.yellow('(saved project path unavailable; using current cwd)')}`);
        if (resumed.instruction) process.stderr.write(` ${c.dim('—')} ${c.dim(resumed.instruction.slice(0, 50))}`);
        process.stderr.write('\n');
        renderResumePreview(resumed, { renderEvent });
      } else {
        process.stderr.write(`  ${c.yellow('!')} ${c.dim(resumed.reason || 'No conversation found for session ' + lastSession.sessionId)}\n`);
      }
    } else {
      process.stderr.write(`  ${c.yellow('!')} ${c.dim('No previous session to resume')}\n`);
    }
  }

  process.stderr.write(`\n  ${c.dim('Press')} ${c.brand('Enter')} ${c.dim('to start, or type a prompt below.')}\n`);

  // Keep one bottom-reserved UI surface: the fixed input dock. The older
  // status bar used the same terminal scroll-region primitive, so mounting
  // both would make prompt placement unpredictable.
  orbitRef.current = createOrbit();
  const inputDockActive = mountInputDock();
  if (inputDockActive) {
    process.on('beforeExit', unmountInputDock);
    process.on('exit',       unmountInputDock);
  }

  // ── Bracketed paste (DEC private mode 2004) ──────────────────────────────
  // Ask the terminal to wrap pasted content in ESC[200~ … ESC[201~ markers so
  // we can merge a multi-line paste into a single input regardless of how
  // slowly the bytes arrive. Falls back to the legacy 35 ms debounce for
  // terminals that ignore the request.
  const PASTE_BEGIN = '\x1b[200~';
  const PASTE_END   = '\x1b[201~';
  let _inBracketedPaste = false;
  let _bracketedPasteBuffer = '';
  const _pasteEndListeners = new Set();
  function onBracketedPasteEnd(cb) { _pasteEndListeners.add(cb); return () => _pasteEndListeners.delete(cb); }
  function isInBracketedPaste() { return _inBracketedPaste; }

  if (process.stdin.isTTY) {
    try { process.stderr.write('\x1b[?2004h'); } catch {}
    const disableBracketedPaste = () => { try { process.stderr.write('\x1b[?2004l'); } catch {} };
    process.on('exit', disableBracketedPaste);
    process.once('SIGINT', disableBracketedPaste);
    process.once('SIGTERM', disableBracketedPaste);

    // Prepend so we see raw bytes before readline consumes them.
    process.stdin.prependListener('data', (chunk) => {
      const s = chunk.toString('utf8');
      let i = 0;
      while (i < s.length) {
        if (!_inBracketedPaste) {
          const start = s.indexOf(PASTE_BEGIN, i);
          if (start === -1) return;
          _inBracketedPaste = true;
          _bracketedPasteBuffer = '';
          i = start + PASTE_BEGIN.length;
        } else {
          const end = s.indexOf(PASTE_END, i);
          if (end === -1) {
            _bracketedPasteBuffer += s.slice(i);
            return;
          }
          _bracketedPasteBuffer += s.slice(i, end);
          _inBracketedPaste = false;
          const payload = _bracketedPasteBuffer;
          _bracketedPasteBuffer = '';
          // Notify subscribers on next tick so readline finishes emitting its
          // synchronous `line` events for the buffered content first.
          const cbs = [..._pasteEndListeners];
          setImmediate(() => { for (const cb of cbs) { try { cb(payload); } catch {} } });
          i = end + PASTE_END.length;
        }
      }
    });
  }

  // The prompt label is the USER speaking, not the agent. Use the signed-in
  // GitHub handle if known, otherwise fall back to "You".
  //
  // Modern Node readline strips ANSI escapes when calculating prompt width.
  // Bash-style SOH/STX markers confuse readline redraws on long wrapped input
  // and can make the first prompt line appear duplicated.
  function userPrompt() {
    const who = session.user?.github_username || session.user?.email?.split('@')[0] || 'You';
    if (term().plain) return `${who} > `;
    // Brand magenta handle + chevron. No inverse chip, no bold — the color
    // alone marks this row as user input.
    return `${paint.brand.primary(who)} ${paint.brand.primary('›')} `;
  }

  function printInputBottomRule() {
    if (isInputDockMounted()) {
      clearInputPrompt();
      moveToContent();
      return;
    }
    if (term().plain) return;
    process.stderr.write('\n');
  }

  function idleInputTips() {
    return '[Enter] send  [/] commands  [Tab] complete  [Ctrl+D] details';
  }

  function executionInputTips() {
    return 'type any extra context (paths, corrections, follow-ups) · [Enter] send · [Esc] cancel · [Ctrl+P] pause';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: userPrompt(),
    completer: (line) => {
      if (line.startsWith('/')) {
        return [commandCompletions(line), line];
      }
      return [[], line];
    },
    historySize: 100,
  });

  // Give approval manager access to readline for pause/resume
  approval.setReadline(rl);
  ctx._rl = rl; // expose to /resume command for readline pause
  let inputActive = false;
  let slashHintVisible = false;
  let slashHintRowsVisible = 0;
  let slashHintItems = [];
  let slashHintSelected = 0;
  let slashHintLine = '';

  function promptBottomPaddingLines() {
    if (!process.stderr.isTTY || term().plain) return 0;
    // When the dock is mounted the hint borrows the rows below the input
    // (bottom rule + tips + safety); prepareInputPrompt re-renders the
    // frame when clearSlashHint() fires, so the rule/tips reappear.
    // 3 rows fits comfortably in the dock's reservation without leaking
    // past the safety row.
    if (isInputDockMounted()) return 3;
    const raw = process.env.KEPLER_PROMPT_BOTTOM_PADDING ?? '5';
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(8, n);
  }

  function truncateHintText(text, max) {
    const s = String(text || '');
    if (s.length <= max) return s;
    if (max <= 1) return '';
    return s.slice(0, max - 1) + '…';
  }

  function promptColumns() {
    return stripAnsi(userPrompt()).length;
  }

  function restoreReadlineCursor() {
    const col = Math.max(0, promptColumns() + Number(rl.cursor || 0));
    readline.cursorTo(process.stderr, col);
  }

  function renderSlashHint(line = '', { preserveSelection = false } = {}) {
    if (!process.stderr.isTTY || term().plain || !inputActive || !promptBottomPaddingLines()) return;
    const rows = promptBottomPaddingLines();
    const suggestions = slashCommandSuggestions(line, Math.min(5, rows));
    const cols = process.stdout.columns || 80;
    if (!preserveSelection || line !== slashHintLine) slashHintSelected = 0;
    slashHintItems = suggestions;
    slashHintLine = line;
    if (slashHintSelected >= slashHintItems.length) slashHintSelected = Math.max(0, slashHintItems.length - 1);

    readline.moveCursor(process.stderr, 0, 1);
    for (let i = 0; i < rows; i++) {
      readline.clearLine(process.stderr, 0);
      readline.cursorTo(process.stderr, 0);
      const item = suggestions[i];
      if (item) {
        const marker = i === slashHintSelected ? c.brand('›') : c.dim(' ');
        const command = item.command.padEnd(13);
        const maxDesc = Math.max(0, cols - 21);
        const desc = truncateHintText(item.description, maxDesc);
        process.stderr.write(`  ${marker} ${c.brand(command)}${desc ? c.dim(desc) : ''}`);
      }
      if (i < rows - 1) readline.moveCursor(process.stderr, 0, 1);
    }
    readline.moveCursor(process.stderr, 0, -rows);
    restoreReadlineCursor();
    slashHintVisible = suggestions.length > 0;
    slashHintRowsVisible = rows;
  }

  function clearSlashHint({ restoreCursor: shouldRestoreCursor = true } = {}) {
    if (!slashHintVisible || !process.stderr.isTTY || term().plain) {
      slashHintVisible = false;
      slashHintRowsVisible = 0;
      return;
    }
    const rows = slashHintRowsVisible || promptBottomPaddingLines() || 1;
    readline.moveCursor(process.stderr, 0, 1);
    for (let i = 0; i < rows; i++) {
      readline.clearLine(process.stderr, 0);
      readline.cursorTo(process.stderr, 0);
      if (i < rows - 1) readline.moveCursor(process.stderr, 0, 1);
    }
    readline.moveCursor(process.stderr, 0, -rows);
    // The dock's bottom rule + tips row live in the rows we just cleared.
    // Repaint the frame (input row untouched) so they reappear.
    if (isInputDockMounted()) redrawDockFrame();
    if (shouldRestoreCursor) restoreReadlineCursor();
    slashHintVisible = false;
    slashHintRowsVisible = 0;
    slashHintItems = [];
    slashHintSelected = 0;
    slashHintLine = '';
  }

  function replaceReadlineLine(value) {
    const next = String(value || '');
    rl.line = next;
    rl.cursor = next.length;
    if (typeof rl._refreshLine === 'function') {
      rl._refreshLine();
    } else {
      readline.cursorTo(process.stderr, promptColumns());
      readline.clearLine(process.stderr, 1);
      process.stderr.write(next);
    }
  }

  function acceptSlashHint() {
    const item = slashHintItems[slashHintSelected];
    if (!item) return false;
    replaceReadlineLine(item.command);
    slashHintLine = item.command;
    renderSlashHint(item.command, { preserveSelection: true });
    return true;
  }

  function moveSlashHintSelection(delta) {
    if (!slashHintItems.length) return false;
    const count = slashHintItems.length;
    slashHintSelected = (slashHintSelected + delta + count) % count;
    replaceReadlineLine(slashHintLine);
    renderSlashHint(slashHintLine, { preserveSelection: true });
    return true;
  }

  function selectedSlashCommandFor(line) {
    const input = String(line || '').trim();
    if (!input.startsWith('/')) return null;
    if (COMMANDS[input] || input.startsWith('/help ')) return input;
    const item = slashHintItems[slashHintSelected];
    if (!item) return input;
    return item.command;
  }

  function reservePromptBottomPadding() {
    const lines = promptBottomPaddingLines();
    if (!lines) return;
    process.stderr.write(`${'\n'.repeat(lines)}\x1b[${lines}A\r`);
  }

  function renderIdleDockInput() {
    if (!isInputDockMounted()) return false;
    return renderDockInput(userPrompt(), rl.line || '', {
      context: buildContextStrip(),
      tips: idleInputTips(),
    });
  }

  function promptInputLine() {
    // When the fixed dock is active, readline should own only the input
    // buffer, not the visual prompt. If readline paints the prompt itself,
    // long wrapped input can leave a stale duplicate row inside the dock.
    rl.setPrompt(isInputDockMounted() ? '' : userPrompt());
    reservePromptBottomPadding();
    inputActive = true;
    rl.prompt();
    renderIdleDockInput();
  }

  function printSubmittedInput(input) {
    if (!isInputDockMounted()) {
      printInputBottomRule();
      return;
    }
    const lines = String(input || '').split('\n');
    printInputBottomRule();
    process.stderr.write(`${transcriptHeader('you', { tone: 'user' })}\n`);
    for (const line of lines) {
      process.stderr.write(`${transcriptLine(line, { tone: 'user' })}\n`);
    }
  }

  // Helper: show prompt with separator + vertical breathing room
  function showPrompt() {
    if (isInputDockMounted()) {
      prepareInputPrompt({ context: buildContextStrip(), tips: idleInputTips() });
      promptInputLine();
      return;
    }
    printPromptBlock();
    process.stderr.write('\n');  // half-inch vertical gap above input line
    promptInputLine();
  }

  showPrompt();

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', (_str, key = {}) => {
      if (!inputActive) return;
      setImmediate(() => {
        if (!inputActive) return;
        if (slashHintVisible && key.name === 'tab' && acceptSlashHint()) return;
        if (slashHintVisible && key.name === 'down' && moveSlashHintSelection(1)) return;
        if (slashHintVisible && key.name === 'up' && moveSlashHintSelection(-1)) return;
        const isSlash = String(rl.line || '').trimStart().startsWith('/');
        if (!isSlash) clearSlashHint();
        // Refresh the dock input FIRST so the frame (bottom rule + tips)
        // is fresh, THEN paint the slash hint on top — otherwise the
        // dock repaint would wipe the hint we just wrote.
        renderIdleDockInput();
        if (isSlash) renderSlashHint(rl.line);
      });
    });
  }

  // Guard against concurrent line handlers and multiline paste bursts.
  //
  // Node readline emits one `line` event per pasted newline. Two mechanisms
  // coalesce those into a single input:
  //   1. If the terminal supports bracketed paste, we hold flushing until we
  //      see the ESC[201~ end marker — reliable regardless of paste latency.
  //   2. Otherwise we fall back to a short timer that merges bursts arriving
  //      within KEPLER_PASTE_FLUSH_MS.
  let _lineInFlight = false;
  const _queuedLines = [];
  let _pasteLines = [];
  let _pasteFlushTimer = null;

  function pasteFlushDelayMs() {
    const raw = Number.parseInt(process.env.KEPLER_PASTE_FLUSH_MS || '35', 10);
    return Number.isFinite(raw) && raw >= 0 ? Math.min(250, raw) : 35;
  }

  function queueOrRunLine(line) {
    if (_lineInFlight) {
      if (line && line.trim()) _queuedLines.push(line);
      return;
    }
    _lineInFlight = true;
    Promise.resolve()
      .then(() => _handleLine(line))
      .finally(() => {
        _lineInFlight = false;
        if (_queuedLines.length) {
          const next = _queuedLines.shift();
          setImmediate(() => queueOrRunLine(next));
        }
      });
  }

  function flushPastedLines() {
    if (_pasteFlushTimer) {
      clearTimeout(_pasteFlushTimer);
      _pasteFlushTimer = null;
    }
    if (!_pasteLines.length) return;
    const line = _pasteLines.join('\n');
    _pasteLines = [];
    queueOrRunLine(line);
  }

  // If we're mid-paste when readline fires `line`, cancel the debounce timer;
  // the paste-end listener below will flush once the terminal closes the
  // bracket. If we're NOT in a paste (either the terminal doesn't support it,
  // or the user pressed Enter normally), the debounce falls back to old
  // behavior — a single Enter flushes almost instantly.
  rl.on('line', async (line) => {
    _pasteLines.push(line);
    if (_pasteFlushTimer) clearTimeout(_pasteFlushTimer);
    if (isInBracketedPaste()) {
      _pasteFlushTimer = null;
    } else {
      _pasteFlushTimer = setTimeout(flushPastedLines, pasteFlushDelayMs());
    }
  });

  onBracketedPasteEnd(() => {
    // Readline has finished emitting synchronous line events for the pasted
    // content by the time this fires (setImmediate in the pre-listener).
    flushPastedLines();
  });

  async function _handleLine(line) {
    let input = line.trim();
    const selectedSlashCommand = selectedSlashCommandFor(input);
    inputActive = false;
    clearSlashHint();
    if (selectedSlashCommand) input = selectedSlashCommand;
    if (!input) {
      // Empty Enter leaves readline's phantom prompt line ("ravia.sapbpc ›")
      // committed above the cursor. Wipe it so repeated blank Enters don't
      // stack into a ladder of empty prompts in the transcript.
      if (process.stderr.isTTY && !term().plain) {
        // The paste debounce may have batched N Enters into one flush. The
        // joined `line` string has one '\n' per additional Enter, so
        // split('\n').length gives the phantom count.
        const phantoms = Math.max(1, String(line).split('\n').length);
        for (let i = 0; i < phantoms; i++) {
          process.stderr.write('\x1b[A\x1b[2K\r');
        }
      }
      showPrompt();
      return;
    }
    printSubmittedInput(input);

    // Save to input history
    session.inputHistory.push(input);

    // Slash commands
    if (input.startsWith('/')) {
      await handleCommand(input, ctx);
      showPrompt();
      return;
    }

    // Budget cap (PRD-055 §10). Stop before the next paid call when exceeded.
    if (session.budgetUsd && session.totalCost >= session.budgetUsd) {
      session.budgetExceeded = true;
      process.stderr.write(`  ${c.yellow('⏹')} ${c.dim(`Budget reached ($${session.totalCost.toFixed(2)} of $${session.budgetUsd.toFixed(2)}). Use /budget clear to continue.`)}\n`);
      showPrompt();
      return;
    }

    const originalInput = input;
    const creds = auth.loadCredentials();
    if (!creds.token) {
      process.stderr.write(`  ${c.red('Not logged in. Run /login first.')}\n`);
      showPrompt();
      return;
    }

    // Create or reuse stream client — sessionId persists across turns.
    // The same client also owns the authenticated vision-analysis preflight.
    if (!streamClient || streamClient.baseUrl !== creds.backendUrl || streamClient.token !== creds.token) {
      streamClient = new TarangStreamClient({
        baseUrl: creds.backendUrl,
        token: creds.token,
        toolExecutor,
        approvalManager: approval,
      });
    }
    const client = streamClient;
    if (session.id && !client.sessionId) {
      client.sessionId = session.id;
    }

    try {
      const pending = pendingVisionPaths(ctx);
      const prepared = prepareImageAttachments(originalInput, {
        cwd: safeCwd(),
        extraPaths: pending,
      });
      if (prepared.attachments.length) {
        process.stderr.write(`  ${c.brand('◇')} ${c.dim(`attached ${prepared.attachments.length} image${prepared.attachments.length === 1 ? '' : 's'}:`)} ${prepared.attachments.map(attachmentSummaryLine).join(c.dim(' · '))}\n`);
        jsonlWriter.writeKeplerEvent({
          type: 'attachments',
          data: { attachments: prepared.attachments.map(publicAttachmentMetadata) },
        });
        const approved = await confirmVisionUpload(ctx, prepared.attachments, { skip: skipPerms });
        pending.length = 0;
        if (!approved) {
          process.stderr.write(`  ${c.yellow('!')} ${c.dim('Vision upload skipped; continuing without image analysis.')}\n`);
          input = prepared.instruction || originalInput;
        } else {
          process.stderr.write(`  ${c.brand('⠋')} ${c.dim('Analyzing image...')}\r`);
          const analysis = await client.analyzeVision({
            instruction: prepared.instruction,
            attachments: prepared.attachments,
          });
          process.stderr.write(`\r${' '.repeat(80)}\r`);
          process.stderr.write(`  ${c.green('✓')} ${c.dim(`Vision analysis completed for ${prepared.attachments.length} image${prepared.attachments.length === 1 ? '' : 's'}`)}${analysis.model ? c.dim(` · ${analysis.model}`) : ''}\n`);
          jsonlWriter.writeKeplerEvent({
            type: 'vision_analysis',
            data: {
              model: analysis.model || '',
              summary_chars: String(analysis.summary || '').length,
              attachments: analysis.attachments || prepared.metadata,
            },
          });
          input = appendVisionAnalysisToInstruction(prepared.instruction, analysis);
        }
      } else {
        input = prepared.instruction || originalInput;
      }
    } catch (err) {
      process.stderr.write(`  ${c.red('Vision error: ' + (err.message || String(err)))}\n`);
      showPrompt();
      return;
    }

    // Regular prompt
    const userMessage = { role: 'user', content: input };
    session.history.push(userMessage);
    session.agentHistory.push(userMessage);
    session.turns++;
    session.toolCalls = 0;
    session.subAgentToolCalls = 0;
    session.lastTask = originalInput;
    // Reset per-turn counts so the mission report reflects this turn only.
    session.toolCounts = {};
    session.subAgentCounts = {};
    session.filesRead = [];
    session.savedUsd = 0;
    session._lastEmittedThinking = '';
    session.creditsLowWarned = false;
    session.msgsLowWarned = false;

    // Tell the orbit a new turn started — switches to DISCOVERY and updates
    // task / turn counters in the status bar.
    if (orbitRef.current) orbitRef.current.onUserInput(originalInput);

    // Start session tracking on first turn
    if (session.turns === 1) {
      sessionMgr.start(originalInput);
    }
    let userTurnWritten = false;
    const writeCurrentUserTurn = () => {
      if (userTurnWritten) return;
      jsonlWriter.writeUserTurn(input);
      jsonlWriter.writeHistory(input);
      userTurnWritten = true;
    };
    if (session.id) writeCurrentUserTurn();

    let assistantContent = '';
    const agentTurnHistory = new AgentHistoryTurnBuilder();

    // ── Execution keypress listener (Esc = cancel, Space = pause/resume) ──
    let executionPaused = false;
    let keypressCleanup = null;
    let execListenerActive = false;
    let lastCtrlCAt = 0; // PRD-055 §8.4: first Ctrl+C cancels, second exits
    let executionInputBuffer = '';
    let executionInputVisible = false;

    function executionInputPrefix() {
      // Inviting prompt: brand '+' + hint that this accepts any extra
      // context (paths, corrections, more instructions). Visible even when
      // the buffer is empty so users know they can type mid-run.
      return `${paint.brand.data('+')} ${paint.dim('add instruction')} ${paint.dim('›')} `;
    }

    function redrawExecutionInput() {
      if (isInputDockMounted()) {
        renderDockInput(executionInputPrefix(), executionInputBuffer, {
          context: buildContextStrip(),
          tips: executionInputTips(),
        });
        executionInputVisible = true;
        return;
      }
      if (!executionInputVisible) {
        stopSpinner();
        process.stderr.write(`\n${executionInputPrefix()}`);
        executionInputVisible = true;
      }
      readline.clearLine(process.stderr, 0);
      readline.cursorTo(process.stderr, 0);
      process.stderr.write(`${executionInputPrefix()}${executionInputBuffer}`);
    }

    function focusExecutionInput() {
      if (!isInputDockMounted()) return;
      focusDockInput(executionInputPrefix(), executionInputBuffer);
    }
    runtime.afterContentFlush = focusExecutionInput;

    async function submitExecutionInstruction() {
      const instruction = executionInputBuffer.trim();
      executionInputBuffer = '';
      if (!instruction) {
        if (isInputDockMounted()) {
          clearInputPrompt();
          renderDockInput(executionInputPrefix(), '', {
            context: buildContextStrip(),
            tips: executionInputTips(),
          });
          moveToContent();
        } else if (executionInputVisible) {
          process.stderr.write('\n');
        }
        executionInputVisible = false;
        return;
      }
      if (isInputDockMounted()) {
        clearInputPrompt();
        moveToContent();
        process.stderr.write(`${executionInputPrefix()}${instruction}\n`);
        renderDockInput(executionInputPrefix(), '', {
          context: buildContextStrip(),
          tips: executionInputTips(),
        });
        moveToContent();
      } else if (executionInputVisible) {
        process.stderr.write('\n');
      }
      executionInputVisible = false;
      try {
        await client.resume(instruction);
        jsonlWriter.writeKeplerEvent({
          type: 'user_intervention',
          data: { instruction, task_id: client.currentTaskId || null },
        });
        process.stderr.write(`  ${c.green('↳')} ${c.dim('sent follow-up to running agent')}\n`);
      } catch {
        _queuedLines.push(instruction);
        process.stderr.write(`  ${c.yellow('↳')} ${c.dim('queued follow-up for the next turn')}\n`);
      }
    }

    function appendExecutionInput(text) {
      if (!text) return;
      executionInputBuffer += text;
      redrawExecutionInput();
    }

    function backspaceExecutionInput() {
      if (!executionInputBuffer) return false;
      executionInputBuffer = executionInputBuffer.slice(0, -1);
      redrawExecutionInput();
      return true;
    }

    if (process.stdin.isTTY) {
      rl.pause();
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      execListenerActive = true;

      // Bracketed-paste state for follow-up input during execution.
      let execPasteActive = false;
      let execPasteBuffer = '';

      // Accept any character that isn't a bare C0 control (except tab) and
      // isn't part of an ESC sequence. Unicode, emoji, and tabs all pass.
      const isSafeFollowUpText = (s) => {
        if (!s) return false;
        if (s.includes('\x1b')) return false; // escape / arrow / meta keys
        for (const ch of s) {
          const code = ch.codePointAt(0);
          if (code === 0x09) continue; // tab ok
          if (code < 0x20 || code === 0x7f) return false;
        }
        return true;
      };

      const onData = (data) => {
        if (!execListenerActive) return; // paused for approval menu
        const bytes = [...data];
        const text = data.toString('utf8');

        // ── Bracketed paste passthrough ────────────────────────────────────
        // Strip ESC[200~/ESC[201~ markers and treat the content between them
        // as a single append. Handles pastes that straddle chunk boundaries.
        if (execPasteActive || text.includes(PASTE_BEGIN)) {
          let s = text;
          while (s.length) {
            if (!execPasteActive) {
              const start = s.indexOf(PASTE_BEGIN);
              if (start === -1) break;
              // Anything before the start marker is normal keystrokes;
              // let it fall through by re-invoking with just that slice.
              if (start > 0) {
                const pre = s.slice(0, start);
                // Recurse via a synthetic buffer so normal handlers process
                // the pre-paste characters below.
                onData(Buffer.from(pre, 'utf8'));
              }
              execPasteActive = true;
              execPasteBuffer = '';
              s = s.slice(start + PASTE_BEGIN.length);
              continue;
            }
            const end = s.indexOf(PASTE_END);
            if (end === -1) { execPasteBuffer += s; return; }
            execPasteBuffer += s.slice(0, end);
            execPasteActive = false;
            const payload = execPasteBuffer;
            execPasteBuffer = '';
            if (payload) appendExecutionInput(payload);
            s = s.slice(end + PASTE_END.length);
          }
          if (!s.length) return;
          // Anything after the end marker (rare) falls through as a fresh
          // buffer for the normal handlers.
          data = Buffer.from(s, 'utf8');
        }

        const bytes2 = [...data];
        const text2 = data.toString('utf8');

        // Esc key (single byte 0x1b, not part of arrow sequence)
        if (bytes2.length === 1 && bytes2[0] === 0x1b) {
          if (executionInputVisible || executionInputBuffer) {
            executionInputBuffer = '';
            if (isInputDockMounted()) {
              clearInputPrompt();
              renderDockInput(executionInputPrefix(), '', {
                context: buildContextStrip(),
                tips: executionInputTips(),
              });
              moveToContent();
            } else if (executionInputVisible) {
              readline.clearLine(process.stderr, 0);
              readline.cursorTo(process.stderr, 0);
            }
            executionInputVisible = false;
            return;
          }
          stopSpinner();
          if (isInputDockMounted()) {
            clearInputPrompt();
            moveToContent();
          }
          process.stderr.write(`\n  ${c.yellow('⏹')} ${c.dim('Cancelled.')}\n`);
          // cancel() now aborts the in-flight SSE reader; the for-await loop
          // wakes up immediately and the prompt returns. No more "stuck"
          // Cancelling… message.
          client.cancel();
          return;
        }

        if (bytes2.length === 1 && (bytes2[0] === 0x7f || bytes2[0] === 0x08)) {
          backspaceExecutionInput();
          return;
        }

        if (text2.includes('\r') || text2.includes('\n')) {
          const parts = text2.split(/\r?\n|\r/);
          if (parts[0]) appendExecutionInput(parts[0]);
          submitExecutionInstruction();
          // Extra lines from a raw (non-bracketed) paste get concatenated
          // into the current follow-up buffer instead of firing multiple
          // resume() calls. If the user presses Enter again, they send.
          for (const extra of parts.slice(1)) {
            if (extra) appendExecutionInput('\n' + extra);
          }
          return;
        }

        // Ctrl+P — pause/resume (moved off Space so follow-up input can start
        // with a space without triggering pause).
        if (bytes2.length === 1 && bytes2[0] === 0x10) {
          if (executionPaused) {
            executionPaused = false;
            if (isInputDockMounted()) moveToContent();
            process.stderr.write(`  ${c.green('▶')} ${c.dim('Resumed')}\n`);
            client.resume();
            if (orbitRef.current) orbitRef.current.onResume();
          } else {
            executionPaused = true;
            stopSpinner();
            if (isInputDockMounted()) moveToContent();
            process.stderr.write(`  ${c.yellow('⏸')} ${c.dim('Paused — press Ctrl+P to resume, Esc to cancel')}\n`);
            client.pause();
            if (orbitRef.current) orbitRef.current.onPause();
          }
          return;
        }

        // Ctrl+C during execution — PRD-055 §8.4 two-step semantics:
        //   first press → cancel current backend run, stay in REPL
        //   second press within 2s → exit the CLI
        if (bytes2[0] === 0x03) {
          stopSpinner();
          const now = Date.now();
          if (lastCtrlCAt && (now - lastCtrlCAt) < 2000) {
            if (isInputDockMounted()) unmountInputDock();
            process.stderr.write(`\n  ${c.dim('exiting…')}\n`);
            try { client.cancel(); } catch {}
            process.exit(0);
          }
          lastCtrlCAt = now;
          if (isInputDockMounted()) {
            clearInputPrompt();
            moveToContent();
          }
          process.stderr.write(`\n  ${c.yellow('⏹')} ${c.dim('Cancelled. Press Ctrl+C again within 2s to exit.')}\n`);
          try { client.cancel(); } catch {}
          return;
        }

        // Ctrl+D — expand last tool card (Mission Control §6.2). Only when
        // there's no in-progress follow-up input.
        if (!executionInputBuffer && bytes2.length === 1 && bytes2[0] === 0x04) {
          stopSpinner();
          if (isInputDockMounted()) moveToContent();
          expandLast();
          return;
        }

        // Any safe text (unicode, tabs, spaces, symbols) becomes a live
        // follow-up instruction. Enter sends it via resume(instruction).
        if (isSafeFollowUpText(text2)) {
          appendExecutionInput(text2);
          return;
        }
      };

      process.stdin.on('data', onData);

      // Let approval manager pause/resume this listener
      approval.setExecutionHooks({
        onPause: () => { execListenerActive = false; },
        onResume: () => { execListenerActive = true; },
      });

      keypressCleanup = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(wasRaw || false);
        execListenerActive = false;
        approval.setExecutionHooks({}); // clear hooks
        rl.resume();
      };
    }

    try {
      if (isInputDockMounted()) {
        renderDockInput(executionInputPrefix(), '', {
          context: buildContextStrip(),
          tips: executionInputTips(),
        });
        moveToContent();
      }
      startContentStream();
      process.stderr.write(`\n${transcriptHeader('kepler', { tone: 'assistant' })}\n`);
      runtime.contentHeaderPrinted = true;

      // Immediate feedback so the screen isn't blank between submit and the
      // first backend event. The first `status`, `thinking`, or `content_*`
      // event will replace this text; stopSpinner clears it before content
      // renders.
      startSpinner('thinking…');

      const execContext = { cwd: safeCwd() };
      if (skipPerms) execContext.freeswim = true;
      effectivePolicy = loadEffectivePolicy({ cwd: safeCwd() });
      approval.policy = effectivePolicy.policy;
      if (approval.trustStore) approval.trustStore.policy = effectivePolicy.policy;
      hookRunner.reload();
      latestProjectContext = loadProjectContext({ cwd: safeCwd(), previous: latestProjectContext });
      let projectResources = toolExecutor.getProjectResources();
      const promptRoots = promptProjectRoots(input);
      if (promptRoots.length > 0) {
        await toolExecutor.registerProjectRoots(promptRoots);
        projectResources = toolExecutor.getProjectResources();
      }
      const promptHook = await hookRunner.run('UserPromptSubmit', {
        input: { prompt: input },
        turnId: String(session.turns),
      });
      const hookHints = (promptHook.results || [])
        .map(r => r.parsed?.feedback)
        .filter(Boolean)
        .map(text => ({ source: 'hook', kind: 'feedback', text, ttl_turns: 1, priority: 'medium' }));
      const rejectionHints = (approval.consumeRejectionHints?.() || [])
        .map(h => ({
          source: 'hitl',
          kind: 'approval_rejection',
          text: `${h.decision === 'replan' ? 'User requested a re-plan' : 'User rejected approval'} for ${h.tool}. ${h.note ? `Reason: ${h.note}` : h.reason}. Adjust the approach before retrying.`,
          ttl_turns: 1,
          priority: 'high',
        }));
      latestEnvelope = buildContextEnvelope({
        cwd: safeCwd(),
        effectivePolicy,
        projectContext: latestProjectContext,
        activeHints: [...hookHints, ...rejectionHints],
        projectResources,
        agentContext: toolExecutor.getAgentContext(),
      });
      ctx.effectivePolicy = effectivePolicy;
      ctx.latestProjectContext = latestProjectContext;
      ctx.latestEnvelope = latestEnvelope;
      Object.assign(execContext, latestEnvelope);
      if (skipPerms) execContext.freeswim = true;
      const modelOverrides = Object.fromEntries(sessionModelOverrideEntries());
      if (Object.keys(modelOverrides).length > 0) {
        execContext.model_overrides = modelOverrides;
        if (modelOverrides.reasoning) execContext.model_override = modelOverrides.reasoning;
      }
      // PRD-071: seed work_scope from CLI so the backend has a byte-stable
      // scope block from turn 1. Uses projectResources already gathered by
      // the envelope above.
      execContext.work_scope = buildWorkScope({
        instruction: input,
        cwd: safeCwd(),
        projectResources,
      });
      for (const file of latestProjectContext.changed || []) {
        if (effectivePolicy.policy.context?.showReloadNotice) {
          process.stderr.write(`  ${c.dim(`[Context] ${file.label} updated — re-read`)}\n`);
        }
      }

      for await (const event of client.execute(input, execContext, session.agentHistory)) {
        jsonlWriter.writeKeplerEvent(event);
        if (event.type === 'plan_created' || event.type === 'goal_created') {
          persistProjectArtifacts(
            event.data,
            toolExecutor.getProjectResources(),
            message => process.stderr.write(`  ${c.dim(message)}\n`),
          );
        }
        if (isInputDockMounted()) moveToContent();
        renderEvent(event);
        focusExecutionInput();

        if (event.type === 'content_partial') {
          const text = event.data?.text || '';
          assistantContent += text;
          agentTurnHistory.addAssistantText(text);
          jsonlWriter.accumulateContent(text);
        } else if (event.type === 'content') {
          const text = event.data?.text || '';
          const newText = assistantContent && text.startsWith(assistantContent)
            ? text.slice(assistantContent.length)
            : text === assistantContent ? '' : text;
          if (text) {
            assistantContent = assistantContent && !text.startsWith(assistantContent)
              ? assistantContent + text
              : text;
          }
          if (newText) {
            agentTurnHistory.addAssistantText(newText);
            jsonlWriter.accumulateContent(newText);
          }
        }

        // Local JSONL: capture session ID from backend
        if (event.type === 'session_info' && event.data?.session_id) {
          jsonlWriter.setSessionId(event.data.session_id);
          hookRunner.sessionId = event.data.session_id;
          writeCurrentUserTurn();
        }

        // Local JSONL: accumulate tool calls
        if (event.type === 'tool_call' || event.type === 'tool_request') {
          const d = event.data || {};
          agentTurnHistory.addToolUse(d);
          jsonlWriter.accumulateToolCall(d.call_id || d.request_id, d.tool, d.args);
        }

        // Local JSONL: record tool results
        if (event.type === 'tool_done' || event.type === 'tool_result') {
          const d = event.data || {};
          agentTurnHistory.addToolResult(d);
          jsonlWriter.recordToolResult(d.call_id || d._callId, d.output, d.success === false, d);
        }

        // Local JSONL: flush assistant turn on complete
        if (event.type === 'complete') {
          jsonlWriter.setTurnUsage(event.data?.usage, session.model);
          jsonlWriter.flushAssistantTurn();
        }
      }

      flushContent();
    } catch (err) {
      inPlace('');
      flushContent();
      process.stderr.write(`  ${c.red('Error: ' + err.message)}\n`);
    } finally {
      // Clean up execution keypress listener
      runtime.afterContentFlush = null;
      if (keypressCleanup) keypressCleanup();
    }

    if (assistantContent) {
      const assistantMessage = { role: 'assistant', content: assistantContent };
      session.history.push(assistantMessage);
    }
    const structuredTurn = agentTurnHistory.finish();
    if (structuredTurn.length) {
      session.agentHistory.push(...structuredTurn);
    } else if (assistantContent) {
      session.agentHistory.push({ role: 'assistant', content: assistantContent });
    }

    showPrompt();
  }

  rl.on('close', async () => {
    clearSlashHint({ restoreCursor: false });
    inputActive = false;
    stopSpinner();
    if (isInputDockMounted()) unmountInputDock();
    await hookRunner.run('Stop', { input: { session_id: session.id || '' } });
    await jsonlWriter.close();
    process.stderr.write(`\n  ${c.dim('session ended')}\n\n`);
    process.exit(0);
  });
}
