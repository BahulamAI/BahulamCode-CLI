import path from 'node:path';

const MAX_LCS_CELLS = 600_000;

export function buildFileDiff({
  filePath = '',
  before = '',
  after = '',
  cwd = process.cwd(),
  context = 3,
} = {}) {
  const oldText = before == null ? '' : String(before);
  const newText = after == null ? '' : String(after);
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffOps(oldLines, newLines);
  const added = ops.filter(op => op.type === 'add').length;
  const removed = ops.filter(op => op.type === 'remove').length;
  const hunks = buildHunks(ops, context);
  const relativePath = shortPath(filePath, cwd);

  return {
    type: 'file_diff',
    path: filePath,
    relative_path: relativePath,
    lines_added: added,
    lines_removed: removed,
    hunks,
    unified: renderUnifiedDiff(relativePath || filePath, hunks),
  };
}

function splitLines(text) {
  if (!text) return [];
  const lines = String(text).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function shortPath(filePath, cwd) {
  const value = String(filePath || '');
  if (!value) return '';
  try {
    const rel = path.relative(cwd || process.cwd(), value);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  } catch { /* best effort */ }
  return value;
}

function diffOps(oldLines, newLines) {
  if (!oldLines.length && !newLines.length) return [];
  if (!oldLines.length) return newLines.map((line, i) => ({ type: 'add', text: line, oldLine: 1, newLine: i + 1 }));
  if (!newLines.length) return oldLines.map((line, i) => ({ type: 'remove', text: line, oldLine: i + 1, newLine: 1 }));

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return prefixSuffixOps(oldLines, newLines);
  }
  return lcsOps(oldLines, newLines);
}

function prefixSuffixOps(oldLines, newLines) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  const ops = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: 'context', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }
  for (let i = prefix; i <= oldSuffix; i++) {
    ops.push({ type: 'remove', text: oldLines[i], oldLine: i + 1, newLine: prefix + 1 });
  }
  for (let i = prefix; i <= newSuffix; i++) {
    ops.push({ type: 'add', text: newLines[i], oldLine: oldSuffix + 2, newLine: i + 1 });
  }

  const oldTailStart = oldSuffix + 1;
  const newTailStart = newSuffix + 1;
  for (let i = 0; oldTailStart + i < oldLines.length; i++) {
    ops.push({
      type: 'context',
      text: oldLines[oldTailStart + i],
      oldLine: oldTailStart + i + 1,
      newLine: newTailStart + i + 1,
    });
  }
  return ops;
}

function lcsOps(oldLines, newLines) {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols));

  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      ops.push({ type: 'context', text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (j < newLines.length && (i >= oldLines.length || dp[i][j + 1] > dp[i + 1][j])) {
      ops.push({ type: 'add', text: newLines[j], oldLine: i + 1, newLine: j + 1 });
      j++;
    } else {
      ops.push({ type: 'remove', text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
      i++;
    }
  }
  return ops;
}

function buildHunks(ops, context) {
  const changeIndexes = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'context') changeIndexes.push(i);
  }
  if (!changeIndexes.length) return [];

  const ranges = [];
  for (const idx of changeIndexes) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map(range => {
    const lines = ops.slice(range.start, range.end + 1);
    const oldLineNumbers = lines.filter(l => l.type !== 'add').map(l => l.oldLine);
    const newLineNumbers = lines.filter(l => l.type !== 'remove').map(l => l.newLine);
    const oldStart = oldLineNumbers[0] || lines[0]?.oldLine || 1;
    const newStart = newLineNumbers[0] || lines[0]?.newLine || 1;
    const oldCount = lines.filter(l => l.type !== 'add').length;
    const newCount = lines.filter(l => l.type !== 'remove').length;
    return { old_start: oldStart, old_count: oldCount, new_start: newStart, new_count: newCount, lines };
  });
}

function renderUnifiedDiff(filePath, hunks) {
  if (!hunks?.length) return '';
  const out = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.old_start},${hunk.old_count} +${hunk.new_start},${hunk.new_count} @@`);
    for (const line of hunk.lines) {
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      out.push(`${prefix}${line.text}`);
    }
  }
  return out.join('\n');
}
