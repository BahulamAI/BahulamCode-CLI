#!/usr/bin/env node
/**
 * Test runner for @bahulam/code.
 *
 * Usage:
 *   node scripts/run-tests.mjs            # all tests
 *   node scripts/run-tests.mjs --unit     # unit tests only (no network, no spawned processes)
 *   node scripts/run-tests.mjs --integration  # integration tests only
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const unitOnly = args.includes('--unit');
const integrationOnly = args.includes('--integration');

const env = {
    ...process.env,
    BAHULAM_HOME: process.env.BAHULAM_HOME || '/tmp/bahulam-code-test-home',
};

// ── Unit tests ───────────────────────────────────────────────────────────────
// Self-contained: no network, no spawned long-running processes, no auth tokens.
// Must pass on any contributor machine with `node >= 18` and `npm install`.
const UNIT_TESTS = [
    'test/test-backend-url.mjs',
    'test/test-agent-history.mjs',
    'test/test-sse-client.mjs',
    'test/test-tool-executor.mjs',
    'test/test-generate-image.mjs',
    'test/test-analyze-image.mjs',
    'test/test-project-artifacts.mjs',
    'test/test-work-scope.mjs',
    'test/test-lint-resolver.mjs',
    'test/test-local-service.mjs',
    'test/test-skills.mjs',
    'test/test-callback.mjs',
    'test/test-rate-limit-display.mjs',
    'test/test-preflight.mjs',
    'test/test-plugin-composes.mjs',
    'test/pi-compat-smoke.mjs',
    'test/pi-scaffold-smoke.mjs',
    'test/pi-requirements-smoke.mjs',
    'test/test-formatter.mjs',
    'test/test-terminal-rendering.mjs',
    'test/test-render-queue.mjs',
    'test/test-input-dock.mjs',
    'test/test-live-steering-client.mjs',
    'test/test-slash-commands.mjs',
    'test/test-approval.mjs',
    'test/test-approval-log.mjs',
    'test/test-bahulam-contract.mjs',
    'test/test-session-manager.mjs',
    'test/test-safety.mjs',
    'test/test-jsonl-writer.mjs',
    'test/test-analytics.mjs',
    'test/test-stagnation.mjs',
    'test/test-attachments.mjs',
    'test/test-bm25.mjs',
    'test/test-output-filter.mjs',
    'test/test-risk-tier.mjs',
    'test/test-resume-append.mjs',
];

// ── Integration tests ────────────────────────────────────────────────────────
// Spawn real processes, bind sockets, or test multi-process coordination.
// Require no external services but do require a working OS environment.
const INTEGRATION_TESTS = [
    'test/test-socket-server.mjs',
    'test/test-session-attach.mjs',
    'test/test-session-event-tap.mjs',
    'test/test-session-relay.mjs',
];

// Default (no flag) runs unit tests only — safe for all contributors.
// Integration tests require daemon modules and are opt-in.
const toRun = integrationOnly
    ? INTEGRATION_TESTS
    : [...UNIT_TESTS];

let totalPassed = 0;
let totalFailed = 0;

for (const file of toRun) {
    const result = spawnSync(process.execPath, [path.join(root, file)], {
        env,
        stdio: 'inherit',
        cwd: root,
    });
    if (result.status !== 0) {
        totalFailed++;
    } else {
        totalPassed++;
    }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${totalPassed} test files passed, ${totalFailed} failed`);

if (totalFailed > 0) process.exit(1);
