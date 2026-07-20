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
  explore: 'Exploring',
  plan: 'Planning',
  verify: 'Verifying',
  debug: 'Debugging',
  refactor: 'Refactoring',
  ask_user: 'Asking',
});

export function toolDisplayLabel(tool) {
  if (!tool) return 'Use tool';
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool];
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

export function toolDisplaySummary(tool, args = {}, { cwd } = {}) {
  switch (tool) {
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
    case 'explore':
    case 'plan':
    case 'verify':
    case 'debug':
    case 'refactor':
      return args.query || args.task || args.prompt || '';
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
