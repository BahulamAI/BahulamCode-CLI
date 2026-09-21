import { term, _setForTesting } from '../../src/ui/term.mjs';
import { transcriptHeader, transcriptLine } from '../../src/ui/transcript-block.mjs';
import { appendContent, flushContent, startContentStream, stopSpinner, renderBlockBoundary, renderToolCall, renderToolResult } from '../../src/terminal/repl-render.mjs';
import { runtime } from '../../src/terminal/repl-state.mjs';
import { buildFileDiff } from '../../src/core/file-diff.mjs';
import * as dock from '../../src/ui/input-dock.mjs';

export function captureTranscript({ columns = 80, appearance = 'dark', docked = false, mode = 'subtle' } = {}) {
  const original = { ...term() };
  const previousMode = process.env.BAHULAM_BLOCK_SEPARATOR;
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let bytes = '';
  try {
    process.env.BAHULAM_BLOCK_SEPARATOR = mode;
    _setForTesting({ columns, rows: 48, appearance, isTTY: true, color: true, colorLevel: 'truecolor', unicode: true, plain: false, fixedInput: docked });
    process.stdout.write = process.stderr.write = chunk => { bytes += String(chunk); return true; };
    if (docked) dock.mountInputDock({ preserveScrollback: true });
    startContentStream();
    const user = text => {
      renderBlockBoundary('user');
      process.stderr.write(transcriptHeader('you', { tone: 'user' }) + '\n' + transcriptLine(text) + '\n');
      runtime.lastRenderedBlock = 'user';
      startContentStream({ previousBlock: runtime.lastRenderedBlock });
    };
    const assistant = text => { appendContent(text); flushContent(); };
    user('Add authorization checks.');
    assistant('I will review the existing guard.');
    assistant('Then run the focused checks.');
    renderToolCall({ call_id: 'section-edit', tool: 'edit_file', args: { file_path: 'src/auth.ts', search: 'return true;' } });
    stopSpinner(); // The live event dispatcher clears status before results.
    renderToolResult({ call_id: 'section-edit', tool: 'edit_file', success: true,
      file_diff: buildFileDiff({ filePath: 'src/auth.ts', before: 'return true;\n', after: 'return hasScope(token);\n' }) });
    renderToolCall({ call_id: 'section-test', tool: 'shell', args: { command: 'npm test -- auth' } });
    stopSpinner();
    renderToolResult({ call_id: 'section-test', tool: 'shell', success: true, exit_code: 0, output: '12 checks passed', duration_ms: 400 });
    assistant('Updated `src/auth.ts`.\n\n```typescript\nconst retries = 3;\nconst scope = "read";\nreturn scope;\n```\n\n[Review notes](https://example.test)');
    user('What changed?');
    assistant('Authorization now checks scope.');
    if (docked) dock.renderDockInput('You > ', 'keep this draft', { context: 'code', meta: 'review', tips: 'Enter send' });
    return bytes;
  } finally {
    stopSpinner();
    startContentStream();
    if (docked) dock.unmountInputDock();
    runtime.pendingHead = null;
    process.stdout.write = stdout; process.stderr.write = stderr;
    _setForTesting(original);
    if (previousMode === undefined) delete process.env.BAHULAM_BLOCK_SEPARATOR;
    else process.env.BAHULAM_BLOCK_SEPARATOR = previousMode;
  }
}
