/**
 * Workspace-bounded file access for the local service.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;

export function resolveWorkspacePath(session, requestedPath = '.') {
  if (!session?.root_path) throw new Error('session.root_path is required');
  const root = fs.realpathSync(session.root_path);
  let rel = String(requestedPath || '.').trim();
  if (!rel || rel === '/') rel = '.';
  rel = rel.replace(/^[/\\]+/, '');

  const candidate = path.resolve(root, rel);
  let canonical;
  try {
    canonical = fs.realpathSync(candidate);
  } catch {
    canonical = realpathForMissing(candidate);
  }

  if (!isWithin(root, canonical)) {
    const err = new Error('Path is outside the granted workspace root');
    err.code = 'OUTSIDE_WORKSPACE';
    throw err;
  }

  return canonical;
}

export function listWorkspacePath(session, requestedPath = '.', { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const target = resolveWorkspacePath(session, requestedPath);
  const stat = fs.statSync(target);
  const root = fs.realpathSync(session.root_path);

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((entry) => !shouldHideEntry(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, maxEntries)
      .map((entry) => {
        const fullPath = path.join(target, entry.name);
        let childStat = null;
        try {
          childStat = fs.statSync(fullPath);
        } catch {}
        return {
          name: entry.name,
          path: normalizeRelative(root, fullPath),
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          size: childStat?.size ?? null,
          updated_at: childStat?.mtime ? childStat.mtime.toISOString() : null,
        };
      });

    return {
      ok: true,
      type: 'directory',
      path: normalizeRelative(root, target),
      entries,
      truncated: entries.length >= maxEntries,
    };
  }

  if (stat.isFile()) {
    return {
      ok: true,
      type: 'file',
      path: normalizeRelative(root, target),
      file: describeFile(root, target, stat),
      preview: readTextPreview(target),
    };
  }

  return {
    ok: false,
    type: 'other',
    path: normalizeRelative(root, target),
    error: 'Unsupported filesystem entry',
  };
}

export function readWorkspaceFile(session, requestedPath, { maxBytes = DEFAULT_MAX_TEXT_BYTES } = {}) {
  const target = resolveWorkspacePath(session, requestedPath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    const err = new Error('Requested path is not a file');
    err.code = 'NOT_FILE';
    throw err;
  }
  if (stat.size > maxBytes) {
    const err = new Error(`File is larger than ${maxBytes} bytes`);
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  return fs.readFileSync(target);
}

function describeFile(root, target, stat) {
  return {
    name: path.basename(target),
    path: normalizeRelative(root, target),
    size: stat.size,
    updated_at: stat.mtime.toISOString(),
    extension: path.extname(target).slice(1).toLowerCase(),
    text_like: isTextLike(target),
  };
}

function readTextPreview(target) {
  if (!isTextLike(target)) return null;
  try {
    const fd = fs.openSync(target, 'r');
    try {
      const buf = Buffer.alloc(DEFAULT_MAX_TEXT_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const content = buf.subarray(0, bytesRead).toString('utf-8');
      if (content.includes('\u0000')) return null;
      return {
        content,
        truncated: fs.statSync(target).size > bytesRead,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function isTextLike(target) {
  const ext = path.extname(target).toLowerCase();
  return [
    '',
    '.txt', '.md', '.mdx', '.json', '.jsonl', '.yaml', '.yml', '.toml',
    '.csv', '.tsv', '.xml', '.html', '.css', '.js', '.mjs', '.cjs',
    '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
    '.c', '.cpp', '.h', '.hpp', '.sh', '.sql', '.log', '.ini',
  ].includes(ext);
}

function shouldHideEntry(name) {
  return ['node_modules', '.git', '.next', 'dist', 'build', '__pycache__'].includes(name);
}

function normalizeRelative(root, target) {
  const rel = path.relative(root, target);
  return rel ? rel.split(path.sep).join('/') : '.';
}

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathForMissing(candidate) {
  let current = candidate;
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}
