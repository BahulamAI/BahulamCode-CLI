import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { persistProjectArtifacts } from '../src/core/project-artifacts.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-artifacts-'));
const first = path.join(temp, 'first');
const second = path.join(temp, 'second');
fs.mkdirSync(first);
fs.mkdirSync(second);

const resources = [
    { project_id: 'first', root: first },
    { project_id: 'second', root: second },
];

const written = persistProjectArtifacts({
    project_ids: ['second'],
    goal: 'Fix the parser.',
    plan: '1. Inspect\n2. Test',
}, resources);

assert.strictEqual(written.length, 2);
assert.strictEqual(
    fs.readFileSync(path.join(second, '.kepler', 'goal.md'), 'utf-8'),
    'Fix the parser.',
);
assert.strictEqual(
    fs.readFileSync(path.join(second, '.kepler', 'plan.md'), 'utf-8'),
    '1. Inspect\n2. Test',
);
assert.strictEqual(fs.existsSync(path.join(first, '.kepler')), false);

const ignored = persistProjectArtifacts({
    project_ids: ['unregistered'],
    plan: 'must not be written',
}, resources);
assert.deepStrictEqual(ignored, []);

console.log('  \x1b[32m✓\x1b[0m project artifacts stay within registered roots');
