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

console.log('test-stagnation.mjs: passed');
