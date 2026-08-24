/**
 * Slash Commands — canonical catalog + input normalizer.
 *
 * This module is the ONE source of truth for the REPL's slash commands.
 * Consumers:
 *   - src/terminal/repl.mjs imports COMMANDS, HELP_GROUPS, etc. for its
 *     runtime dispatch and slash-hint suggestions.
 *   - src/index.mjs iterates COMMANDS for `bahulam-code --help` output.
 *
 * The runtime *handlers* live in repl.mjs (they need session/ctx access
 * that only the REPL has). This module is data-only + pure normalization.
 */

// name -> one-line description (bare string).
export const COMMANDS = {
  '/help':        'Show commands',
  '/login':       'Sign in via browser',
  '/whoami':      'Show logged-in user',
  '/status':      'Session status & system info',
  '/plan':        'Show plan/tasks',
  '/tasks':       'Show or update project tasks',
  '/stats':       'Progress bars & metrics',
  '/new':         'Start a new session',
  '/clear':       'Clear conversation',
  '/git':         'Git status',
  '/diff':        'Git diff',
  '/cost':        'Show session cost',
  '/model':       'Show or set session model overrides',
  '/attach':      'Attach image path or clipboard image to next prompt',
  '/attachments': 'List or clear pending image attachments',
  '/history':     'Show conversation',
  '/settings':    'Show policy/settings',
  '/last':        'Expand last tool output',
  '/expand':      'Expand tool output by index (or "all")',
  '/fold':        'Hide previously expanded tool output',
  '/checkpoint':  'List recent file checkpoints',
  '/undo':        'Restore the last file checkpoint',
  '/preflight':   'Re-run the onboarding diagnostic',
  '/report':      'Save the mission report as markdown',
  '/why':         'Print the agent reasoning for the last decision',
  '/map':         'Show the registered project tree',
  '/budget':      'Set / clear a hard session cost cap',
  '/quiet':       'Verbosity: hide sub-agent inner tools',
  '/verbose':     'Verbosity: show sub-agent inner tools',
  '/surgical':    'Verbosity: show everything (reasoning, expanded tools)',
  '/compact':     'Compact conversation context',
  '/agents':      'List available agents',
  '/subagents':   'Alias of /agents (list/create/edit/sync sub-agents)',
  '/skills':      'List / install / view / remove skills (SKILL.md bundles)',
  '/run':         'Run a sub-agent or synced workflow',
  '/explore':     'Code explorer agent',
  '/review':      'Code review agent',
  '/architect':   'Feature architect agent',
  '/safety':      'Show safety guardrail status',
  '/auto':        'Session autopilot: `/auto` routine-only · `/auto full` everything · `/auto off`',
  '/approvals':   'List or edit session approval grants (`/approvals clear` revokes all)',
  '/resume':      'Resume a previous session',
  '/sessions':    'List resumable sessions',
  '/logout':      'Sign out and clear credentials',
  '/exit':        'Exit CLI',
};

// Grouped view for the `/help` interactive display. Each entry is
// [command-with-args, description] so subcommands appear inline.
export const HELP_GROUPS = [
  {
    key: 'plan',
    title: 'Plan',
    summary: 'plan and project tasks',
    commands: [
      ['/plan', 'Plan and task overview'],
      ['/plan status', 'Plan owner and task files'],
      ['/plan edit', 'Show editable task/plan paths'],
      ['/tasks', 'List project tasks'],
      ['/tasks add <text>', 'Add backlog task'],
      ['/tasks active|blocked|done <text>', 'Append to a task list'],
    ],
  },
  {
    key: 'status',
    title: 'Status',
    summary: 'session, usage, budget',
    commands: [
      ['/status', 'Session snapshot'],
      ['/status context', 'Loaded .bahulam context'],
      ['/status metrics', 'Progress bars and runtime metrics'],
      ['/status cost', 'Credits and message window'],
      ['/model [role] [model]', 'Show or set session model override'],
      ['/attach <image>', 'Attach image to the next prompt'],
      ['/attach clipboard', 'Attach image currently copied to macOS/Windows clipboard'],
      ['/attachments', 'List pending image attachments'],
      ['/attachments clear', 'Clear pending image attachments'],
      ['/status budget <amount|clear>', 'Set or clear session budget'],
    ],
  },
  {
    key: 'history',
    title: 'History',
    summary: 'transcript, reports, undo',
    commands: [
      ['/history', 'Recent transcript'],
      ['/history approvals', 'Approval log'],
      ['/history last', 'Expand last tool output'],
      ['/history expand [n|all]', 'Expand tool output'],
      ['/history checkpoint', 'List checkpoints'],
      ['/history undo', 'Restore latest checkpoint'],
      ['/history report', 'Save mission report'],
    ],
  },
  {
    key: 'settings',
    title: 'Settings',
    summary: 'auth, policy, verbosity',
    commands: [
      ['/settings policy', 'Effective project policy'],
      ['/settings login', 'Sign in'],
      ['/settings logout', 'Sign out'],
      ['/settings whoami', 'Current user'],
      ['/settings quiet|verbose|surgical', 'Verbosity'],
    ],
  },
  {
    key: 'worktree',
    title: 'Worktree',
    summary: 'git and files',
    commands: [
      ['/git', 'Git status'],
      ['/diff', 'Git diff'],
      ['/map', 'Registered project tree'],
      ['/preflight', 'Onboarding diagnostic'],
      ['/safety', 'Safety guardrail status'],
    ],
  },
  {
    key: 'agents',
    title: 'Agents',
    summary: 'specialist modes',
    commands: [
      ['/agents', 'List built-in and local agents'],
      ['/agents create <name>', 'Create .bahulam/agents/<name>.yaml'],
      ['/agents edit <name>', 'Open local agent YAML'],
      ['/agents sync [name]', 'Sync all or one local agent to cloud'],
      ['/run <agent> [instruction]', 'Run a local or built-in agent'],
      ['/explore <instruction>', 'Explore code'],
      ['/review <instruction>', 'Review code'],
      ['/architect <instruction>', 'Design an approach'],
    ],
  },
  {
    key: 'skills',
    title: 'Skills',
    summary: 'SKILL.md bundles',
    commands: [
      ['/skills', 'List installed skills'],
      ['/skills install <url|path>', 'Install from Git URL or local directory'],
      ['/skills install <src> --project', 'Install into .bahulam/skills (project scope)'],
      ['/skills install <src> --force', 'Overwrite an existing skill'],
      ['/skills view <name> [resource]', 'Show SKILL.md or a bundled resource'],
      ['/skills remove <name>', 'Uninstall a skill'],
      ['/skills update <name>', 'Reinstall from the recorded source'],
    ],
  },
  {
    key: 'workflows',
    title: 'Workflows',
    summary: 'saved automations',
    commands: [
      ['/run <workflow> [instruction]', 'Run a synced workflow if no agent matches'],
    ],
  },
  {
    key: 'session',
    title: 'Session',
    summary: 'resume and clear',
    commands: [
      ['/sessions', 'List resumable sessions'],
      ['/resume [id]', 'Resume a session'],
      ['/compact', 'Compact conversation context'],
      ['/new', 'Start a fresh session'],
      ['/clear', 'Clear conversation'],
      ['/exit', 'Exit CLI'],
    ],
  },
];

export const HELP_GROUP_ALIASES = new Map(
  HELP_GROUPS.flatMap(group => [[group.key, group], [group.title.toLowerCase(), group]])
);

// Old flat commands that the user might still type. Map them to the new
// namespaced form so completion + help nudge them toward the current UX.
export const LEGACY_COMMAND_HINTS = {
  '/stats':      '/status metrics',
  '/cost':       '/status cost',
  '/budget':     '/status budget',
  '/last':       '/history last',
  '/expand':     '/history expand',
  '/fold':       '/history fold',
  '/undo':       '/history undo',
  '/checkpoint': '/history checkpoint',
  '/report':     '/history report',
  '/login':      '/settings login',
  '/logout':     '/settings logout',
  '/whoami':     '/settings whoami',
  '/quiet':      '/settings quiet',
  '/verbose':    '/settings verbose',
  '/surgical':   '/settings surgical',
};

// Namespaced subcommands. `/status metrics` -> `/stats`, etc.
export const NAMESPACED_COMMANDS = {
  '/status': {
    metrics: '/stats',
    stats:   '/stats',
    cost:    '/cost',
    credits: '/cost',
    budget:  '/budget',
  },
  '/history': {
    last:        '/last',
    expand:      '/expand',
    fold:        '/fold',
    undo:        '/undo',
    checkpoint:  '/checkpoint',
    checkpoints: '/checkpoint',
    report:      '/report',
  },
  '/settings': {
    login:    '/login',
    logout:   '/logout',
    whoami:   '/whoami',
    quiet:    '/quiet',
    verbose:  '/verbose',
    surgical: '/surgical',
  },
};

/**
 * Normalize a raw slash-command input like "/status metrics arg" into
 * { cmd: '/stats', rest: 'arg', rawCmd, aliasTarget }, resolving legacy
 * aliases and namespaced subcommands to their canonical form.
 *
 * - `rawCmd`      the lower-cased first token as the user typed it
 * - `cmd`         the canonical command (namespaced hit if any, else rawCmd)
 * - `rest`        the remaining args joined with spaces
 * - `aliasTarget` for legacy flat commands, the new namespaced form to
 *                 suggest to the user (null when not aliased)
 */
export function normalizeCommandInput(input) {
  const parts = String(input || '').trim().split(/\s+/).filter(Boolean);
  const rawCmd = (parts[0] || '').toLowerCase();
  const restParts = parts.slice(1);
  const sub = (restParts[0] || '').toLowerCase();
  const namespaced = NAMESPACED_COMMANDS[rawCmd]?.[sub];
  if (namespaced) {
    return {
      cmd: namespaced,
      rest: restParts.slice(1).join(' '),
      rawCmd,
      aliasTarget: null,
    };
  }
  return {
    cmd: rawCmd,
    rest: restParts.join(' '),
    rawCmd,
    aliasTarget: LEGACY_COMMAND_HINTS[rawCmd] || null,
  };
}
