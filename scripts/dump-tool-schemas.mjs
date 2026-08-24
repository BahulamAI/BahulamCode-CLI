#!/usr/bin/env node
// PRD-091 — dump built-in tool schemas as JSON so the gateway can advertise
// them 1:1 to the model without reimplementing schema shapes server-side.
//
// Usage:
//   node scripts/dump-tool-schemas.mjs > tool-schemas.json
//
// Reads src/tools/registry.mjs's BUILTIN_TOOLS list, emits an array of
// OpenAI-shape function tools. Also emits a Bahulam-shape metadata block
// per tool (client_execution / server_execution) so the gateway knows
// which tools it should dispatch server-side (meta-tools/subagents) vs
// which the client executes locally (bash, read_file, etc.).

import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(HERE, '..', 'src', 'tools');

// Server-dispatched tools — the client-side .call() is a stub; real work
// happens at gateway /v1/agent/subagent. Everything else is client-local.
const SERVER_DISPATCHED = new Set([
  'explore', 'plan', 'verify', 'debug', 'refactor',
]);

async function main() {
  const files = readdirSync(TOOLS_DIR)
    .filter(f => f.endsWith('.mjs') && f !== 'registry.mjs' && f !== 'tool-executor.mjs');

  const out = [];
  for (const file of files) {
    const url = pathToFileURL(join(TOOLS_DIR, file)).href;
    let mod;
    try { mod = await import(url); }
    catch (e) { process.stderr.write(`  skip ${file}: ${e.message}\n`); continue; }
    for (const [exportName, exportVal] of Object.entries(mod)) {
      if (!exportVal || typeof exportVal !== 'object') continue;
      if (!exportVal.name || !exportVal.inputSchema) continue;
      const dispatch = SERVER_DISPATCHED.has(exportVal.name) ? 'server' : 'client';
      out.push({
        type: 'function',
        function: {
          name: exportVal.name,
          description: exportVal.description || '',
          parameters: exportVal.inputSchema,
        },
        bahulam: {
          dispatch,
          source_file: `src/tools/${file}`,
          source_export: exportName,
        },
      });
    }
  }
  // Stable sort so diffs stay readable
  out.sort((a, b) => a.function.name.localeCompare(b.function.name));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`  ✓ dumped ${out.length} tool schemas\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
