import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/local-service/workspace-voice.js', import.meta.url), 'utf8');
const speechTranscript = vm.runInNewContext(`${source}\nspeechTranscript`, {});
const result = transcript => [{ transcript }];

const first = { resultIndex: 0, results: [result('Create a page')] };
const next = { resultIndex: 1, results: [result('Create a page'), result(' with a chart')] };
const revised = { resultIndex: 1, results: [result('Create a page'), result(' with a chart please.')] };

assert.equal(speechTranscript(first), 'Create a page');
assert.equal(speechTranscript(next), 'Create a page with a chart');
assert.equal(speechTranscript(revised), 'Create a page with a chart please.');
assert.equal(['Existing prompt', speechTranscript(next)].join(' '), 'Existing prompt Create a page with a chart');

console.log('workspace voice transcript preserves earlier speech results');
