#!/usr/bin/env node
/**
 * Persistent benchmark wrapper with role/model overrides.
 *
 * This keeps run-persistent.mjs as the single benchmark implementation and
 * injects resolver inputs through environment JSON:
 *   - KEPLER_BENCH_MODEL_OVERRIDES_JSON
 *   - KEPLER_BENCH_AGENT_SPEC_JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER = path.join(__dirname, 'run-persistent.mjs');

const ROLE_FLAGS = new Map([
    ['--main-model', 'main'],
    ['--coder-model', 'coder'],
    ['--reasoning-model', 'reasoning'],
    ['--fast-model', 'fast'],
    ['--orchestrator-model', 'orchestrator'],
    ['--local-model', 'local'],
    ['--worker-model', 'worker'],
    ['--explore-model', 'explore'],
    ['--plan-model', 'plan'],
    ['--verify-model', 'verify'],
    ['--debug-model', 'debug'],
    ['--refactor-model', 'refactor'],
]);

function usage() {
    process.stderr.write(`
Persistent benchmark with model override support

Usage:
  TARANG_ENV=local node benchmark/model-comparison/run-persistent-model-overrides.mjs \\
    --questions benchmark/model-comparison/questions.json \\
    --label resolver-overrides-smoke \\
    --model moonshotai/kimi-k3 \\
    --route platform \\
    --explore-model deepseek/deepseek-v4-flash \\
    --plan-model deepseek/deepseek-v4-pro \\
    --debug-model moonshotai/kimi-k3

Override options:
  --role-model <role=model>       Add one role override; repeatable
  --model-overrides <json|path>   JSON object, e.g. '{"explore":"deepseek/deepseek-v4-flash"}'
  --agent-spec <json|path>        Agent spec JSON object or file path

Role shortcut options:
  ${Array.from(ROLE_FLAGS.keys()).join(', ')}

All other options are passed through to run-persistent.mjs.
`);
}

function readJsonValue(value, label) {
    const maybePath = path.resolve(process.cwd(), value);
    const raw = fs.existsSync(maybePath) ? fs.readFileSync(maybePath, 'utf8') : value;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('expected a JSON object');
        }
        return parsed;
    } catch (err) {
        throw new Error(`${label} must be a JSON object or path to one: ${err.message}`);
    }
}

function parseRoleModel(value) {
    const eq = value.indexOf('=');
    if (eq <= 0 || eq === value.length - 1) {
        throw new Error(`--role-model must use role=model format, got: ${value}`);
    }
    return [value.slice(0, eq).trim(), value.slice(eq + 1).trim()];
}

function parseArgs(argv) {
    const passThrough = [];
    const roleOverrides = {};
    let explicitOverrides = null;
    let agentSpec = null;

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        }
        if (arg === '--role-model') {
            const next = argv[++i];
            if (!next) throw new Error('--role-model requires role=model');
            const [role, model] = parseRoleModel(next);
            roleOverrides[role] = model;
            continue;
        }
        if (arg === '--model-overrides' || arg === '--local-overrides') {
            const next = argv[++i];
            if (!next) throw new Error(`${arg} requires JSON or a file path`);
            explicitOverrides = readJsonValue(next, arg);
            continue;
        }
        if (arg === '--agent-spec') {
            const next = argv[++i];
            if (!next) throw new Error('--agent-spec requires JSON or a file path');
            agentSpec = readJsonValue(next, arg);
            continue;
        }
        if (ROLE_FLAGS.has(arg)) {
            const next = argv[++i];
            if (!next) throw new Error(`${arg} requires a model id`);
            roleOverrides[ROLE_FLAGS.get(arg)] = next;
            continue;
        }
        passThrough.push(arg);
    }

    return {
        passThrough,
        modelOverrides: {
            ...(explicitOverrides || {}),
            ...roleOverrides,
        },
        agentSpec,
    };
}

function main() {
    let parsed;
    try {
        parsed = parseArgs(process.argv);
    } catch (err) {
        process.stderr.write(`Error: ${err.message}\n`);
        usage();
        process.exit(2);
    }

    const env = { ...process.env };
    if (Object.keys(parsed.modelOverrides).length > 0) {
        env.KEPLER_BENCH_MODEL_OVERRIDES_JSON = JSON.stringify(parsed.modelOverrides);
    }
    if (parsed.agentSpec) {
        env.KEPLER_BENCH_AGENT_SPEC_JSON = JSON.stringify(parsed.agentSpec);
    }

    if (env.KEPLER_BENCH_MODEL_OVERRIDES_JSON) {
        process.stderr.write(`Model overrides: ${env.KEPLER_BENCH_MODEL_OVERRIDES_JSON}\n`);
    }
    if (env.KEPLER_BENCH_AGENT_SPEC_JSON) {
        process.stderr.write(`Agent spec: ${env.KEPLER_BENCH_AGENT_SPEC_JSON}\n`);
    }

    const child = spawn(process.execPath, [RUNNER, ...parsed.passThrough], {
        cwd: process.cwd(),
        env,
        stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 1);
    });
}

main();
