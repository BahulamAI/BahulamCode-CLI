import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWorkScope, promptProjectRoots, summarizeWorkScope } from '../src/core/work-scope.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-work-scope-'));
const rawCli = path.join(root, 'codekepler-npm');
const rawBackend = path.join(root, 'codekepler-backend');
fs.mkdirSync(path.join(rawCli, '.bahulam'), { recursive: true });
fs.mkdirSync(path.join(rawBackend, '.git'), { recursive: true });
const cli = fs.realpathSync(rawCli);
const backend = fs.realpathSync(rawBackend);
fs.writeFileSync(path.join(cli, 'package.json'), '{"name":"cli"}\n');
fs.writeFileSync(path.join(backend, 'app.py'), 'print("ok")\n');

try {
    const instruction = `Check "${path.join(backend, 'app.py')}" and keep CLI aligned.`;
    const resources = [{
        project_id: 'abc123',
        root: backend,
        name: 'codekepler-backend',
        index_version: 'v1',
    }];

    const scope = buildWorkScope({
        instruction,
        cwd: cli,
        projectResources: resources,
    });
    const again = buildWorkScope({
        instruction,
        cwd: cli,
        projectResources: resources,
    });

    assert.equal(scope.schema, 'kepler.work_scope/1');
    assert.equal(scope.primary_root, cli);
    assert.equal(scope.cache_policy.stable_system, false);
    assert.equal(scope.cache_policy.placement, 'pinned_context');
    assert.equal(scope.version, again.version);
    assert.deepEqual(
        scope.active_roots.map(root => root.path),
        [cli, backend],
    );
    assert.equal(scope.active_roots.find(root => root.path === backend).source, 'prompt');
    assert.equal(scope.workspace_resources[0].project_id, 'abc123');
    assert.match(summarizeWorkScope(scope), /codekepler-backend/);

    const pasted = buildWorkScope({
        instruction: `${backend} should be checked too`,
        cwd: cli,
    });
    assert.ok(pasted.active_roots.some(root => root.path === backend));

    const spacedParent = path.join(root, 'Tarang Orca');
    const docsRaw = path.join(spacedParent, 'appstak-platform', 'apps', 'kepler-docs');
    const npmRaw = path.join(spacedParent, 'codekepler-npm');
    fs.mkdirSync(path.join(docsRaw, '.git'), { recursive: true });
    fs.mkdirSync(path.join(npmRaw, '.git'), { recursive: true });
    const docs = fs.realpathSync(docsRaw);
    const npm = fs.realpathSync(npmRaw);
    const routed = promptProjectRoots(`Docs '${docs}' should match CLI '${npm}'`);
    assert.deepEqual(routed, [docs, npm]);

    console.log('  \x1b[32m✓\x1b[0m work scope derives active roots and stable cache metadata');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
