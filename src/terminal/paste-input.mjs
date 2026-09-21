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

function stripPastedPathQuotes(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

export function clipboardPathCandidate(value) {
  const text = stripPastedPathQuotes(value);
  if (!text) return '';
  if (text.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(text).pathname);
    } catch {
      return text;
    }
  }
  return text;
}

export function quotedAttachmentReference(value) {
  const text = clipboardPathCandidate(value);
  if (!/[\s"'\\]/.test(text)) return `@${text}`;
  return `@"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function classifyPastedPromptPayload(payload, { looksLikeAttachmentReference = () => false } = {}) {
  const text = normalizePastedText(payload || '');
  if (!text) {
    return { kind: 'clipboard_image', text: '@clipboard ', label: '[clipboard image]' };
  }

  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length && lines.every(line => looksLikeAttachmentReference(clipboardPathCandidate(line)))) {
    return {
      kind: lines.length === 1 ? 'clipboard_path' : 'clipboard_paths',
      text: `${lines.map(quotedAttachmentReference).join('\n')} `,
      label: lines.length === 1 ? '[clipboard path]' : `[clipboard paths · ${lines.length}]`,
    };
  }

  return {
    kind: 'clipboard_text',
    text,
    label: pastedTextLabel(text).replace('[text copied', '[clipboard text'),
  };
}
