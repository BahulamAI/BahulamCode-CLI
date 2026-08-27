/**
 * Workspace-bounded file access for the local service.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;
export const DEFAULT_MAX_RAW_BYTES = 100 * 1024 * 1024;

const EXACT_FILE_TYPES = new Map([
  ['dockerfile', { kind: 'code', language: 'dockerfile', label: 'Dockerfile', textLike: true }],
  ['containerfile', { kind: 'code', language: 'dockerfile', label: 'Containerfile', textLike: true }],
  ['makefile', { kind: 'code', language: 'makefile', label: 'Makefile', textLike: true }],
  ['rakefile', { kind: 'code', language: 'ruby', label: 'Ruby', textLike: true }],
  ['gemfile', { kind: 'code', language: 'ruby', label: 'Ruby', textLike: true }],
  ['pipfile', { kind: 'config', language: 'toml', label: 'TOML', textLike: true }],
  ['requirements.txt', { kind: 'config', language: 'plaintext', label: 'Requirements', textLike: true }],
  ['package.json', { kind: 'config', language: 'json', label: 'JSON', textLike: true }],
  ['tsconfig.json', { kind: 'config', language: 'json', label: 'JSON', textLike: true }],
  ['.gitignore', { kind: 'config', language: 'plaintext', label: 'Git Ignore', textLike: true }],
  ['.dockerignore', { kind: 'config', language: 'plaintext', label: 'Docker Ignore', textLike: true }],
]);

const EXTENSION_FILE_TYPES = new Map([
  ['txt', { kind: 'text', language: 'plaintext', label: 'Text', textLike: true }],
  ['log', { kind: 'text', language: 'plaintext', label: 'Log', textLike: true }],
  ['md', { kind: 'markdown', language: 'markdown', label: 'Markdown', textLike: true }],
  ['mdx', { kind: 'markdown', language: 'markdown', label: 'MDX', textLike: true }],
  ['mmd', { kind: 'mermaid', language: 'markdown', label: 'Mermaid', textLike: true }],
  ['mermaid', { kind: 'mermaid', language: 'markdown', label: 'Mermaid', textLike: true }],
  ['drawio', { kind: 'drawio', language: 'xml', label: 'Draw.io', textLike: true }],
  ['dio', { kind: 'drawio', language: 'xml', label: 'Draw.io', textLike: true }],
  ['json', { kind: 'config', language: 'json', label: 'JSON', textLike: true }],
  ['jsonl', { kind: 'config', language: 'json', label: 'JSONL', textLike: true }],
  ['yaml', { kind: 'config', language: 'yaml', label: 'YAML', textLike: true }],
  ['yml', { kind: 'config', language: 'yaml', label: 'YAML', textLike: true }],
  ['toml', { kind: 'config', language: 'toml', label: 'TOML', textLike: true }],
  ['ini', { kind: 'config', language: 'ini', label: 'INI', textLike: true }],
  ['env', { kind: 'config', language: 'plaintext', label: 'Environment', textLike: true }],
  ['properties', { kind: 'config', language: 'plaintext', label: 'Properties', textLike: true }],
  ['xml', { kind: 'code', language: 'xml', label: 'XML', textLike: true }],
  ['html', { kind: 'code', language: 'html', label: 'HTML', textLike: true }],
  ['htm', { kind: 'code', language: 'html', label: 'HTML', textLike: true }],
  ['css', { kind: 'code', language: 'css', label: 'CSS', textLike: true }],
  ['scss', { kind: 'code', language: 'scss', label: 'SCSS', textLike: true }],
  ['sass', { kind: 'code', language: 'scss', label: 'Sass', textLike: true }],
  ['less', { kind: 'code', language: 'less', label: 'Less', textLike: true }],
  ['js', { kind: 'code', language: 'javascript', label: 'JavaScript', textLike: true }],
  ['mjs', { kind: 'code', language: 'javascript', label: 'JavaScript', textLike: true }],
  ['cjs', { kind: 'code', language: 'javascript', label: 'JavaScript', textLike: true }],
  ['jsx', { kind: 'code', language: 'javascript', label: 'JavaScript JSX', textLike: true }],
  ['ts', { kind: 'code', language: 'typescript', label: 'TypeScript', textLike: true }],
  ['tsx', { kind: 'code', language: 'typescript', label: 'TypeScript JSX', textLike: true }],
  ['vue', { kind: 'code', language: 'html', label: 'Vue', textLike: true }],
  ['svelte', { kind: 'code', language: 'html', label: 'Svelte', textLike: true }],
  ['py', { kind: 'code', language: 'python', label: 'Python', textLike: true }],
  ['rb', { kind: 'code', language: 'ruby', label: 'Ruby', textLike: true }],
  ['go', { kind: 'code', language: 'go', label: 'Go', textLike: true }],
  ['rs', { kind: 'code', language: 'rust', label: 'Rust', textLike: true }],
  ['java', { kind: 'code', language: 'java', label: 'Java', textLike: true }],
  ['kt', { kind: 'code', language: 'kotlin', label: 'Kotlin', textLike: true }],
  ['kts', { kind: 'code', language: 'kotlin', label: 'Kotlin', textLike: true }],
  ['swift', { kind: 'code', language: 'swift', label: 'Swift', textLike: true }],
  ['c', { kind: 'code', language: 'c', label: 'C', textLike: true }],
  ['h', { kind: 'code', language: 'c', label: 'C Header', textLike: true }],
  ['cpp', { kind: 'code', language: 'cpp', label: 'C++', textLike: true }],
  ['cc', { kind: 'code', language: 'cpp', label: 'C++', textLike: true }],
  ['cxx', { kind: 'code', language: 'cpp', label: 'C++', textLike: true }],
  ['hpp', { kind: 'code', language: 'cpp', label: 'C++ Header', textLike: true }],
  ['cs', { kind: 'code', language: 'csharp', label: 'C#', textLike: true }],
  ['php', { kind: 'code', language: 'php', label: 'PHP', textLike: true }],
  ['dart', { kind: 'code', language: 'dart', label: 'Dart', textLike: true }],
  ['scala', { kind: 'code', language: 'scala', label: 'Scala', textLike: true }],
  ['r', { kind: 'code', language: 'r', label: 'R', textLike: true }],
  ['lua', { kind: 'code', language: 'lua', label: 'Lua', textLike: true }],
  ['pl', { kind: 'code', language: 'perl', label: 'Perl', textLike: true }],
  ['ex', { kind: 'code', language: 'elixir', label: 'Elixir', textLike: true }],
  ['exs', { kind: 'code', language: 'elixir', label: 'Elixir', textLike: true }],
  ['clj', { kind: 'code', language: 'clojure', label: 'Clojure', textLike: true }],
  ['fs', { kind: 'code', language: 'fsharp', label: 'F#', textLike: true }],
  ['jl', { kind: 'code', language: 'julia', label: 'Julia', textLike: true }],
  ['zig', { kind: 'code', language: 'plaintext', label: 'Zig', textLike: true }],
  ['sh', { kind: 'code', language: 'shell', label: 'Shell', textLike: true }],
  ['bash', { kind: 'code', language: 'shell', label: 'Bash', textLike: true }],
  ['zsh', { kind: 'code', language: 'shell', label: 'Zsh', textLike: true }],
  ['fish', { kind: 'code', language: 'shell', label: 'Fish', textLike: true }],
  ['ps1', { kind: 'code', language: 'powershell', label: 'PowerShell', textLike: true }],
  ['bat', { kind: 'code', language: 'bat', label: 'Batch', textLike: true }],
  ['cmd', { kind: 'code', language: 'bat', label: 'Batch', textLike: true }],
  ['sql', { kind: 'code', language: 'sql', label: 'SQL', textLike: true }],
  ['graphql', { kind: 'code', language: 'graphql', label: 'GraphQL', textLike: true }],
  ['gql', { kind: 'code', language: 'graphql', label: 'GraphQL', textLike: true }],
  ['proto', { kind: 'code', language: 'protobuf', label: 'Protocol Buffers', textLike: true }],
  ['tf', { kind: 'code', language: 'hcl', label: 'Terraform', textLike: true }],
  ['hcl', { kind: 'code', language: 'hcl', label: 'HCL', textLike: true }],
  ['dax', { kind: 'code', language: 'msdax', label: 'DAX', textLike: true }],
  ['pq', { kind: 'code', language: 'powerquery', label: 'Power Query', textLike: true }],
  ['m', { kind: 'code', language: 'powerquery', label: 'Power Query', textLike: true }],
  ['lookml', { kind: 'code', language: 'plaintext', label: 'LookML', textLike: true }],
  ['csv', { kind: 'table', language: 'csv', label: 'CSV', textLike: true }],
  ['tsv', { kind: 'table', language: 'plaintext', label: 'TSV', textLike: true }],
  ['png', { kind: 'image', language: null, label: 'PNG Image', textLike: false }],
  ['jpg', { kind: 'image', language: null, label: 'JPEG Image', textLike: false }],
  ['jpeg', { kind: 'image', language: null, label: 'JPEG Image', textLike: false }],
  ['gif', { kind: 'image', language: null, label: 'GIF Image', textLike: false }],
  ['webp', { kind: 'image', language: null, label: 'WebP Image', textLike: false }],
  ['svg', { kind: 'image', language: 'xml', label: 'SVG Image', textLike: false }],
  ['bmp', { kind: 'image', language: null, label: 'Bitmap Image', textLike: false }],
  ['ico', { kind: 'image', language: null, label: 'Icon', textLike: false }],
  ['pdf', { kind: 'pdf', language: null, label: 'PDF', textLike: false }],
  ['xlsx', { kind: 'spreadsheet', language: null, label: 'Excel Workbook', textLike: false }],
  ['xls', { kind: 'spreadsheet', language: null, label: 'Excel Workbook', textLike: false }],
  ['ods', { kind: 'spreadsheet', language: null, label: 'Spreadsheet', textLike: false }],
  ['docx', { kind: 'document', language: null, label: 'Word Document', textLike: false }],
  ['doc', { kind: 'document', language: null, label: 'Word Document', textLike: false }],
  ['odt', { kind: 'document', language: null, label: 'Document', textLike: false }],
  ['pptx', { kind: 'presentation', language: null, label: 'PowerPoint', textLike: false }],
  ['ppt', { kind: 'presentation', language: null, label: 'PowerPoint', textLike: false }],
  ['odp', { kind: 'presentation', language: null, label: 'Presentation', textLike: false }],
]);

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

export function describeWorkspaceFileName(filePath) {
  const name = path.basename(String(filePath || ''));
  const lowerName = name.toLowerCase();
  const ext = path.extname(name).slice(1).toLowerCase();
  const exact = EXACT_FILE_TYPES.get(lowerName);
  if (exact) return fileTypeResult(ext, exact);
  const byExtension = EXTENSION_FILE_TYPES.get(ext);
  if (byExtension) return fileTypeResult(ext, byExtension);
  if (!ext) {
    return fileTypeResult('', {
      kind: 'text',
      language: 'plaintext',
      label: 'Text',
      textLike: true,
    });
  }
  return fileTypeResult(ext, {
    kind: 'binary',
    language: null,
    label: `${ext.toUpperCase()} File`,
    textLike: false,
  });
}

export function contentTypeForPath(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    case 'ico': return 'image/x-icon';
    case 'pdf': return 'application/pdf';
    case 'txt':
    case 'log':
    case 'md':
    case 'mdx':
    case 'mmd':
    case 'mermaid':
    case 'drawio':
    case 'dio':
    case 'json':
    case 'jsonl':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'csv':
    case 'tsv':
    case 'xml':
    case 'html':
    case 'htm':
    case 'css':
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'py':
    case 'rb':
    case 'go':
    case 'rs':
    case 'java':
    case 'sh':
    case 'sql':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function describeFile(root, target, stat) {
  const type = describeWorkspaceFileName(target);
  return {
    name: path.basename(target),
    path: normalizeRelative(root, target),
    size: stat.size,
    updated_at: stat.mtime.toISOString(),
    extension: path.extname(target).slice(1).toLowerCase(),
    text_like: type.textLike,
    kind: type.kind,
    viewer: type.viewer,
    language: type.language,
    label: type.label,
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
  return describeWorkspaceFileName(target).textLike;
}

function fileTypeResult(extension, info) {
  return {
    extension,
    kind: info.kind,
    viewer: viewerForKind(info.kind),
    language: info.language,
    label: info.label,
    textLike: Boolean(info.textLike),
  };
}

function viewerForKind(kind) {
  switch (kind) {
    case 'markdown': return 'markdown';
    case 'mermaid': return 'mermaid';
    case 'drawio': return 'drawio';
    case 'image': return 'image';
    case 'pdf': return 'pdf';
    case 'spreadsheet': return 'spreadsheet';
    case 'document': return 'document';
    case 'presentation': return 'presentation';
    case 'table': return 'table';
    case 'code':
    case 'config':
    case 'text':
      return 'code';
    default:
      return 'unsupported';
  }
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
