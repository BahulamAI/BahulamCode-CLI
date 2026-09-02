export function isRawMultilinePasteChunk(text) {
  const value = String(text || '');
  if (!value) return false;
  if (!/[\r\n]/.test(value)) return false;

  const withoutLineBreaks = value.replace(/[\r\n]/g, '');
  if (!withoutLineBreaks.length) return false;

  // A single printable char followed by Enter can be delivered in one chunk
  // by some terminals; keep that as normal line submission.
  return withoutLineBreaks.length > 1 || value.split(/\r?\n|\r/).length > 2;
}

export function normalizePastedText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function pastedTextLabel(text) {
  const value = normalizePastedText(text);
  const lines = value ? value.split('\n').length : 0;
  if (lines > 1) return `[text copied · ${lines} lines]`;
  return '[text copied]';
}
