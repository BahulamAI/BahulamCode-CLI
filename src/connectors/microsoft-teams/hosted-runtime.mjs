import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePluginManifestFile, validatePluginManifest } from '../../plugins/manifest.mjs';
import { dispatch } from '../../orchestration/dispatch.mjs';
import { ADO_REVIEW_OPERATIONS } from '../azure-devops-broker.mjs';

const worker = fileURLToPath(new URL('./hosted-worker.mjs', import.meta.url));
export function adoPluginDigest(pluginDir) {
  const root = fs.realpathSync(pluginDir);
  const files = ['plugin.yaml', 'config/workspace.yaml'];
  function visit(relative) {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Hosted plugins cannot contain symlinks.');
      const name = `${relative}/${item.name}`;
      if (item.isDirectory()) visit(name); else files.push(name);
    }
  }
  visit('tools');
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    if (!fs.realpathSync(path.join(root, file)).startsWith(root + path.sep)) throw new Error('Plugin path escapes root.');
    const body = fs.readFileSync(path.join(root, file));
    hash.update(JSON.stringify([file, body.length]) + '\n'); hash.update(body);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function executeHostedTool({ pluginDir, definition, args, connectionId, invoke, signal }) {
  const root = fs.realpathSync(pluginDir);
  const modulePath = fs.realpathSync(path.resolve(root, definition.tool));
  if (!modulePath.startsWith(root + path.sep) || !ADO_REVIEW_OPERATIONS.includes(definition.name)) throw new Error('Hosted tool denied.');
  return new Promise((resolve, reject) => {
    let finished = false, invoked = false;
    const child = fork(worker, [], { env: { NODE_ENV: 'production' },
      execArgv: ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${worker}`],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); child.kill();
      error ? reject(new Error(error)) : resolve(result);
    };
    const abort = () => finish('ADO request cancelled.');
    const timer = setTimeout(() => finish('ADO tool timed out; check before retrying a write.'), 65000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish('ADO worker unavailable.'));
    child.on('exit', () => finish('ADO worker exited.'));
    child.on('message', async message => {
      if (finished) return;
      if (message.type === 'result') return finish(message.error, message.result);
      if (message.type !== 'invoke' || invoked || message.operation !== definition.name) return finish('ADO worker operation denied.');
      invoked = true;
      try {
        const result = await invoke({ connectionId, operation: definition.name, args: message.args, signal });
        if (!finished) child.send({ result });
      } catch { if (!finished) child.send({ error: true }); }
    });
    if (signal?.aborted) abort();
    else child.send({ modulePath, operation: definition.name, args, connectionId });
  });
}

export function loadHostedRuntime({ pluginDir, expectedDigest, credentials, model, dispatchOverride = dispatch }) {
  if (!expectedDigest || adoPluginDigest(pluginDir) !== expectedDigest) throw new Error('ADO plugin digest mismatch.');
  const manifest = parsePluginManifestFile(path.join(pluginDir, 'plugin.yaml'));
  if (validatePluginManifest(manifest).errors?.length) throw new Error('Invalid ADO plugin.');
  const definitions = manifest.config.tools.filter(t => ADO_REVIEW_OPERATIONS.includes(t.name));
  if (definitions.length !== ADO_REVIEW_OPERATIONS.length) throw new Error('Hosted ADO tools are incomplete.');
  const agent = { ...manifest.config.agents.find(a => a.entry_agent), max_iterations: 10,
    tools: [...ADO_REVIEW_OPERATIONS] };
  return async ({ text, sessionId, connectionId, invoke, signal }) => {
    // Immutable deployment required; reject edits between startup and each run.
    if (adoPluginDigest(pluginDir) !== expectedDigest) throw new Error('ADO plugin changed.');
    let usage;
    const outcome = await dispatchOverride({ type: 'invoke', source: 'microsoft-teams',
      target: { kind: 'agent', slug: agent.slug, agent }, params: { instruction: text }, channel: 'local', substrate: 'direct', signal }, {
      toolExecutor: {
        listPluginToolSchemas: () => definitions.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        async execute(name, args) {
          const definition = definitions.find(t => t.name === name);
          if (!definition) return { success: false, output: 'Tool denied.' };
          try { return { success: true, output: await executeHostedTool({ pluginDir, definition, args, connectionId, invoke, signal }) }; }
          catch { return { success: false, output: 'ADO operation failed. Check connection and approval status before retrying.' }; }
        },
      }, listRunnables: () => [agent], credentials, defaultModel: model, sessionId, cwd: pluginDir,
      renderEvent: event => { if (event.type === 'complete' && event.data?.usage?.models) usage = event.data.usage; },
    });
    if (!outcome.dispatched || !usage?.models) throw new Error('Runtime did not report billable usage.');
    return { output: outcome.result.status === 'failed' ? 'The review did not complete. Check connection status before retrying.' : outcome.result.output,
      usage: { models_breakdown: usage.models } };
  };
}
