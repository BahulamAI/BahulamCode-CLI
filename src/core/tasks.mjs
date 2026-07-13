import * as fs from 'node:fs';
import * as path from 'node:path';

export const TASK_FILES = Object.freeze({
  active: 'active.md',
  backlog: 'backlog.md',
  blocked: 'blocked.md',
  done: 'done.md',
});

const DEFAULT_CONTENT = Object.freeze({
  'README.md': '# Kepler Tasks\n\nChecklist files are read every turn.\n',
  'active.md': '# Active\n\n',
  'backlog.md': '# Backlog\n\n',
  'blocked.md': '# Blocked\n\n',
  'done.md': '# Done\n\n',
});

export function ensureTaskFiles({ cwd = process.cwd() } = {}) {
  const dir = path.join(cwd, '.kepler', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, content] of Object.entries(DEFAULT_CONTENT)) {
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath)) continue;
    fs.writeFileSync(filePath, content);
    written.push(filePath);
  }
  return { dir, written };
}

export function loadTaskBoard({ cwd = process.cwd(), create = false } = {}) {
  const dir = path.join(cwd, '.kepler', 'tasks');
  if (create) ensureTaskFiles({ cwd });
  const lists = {};
  for (const [list, fileName] of Object.entries(TASK_FILES)) {
    const filePath = path.join(dir, fileName);
    const content = readText(filePath);
    lists[list] = {
      list,
      fileName,
      path: filePath,
      exists: fs.existsSync(filePath),
      content,
      tasks: parseTaskMarkdown(content, list),
    };
  }

  const planPath = path.join(cwd, '.kepler', 'plan.md');
  const goalPath = path.join(cwd, '.kepler', 'goal.md');
  return {
    dir,
    lists,
    plan: { path: planPath, exists: fs.existsSync(planPath), content: readText(planPath) },
    goal: { path: goalPath, exists: fs.existsSync(goalPath), content: readText(goalPath) },
  };
}

export function appendTask({ cwd = process.cwd(), list = 'backlog', text }) {
  const normalized = normalizeList(list);
  const taskText = String(text || '').trim();
  if (!taskText) throw new Error('Task text is required');
  const { dir } = ensureTaskFiles({ cwd });
  const filePath = path.join(dir, TASK_FILES[normalized]);
  const prefix = normalized === 'done' ? '- [x]' : '- [ ]';
  fs.appendFileSync(filePath, `${prefix} ${taskText}\n`);
  return { list: normalized, path: filePath, text: taskText };
}

export function taskCounts(board) {
  const lists = board?.lists || {};
  return Object.fromEntries(
    Object.entries(TASK_FILES).map(([list]) => [list, lists[list]?.tasks?.length || 0]),
  );
}

function normalizeList(value) {
  const key = String(value || '').toLowerCase();
  if (key === 'todo' || key === 'pending') return 'backlog';
  if (key === 'current' || key === 'doing') return 'active';
  if (key === 'complete' || key === 'completed') return 'done';
  if (key in TASK_FILES) return key;
  throw new Error(`Unknown task list: ${value}`);
}

function readText(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  } catch {
    return '';
  }
}

export function parseTaskMarkdown(content, list = 'backlog') {
  const tasks = [];
  let section = '';
  const lines = String(content || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }

    const checkbox = line.match(/^\s*[-*]\s+\[([ xX!-])\]\s+(.+?)\s*$/);
    if (checkbox) {
      tasks.push({
        list,
        line: i + 1,
        section,
        checked: checkbox[1].toLowerCase() === 'x',
        text: checkbox[2].trim(),
      });
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet && !bullet[1].startsWith('`')) {
      tasks.push({
        list,
        line: i + 1,
        section,
        checked: list === 'done',
        text: bullet[1].trim(),
      });
    }
  }
  return tasks;
}
