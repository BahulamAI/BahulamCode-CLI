const TOOL_LABELS = Object.freeze({
  shell: 'Run command',
  read_file: 'Read file',
  read_files: 'Read files',
  write_file: 'Create file',
  write_project: 'Create project files',
  edit_file: 'Edit file',
  delete_file: 'Delete file',
  list_files: 'List files',
  search_code: 'Search code',
  search_files: 'Search files',
  grep: 'Search text',
  get_file_info: 'Inspect file',
  validate_file: 'Validate file',
  validate_build: 'Validate build',
  validate_structure: 'Check project structure',
  lint_check: 'Check code quality',
  run_tests: 'Run tests',
  git_diff: 'Review changes',
  git_status: 'Check repository status',
  analyze_code: 'Analyze code',
  explore: 'Explore codebase',
  plan: 'Create implementation plan',
  verify: 'Verify implementation',
  debug: 'Debug issue',
  refactor: 'Refactor code',
  ask_user: 'Ask for input',
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
      return (args.file_paths || args.paths || [])
        .map(filePath => shortPath(filePath, cwd))
        .join(', ');
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
