import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillInstaller } from '../src/skills/installer.mjs';
import { SkillsLoader } from '../src/skills/loader.mjs';
import { createToolExecutor } from '../src/core/tool-executor.mjs';

function writeSkill(root, name, description, marker) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${name}
description: ${description}
compatibility:
  - claude-code
---
# Procedure

Use ${marker}.
`, 'utf-8');
    fs.writeFileSync(path.join(dir, 'references', 'guide.md'), `${marker} reference`, 'utf-8');
    return dir;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-skills-test-'));
const home = path.join(root, 'home');
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });

try {
    writeSkill(path.join(home, '.claude', 'skills'), 'review', 'Global review', 'global');
    writeSkill(path.join(project, '.kepler', 'skills'), 'review', 'Project review', 'project');

    const loader = new SkillsLoader({ homeDir: home }).load(project);
    const rows = loader.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, 'Project review');
    assert.deepEqual(rows[0].shadowed_sources, ['claude-global:review']);
    assert.match(loader.view('review').instructions, /Use project/);
    assert.equal(
        loader.view('review', 'references/guide.md').content,
        'project reference',
    );
    assert.throws(() => loader.view('review', '../outside.txt'), /escapes/);
    assert.match(
        loader.view('review', null, { sourceId: 'claude-global:review' }).instructions,
        /Use global/,
    );

    const source = path.join(root, 'vendor-source');
    writeSkill(path.join(source, 'skills'), 'vendor-skill', 'Vendor procedure', 'vendor');
    const installer = new SkillInstaller({ cwd: project, homeDir: home });
    const executor = createToolExecutor({ skillsLoader: loader, skillInstaller: installer });
    const installed = await executor.execute('skill_install', { source, scope: 'global' });
    assert.equal(installed.success, true);
    assert.deepEqual(installed.installed, ['vendor-skill']);
    assert.ok(installer.lock('global').skills['vendor-skill']);
    assert.equal(loader.get('vendor-skill').source, 'kepler-global');

    const listed = await executor.execute('skills_list', { query: 'vendor' });
    assert.equal(listed.success, true);
    assert.equal(listed.skills[0].name, 'vendor-skill');
    const viewed = await executor.execute('skill_view', { name: 'vendor-skill' });
    assert.match(viewed.skill.instructions, /Use vendor/);

    writeSkill(path.join(source, 'skills'), 'vendor-skill', 'Vendor procedure', 'updated');
    const updated = await executor.execute('skill_update', { name: 'vendor-skill', scope: 'global' });
    assert.equal(updated.success, true);
    const viewedUpdated = await executor.execute('skill_view', { name: 'vendor-skill' });
    assert.match(viewedUpdated.skill.instructions, /Use updated/);

    const removed = await executor.execute('skill_remove', { name: 'vendor-skill', scope: 'global' });
    assert.equal(removed.success, true);
    assert.equal(fs.existsSync(path.join(home, '.kepler', 'skills', 'vendor-skill')), false);
    console.log('Skills tests passed');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
