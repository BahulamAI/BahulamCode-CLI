// Smoke test for the pi-pack scaffolder.
// Builds a fake pi ingredient on disk, runs the scaffolder, verifies:
//   - generated pack directory has plugin.yaml, config/workspace.yaml, tools/, workspace/
//   - manifest declares composes with the expected namespace and expose list
//   - preflight accepts the generated pack
//
// Run: node test/pi-scaffold-smoke.mjs

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scaffold-'));
process.env.BAHULAM_HOME = path.join(tmp, 'home', '.bahulam');
process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';

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

// ── Fake pi ingredient: two registered tools, no ceremony. Mirrors the
// shape a real pi package would leave in ~/.bahulam/plugins-pi/.
const piName = 'pi-web-access';
const piDir = path.join(process.env.BAHULAM_HOME, 'plugins-pi', piName);
fs.mkdirSync(piDir, { recursive: true });
fs.writeFileSync(path.join(piDir, 'package.json'), JSON.stringify({
  name: piName,
  version: '0.27.0',
  main: 'index.mjs',
  type: 'module',
}, null, 2));
fs.writeFileSync(path.join(piDir, 'index.mjs'), `
import { pi } from 'pi';
pi.registerTool('web_search', {
  description: 'Search the web',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}, async (args) => ({ output: 'searched ' + args.query }));
pi.registerTool('fetch_content', {
  description: 'Fetch a URL',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
}, async (args) => ({ output: 'fetched ' + args.url }));
`);

// Prime the tools cache the scaffolder reads.
const { discoverPiTools } = await import(path.join(repoRoot, 'src/plugins/pi-compat/probe.mjs'));
const discovered = await discoverPiTools(piDir, { pluginName: piName });
ok('probe found 2 tools', discovered.tools.length === 2);

// ── Scaffold ──
const { scaffoldPiPack, deriveSlug, deriveNamespace } =
  await import(path.join(repoRoot, 'src/plugins/pi-compat/scaffold.mjs'));

eq('deriveSlug returns package name as-is', deriveSlug('pi-web-access'), 'pi-web-access');
eq('deriveSlug strips npm scope',           deriveSlug('@ffmpeg/transitions'), 'transitions');
eq('deriveSlug does NOT append suffix',     /studio|pack$|-plugin$/.test(deriveSlug('pi-web-access')), false);
eq('deriveNamespace strips pi-',   deriveNamespace('pi-web-access'), 'web');
ok('deriveNamespace scoped shape', /^transit/.test(deriveNamespace('@ffmpeg/transitions')));

const packsDir = path.join(process.env.BAHULAM_HOME, 'plugins');
fs.mkdirSync(packsDir, { recursive: true });
const result = scaffoldPiPack({
  packageName: piName,
  versionRange: '^0.27.0',
  piDir,
  targetDir: packsDir,
  discoveredTools: discovered,
  state: true,
  workspace: true,
});
ok('scaffold returned dest',       fs.existsSync(result.dest));
ok('plugin.yaml written',          fs.existsSync(path.join(result.dest, 'plugin.yaml')));
ok('workspace agent yaml written', fs.existsSync(path.join(result.dest, 'config/workspace.yaml')));
ok('save-item.mjs written',        fs.existsSync(path.join(result.dest, 'tools/save-item.mjs')));
ok('list-items.mjs written',       fs.existsSync(path.join(result.dest, 'tools/list-items.mjs')));
ok('drop-item.mjs written',        fs.existsSync(path.join(result.dest, 'tools/drop-item.mjs')));
ok('workspace panel.html written', fs.existsSync(path.join(result.dest, 'workspace/panel.html')));
eq('slug derived',                 result.slug, 'pi-web-access');
eq('namespace derived',            result.namespace, 'web');
eq('expose list matches tools',    result.exposeTools.sort(), ['fetch_content', 'web_search']);

// ── Manifest sanity: composes block wired, entry agent has both native+composed tools ──
const manifestText = fs.readFileSync(path.join(result.dest, 'plugin.yaml'), 'utf-8');
const agentText = fs.readFileSync(path.join(result.dest, 'config/workspace.yaml'), 'utf-8');
ok('manifest declares pi source',   /source:\s+pi:pi-web-access@\^0\.27\.0/.test(manifestText));
ok('manifest namespace is web',     /as:\s+web/.test(manifestText));
ok('manifest exposes web_search',      /-\s+web_search/.test(manifestText));
ok('manifest points to workspace agent', /workspace:\s+\.\/config\/workspace\.yaml/.test(manifestText));
ok('manifest has no inline agents',    !/^\s+agents:/m.test(manifestText));
ok('agent is framework yaml',          /apiVersion:\s+agent\.framework\/v1/.test(agentText));
ok('agent has metadata slug',          /metadata:\n\s+slug:\s+web-specialist/.test(agentText));
ok('agent prompt is under agent block', /agent:\n(?:.*\n)*?\s+system_prompt:/m.test(agentText));
ok('agent grants web__web_search',     /-\s+web__web_search/.test(agentText));
ok('agent does not use dot separator', !/-\s+web\.web_search/.test(agentText));
ok('agent grants native save_item',    /-\s+save_item/.test(agentText));

// ── Pure-composition variant (no state, no workspace) ──
const thinResult = scaffoldPiPack({
  packageName: piName,
  versionRange: '^0.27.0',
  piDir,
  targetDir: packsDir,
  discoveredTools: discovered,
  state: false,
  workspace: false,
  slug: 'web-thin',
});
ok('thin pack: no tools dir',       !fs.existsSync(path.join(thinResult.dest, 'tools')));
ok('thin pack: no workspace dir',   !fs.existsSync(path.join(thinResult.dest, 'workspace')));
ok('thin pack: workspace yaml written', fs.existsSync(path.join(thinResult.dest, 'config/workspace.yaml')));
const thinManifest = fs.readFileSync(path.join(thinResult.dest, 'plugin.yaml'), 'utf-8');
ok('thin pack: empty tools block',  /tools:\s*\[\]/.test(thinManifest));
ok('thin pack: still composes',     /source:\s+pi:pi-web-access@\^0\.27\.0/.test(thinManifest));
ok('thin pack: points to workspace agent', /workspace:\s+\.\/config\/workspace\.yaml/.test(thinManifest));

// ── Preflight the generated packs (this is the acceptance gate that
// `bahulam install` will run against every generated pack). ──
const { preflightPlugin } = await import(path.join(repoRoot, 'src/plugins/preflight.mjs'));
{
  const pre = await preflightPlugin(result.dest, { existingPluginNames: () => [] });
  ok('generated pack passes preflight', pre.ok === true);
  if (!pre.ok) console.error('  errors:', pre.errors);
}
{
  const pre = await preflightPlugin(thinResult.dest, { existingPluginNames: () => [] });
  ok('thin pack passes preflight',       pre.ok === true);
  if (!pre.ok) console.error('  errors:', pre.errors);
}

// Cleanup
fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nall pi-scaffold smoke tests passed');
}
