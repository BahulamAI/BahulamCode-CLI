#!/usr/bin/env node
/**
 * Prep SWE-bench Hard-10 Repositories
 * ===================================
 *
 * One-time (or on-demand) setup for `questions-swe-hard10.json`.
 * Clones each repo at its base_commit into ~/.kepler-bench-repos/<instance_id>.
 *
 * On subsequent runs, resets each existing clone to its base commit (fast).
 * Use --refresh to force re-clone.
 *
 * Why we pre-clone:
 *   The persistent model-comparison harness (run-persistent.mjs) runs multiple
 *   questions in one session. Each question in questions-swe-hard10.json points
 *   at a fixed repo path so no per-question git overhead pollutes timing.
 *
 * Usage:
 *   node benchmark/model-comparison/prep-swe-repos.mjs
 *   node benchmark/model-comparison/prep-swe-repos.mjs --refresh   # re-clone all
 *   node benchmark/model-comparison/prep-swe-repos.mjs --reset     # reset to base only
 *
 * After this, run:
 *   node benchmark/model-comparison/run-persistent.mjs \
 *     --questions benchmark/model-comparison/questions-swe-hard10.json \
 *     --label "<some-label>" --model <model-id> --route platform
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
    const out = { refresh: false, reset: false, questions: path.join(__dirname, 'questions-swe-hard10.json') };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--refresh') out.refresh = true;
        else if (a === '--reset') out.reset = true;
        else if (a === '--questions') out.questions = argv[++i];
    }
    return out;
}

const args = parseArgs(process.argv);
const rootDir = path.join(os.homedir(), '.kepler-bench-repos');
fs.mkdirSync(rootDir, { recursive: true });

const spec = JSON.parse(fs.readFileSync(args.questions, 'utf8'));
const instances = spec.questions;
console.log(`Prepping ${instances.length} SWE-bench repos → ${rootDir}`);

let done = 0;
let failed = 0;
for (const q of instances) {
    const dest = path.join(rootDir, q.instance_id);
    const gitUrl = `https://github.com/${q.repo}.git`;
    const exists = fs.existsSync(path.join(dest, '.git'));

    try {
        if (args.refresh && exists) {
            fs.rmSync(dest, { recursive: true, force: true });
        }
        if (!fs.existsSync(path.join(dest, '.git'))) {
            console.log(`  [clone]  ${q.instance_id}  (${q.repo})`);
            execSync(`git clone --quiet ${gitUrl} ${dest}`, { stdio: 'inherit' });
        }
        console.log(`  [reset]  ${q.instance_id} → ${q.base_commit.substring(0, 8)}`);
        execSync(
            `git -C ${dest} fetch --quiet origin ${q.base_commit} && ` +
            `git -C ${dest} reset --hard --quiet ${q.base_commit} && ` +
            `git -C ${dest} clean -fdx --quiet`,
            { stdio: 'inherit' }
        );
        done++;
    } catch (err) {
        console.error(`  [FAIL]   ${q.instance_id}: ${err.message.split('\n')[0]}`);
        failed++;
    }
}

console.log(`\ndone: ${done}/${instances.length} ready${failed ? ` (${failed} failed)` : ''}`);
console.log(`\nNext:`);
console.log(`  node benchmark/model-comparison/run-persistent.mjs \\`);
console.log(`    --questions benchmark/model-comparison/questions-swe-hard10.json \\`);
console.log(`    --label "<label>" --model <model-id> --route platform`);
