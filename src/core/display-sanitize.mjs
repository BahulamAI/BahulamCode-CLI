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

