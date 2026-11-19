import { redactSensitive } from './approval-log.mjs';
import { isSensitiveConfigPath } from './safety.mjs';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /^(?:authorization|api[-_]?key|apikey|key|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|pwd|access[-_]?key|secret[-_]?access[-_]?key)$|(?:^|[-_])(?:api[-_]?key|apikey|token|secret|password|passwd|pwd|access[-_]?key|secret[-_]?access[-_]?key)(?:$|[-_])/i;
const SENSITIVE_FILE_CONTENT = new Set(['content', 'contents', 'text', 'patch', 'new_string', 'newString', 'replace', 'replacement']);

/**
 * Remove terminal control sequences from event-log/display text. These events
 * are presentation copies; callers must keep the original value for model
 * history and tool execution. Newlines and tabs remain useful transcript data.
 */
export function stripTerminalControls(value) {
  const input = String(value ?? '');
  const output = [];
  let state = 'text';

  for (const char of input) {
    const code = char.codePointAt(0);
    if (state === 'text') {
      if (code === 0x1b) state = 'escape';
      else if (code === 0x9b) state = 'csi';
      else if ([0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(code)) state = 'string';
      else if (char === '\n' || char === '\t') output.push(char);
      else if (!/\p{Cc}/u.test(char)) output.push(char);
      continue;
    }

    if (state === 'escape') {
      if (char === '[') state = 'csi';
      else if ([']', 'P', 'X', '^', '_'].includes(char)) state = 'string';
      else state = 'text';
      continue;
    }
    if (state === 'csi') {
      if (code >= 0x40 && code <= 0x7e) state = 'text';
      continue;
    }
    if (state === 'string') {
      if (code === 0x07 || code === 0x9c) state = 'text';
      else if (code === 0x1b) state = 'string-escape';
      continue;
    }
    if (state === 'string-escape') state = char === '\\' ? 'text' : 'string';
  }

  return output.join('');
}

/** Clone and sanitize event/display data without mutating the source object. */
export function sanitizeDisplayValue(value, depth = 0) {
  if (depth > 12) return '[truncated-depth]';
  if (typeof value === 'string') return redactSensitive(stripTerminalControls(value));
  if (value == null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => sanitizeDisplayValue(item, depth + 1));
  }

  const filePath = value.file_path || value.path || '';
  const sensitiveFile = typeof filePath === 'string' && isSensitiveConfigPath(filePath);
  const sanitized = Object.create(null);
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (SENSITIVE_KEY.test(key)) {
      sanitized[key] = REDACTED;
    } else if (sensitiveFile && SENSITIVE_FILE_CONTENT.has(key)) {
      sanitized[key] = '[redacted sensitive config]';
    } else {
      sanitized[key] = sanitizeDisplayValue(item, depth + 1);
    }
  }
  return sanitized;
}
