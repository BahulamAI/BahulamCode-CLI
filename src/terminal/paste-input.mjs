export function isRawMultilinePasteChunk(text) {
  const value = String(text || '');
  if (!value) return false;
  // Buffered typing (including a slash command) can arrive together with Enter.
  // Only a break inside the remaining text establishes a multiline paste.
  const withoutTrailingBreak = value.replace(/\r\n$|\r$|\n$/, '');
  return /[\r\n]/.test(withoutTrailingBreak);
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
