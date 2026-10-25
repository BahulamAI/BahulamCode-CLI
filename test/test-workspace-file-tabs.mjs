import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/local-service/workspace-file-tabs.js', import.meta.url), 'utf8');
const ensureWorkspaceFileTab = vm.runInNewContext(`${source}\nensureWorkspaceFileTab`, {});
const tabs = [{ path: 'plugin://example/view', name: 'Plugin' }];

for (const path of ['src/one.js', 'src/two.js', 'src/three.js']) {
  ensureWorkspaceFileTab(tabs, path);
}
assert.deepEqual(tabs.map(tab => tab.path), [
  'plugin://example/view', 'src/one.js', 'src/two.js', 'src/three.js',
]);

for (const path of ['src/two.js', 'src/one.js', 'src/three.js']) {
  ensureWorkspaceFileTab(tabs, path);
}
assert.deepEqual(tabs.map(tab => tab.path), [
  'plugin://example/view', 'src/one.js', 'src/two.js', 'src/three.js',
]);

console.log('workspace explorer keeps one tab per selected file');
