// Compiled client regression gate. Fixtures use isolated homes and fake OS adapters.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('SKIP: Unix PTYs; native Windows acceptance is a separate release gate.');
  process.exit(0);
}
const suites = [
  'inline', 'inline-layout', 'mouse', 'approval', 'composer', 'detail-focus',
  'questions', 'resume-popup', 'integrations', 'commands', 'idle',
];
for (const suite of suites) {
  if (suite === 'commands' && process.argv.includes('--fixtures-only')) continue;
  console.log(`\nRust PTY: ${suite}`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`test-tui-${suite}.mjs`, import.meta.url))], {
    stdio: 'inherit', timeout: 180_000,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
