import * as fs from 'node:fs';
import * as path from 'node:path';
import { bahulamHome, projectConfigDir } from '../core/paths.mjs';

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

function readMemoryFile(dir, maxChars) {
  return readIfExists(path.join(dir, 'BAHULAM.md'), maxChars);
}

export function loadBahulamMemory({ cwd = process.cwd() } = {}) {
  const files = [];
  const global = readMemoryFile(bahulamHome());
  if (global) files.push({ source: 'global', ...global });

  const topLevel = readMemoryFile(cwd);
  if (topLevel) files.push({ source: 'project-top-level', ...topLevel });

  const project = readMemoryFile(projectConfigDir(cwd));
  if (project) files.push({ source: 'project', ...project });

  return files;
}
