const CLI_COMMANDS = [
  'agent', 'attach', 'completion', 'daemonize', 'dashboard', 'device', 'help',
  'history', 'init', 'install', 'list', 'local', 'login', 'logout', 'mcp',
  'pair', 'plugin', 'plugins', 'pull', 'remote', 'sessions', 'skills', 'skill',
  'stats', 'stop', 'version', 'workflow', 'workspace', 'workspaces',
];
const COMMON_FLAGS = [
  '--agent', '--bundled', '--direct', '--headless', '--help', '--local',
  '--remote', '--resume', '--version', '--workflow', '-h', '-p',
];
const SHELLS = ['bash', 'zsh', 'fish', 'powershell'];

export function completeCliWords(words = []) {
  const parts = words.map(value => String(value || '')).filter(value => value !== '--');
  const current = parts.at(-1) || '';
  const previous = parts.at(-2) || '';
  let candidates = [];
  if (parts.length <= 1) {
    candidates = [...CLI_COMMANDS, ...COMMON_FLAGS];
  } else if (previous === 'completion') {
    candidates = SHELLS;
  } else if (previous === 'mcp') {
    candidates = ['add', 'list', 'ls', 'remove', 'rm', 'test', 'status'];
  } else if (previous === 'plugin' || previous === 'plugins') {
    candidates = ['list', 'ls', 'install', 'remove', 'rm', 'info', 'doctor'];
  } else if (previous === 'workflow') {
    candidates = ['list', 'create', 'run', 'show', 'validate', 'check', 'lint'];
  } else if (previous === 'agent') {
    candidates = ['list', 'create', 'show', 'run', 'validate', 'check', 'lint'];
  } else if (previous === 'workspace' || previous === 'workspaces' || previous === 'local') {
    candidates = ['open', 'list', 'stop'];
  } else if (previous === 'remote') {
    candidates = ['enable', 'disable', 'status', 'pair'];
  } else if (previous === 'skills' || previous === 'skill') {
    candidates = ['list', 'install', 'info', 'remove', 'doctor'];
  } else if (previous === 'history') {
    candidates = ['--help', '--json'];
  } else if (previous === 'sessions' || previous === 'stats' || previous === 'dashboard') {
    candidates = ['--help', '--json'];
  } else {
    candidates = COMMON_FLAGS;
  }
  return [...new Set(candidates)].filter(candidate => candidate.startsWith(current)).sort();
}

export function generateShellCompletion(shell) {
  switch (String(shell || '').toLowerCase()) {
    case 'bash':
      return `# Add to ~/.bashrc: eval "$(bahulam completion bash)"\n_bahulam_completion() {\n  local words=("\${COMP_WORDS[@]:1}")\n  COMPREPLY=( $(bahulam __complete -- "\${words[@]}" 2>/dev/null) )\n}\ncomplete -F _bahulam_completion bahulam bahulam-code\n`;
    case 'zsh':
      return `# Add to ~/.zshrc: eval "$(bahulam completion zsh)"\n#compdef bahulam bahulam-code\n_bahulam_completion() {\n  local -a completions\n  completions=(\${(@f)$(bahulam __complete -- $words[2,$CURRENT] 2>/dev/null)})\n  _describe 'bahulam command' completions\n}\ncompdef _bahulam_completion bahulam bahulam-code\n`;
    case 'fish':
      return `# Save as ~/.config/fish/completions/bahulam.fish\nfunction __bahulam_complete\n  set -l words (commandline -opc)\n  set -e words[1]\n  set -a words (commandline -ct)\n  command bahulam __complete -- $words 2>/dev/null\nend\ncomplete -c bahulam -f -a '(__bahulam_complete)'\ncomplete -c bahulam-code -f -a '(__bahulam_complete)'\n`;
    case 'powershell':
    case 'pwsh':
      return `# Add to $PROFILE: Invoke-Expression (bahulam completion powershell | Out-String)\nRegister-ArgumentCompleter -Native -CommandName bahulam,bahulam-code -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })\n  bahulam __complete -- $words 2>$null | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
    default:
      throw new Error(`Unsupported shell '${shell}'. Choose: ${SHELLS.join(', ')}.`);
  }
}

export function supportedCompletionShells() {
  return [...SHELLS];
}
