#!/usr/bin/env node
// PRD-091 Phase 0 — thin-CLI latency probe.
//
// Purpose:
//   Validate that a local agent loop calling a server-side /v1/agent/turn
//   per iteration is fast enough to be usable. Success bar per PRD-091 §7
//   Phase 0: p50 turn overhead < 200ms, p99 < 500ms (excluding LLM time).
//
// Usage:
//   BAHULAM_GATEWAY_URL=http://127.0.0.1:8180 \
//   BAHULAM_API_KEY=svc_your_local_service_token \
//   node test/phase0-latency-probe.mjs
//
// The probe runs N canned prompts through the full loop
// (send messages → get tool_calls → exec bash locally → send results → repeat)
// and reports per-turn timing + p50/p99 aggregates.
//
// This is a scratch script, not part of the shipped CLI. Delete once
// Phase 0 wraps.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

const exec = promisify(execCb);

const GATEWAY = (process.env.BAHULAM_GATEWAY_URL || 'http://127.0.0.1:8180').replace(/\/+$/, '');
const API_KEY = process.env.BAHULAM_API_KEY;
const MODEL = process.env.BAHULAM_MODEL || undefined;
const MAX_ITERS_PER_PROMPT = 5;

if (!API_KEY) {
  console.error('ERROR: BAHULAM_API_KEY env var required.');
  console.error('       For local testing use a service token: BAHULAM_API_KEY=svc_local ...');
  process.exit(2);
}

const PROMPTS = [
  'List the current directory.',
  'How many .py files are in the current directory (top level only)?',
  'What is the last modified file in this directory?',
  'Print the current date.',
  'How many lines are in package.json?',
];

// ── Turn call ───────────────────────────────────────────────────────────

async function callTurn(messages, toolResults) {
  const t0 = performance.now();
  const body = { messages, ...(toolResults ? { tool_results: toolResults } : {}), ...(MODEL ? { model: MODEL } : {}) };
  const res = await fetch(`${GATEWAY}/v1/agent/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'X-Bahulam-User-Id': 'phase0-probe',
      'X-Bahulam-Tier': 'free',
    },
    body: JSON.stringify(body),
  });
  const t1 = performance.now();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return { data, roundTripMs: t1 - t0 };
}

async function runBash(command) {
  try {
    const { stdout, stderr } = await exec(command, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
  } catch (e) {
    return `[bash error] ${e.message || String(e)}`;
  }
}

// ── Run one prompt end-to-end ───────────────────────────────────────────

async function runPrompt(prompt) {
  let messages = [{ role: 'user', content: prompt }];
  let toolResults = null;
  const turns = [];
  for (let iter = 0; iter < MAX_ITERS_PER_PROMPT; iter++) {
    const { data, roundTripMs } = await callTurn(messages, toolResults);
    const overhead = roundTripMs - (data.timing_ms?.llm || 0);
    turns.push({
      roundTripMs,
      llmMs: data.timing_ms?.llm || 0,
      overheadMs: overhead,
      serverTotalMs: data.timing_ms?.total || 0,
      done: data.done,
      toolCallCount: data.tool_calls?.length || 0,
    });
    messages = [...messages, ...data.messages];
    if (data.done) return { prompt, turns, final: data.messages.at(-1)?.content || '' };
    toolResults = [];
    for (const tc of data.tool_calls || []) {
      const cmd = tc.input?.command || '';
      const output = await runBash(cmd);
      toolResults.push({ tool_call_id: tc.id, output: output.slice(0, 4000) });
    }
  }
  return { prompt, turns, final: '(max iterations reached)' };
}

// ── Stats ──────────────────────────────────────────────────────────────

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100));
  return sorted[i];
}

function report(allTurns) {
  const overheads = allTurns.map(t => t.overheadMs).filter(n => n >= 0).sort((a, b) => a - b);
  const roundTrips = allTurns.map(t => t.roundTripMs).sort((a, b) => a - b);
  const llms = allTurns.map(t => t.llmMs).sort((a, b) => a - b);
  const fmt = (n) => `${n.toFixed(1)}ms`;
  console.log(`\n═══ Phase 0 latency (${allTurns.length} turns) ═══`);
  console.log(`  Overhead (round-trip minus LLM):  p50=${fmt(pct(overheads, 50))}  p95=${fmt(pct(overheads, 95))}  p99=${fmt(pct(overheads, 99))}`);
  console.log(`  Full round-trip (client→gateway→LLM→client):  p50=${fmt(pct(roundTrips, 50))}  p95=${fmt(pct(roundTrips, 95))}  p99=${fmt(pct(roundTrips, 99))}`);
  console.log(`  LLM time (upstream only):  p50=${fmt(pct(llms, 50))}  p95=${fmt(pct(llms, 95))}  p99=${fmt(pct(llms, 99))}`);
  const p50o = pct(overheads, 50), p99o = pct(overheads, 99);
  const pass50 = p50o < 200, pass99 = p99o < 500;
  console.log(`\n  PRD-091 target: p50 overhead < 200ms, p99 < 500ms`);
  console.log(`    p50 ${pass50 ? '✓ PASS' : '✗ FAIL'}   p99 ${pass99 ? '✓ PASS' : '✗ FAIL'}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`Phase 0 probe — gateway=${GATEWAY}  model=${MODEL || '(gateway default)'}`);
  const allTurns = [];
  for (const [i, prompt] of PROMPTS.entries()) {
    console.log(`\n[${i + 1}/${PROMPTS.length}] ${prompt}`);
    try {
      const { turns, final } = await runPrompt(prompt);
      allTurns.push(...turns);
      turns.forEach((t, j) => {
        console.log(`  turn ${j + 1}:  rt=${t.roundTripMs.toFixed(1)}ms  llm=${t.llmMs.toFixed(1)}ms  overhead=${t.overheadMs.toFixed(1)}ms  tools=${t.toolCallCount}  ${t.done ? '✓ done' : ''}`);
      });
      console.log(`  → ${final.slice(0, 120)}${final.length > 120 ? '…' : ''}`);
    } catch (e) {
      console.log(`  ✗ ${e.message}`);
    }
  }
  report(allTurns);
}

main().catch(err => { console.error(err); process.exit(1); });
