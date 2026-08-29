import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadBahulamMemory } from '../config/memory-loader.mjs';
import { bahulamHome, projectConfigDir } from './paths.mjs';

function sha(content) {
  return crypto.createHash('sha256').update(content || '').digest('hex').slice(0, 12);
}

function readFile(filePath, label, maxChars = 12000) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      label,
      path: filePath,
      hash: sha(content),
      bytes: Buffer.byteLength(content),
      content: content.length > maxChars
        ? content.slice(0, maxChars) + '\n\n[...truncated...]'
        : content,
      truncated: content.length > maxChars,
    };
  } catch (err) {
    return { label, path: filePath, error: err.message, content: '' };
  }
}

function readTasks(bahulamDir) {
  const tasksDir = path.join(bahulamDir, 'tasks');
  const files = [];
  try {
    if (!fs.existsSync(tasksDir)) return files;
    for (const name of fs.readdirSync(tasksDir).sort()) {
      if (!name.endsWith('.md')) continue;
      const file = readFile(path.join(tasksDir, name), `tasks/${name}`, 6000);
      if (file) files.push(file);
    }
  } catch { /* best effort */ }
  return files;
}

function scanSkills(dir, scope) {
  const skillsDir = path.join(dir, 'skills');
  const out = [];
  try {
    if (!fs.existsSync(skillsDir)) return out;
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      let filePath = null;
      let name = entry.name;
      if (entry.isDirectory()) filePath = path.join(skillsDir, entry.name, 'SKILL.md');
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        filePath = path.join(skillsDir, entry.name);
        name = entry.name.replace(/\.md$/, '');
      }
      if (!filePath || !fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const desc = raw.match(/^description:\s*(.+)$/mi)?.[1]?.trim()
        || raw.match(/^#\s+.+\n+([^\n]+)/)?.[1]?.trim()
        || '';
      out.push({ name, description: desc, scope, source_id: `${scope}:${name}`, path: filePath });
    }
  } catch { /* best effort */ }
  return out;
}

export function loadProjectContext({ cwd = process.cwd(), previous = null } = {}) {
  const bahulamDir = projectConfigDir(cwd);
  const files = [];
  for (const file of loadBahulamMemory({ cwd })) {
    const label = file.path.endsWith(path.join('.bahulam', 'KEPLER.md'))
      ? 'KEPLER.md'
      : path.basename(file.path);
    files.push({
      label,
      source: file.source,
      path: file.path,
      hash: sha(file.content),
      bytes: Buffer.byteLength(file.content),
      content: file.content,
    });
  }

  for (const name of ['config.json', 'project.md', 'style.md', 'goal.md', 'plan.md', 'hitl.md']) {
    const file = readFile(path.join(bahulamDir, name), name, name.endsWith('.json') ? 4000 : 12000);
    if (file) files.push(file);
  }
  files.push(...readTasks(bahulamDir));

  const previousHashes = new Map((previous?.files || []).map(f => [f.path, f.hash]));
  const changed = files.filter(f => f.hash && previousHashes.get(f.path) && previousHashes.get(f.path) !== f.hash);
  const loaded = files.filter(f => !f.error).map(f => ({
    label: f.label,
    path: f.path,
    hash: f.hash,
    bytes: f.bytes,
    source: f.source || 'project',
    included: true,
    changed: changed.some(c => c.path === f.path),
  }));

  const skills = [
    ...scanSkills(bahulamHome(), 'global'),
    ...scanSkills(bahulamDir, 'project'),
  ];
  const byName = new Map();
  for (const skill of skills) byName.set(skill.name, skill);

  return {
    root: cwd,
    kepler_dir: bahulamDir,
    files,
    loaded,
    changed,
    available_skills: [...byName.values()],
    task_state: files
      .filter(f => f.label.startsWith('tasks/'))
      .map(f => ({ name: f.label.replace('tasks/', ''), hash: f.hash, content: f.content })),
    loaded_at: new Date().toISOString(),
  };
}

export function contextToPromptBlock(context) {
  const parts = [];
  if (context?.root) {
    parts.push([
      '--- task workflow ---',
      'Keep .bahulam/tasks/active.md current for the work in progress.',
      'Use .bahulam/tasks/backlog.md for deferred work, .bahulam/tasks/blocked.md for items waiting on input, and .bahulam/tasks/done.md for completed work.',
      'When the task state changes materially, update the appropriate task markdown file before the turn finishes.',
    ].join('\n'));
  }
  for (const file of context?.files || []) {
    if (!file.content || file.label === 'config.json') continue;
    parts.push(`--- ${file.label} (${file.hash}) ---\n${file.content}`);
  }
  return parts.join('\n\n');
}
