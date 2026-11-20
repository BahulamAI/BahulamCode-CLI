import { isSensitiveConfigPath } from '../core/safety.mjs';

// Keep the compact display independent of the executor's result and model history.
export function rustDiffDisplay(diff) {
  const path = diff.relative_path || diff.path || '';
  if (diff.redacted || isSensitiveConfigPath(path) || isSensitiveConfigPath(diff.path)) {
    const preview = 'Diff redacted for sensitive config';
    return { path, preview, unified: preview, redacted: true, hunks: [] };
  }
  const hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
  const lines = [];
  for (const hunk of hunks) {
    for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
      if (line.type === 'add' || line.type === 'remove') {
        lines.push((line.type === 'add' ? '+' : '-') + line.text);
        if (lines.length === 3) break;
      }
    }
    if (lines.length === 3) break;
  }
  const unified = diff.unified || hunks.map(hunk => hunk.text ?? hunk.content ??
    (hunk.lines || []).map(line => (line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ') + line.text).join('\n')).join('\n');
  if (!lines.length && unified) {
    for (const line of unified.split('\n')) {
      if (/^[+-]/.test(line) && !/^(--- |\+\+\+ )/.test(line)) lines.push(line);
      if (lines.length === 3) break;
    }
  }
  const preview = lines.map(line => Array.from(line.slice(0, 240)).slice(0, 120).join('')).join('\n');
  return { path, preview, unified };
}

export function rustToolEditDisplay(data) {
  const diffs = Array.isArray(data.file_diffs) ? data.file_diffs : data.file_diff ? [data.file_diff] : [];
  if (diffs.length !== 1 || !diffs[0]) return {};
  if (data.success === false || data.ok === false || data.error || data.is_error ||
      (data.exit_code != null && Number(data.exit_code) !== 0)) return {};
  const {preview, unified} = rustDiffDisplay(diffs[0]);
  if (!preview) return {};
  const result = data.output ?? data.result;
  const text = typeof result === 'string' ? result : result == null ? '' : JSON.stringify(result, null, 2);
  return { has_edit_diff: true, preview, output: [text, unified].filter(Boolean).join('\n\n') };
}
