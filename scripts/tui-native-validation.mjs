// Human-observed native validation. Never labels emulated/helper checks as native passes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Run this harness inside the terminal being validated, not a pipe or headless CI job.');
  process.exit(2);
}
const checks = [
  ['clipboard', 'Use /copy last, paste into another app, then Ctrl+V back into the composer. Verify Unicode and multiline text.'],
  ['editor', 'Type a draft, press Ctrl+G, edit/save/exit, and verify the draft and terminal cursor return correctly.'],
  ['links', 'Click the example.com link normally, then open the PDF with Alt+O. Verify the intended URL/file in the real OS application.'],
  ['notifications', 'Submit /approval, switch focus away for three seconds, verify one real notification, return and deny.'],
  ['graphics', 'Inspect the gradient. Scroll partly/out of view, resize smaller/larger, switch /tui fullscreen and /tui inline. Verify no stray pixels or covered text.'],
  ['selection', 'Drag text, release, paste it elsewhere. Verify black text on white selection and no image/control bytes in copied text.'],
];
console.log('Native terminal acceptance: no fake clipboard, editor, opener or notification helpers.');
console.log('Do these checks in BOTH views. Ctrl+C twice exits the demo to record results.');
for (const [name, instruction] of checks) console.log(`\n${name}: ${instruction}`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('\nPress Enter to start.');
rl.close();
const child = spawn(process.execPath, [path.join(root, 'scripts/tui-rich-demo.mjs')], { cwd: root, stdio: 'inherit', env: process.env });
const exit = await new Promise(resolve => { child.once('error', error => resolve({ error: error.message })); child.once('exit', (code, signal) => resolve({ code, signal })); });
const answers = readline.createInterface({ input: process.stdin, output: process.stdout });
const results = {};
for (const [name] of checks) {
  let status;
  do { status = (await answers.question(`${name}: pass / fail / unsupported / not-run? `)).trim(); }
  while (!['pass','fail','unsupported','not-run'].includes(status));
  results[name] = { status, evidence: await answers.question('Observed result / limitations: ') };
}
answers.close();
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
const worktree = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
const dirty = worktree.status === 0 ? Boolean(worktree.stdout.trim()) : null;
const report = { kind: 'human-observed-native', timestamp: new Date().toISOString(), revision, dirty,
  platform: process.platform, osRelease: os.release(), arch: process.arch,
  terminal: process.env.TERM_PROGRAM || 'unknown', terminalVersion: process.env.TERM_PROGRAM_VERSION || '',
  term: process.env.TERM || '', viaSSH: !!process.env.SSH_CONNECTION, viaTmux: !!process.env.TMUX,
  graphicsOverride: process.env.BAHULAM_TUI_GRAPHICS || 'auto', exit, results };
const output = path.join(os.tmpdir(), `bahulam-native-${process.platform}-${Date.now()}.json`);
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(`\nReport saved: ${output}`);
