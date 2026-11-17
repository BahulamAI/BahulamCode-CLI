import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const binary = fileURLToPath(new URL(`../rust/target/debug/bahulam-tui${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

test('standalone doctor is plain, reports hints honestly and never dumps unrelated environment', () => {
  const result = spawnSync(binary, ['--doctor','--json'], {encoding:'utf8', env:{...process.env,
    TERM:'xterm-256color', TERM_PROGRAM:'vscode', TERM_PROGRAM_VERSION:'fixture',
    NO_COLOR:'1', FORCE_COLOR:'3', BAHULAM_TUI_COLOR_LEVEL:'',
    SSH_CONNECTION:'SECRET_ADDRESS', API_KEY:'SECRET_TOKEN', TMUX:'SECRET_SOCKET',
  }});
  assert.equal(result.status,0,result.stderr);
  const caps = JSON.parse(result.stdout);
  assert.equal(caps.color_depth,'none');
  assert.equal(caps.interactive,false);
  assert.equal(caps.view,null);
  assert.equal(caps.mouse_capture,false);
  assert.equal(caps.bracketed_paste,false);
  assert.equal(caps.ssh,true);
  assert.equal(caps.tmux,true);
  assert.match(caps.detection,/active queries not implemented/);
  assert.doesNotMatch(result.stdout,/SECRET|\x1b/);
});

test('diagnostic flag does not start replay or change terminal modes', () => {
  const result=spawnSync(binary,['--doctor'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Bahulam terminal capabilities/);
  assert.doesNotMatch(result.stdout,/\x1b/);
  for(const args of [['--json'],['--doctor','--stdio'],['--doctor','--replay','missing.jsonl']]) {
    const invalid=spawnSync(binary,args,{encoding:'utf8'});
    assert.notEqual(invalid.status,0);
    assert.doesNotMatch(invalid.stdout,/\x1b/);
  }
});
