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
  const dir = path.join(cwd, '.bahulam', 'tasks');
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
  const dir = path.join(cwd, '.bahulam', 'tasks');
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

  const planPath = path.join(cwd, '.bahulam', 'plan.md');
  const goalPath = path.join(cwd, '.bahulam', 'goal.md');
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

export function updateTask({ cwd = process.cwd(), list = 'active', index, text, checked } = {}) {
  const normalized = normalizeList(list);
  const taskIndex = normalizeTaskIndex(index);
  ensureTaskFiles({ cwd });
  const filePath = taskFilePath(cwd, normalized);
  const content = readText(filePath);
  const tasks = parseTaskMarkdown(content, normalized);
  const task = tasks[taskIndex - 1];
  if (!task) throw new Error(`No task ${taskIndex} in ${normalized}`);

  const lines = content.split(/\r?\n/);
  const nextText = String(text ?? task.text).trim();
  if (!nextText) throw new Error('Task text is required');
  const nextChecked = checked === undefined ? task.checked : Boolean(checked);
  lines[task.line - 1] = taskLine(nextText, normalized, nextChecked);
  fs.writeFileSync(filePath, lines.join('\n'));
  return { list: normalized, path: filePath, index: taskIndex, previous: task, text: nextText, checked: nextChecked };
}

export function removeTask({ cwd = process.cwd(), list = 'active', index } = {}) {
  const normalized = normalizeList(list);
  const taskIndex = normalizeTaskIndex(index);
  ensureTaskFiles({ cwd });
  const filePath = taskFilePath(cwd, normalized);
  const content = readText(filePath);
  const tasks = parseTaskMarkdown(content, normalized);
  const task = tasks[taskIndex - 1];
  if (!task) throw new Error(`No task ${taskIndex} in ${normalized}`);

  const lines = content.split(/\r?\n/);
  lines.splice(task.line - 1, 1);
  fs.writeFileSync(filePath, lines.join('\n'));
  return { list: normalized, path: filePath, index: taskIndex, task };
}

export function moveTask({ cwd = process.cwd(), from = 'active', index, to = 'done', text } = {}) {
  const source = normalizeList(from);
  const target = normalizeList(to);
  const removed = removeTask({ cwd, list: source, index });
  const taskText = String(text ?? removed.task.text).trim();
  const appended = appendTask({ cwd, list: target, text: taskText });
  return {
    from: source,
    to: target,
    index: removed.index,
    text: taskText,
    sourcePath: removed.path,
    targetPath: appended.path,
  };
}

export function taskCounts(board) {
  const lists = board?.lists || {};
  return Object.fromEntries(
    Object.entries(TASK_FILES).map(([list]) => [list, lists[list]?.tasks?.length || 0]),
  );
}

export function normalizeList(value) {
  const key = String(value || '').toLowerCase();
  if (key === 'todo' || key === 'pending') return 'backlog';
  if (key === 'current' || key === 'doing') return 'active';
  if (key === 'complete' || key === 'completed') return 'done';
  if (key in TASK_FILES) return key;
  throw new Error(`Unknown task list: ${value}`);
}

function normalizeTaskIndex(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error('Task index must be a positive number');
  return n;
}

function taskFilePath(cwd, list) {
  return path.join(cwd, '.bahulam', 'tasks', TASK_FILES[list]);
}

function taskLine(text, list, checked = false) {
  const mark = checked || list === 'done' ? 'x' : ' ';
  return `- [${mark}] ${text}`;
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
