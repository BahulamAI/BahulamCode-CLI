import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function readIfExists(filePath, maxChars = 12000) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      path: filePath,
      content: content.length > maxChars
        ? content.slice(0, maxChars) + '\n\n[...truncated...]'
        : content,
    };
  } catch {
    return null;
  }
}

export function loadKeplerMemory({ cwd = process.cwd() } = {}) {
  const files = [];
  const global = readIfExists(path.join(os.homedir(), '.kepler', 'KEPLER.md'));
  if (global) files.push({ source: 'global', ...global });

  const topLevel = readIfExists(path.join(cwd, 'KEPLER.md'));
  if (topLevel) files.push({ source: 'project-top-level', ...topLevel });

  const project = readIfExists(path.join(cwd, '.kepler', 'KEPLER.md'));
  if (project) files.push({ source: 'project', ...project });

  return files;
}
