#!/usr/bin/env node
/**
 * Test runner for @bahulam/code.
 *
 * Usage:
 *   node scripts/run-tests.mjs            # unit tests only (default, CI-safe)
 *   node scripts/run-tests.mjs --unit     # unit tests only
 *   node scripts/run-tests.mjs --integration  # integration tests only
 *   node scripts/run-tests.mjs --all      # unit + integration
 *
 * Every file matching `test/*.mjs` must appear in one of the lists below or in
 * SKIPPED with a stated reason. A file that is in neither is reported as an
 * orphan and fails the run: silently dropping a suite from the runner is how a
 * green build hid a runtime ReferenceError for several releases.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const unitOnly = args.includes('--unit');
const integrationOnly = args.includes('--integration');
const runAll = args.includes('--all');

const env = {
    ...process.env,
    BAHULAM_HOME: process.env.BAHULAM_HOME || '/tmp/bahulam-code-test-home',
};

// ── Skips ────────────────────────────────────────────────────────────────────
// Not run, but NOT hidden: printed on every invocation so the gap stays visible.
// Only for suites that cannot execute here at all — never for "it fails".
const SKIPPED = new Map([
    ['test/test.mjs', 'legacy aggregate suite; imports src/ui/ink-app.mjs which no longer exists'],
    ['test/e2e-smoke.mjs', 'imports src/index.mjs which no longer exists'],
    ['test/phase0-latency-probe.mjs', 'latency benchmark, asserts no behaviour'],
    ['test/test-code-cards-browser.mjs', 'requires puppeteer (optional devDependency)'],
    ['test/test-design-browser.mjs', 'requires puppeteer (optional devDependency)'],
    ['test/test-dock-browser.mjs', 'requires puppeteer (optional devDependency)'],
    ['test/test-startup-browser.mjs', 'requires puppeteer (optional devDependency)'],
    ['test/test-transcript-browser.mjs', 'requires puppeteer (optional devDependency)'],
]);

// ── Unit tests ───────────────────────────────────────────────────────────────
// Self-contained: no network, no spawned long-running processes, no auth tokens.
// Must pass on any contributor machine with `node >= 18` and `npm install`.
const UNIT_TESTS = [
    'test/test-display-payload-store.mjs',
    'test/test-rust-attachment-previews.mjs',
    'test/test-rust-interactions.mjs',
    'test/test-cli-update.mjs',
    'test/test-rust-approval.mjs',
    'test/test-rust-event-parity.mjs',
    'test/test-rust-usage.mjs',
    'test/test-display-sanitize.mjs',
    'test/test-resume-display-stability.mjs',
    'test/test-resume-folder-scope.mjs',
    'test/test-rust-tui-settings.mjs',
    'test/test-rust-tui-backpressure.mjs',
    'test/test-background-promotion.mjs',
    'test/test-backend-url.mjs',
    'test/test-auth-sessions.mjs',
    'test/test-auth-repl.mjs',
    'test/test-agent-history.mjs',
    'test/test-agent-registry-plugin-entry.mjs',
    'test/test-agent-trace.mjs',
    'test/test-sse-client.mjs',
    'test/test-tool-executor.mjs',
    'test/test-tool-error.mjs',
    'test/test-request-retry.mjs',
    'test/test-remember.mjs',
    'test/test-generate-image.mjs',
    'test/test-analyze-image.mjs',
    'test/test-project-artifacts.mjs',
    'test/test-work-scope.mjs',
    'test/test-kepler-contract.mjs',
    'test/test-index-freshness.mjs',
    'test/test-graph-index.mjs',
    'test/test-lint-resolver.mjs',
    'test/test-local-service.mjs',
    'test/test-workspace-voice.mjs',
    'test/test-workspace-file-tabs.mjs',
    'test/test-skills.mjs',
    'test/test-callback.mjs',
    'test/test-rate-limit-display.mjs',
    'test/test-preflight.mjs',
    'test/test-error-guidance.mjs',
    'test/test-plugin-composes.mjs',
    'test/test-plugin-registry-install.mjs',
    'test/test-plugin-state.mjs',
    'test/test-plugin-state-schema.mjs',
    'test/test-plugin-settings.mjs',
    'test/test-plugin-capability-graph.mjs',
    'test/test-plugin-runtime-loaders.mjs',
    'test/test-plugin-loader-categories.mjs',
    'test/test-plugin-agents-from.mjs',
    'test/test-plugin-client-advertising.mjs',
    'test/test-plugin-local-execution.mjs',
    'test/test-plugin-lifecycle.mjs',
    'test/pi-compat-smoke.mjs',
    'test/pi-scaffold-smoke.mjs',
    'test/pi-requirements-smoke.mjs',
    'test/test-formatter.mjs',
    'test/test-terminal-rendering.mjs',
    'test/test-transcript-sections.mjs',
    'test/test-code-cards.mjs',
    'test/test-startup-resume.mjs',
    'test/test-resume-mode.mjs',
    'test/test-resume-append.mjs',
    'test/test-design-system.mjs',
    'test/test-render-queue.mjs',
    'test/test-input-dock.mjs',
    'test/test-dock-lifecycle.mjs',
    'test/test-approval-layout.mjs',
    'test/test-live-steering-client.mjs',
    'test/test-slash-commands.mjs',
    'test/test-approval.mjs',
    'test/test-approval-log.mjs',
    'test/test-bahulam-contract.mjs',
    'test/test-session-manager.mjs',
    'test/test-session-core.mjs',
    'test/test-session-protocol.mjs',
    'test/test-protocol-cache-invariance.mjs',
    'test/test-safety.mjs',
    'test/test-jsonl-writer.mjs',
    'test/test-analytics.mjs',
    'test/test-stagnation.mjs',
    'test/test-attachments.mjs',
    'test/test-bm25.mjs',
    'test/test-output-filter.mjs',
    'test/test-risk-tier.mjs',
    'test/test-context-reduction.mjs',
    'test/test-mcp.mjs',
    'test/test-followup-promote.mjs',
    'test/test-followup-queue.mjs',
    'test/test-local-agent.mjs',
    'test/test-mode-selector.mjs',
    'test/test-repl-model-form.mjs',
    'test/test-usage-normalization.mjs',
    'test/test-checkpoints.mjs',
];

// ── Integration tests ────────────────────────────────────────────────────────
// Spawn real processes, bind sockets, or test multi-process coordination.
// Require no external services but do require a working OS environment.
const INTEGRATION_TESTS = [
    'test/test-tui-capabilities.mjs', // requires the compiled Rust binary
    'test/test-followup-repl.mjs',
    'test/test-socket-server.mjs',
    'test/test-session-attach.mjs',
    'test/test-session-event-tap.mjs',
    'test/test-session-relay.mjs',
    'test/e2e-sse-flow.mjs',
    'test/e2e-tool-roundtrip.mjs',
    'test/orchestration-smoke.mjs',
];

// ── Coverage guard ───────────────────────────────────────────────────────────
// Any test file on disk that is not classified is an orphan. This is the guard
// that stops a suite from quietly falling out of the runner.
const onDisk = readdirSync(path.join(root, 'test'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `test/${name}`)
    .sort();

const classified = new Set([...UNIT_TESTS, ...INTEGRATION_TESTS, ...SKIPPED.keys()]);
const orphans = onDisk.filter((file) => !classified.has(file));
const ghosts = [...classified].filter((file) => !onDisk.includes(file));

const SKIPPED_LINES = onDisk.filter((file) => SKIPPED.has(file));

if (SKIPPED_LINES.length > 0) {
    console.log(`\n  Skipped ${SKIPPED_LINES.length} suite(s) — not silently, by name:`);
    for (const file of SKIPPED_LINES) console.log(`    - ${file}: ${SKIPPED.get(file)}`);
}

if (ghosts.length > 0) {
    console.error(`\n✗ Runner lists ${ghosts.length} file(s) that do not exist:\n`);
    for (const file of ghosts) console.error(`    ${file}`);
    process.exit(1);
}

if (orphans.length > 0) {
    console.error(`\n✗ ${orphans.length} test file(s) are in no list and would never run:\n`);
    for (const file of orphans) console.error(`    ${file}`);
    console.error('\n  Add each to UNIT_TESTS, INTEGRATION_TESTS, or SKIPPED (with a reason).\n');
    process.exit(1);
}

// Default (no flag) runs unit tests only — safe for all contributors.
// Integration tests require daemon modules and are opt-in.
const toRun = integrationOnly
    ? INTEGRATION_TESTS
    : runAll
        ? [...UNIT_TESTS, ...INTEGRATION_TESTS]
        : [...UNIT_TESTS];

// ── Syntax preflight ─────────────────────────────────────────────────────────
// A file that cannot parse is a silent production outage: dynamic import()
// throws at call time, so a whole feature disappears instead of failing loudly.
// Parse every source file before running any test.
function collectMjs(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectMjs(full, out);
        else if (entry.name.endsWith('.mjs')) out.push(full);
    }
    return out;
}

const syntaxFailures = [];
for (const file of collectMjs(path.join(root, 'src'))) {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
    if (check.status !== 0) syntaxFailures.push({ file, stderr: check.stderr || '' });
}

if (syntaxFailures.length > 0) {
    console.error(`\n✗ Syntax preflight failed for ${syntaxFailures.length} file(s):\n`);
    for (const { file, stderr } of syntaxFailures) {
        console.error(`  ${path.relative(root, file)}`);
        console.error(stderr.split('\n').slice(0, 3).map((l) => `    ${l}`).join('\n'));
    }
    process.exit(1);
}

let totalPassed = 0;
const failures = [];

for (const file of toRun) {
    const result = spawnSync(process.execPath, [path.join(root, file)], {
        env,
        stdio: 'inherit',
        cwd: root,
    });
    if (result.status !== 0) {
        failures.push({ file, status: result.status });
    } else {
        totalPassed++;
    }
}

// Name every failure. A count alone is how a broken suite stayed invisible.
if (failures.length > 0) {
    console.error(`\n  Failed suite(s):`);
    for (const { file, status } of failures) {
        console.error(`    ✗ ${file}${status === null ? ' (killed)' : ` (exit ${status})`}`);
    }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${totalPassed} test files passed, ${failures.length} failed, ${SKIPPED_LINES.length} skipped`);

if (failures.length > 0) process.exit(1);
