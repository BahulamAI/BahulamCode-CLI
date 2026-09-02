// Smoke test for the static requirements analyzer.
// Builds a fake pi package on disk with spawn(ffmpeg), process.env.FAKE_API_KEY,
// and a workspace-scoped path check. Verifies the analyzer detects each,
// writes the sidecar, formats a report, and that the scaffolder consumes
// the sidecar to inject a Requirements & constraints block into the
// generated agent's system prompt.
//
// Run: node test/pi-requirements-smoke.mjs

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reqs-'));
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

// ── Fake pi package: uses ffmpeg via spawn, reads an API key, enforces
// workspace-scoped paths. Includes a Requirements README section.
const piName = 'pi-fake-media';
const piDir = path.join(process.env.BAHULAM_HOME, 'plugins-pi', piName);
fs.mkdirSync(piDir, { recursive: true });
fs.writeFileSync(path.join(piDir, 'package.json'), JSON.stringify({
  name: piName,
  version: '1.0.0',
  main: 'index.mjs',
  type: 'module',
  optionalDependencies: { ffmpeg: '*' },
}, null, 2));

fs.mkdirSync(path.join(piDir, 'extensions'), { recursive: true });
fs.writeFileSync(path.join(piDir, 'extensions/tool.ts'), `
import { spawn } from 'node:child_process';
import { pi } from 'pi';

const API_KEY = process.env.FAKE_MEDIA_API_KEY;
const FFMPEG_PATH = process.env.PI_FAKE_FFMPEG_BINARY || 'ffmpeg';

pi.registerTool('render', {
  description: 'Render media using ffmpeg',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' },
      sourcePath: { type: 'string' },
    },
    required: ['projectId', 'sourcePath'],
  },
}, async (args) => {
  // Workspace-scope check
  if (!args.sourcePath.startsWith(ctx.cwd)) {
    throw new Error('Path is outside the workspace');
  }
  return new Promise((resolve) => {
    const child = spawn(FFMPEG_PATH, ['-i', args.sourcePath]);
    child.on('close', () => resolve({ output: 'rendered' }));
  });
});
`);

fs.writeFileSync(path.join(piDir, 'README.md'), `
# pi-fake-media

## Requirements

- ffmpeg installed on PATH
- FAKE_MEDIA_API_KEY env var for premium features

## Installation

npm install pi-fake-media
`);

fs.writeFileSync(path.join(piDir, 'index.mjs'), `
import def from './extensions/tool.ts';
export default def;
`);

// Fake tool cache to give tool_constraints something to work with.
const fakeTools = {
  tools: [
    {
      name: 'render',
      description: 'Render media using ffmpeg',
      input_schema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' },
          sourcePath: { type: 'string' },
        },
        required: ['projectId', 'sourcePath'],
      },
    },
  ],
  commands: [],
  discovered_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(piDir, '.bahulam-tools.json'), JSON.stringify(fakeTools));

// ── Run analyzer ──
const { analyzeRequirements, formatRequirementsReport, checkRequirementsAgainstHost, REQUIREMENTS_FILE } =
  await import(path.join(repoRoot, 'src/plugins/pi-compat/requirements.mjs'));

const reqs = analyzeRequirements(piDir, { discoveredTools: fakeTools });

ok('sidecar written to disk',       fs.existsSync(path.join(piDir, REQUIREMENTS_FILE)));
ok('detects ffmpeg binary',         reqs.system_binaries.some(b => b.name === 'ffmpeg'));
ok('ffmpeg has install hints',      reqs.system_binaries.find(b => b.name === 'ffmpeg')?.install_hints?.darwin?.includes('brew'));
ok('detects FAKE_MEDIA_API_KEY',    reqs.env_vars.some(v => v.name === 'FAKE_MEDIA_API_KEY'));
ok('flags API_KEY as credential',   reqs.env_vars.find(v => v.name === 'FAKE_MEDIA_API_KEY')?.credential === true);
ok('detects PI_FAKE_FFMPEG_BINARY', reqs.env_vars.some(v => v.name === 'PI_FAKE_FFMPEG_BINARY'));
ok('binary NOT flagged as cred',    reqs.env_vars.find(v => v.name === 'PI_FAKE_FFMPEG_BINARY')?.credential === false);
ok('detects workspace-scoped',      reqs.workspace_scoped_paths === true);
ok('README requirements section',   reqs.readme_sections.length > 0);
ok('README title contains "Req"',   /Req/i.test(reqs.readme_sections[0]?.title || ''));
ok('tool_constraints has render',   Boolean(reqs.tool_constraints?.render));
ok('render.projectId has regex',    Boolean(reqs.tool_constraints?.render?.projectId?.regex));

// ── Formatting ──
const lines = formatRequirementsReport(reqs, { verbose: false });
ok('report mentions system binaries', lines.some(l => l.text.includes('ffmpeg') && l.level === 'warn'));
ok('report mentions credential',      lines.some(l => l.text.includes('FAKE_MEDIA_API_KEY')));
ok('report mentions workspace',       lines.some(l => l.text.includes('workspace-relative')));

// ── Host check ──
const hc = checkRequirementsAgainstHost(reqs);
ok('host check runs binaries', hc.binaries.length >= 1);
ok('host check runs env vars', hc.env_vars.length >= 1);

// ── Scaffolder picks up sidecar → prompt injection ──
const { scaffoldPiPack } = await import(path.join(repoRoot, 'src/plugins/pi-compat/scaffold.mjs'));
const packsDir = path.join(process.env.BAHULAM_HOME, 'plugins');
fs.mkdirSync(packsDir, { recursive: true });
const scaffold = scaffoldPiPack({
  packageName: piName,
  versionRange: '^1.0.0',
  piDir,
  targetDir: packsDir,
  discoveredTools: fakeTools,
  state: true,
  workspace: true,
});
const manifest = fs.readFileSync(path.join(scaffold.dest, 'plugin.yaml'), 'utf-8');
ok('manifest mentions Requirements block',    /Requirements & constraints/.test(manifest));
ok('manifest lists ffmpeg + install hint',    /ffmpeg/i.test(manifest) && /brew install/.test(manifest));
ok('manifest lists API key credential',       /FAKE_MEDIA_API_KEY/.test(manifest));
ok('manifest lists workspace-scoped rule',    /workspace-relative/.test(manifest));
ok('manifest lists projectId regex',          /projectId.*must match/i.test(manifest) || /projectId.*regex/i.test(manifest) || /projectId.*\^\[a-z0-9-\]/.test(manifest));
ok('manifest lists required fields',          /render` requires: `projectId`, `sourcePath`/.test(manifest));
ok('required fields ahead of regex',          manifest.indexOf('render` requires') < manifest.indexOf('must match'));

// ── Host check: with an impossible binary, missing must be > 0 ──
const impossibleReqs = {
  system_binaries: [{ name: 'definitely-not-a-real-binary-xyz-42', install_hints: null }],
  env_vars: [],
};
const impHost = checkRequirementsAgainstHost(impossibleReqs);
ok('impossible binary reported missing', impHost.binaries[0]?.found === false);

// Cleanup
fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nall pi-requirements smoke tests passed');
}
