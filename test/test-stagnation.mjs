import assert from 'node:assert';
import {
    createStagnationTracker,
    stagnationMessage,
} from '../src/core/stagnation.mjs';
import { LocalAgent } from '../src/core/local-agent.mjs';

const tracker = createStagnationTracker({ threshold: 3 });
assert.deepStrictEqual(tracker.record('read_file', { file_path: 'a.js' }), {
    detected: false,
    count: 1,
});
assert.deepStrictEqual(tracker.record('read_file', { file_path: 'a.js' }), {
    detected: false,
    count: 2,
});
assert.deepStrictEqual(tracker.record('read_file', { file_path: 'b.js' }), {
    detected: false,
    count: 1,
});
assert.deepStrictEqual(tracker.record('read_file', { file_path: 'a.js' }), {
    detected: false,
    count: 1,
});

tracker.record('shell', { command: 'npm test' });
tracker.record('shell', { command: 'npm test' });
assert.deepStrictEqual(tracker.record('shell', { command: 'npm test' }), {
    detected: true,
    count: 3,
});

const reordered = createStagnationTracker({ threshold: 2 });
reordered.record('search_code', { path: 'src', pattern: 'foo' });
assert.deepStrictEqual(
    reordered.record('search_code', { pattern: 'foo', path: 'src' }),
    { detected: true, count: 2 },
);

const disabled = createStagnationTracker({ enabled: false });
for (let i = 0; i < 5; i++) {
    assert.deepStrictEqual(disabled.record('read_file', { file_path: 'a.js' }), {
        detected: false,
        count: 0,
    });
}

const invalidThreshold = createStagnationTracker({ threshold: Number.NaN });
invalidThreshold.record('read_file', { file_path: 'a.js' });
invalidThreshold.record('read_file', { file_path: 'a.js' });
assert.deepStrictEqual(
    invalidThreshold.record('read_file', { file_path: 'a.js' }),
    { detected: true, count: 3 },
);

assert.match(stagnationMessage('shell', 3), /duplicate call was skipped/i);

const noChangeEdits = createStagnationTracker({ threshold: 2 });
assert.deepStrictEqual(
    noChangeEdits.recordResult(
        'edit_file',
        { file_path: 'src/a.py', search: 'old', replace: 'new' },
        { success: false, _no_change: true },
    ),
    { detected: false, count: 1, kind: 'no_change_edit', target: 'src/a.py' },
);
assert.deepStrictEqual(
    noChangeEdits.recordResult(
        'edit_file',
        { file_path: 'src/a.py', search: 'different old', replace: 'different new' },
        { success: false, _no_change: true },
    ),
    { detected: true, count: 2, kind: 'no_change_edit', target: 'src/a.py' },
);
assert.match(
    stagnationMessage('edit_file', 2, { kind: 'no_change_edit', target: 'src/a.py' }),
    /made no file changes/i,
);

const noChangeReset = createStagnationTracker({ threshold: 2 });
noChangeReset.recordResult('edit_file', { file_path: 'src/a.py' }, { success: false, _no_change: true });
assert.deepStrictEqual(
    noChangeReset.recordResult('read_file', { file_path: 'src/a.py' }, { success: true, output: 'contents' }),
    { detected: false, count: 0 },
);
assert.deepStrictEqual(
    noChangeReset.recordResult('edit_file', { file_path: 'src/a.py' }, { success: false, _no_change: true }),
    { detected: false, count: 1, kind: 'no_change_edit', target: 'src/a.py' },
);

const responses = [
    {
        content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { file_path: 'a.js' } }],
        stopReason: 'tool_use',
    },
    {
        content: [{ type: 'tool_use', id: 'call-2', name: 'read_file', input: { file_path: 'a.js' } }],
        stopReason: 'tool_use',
    },
    {
        content: [{ type: 'tool_use', id: 'call-3', name: 'read_file', input: { file_path: 'a.js' } }],
        stopReason: 'tool_use',
    },
    {
        content: [{ type: 'text', text: 'Finished after changing approach.' }],
        stopReason: 'end_turn',
    },
];
const localAgent = new LocalAgent({
    apiKey: 'test',
    maxTurns: responses.length,
    stagnationDetection: true,
    toolExecutor: {
        async execute() {
            return { success: true, output: 'file contents' };
        },
    },
});
localAgent.retriever.retrieve = () => [];
localAgent._callLLM = async () => responses.shift();

const events = [];
for await (const event of localAgent.execute('inspect a.js')) events.push(event);
assert.ok(events.some(event => event.type === 'stagnation'));
assert.ok(events.some(event => event.type === 'complete' && event.data.summary === 'Done (local)'));
assert.ok(!events.some(event => event.type === 'complete' && /stagnation/i.test(event.data.summary)));

const noChangeResponses = [
    {
        content: [{ type: 'tool_use', id: 'edit-1', name: 'edit_file', input: { file_path: 'a.js', search: 'old', replace: 'new' } }],
        stopReason: 'tool_use',
    },
    {
        content: [{ type: 'tool_use', id: 'edit-2', name: 'edit_file', input: { file_path: 'a.js', search: 'different', replace: 'newer' } }],
        stopReason: 'tool_use',
    },
    {
        content: [{ type: 'text', text: 'Finished after re-reading.' }],
        stopReason: 'end_turn',
    },
];
const noChangeAgent = new LocalAgent({
    apiKey: 'test',
    maxTurns: noChangeResponses.length,
    stagnationDetection: true,
    stagnationThreshold: 2,
    toolExecutor: {
        async execute() {
            return { success: false, output: 'edit_file made no changes', _no_change: true };
        },
    },
});
noChangeAgent.retriever.retrieve = () => [];
noChangeAgent._callLLM = async () => noChangeResponses.shift();

const noChangeEvents = [];
for await (const event of noChangeAgent.execute('edit a.js')) noChangeEvents.push(event);
assert.ok(noChangeEvents.some(event => event.type === 'stagnation' && event.data?.kind === 'no_change_edit'));
assert.ok(noChangeEvents.some(event => event.type === 'tool_done' && event.data?._stagnation));

console.log('test-stagnation.mjs: passed');
