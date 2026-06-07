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
