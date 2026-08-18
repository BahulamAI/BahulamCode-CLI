// Present-progressive verbs — read more conversationally than "Read file":
// "Reading auth.py  — 47 lines" reads like the agent narrating, not a log.
const TOOL_LABELS = Object.freeze({
  shell: 'Running',
  read_file: 'Reading',
  read_files: 'Reading',
  read_batch: 'Reading batch',
  write_file: 'Writing',
  write_project: 'Writing files',
  edit_file: 'Editing',
  delete_file: 'Deleting',
  list_files: 'Listing',
  search_code: 'Searching',
  search_files: 'Searching files',
  grep: 'Searching for',
  get_file_info: 'Inspecting',
  validate_file: 'Validating',
  validate_build: 'Validating build',
  validate_structure: 'Checking structure',
  lint_check: 'Linting',
  run_tests: 'Running tests',
  git_diff: 'Reviewing changes',
  git_status: 'Checking git',
  analyze_code: 'Analyzing',
  get_project_overview: 'Indexing project',
  skills_list: 'Listing skills',
  skill_view: 'Loading skill',
  skill_install: 'Installing skill',
  skill_update: 'Updating skill',
  skill_remove: 'Removing skill',
  agents_list: 'Listing agents',
  agent_create: 'Creating agent',
  agent_sync: 'Syncing agents',
  workflow_list: 'Listing workflows',
  workflow_create_multi: 'Creating workflow',
  workflow_sync_multi: 'Syncing workflows',
  workflow_run_multi: 'Running workflow',
  Agent: 'Delegating',
  agent: 'Delegating',
  task: 'Delegating',
  sub_agent_tools: 'Sub-agent tools',
  explore: 'Exploring',
  plan: 'Planning',
  verify: 'Verifying',
  debug: 'Debugging',
  refactor: 'Refactoring',
  ask_user: 'Asking',
});

function labelKey(tool) {
  const raw = String(tool || '');
  return TOOL_LABELS[raw] ? raw : raw.toLowerCase();
}

export function toolDisplayLabel(tool) {
  if (!tool) return 'Use tool';
  const key = labelKey(tool);
  if (TOOL_LABELS[key]) return TOOL_LABELS[key];
  return tool
    .replace(/^mcp[_-]?/i, '')
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part, index) => index === 0
      ? part.charAt(0).toUpperCase() + part.slice(1)
      : part.toLowerCase())
    .join(' ');
}

function currentWorkingDirectory() {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

function shortPath(filePath, cwd = currentWorkingDirectory()) {
  const value = String(filePath || '');
  if (cwd && value.startsWith(`${cwd}/`)) return value.slice(cwd.length + 1);
  return value;
}

// Sub-agent prompts (explore/plan/verify/debug/refactor) are often multi-
// paragraph briefs with bullet lists — dumping the whole thing into a tool
// card head made the terminal render N lines of noise per call. Show just
// the first paragraph (up to the first blank line), whitespace-collapsed to
// a single line, and add an ellipsis if more content was hidden.
function firstParagraph(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return '';
  const paraEnd = raw.indexOf('\n\n');
  const head = paraEnd === -1 ? raw : raw.slice(0, paraEnd);
  const collapsed = head.replace(/\s+/g, ' ').trim();
  return raw.length > head.length ? `${collapsed} …` : collapsed;
}

export function toolDisplaySummary(tool, args = {}, { cwd } = {}) {
  const key = String(tool || '').toLowerCase();
  switch (key) {
    case 'shell':
      return args.command || '(empty command)';
    case 'read_file': {
      const filePath = shortPath(args.file_path || args.path, cwd);
      if (args.start_line && args.end_line) {
        return `${filePath} · lines ${args.start_line}-${args.end_line}`;
      }
      if (args.start_line) return `${filePath} · from line ${args.start_line}`;
      return filePath;
    }
    case 'read_files':
    case 'read_batch': {
      const files = (args.file_paths || args.paths || [])
        .concat((args.items || []).map(item => typeof item === 'string' ? item : item?.file_path || item?.path).filter(Boolean))
        .map(filePath => shortPath(filePath, cwd));
      if (files.length <= 6) return files.join(', ');
      return `${files.slice(0, 3).join(', ')} · +${files.length - 3} more`;
    }
    case 'write_file': {
      const filePath = shortPath(args.file_path || args.path, cwd);
      const lineCount = typeof args.content === 'string'
        ? args.content.split('\n').length
        : null;
      return lineCount ? `${filePath} · ${lineCount} lines` : filePath;
    }
    case 'write_project':
      return (args.files || [])
        .map(file => shortPath(file.path || file.file_path, cwd))
        .filter(Boolean)
        .join(', ') || 'Project files';
    case 'edit_file': {
      const filePath = shortPath(args.file_path || args.path, cwd);
      const search = String(args.search || '').trim();
      return search ? `${filePath} · match "${search.slice(0, 40)}${search.length > 40 ? '...' : ''}"` : filePath;
    }
    case 'delete_file':
      return shortPath(args.file_path || args.path, cwd);
    case 'search_code':
    case 'search_files':
    case 'grep':
      return `"${args.query || args.pattern || ''}"${args.path ? ` in ${shortPath(args.path, cwd)}` : ''}`;
    case 'list_files':
      return `${args.pattern || '*'}${args.path ? ` in ${shortPath(args.path, cwd)}` : ''}`;
    case 'run_tests':
    case 'validate_build':
    case 'lint_check':
      return args.command || args.path || args.file_path || '';
    case 'git_diff':
    case 'git_status':
      return args.path ? shortPath(args.path, cwd) : '';
    case 'skills_list':
      return [args.query ? `"${args.query}"` : '', args.scope || '', args.source || ''].filter(Boolean).join(' · ');
    case 'skill_view':
      return [args.name || '', args.path || '', args.source_id || ''].filter(Boolean).join(' · ');
    case 'skill_install':
      return `${args.source || ''}${args.scope ? ` → ${args.scope}` : ''}${args.force ? ' · force' : ''}`;
    case 'skill_update':
    case 'skill_remove':
      return `${args.name || ''}${args.scope ? ` · ${args.scope}` : ''}`;
    case 'agents_list':
      return [args.query ? `"${args.query}"` : '', args.scope || ''].filter(Boolean).join(' · ');
    case 'agent_create':
      return [args.name || '', args.role || '', args.model || ''].filter(Boolean).join(' · ');
    case 'agent_sync':
      return args.name || args.slug || 'all local agents';
    case 'workflow_list':
      return [args.query ? `"${args.query}"` : '', args.scope || ''].filter(Boolean).join(' · ');
    case 'workflow_create_multi':
      return [args.name || '', args.pattern || 'sequential', Array.isArray(args.agents) ? `${args.agents.length} agents` : ''].filter(Boolean).join(' · ');
    case 'workflow_sync_multi':
      return args.name || args.slug || 'all local workflows';
    case 'workflow_run_multi':
      return [args.workflow_id || args.workflowId || args.name || '', args.pattern || 'sequential'].filter(Boolean).join(' · ');
    case 'agent':
    case 'task': {
      const agentName = args.subagent_type || args.agent || args.name || args.type || '';
      const task = firstParagraph(args.prompt || args.task || args.query || args.description || args.instruction || '');
      return [agentName, task].filter(Boolean).join(' · ');
    }
    case 'sub_agent_tools': {
      const total = Number(args.total || args.count || 0);
      const agent = args.agent || args.type || '';
      return [agent, total > 0 ? `${total} tool use${total === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    }
    case 'explore':
    case 'plan':
    case 'verify':
    case 'debug':
    case 'refactor':
      return firstParagraph(args.query || args.task || args.prompt || '');
    case 'ask_user':
      return args.question || args.prompt || '';
    default:
      return Object.values(args)
        .filter(value => typeof value === 'string' && value)
        .join(', ')
        .slice(0, 120);
  }
}

export function shellCommandDisplay(command, { cwd = currentWorkingDirectory() } = {}) {
  const parsed = parseLeadingCd(command);
  if (!parsed) return { command: String(command || '(empty command)'), cwdLabel: '' };

  return {
    command: parsed.command || '(empty command)',
    cwdLabel: compactShellCwd(parsed.cwd, cwd),
  };
}

const COMPACT_SHELL_CHARS = 320;
const COMPACT_SHELL_LINES = 2;

export function shellCommandProfile(command, {
  cwd = currentWorkingDirectory(),
  compactChars = COMPACT_SHELL_CHARS,
  compactLines = COMPACT_SHELL_LINES,
} = {}) {
  const original = String(command || '');
  const display = shellCommandDisplay(original, { cwd });
  const normalized = String(display.command || '').replace(/\r\n?/g, '\n');
  const body = normalized || '(empty command)';
  const lines = normalized ? normalized.split('\n') : [];
  const commandLineCount = Math.max(1, lines.filter(line => line.trim()).length || lines.length);
  const commandByteCount = byteLength(normalized || body);
  const script = detectShellScript(normalized);
  const lineCount = script?.body ? physicalLineCount(script.body) : commandLineCount;
  const byteCount = script?.body ? byteLength(script.body) : commandByteCount;
  const compact = Boolean(script)
    || commandLineCount >= compactLines
    || commandByteCount > compactChars;
  const kind = script?.kind || (lineCount > 1 ? 'shell script' : 'shell command');
  const preview = script?.body ? scriptBodyPreview(script.body) : '';
  const summary = compact
    ? [
        `${kind} · ${lineCount} line${lineCount === 1 ? '' : 's'} · ${formatBytes(byteCount)}`,
        preview ? `preview: ${preview}` : '',
      ].filter(Boolean).join(' · ')
    : body;

  return {
    original,
    command: body,
    cwdLabel: display.cwdLabel,
    lineCount,
    byteCount,
    commandLineCount,
    commandByteCount,
    compact,
    kind,
    summary,
    preview,
    script,
    detailHint: compact ? 'details: F2 or /last' : '',
  };
}

function detectShellScript(command) {
  const text = String(command || '').replace(/\r\n?/g, '\n');
  if (!text) return null;

  const heredoc = text.match(/\b(python3?|node|ruby|perl|bash|sh)\b[^\n]*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n([\s\S]*?)\n\3(?:\s*$|\s)/);
  if (heredoc) {
    const invocation = text.slice(0, text.indexOf('\n')).trim();
    return {
      kind: interpreterKind(heredoc[1]),
      interpreter: heredoc[1],
      marker: heredoc[3],
      invocation,
      body: heredoc[4],
    };
  }

  const inline = text.match(/\b(python3?|node|ruby|perl)\b\s+(?:-[A-Za-z]*[ce][A-Za-z]*|--command|--eval)\s+(['"])([\s\S]{120,})\2/);
  if (inline) {
    return {
      kind: interpreterKind(inline[1]),
      interpreter: inline[1],
      invocation: text.slice(0, inline.index + inline[0].indexOf(inline[2])).trim(),
      body: inline[3],
    };
  }

  const tempScript = text.match(/\b(python3?|node|ruby|perl|bash|sh)\b\s+((?:\/(?:private\/)?tmp|\/private\/var\/folders|\/var\/folders)[^\s;&|]+\.(?:py|mjs|js|rb|pl|sh))\b/);
  if (tempScript) {
    return {
      kind: interpreterKind(tempScript[1]),
      interpreter: tempScript[1],
      invocation: `${tempScript[1]} ${tempScript[2]}`,
      path: tempScript[2],
    };
  }

  return null;
}

function interpreterKind(value) {
  const name = String(value || '').toLowerCase();
  if (name.startsWith('python')) return 'python script';
  if (name === 'node') return 'node script';
  if (name === 'ruby') return 'ruby script';
  if (name === 'perl') return 'perl script';
  return 'shell script';
}

function scriptBodyPreview(body, maxChars = 20) {
  const line = String(body || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(value => value.trim())
    .find(Boolean) || '';
  const compact = line.replace(/\s+/g, ' ');
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

function byteLength(value) {
  try {
    return Buffer.byteLength(String(value || ''), 'utf8');
  } catch {
    return String(value || '').length;
  }
}

function physicalLineCount(value) {
  const text = String(value || '');
  if (!text) return 0;
  return text.split('\n').length;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatShellCommand(command, colors) {
  const tokens = String(command || '').match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|&&|\|\||[|;<>]|[^\s]+|\s+/g) || [];
  let expectsCommand = true;

  return tokens.map(token => {
    if (/^\s+$/.test(token)) return token;
    if (/^(?:&&|\|\||[|;<>])$/.test(token)) {
      expectsCommand = true;
      return colors.red(token);
    }
    if (expectsCommand) {
      expectsCommand = false;
      return colors.blue(token);
    }
    if (/^-{1,2}[\w-]+(?:=.*)?$/.test(token) || /^["']/.test(token)) {
      return colors.yellow(token);
    }
    return colors.white(token);
  }).join('');
}

function parseLeadingCd(command) {
  const text = String(command || '').trim();
  const match = text.match(/^cd\s+((?:"(?:\\.|[^"\\])*")|'(?:\\.|[^'\\])*'|(?:\\.|[^\s&])+)\s*&&\s*([\s\S]+)$/);
  if (!match) return null;
  return {
    cwd: unquoteShellToken(match[1]),
    command: match[2].trim(),
  };
}

function unquoteShellToken(token) {
  const text = String(token || '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const body = text.slice(1, -1);
    return text.startsWith('"')
      ? body.replace(/\\(["\\$`])/g, '$1')
      : body;
  }
  return text.replace(/\\(.)/g, '$1');
}

function compactShellCwd(dir, cwd) {
  const value = String(dir || '');
  if (!value) return '';
  if (cwd && value === cwd) return '';
  if (cwd && value.startsWith(`${cwd}/`)) return value.slice(cwd.length + 1);

  const parts = value.split('/').filter(Boolean);
  if (parts.length <= 2) return value || dir;
  if (/\s/.test(parts[parts.length - 2] || '')) return parts[parts.length - 1];
  return parts.slice(-2).join('/');
}
