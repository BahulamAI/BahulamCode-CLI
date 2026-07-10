import * as fs from 'node:fs';
import * as path from 'node:path';

const FILES = {
  'README.md': `# .kepler/ - project agent context

Kepler reads and writes here to keep state between sessions.

## Files Kepler writes
- \`plan.md\` - current agent plan
- \`goal.md\` - durable session goal
- \`tasks/\` - task list
- \`reports/*.md\` - end-of-turn mission reports
- \`sessions/*.jsonl\` - turn transcripts
- \`commands.log\` - command executions
- \`approvals.log\` - HITL decisions
- \`trust.json\` - approved patterns

## Files you can write
- \`config.json\` - project policy
- \`project.md\` - durable project context
- \`style.md\` - codebase conventions
- \`hitl.md\` - approval guidance
- \`skills/<name>/SKILL.md\` - reusable domain skills

Format v1. Markdown files are intentionally hand-editable.
`,
  'config.json': JSON.stringify({
    version: 1,
    context: {
      loadEveryTurn: ['KEPLER.md', 'project.md', 'style.md', 'goal.md', 'plan.md', 'tasks/*.md'],
      showReloadNotice: true,
    },
    planning: { owner: 'auto', onUserEditedPlan: 'prefer_user_plan' },
    tasks: { storage: 'project_markdown', syncTodoWrite: true, resumePrompt: true },
    hitl: {
      defaultScope: 'once',
      allowSessionTrust: true,
      allowProjectTrust: false,
      reaskAfterMinutes: 30,
    },
    commands: {
      enabled: ['map', 'probe', 'footprint', 'heal', 'align', 'distill', 'brief', 'rewind'],
      dryRunDefault: false,
    },
  }, null, 2) + '\n',
  'settings.json': JSON.stringify({
    env: {},
    permissions: {
      shellAllowlist: ['git', 'npm', 'pnpm'],
      editDenylist: ['**/*.env', 'secrets/**'],
    },
    hooks: {
      UserPromptSubmit: [],
      PreToolUse: [],
      PostToolUse: [],
      Stop: [],
    },
  }, null, 2) + '\n',
  'KEPLER.md': `# Project

## Quick Facts
- Stack:
- Test command:
- Lint command:
- Build command:

## Key Directories

## Code Style

## Critical Rules
`,
  'project.md': '# Project Context\n\nAdd durable project context here.\n',
  'style.md': '# Style\n\nAdd code and communication conventions here.\n',
  'hitl.md': '# HITL Guidance\n\nAdd project-specific approval guidance here.\n',
  'trust.json': JSON.stringify({ version: 1, rules: [] }, null, 2) + '\n',
  'tasks/README.md': `# Kepler Tasks

Checklist files are read every turn.

- \`backlog.md\` - pending tasks
- \`active.md\` - current task
- \`done.md\` - completed tasks
- \`blocked.md\` - waiting on input
`,
  'tasks/backlog.md': '# Backlog\n\n',
  'tasks/active.md': '# Active\n\n',
  'tasks/done.md': '# Done\n\n',
  'tasks/blocked.md': '# Blocked\n\n',
  'skills/starter/SKILL.md': `---
name: starter
description: Project-specific conventions and setup notes. Use when onboarding to this repo.
---

# Starter Skill

Add reusable project knowledge here.
`,
  'commands/onboard.md': `---
name: onboard
description: Explore the project and record onboarding notes.
---

# Onboard

Context:
$ARGUMENTS

Explore the codebase, ask clarifying questions, and record useful notes in .kepler/tasks/active.md.
`,
};

export function scaffoldKeplerProject({ cwd = process.cwd(), force = false } = {}) {
  const root = path.join(cwd, '.kepler');
  const written = [];
  const skipped = [];
  for (const [rel, content] of Object.entries(FILES)) {
    const filePath = path.join(root, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath) && !force) {
      skipped.push(filePath);
      continue;
    }
    fs.writeFileSync(filePath, content);
    written.push(filePath);
  }

  const gitignore = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignore) || force) {
    fs.writeFileSync(gitignore, 'settings.local.json\nsessions/\nreports/\n*.log\n');
    written.push(gitignore);
  }

  return { root, written, skipped };
}

export async function runInitCommand(args = [], { cwd = process.cwd() } = {}) {
  const force = args.includes('--force');
  const result = scaffoldKeplerProject({ cwd, force });
  process.stderr.write(`\x1b[32m✓\x1b[0m Initialized .kepler at ${result.root}\n`);
  process.stderr.write(`  wrote ${result.written.length} files`);
  if (result.skipped.length) process.stderr.write(`, skipped ${result.skipped.length} existing files`);
  process.stderr.write('\n');
}
