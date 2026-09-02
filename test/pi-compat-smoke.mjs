// End-to-end smoke test for pi compat.
// Uses a fake local pi package (no network) to prove every stage of the
// composition pipeline: shim intercepts `import { pi } from 'pi'`,
// probe captures tools, discovery caches to disk, composed tool
// invocation from our executor runs the pi handler and returns the
// result. Path: no fixtures on disk, everything built in a temp dir.
//
// Run: node test/pi-compat-smoke.mjs
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compat-'));
process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
// BAHULAM_HOME is the .bahulam root itself (see paths.mjs resolveHome).
process.env.BAHULAM_HOME = path.join(tmp, 'home', '.bahulam');

let failures = 0;
const ok = (label, cond) => {
  if (cond) console.log(`ok   ${label}`);
  else { failures++; console.error(`FAIL ${label}`); }
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${label}`);
  else { failures++; console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`); }
};

// ── Fake pi package on disk. This mimics what a real pi extension looks
// like: exports a module that, on load, calls pi.registerTool. Placed in
// ~/.bahulam/plugins-pi/ under a sanitized name matching what
// installFromPi would produce.
const piName = 'fake-pi-tool';
const piSafeName = piName; // no scope, so safe name == package name
const piDir = path.join(process.env.BAHULAM_HOME, 'plugins-pi', piSafeName);
fs.mkdirSync(piDir, { recursive: true });
fs.writeFileSync(path.join(piDir, 'package.json'), JSON.stringify({
  name: piName,
  version: '1.0.0',
  main: 'index.mjs',
  type: 'module',
}, null, 2));
fs.writeFileSync(path.join(piDir, 'index.mjs'), `
import { pi } from 'pi';
pi.registerTool('greet', {
  description: 'Say hello with a name',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] },
}, async (args) => {
  return { output: 'hello ' + (args.name || 'world') };
});
pi.registerTool('add', {
  description: 'Add two numbers',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
}, async ({ a, b }) => ({ output: String(Number(a) + Number(b)) }));
`);

// ── 1. Probe: the shim intercepts import 'pi' and captures registrations ──
const { probePiExtension, discoverPiTools, loadPiToolHandler } =
  await import(path.join(repoRoot, 'src/plugins/pi-compat/probe.mjs'));

{
  const captured = await probePiExtension(piDir, { pluginName: piName });
  eq('probe captures 2 tools', captured.tools.map(t => t.name).sort(), ['add', 'greet']);
  ok('probe has description on greet', captured.tools.find(t => t.name === 'greet').description === 'Say hello with a name');
  ok('probe input_schema pulled through', captured.tools.find(t => t.name === 'add').input_schema.required?.includes('a'));
}

// ── 2. Discover caches to .bahulam-tools.json ──
{
  const shape = await discoverPiTools(piDir, { pluginName: piName });
  ok('discovery cache written', fs.existsSync(path.join(piDir, '.bahulam-tools.json')));
  const shape2 = await discoverPiTools(piDir);
  eq('cache-hit returns same shape', shape2.tools.length, shape.tools.length);
}

// ── 3. Direct handler invocation via loadPiToolHandler ──
{
  const invoke = await loadPiToolHandler(piDir, 'greet', { pluginName: piName });
  const result = await invoke({ name: 'sree' });
  eq('direct greet', result, { success: true, output: 'hello sree' });
  const addInvoke = await loadPiToolHandler(piDir, 'add', { pluginName: piName });
  const addResult = await addInvoke({ a: 2, b: 3 });
  eq('direct add', addResult, { success: true, output: '5' });
}

// ── 4. Compose validation via pi-compose.mjs ──
const { parsePiSource, normalizeCompose, validateCompose, composedToolName } =
  await import(path.join(repoRoot, 'src/plugins/pi-compose.mjs'));
{
  const parsed = parsePiSource(`pi:${piName}@1.0.0`);
  ok('parsePiSource parses flat name', parsed && parsed.package_name === piName && parsed.version_range === '1.0.0');
  const bad = validateCompose(normalizeCompose({ source: 'not-a-pi-source', expose: ['x'] }, 0));
  ok('validateCompose rejects non-pi source', bad.errors.length > 0);
  const good = validateCompose(normalizeCompose({ source: `pi:${piName}@1.0.0`, as: 'fx', expose: ['greet', 'add'], verified: true }, 1));
  eq('validateCompose accepts verified compose', good.errors, []);
  eq('composedToolName namespaced', composedToolName({ as: 'fx' }, 'greet'), 'fx__greet');
  eq('composedToolName flat', composedToolName({ as: '' }, 'greet'), 'greet');
}

// ── 5. Registry + executor end-to-end: build a fake pack that composes
// our fake pi package, register through the tool executor, invoke via
// the executor's public `execute()`, verify the result flows back
// unchanged with attribution. ──
const packDir = path.join(tmp, 'test-pack');
fs.mkdirSync(path.join(packDir, 'tools'), { recursive: true });
fs.writeFileSync(path.join(packDir, 'plugin.yaml'), `apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: test-pack
  version: 0.0.1
  description: Composes the fake pi package for end-to-end verification.
spec:
  tools:
    - name: noop
      description: A native no-op tool.
      tool: ./tools/noop.mjs
      parameters: { type: object, properties: {} }
  composes:
    - source: pi:${piName}@1.0.0
      as: fx
      expose: [greet, add]
      verified: true
`);
fs.writeFileSync(path.join(packDir, 'tools', 'noop.mjs'), `
export async function call() { return { success: true, output: 'noop-ok' }; }
`);

const { PluginRegistry } = await import(path.join(repoRoot, 'src/plugins/registry.mjs'));
const registry = new PluginRegistry({ pluginDirs: [path.dirname(packDir)] });
registry.scan();

const tools = registry.listTools();
const composedGreet = tools.find(t => t.name === 'fx__greet');
ok('registry exposes fx__greet', !!composedGreet);
ok('fx__greet has _composed metadata', composedGreet?._composed?.kind === 'pi');
eq('fx__greet package_name', composedGreet?._composed?.package_name, piName);

const { createToolExecutor } = await import(path.join(repoRoot, 'src/core/tool-executor.mjs'));
const executor = createToolExecutor({ pluginRegistry: registry });
await executor.waitForAutoRegister?.();

{
  const result = await executor.execute('fx__greet', { name: 'sree' });
  ok('executor invokes composed pi tool', result?.success === true);
  ok('composed result carries pi output', String(result?.output || '').includes('hello sree'));
  ok('composed result tagged with _composed', result?._composed?.kind === 'pi');

  const addResult = await executor.execute('fx__add', { a: 4, b: 5 });
  ok('executor invokes second composed tool', addResult?.success === true);
  ok('composed add returned 9', String(addResult?.output || '').includes('9'));

  const nativeResult = await executor.execute('noop', {});
  ok('native pack tool still works alongside composed', nativeResult?.success === true);
}

// ── 6. Missing pi package returns a clear install hint ──
{
  const orphanPackDir = path.join(tmp, 'orphan-pack');
  fs.mkdirSync(path.join(orphanPackDir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(orphanPackDir, 'plugin.yaml'), `apiVersion: bahulam.plugin/1
kind: Plugin
metadata: { name: orphan-pack, version: 0.0.1, description: References an unknown pi package. }
spec:
  tools:
    - name: noop
      description: Native tool.
      tool: ./tools/noop.mjs
      parameters: { type: object, properties: {} }
  composes:
    - source: pi:@missing/package@1.0.0
      expose: [something]
      verified: true
`);
  fs.writeFileSync(path.join(orphanPackDir, 'tools', 'noop.mjs'),
    `export async function call() { return { success: true, output: 'ok' }; }`);
  const orphanRegistry = new PluginRegistry({ pluginDirs: [path.dirname(orphanPackDir)] });
  orphanRegistry.scan();
  const orphanExec = createToolExecutor({ pluginRegistry: orphanRegistry });
  await orphanExec.waitForAutoRegister?.();
  const result = await orphanExec.execute('something', {});
  ok('missing pi package surfaces actionable error', result?.success === false && String(result?.output).includes('not installed'));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log(`\nALL PI-COMPAT SMOKE TESTS PASSED`);
