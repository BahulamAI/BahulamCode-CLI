/**
 * One diff presentation for live changes, F2 details and Markdown.
 * Pure: never reads files, applies patches, or changes approval policy.
 */
import { paint } from './palette.mjs';
import { term } from './term.mjs';
import { glyph } from './chrome.mjs';
import { cellWidth, stripSequences } from './render-queue.mjs';
import { wrapRuns, wrapCode } from './code-layout.mjs';
import { isSensitiveConfigPath } from '../core/safety.mjs';

const hunkRE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const count = (lines, side) => lines.filter(line => line.type !== 'meta' && line.type !== (side === 'old' ? 'add' : 'remove')).length;
const filePath = value => String(value || '').split('\t')[0].replace(/^"|"$/g, '').replace(/^[ab]\//, '');

function diffLine(line) {
  if (typeof line === 'object' && line) {
    const aliases = { added: 'add', '+': 'add', removed: 'remove', delete: 'remove', '-': 'remove', same: 'context', ' ': 'context' };
    const type = line.type || line.kind || 'context';
    return { type: aliases[type] || type, text: String(line.text ?? line.content ?? line.value ?? '') };
  }
  const raw = String(line ?? '');
  if (raw.startsWith('\\')) return { type: 'meta', text: raw };
  return { type: raw[0] === '+' ? 'add' : raw[0] === '-' ? 'remove' : 'context', text: /^[ +\-]/.test(raw) ? raw.slice(1) : raw };
}

function normalizeHunk(hunk) {
  const lines = Array.isArray(hunk.lines) ? hunk.lines.map(diffLine)
    : String(hunk.body || '').replace(/\r\n/g, '\n').split('\n').filter(line => line && !line.startsWith('@@')).map(diffLine);
  return {
    old_start: Number(hunk.old_start ?? hunk.oldStart ?? 1),
    new_start: Number(hunk.new_start ?? hunk.newStart ?? 1),
    old_count: Number(hunk.old_count ?? hunk.old_lines ?? hunk.oldCount ?? count(lines, 'old')),
    new_count: Number(hunk.new_count ?? hunk.new_lines ?? hunk.newCount ?? count(lines, 'new')),
    suffix: hunk.suffix || '', lines,
  };
}

export function parseUnifiedDiff(text) {
  const files = [];
  let file, hunk, oldRemaining = 0, newRemaining = 0;
  const start = () => { file = { hunks: [], notes: [] }; files.push(file); hunk = null; };
  const lines = stripSequences(String(text || '')).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      start();
      const paths = raw.match(/^diff --git (?:"a\/(.+)"|a\/(.+?)) (?:"b\/(.+)"|b\/(.+))$/);
      if (paths) { file.oldPath = paths[1] || paths[2]; file.newPath = paths[3] || paths[4]; file.relative_path = file.newPath; }
      else file.notes.push(raw);
      continue;
    }
    if (!file) start();
    const match = raw.match(hunkRE);
    if (match) {
      hunk = { old_start: +match[1], old_count: +(match[2] ?? 1), new_start: +match[3], new_count: +(match[4] ?? 1), suffix: match[5], lines: [] };
      file.hunks.push(hunk);
      oldRemaining = hunk.old_count; newRemaining = hunk.new_count;
      continue;
    }
    const inHunk = hunk && (oldRemaining > 0 || newRemaining > 0);
    if (!inHunk && raw.startsWith('--- ')) {
      if (file.hunks.length) start();
      file.oldPath = filePath(raw.slice(4));
    } else if (!inHunk && raw.startsWith('+++ ')) {
      file.newPath = filePath(raw.slice(4));
      file.relative_path = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
    } else if (hunk && (/^[ +\-\\]/.test(raw))) {
      const line = diffLine(raw); hunk.lines.push(line);
      if (line.type !== 'add' && line.type !== 'meta') oldRemaining--;
      if (line.type !== 'remove' && line.type !== 'meta') newRemaining--;
    }
    else if (!hunk && /^[+\- ]/.test(raw)) {
      hunk = { old_start: 1, new_start: 1, old_count: null, new_count: null, lines: [diffLine(raw)] };
      file.hunks.push(hunk);
    } else if (/^(?:index |old mode |new mode |new file mode |deleted file mode |similarity |rename |copy |Binary files |GIT binary patch)/.test(raw)) file.notes.push(raw);
    else if (!hunk && raw) file.notes.push(raw);
  }
  return files.map(file => ({ ...file, hunks: file.hunks.map(normalizeHunk) }));
}

export function normalizedDiffs(value) {
  if (typeof value === 'string') return parseUnifiedDiff(value);
  const source = Array.isArray(value?.file_diffs) ? value.file_diffs : value?.file_diff ? [value.file_diff]
    : value?.hunks || value?.unified || value?.redacted ? [value] : [];
  return source.flatMap(file => {
    if (!file) return [];
    // Redaction is checked before any body is parsed or highlighted.
    const sensitive = file.redacted || isSensitiveConfigPath(file.relative_path || file.path);
    if (sensitive) return [{ ...file, redacted: true, hunks: [] }];
    if (file.hunks?.length) return [{ ...file, hunks: file.hunks.map(normalizeHunk) }];
    if (file.unified) return parseUnifiedDiff(file.unified).map(parsed => ({ ...file, ...parsed, relative_path: parsed.relative_path || file.relative_path || file.path }));
    return [];
  });
}

/** Bounded word diff. Large replacements use a linear prefix/suffix fallback. */
export function changedWords(before, after) {
  const tokenize = text => String(text).match(/[\p{L}\p{N}_]+|\s+|[^\s]/gu) || [];
  const a = tokenize(before), b = tokenize(after);
  const left = a.map(text => ({ text, changed: true })), right = b.map(text => ({ text, changed: true }));
  if (a.length * b.length > 40000) {
    let i = 0, x = a.length - 1, y = b.length - 1;
    while (i < a.length && i < b.length && a[i] === b[i]) { left[i].changed = right[i].changed = false; i++; }
    while (x >= i && y >= i && a[x] === b[y]) { left[x--].changed = right[y--].changed = false; }
    return [left, right];
  }
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { left[i++].changed = right[j++].changed = false; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return [left, right];
}

function highlightedLines(lines) {
  const words = new Map();
  for (let i = 0; i < lines.length;) {
    if (!['add', 'remove'].includes(lines[i].type)) { i++; continue; }
    const removed = [], added = [];
    while (i < lines.length && ['add', 'remove'].includes(lines[i].type)) {
      (lines[i].type === 'add' ? added : removed).push(i++);
    }
    for (let j = 0; j < Math.min(removed.length, added.length); j++) {
      const pair = changedWords(lines[removed[j]].text, lines[added[j]].text);
      words.set(removed[j], pair[0]); words.set(added[j], pair[1]);
    }
  }
  return words;
}

export function renderFileDiffs(value, {
  columns = term().columns || 80, indent = '  ', numbers = true,
  showFileHeader = true, maxLines = Infinity, maxFiles = Infinity,
} = {}) {
  const files = normalizedDiffs(value);
  const out = [];
  let emitted = 0, omitted = 0;
  const addText = (text, painter = paint.text.muted) => out.push(wrapCode(text, painter, { columns, indent }));
  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
    if (f >= maxFiles) { omitted += total || 1; continue; }
    const path = file.relative_path || file.path || file.newPath || file.oldPath || 'file';
    const added = file.lines_added ?? file.hunks.reduce((n, h) => n + h.lines.filter(l => l.type === 'add').length, 0);
    const removed = file.lines_removed ?? file.hunks.reduce((n, h) => n + h.lines.filter(l => l.type === 'remove').length, 0);
    if (showFileHeader || files.length > 1 || file.redacted) addText(path + ' +' + added + glyph(' −', ' -') + removed, text => paint.bold(paint.brand.primary(text)));
    if (file.redacted || isSensitiveConfigPath(path)) { addText('diff redacted for sensitive config'); continue; }
    if (file.oldPath && file.newPath && file.oldPath !== file.newPath) addText('from ' + file.oldPath + ' to ' + file.newPath);
    for (const note of file.notes || []) addText(note);
    const maxNumber = Math.max(1, ...file.hunks.flatMap(h => [h.old_start + h.old_count, h.new_start + h.new_count]));
    const gutterWidth = String(maxNumber).length;
    for (const hunk of file.hunks) {
      if (emitted < maxLines) addText('@@ -' + hunk.old_start + ',' + hunk.old_count + ' +' + hunk.new_start + ',' + hunk.new_count + ' @@' + (hunk.suffix || ''));
      let old = hunk.old_start, next = hunk.new_start;
      const highlights = highlightedLines(hunk.lines);
      hunk.lines.forEach((line, index) => {
        const oldNumber = ['context', 'remove'].includes(line.type) ? String(old++) : '';
        const newNumber = ['context', 'add'].includes(line.type) ? String(next++) : '';
        if (emitted++ >= maxLines) { omitted++; return; }
        const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : line.type === 'meta' ? '\\' : ' ';
        const surface = line.type === 'add' ? 'add' : line.type === 'remove' ? 'remove' : null;
        const shaded = surface && Boolean(paint.token('diff.' + surface + 'Line').open);
        const neutralSurface = term().colorLevel === 'ansi256' && term().appearance !== 'light';
        const base = shaded && !neutralSurface ? paint.text.primary : line.type === 'add' ? paint.state.success : line.type === 'remove' ? paint.state.danger : paint.text.primary;
        const gutterPaint = shaded ? paint.text.primary : paint.text.muted;
        const gutter = numbers ? oldNumber.padStart(gutterWidth) + ' ' + newNumber.padStart(gutterWidth) + ' ' : '';
        const prefix = gutterPaint(gutter) + base(marker + ' ');
        const changed = text => {
          const emphasis = base(paint.bold(paint.underline(text)));
          return shaded ? paint.diff[surface + 'Word'](emphasis) : emphasis;
        };
        const runs = (highlights.get(index) || [{ text: line.type === 'meta' ? line.text.replace(/^\\\s?/, '') : line.text }])
          .map(word => ({ text: word.text, paint: word.changed ? changed : base }));
        const rows = wrapRuns(runs, {
          columns, indent, first: prefix,
          rest: gutterPaint(' '.repeat(cellWidth(gutter)) + glyph('↳ ', '> ')),
          wordWrap: false,
        });
        out.push(...rows.map(row => {
          if (!shaded) return row;
          // Leave the transcript indent and final terminal column untouched.
          // Padding uses terminal cells, so CJK/tabs and wrapped rows align.
          const padding = ' '.repeat(Math.max(0, Math.max(8, Number(columns) || 80) - 1 - cellWidth(row)));
          return indent + paint.diff[surface + 'Line'](row.slice(indent.length) + padding);
        }));
      });
    }
    if (file.truncated) addText('Source diff incomplete' + (file.truncated_line_count ? ': ' + file.truncated_line_count + ' lines omitted upstream' : '; more content was not supplied'));
  }
  if (omitted) addText(glyph('… ', '... ') + omitted + ' diff lines omitted; use /last for all available changes');
  return out.join('\n');
}

export function renderUnifiedDiff(text, options = {}) {
  return renderFileDiffs(String(text || ''), { indent: '', ...options });
}
