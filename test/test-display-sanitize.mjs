import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sanitizeDisplayValue,stripTerminalControls} from '../src/core/display-sanitize.mjs';

test('display sanitization preserves source execution/history data', () => {
 const source={name:'write_file',args:{path:'/project/.env.local',content:'TEST_PASSWORD=fake-secret'},text:'hello\x1b]52;c;evil\x07world\nline',authorization:'fake-auth'};
 const before=JSON.stringify(source);const copy=sanitizeDisplayValue(source);
 assert.equal(JSON.stringify(source),before);
 assert.equal(copy.args.content,'[redacted sensitive config]');
 assert.equal(copy.authorization,'[REDACTED]');
 assert.equal(copy.text,'helloworld\nline');
 assert.equal(stripTerminalControls('a\x1b[31mb\x1b[0m\tend'),'ab\tend');
 assert.equal(Object.getPrototypeOf(copy),null);
});
