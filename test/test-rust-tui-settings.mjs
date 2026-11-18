import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rustTuiEnvironment} from '../src/daemon/rust-tui-settings.mjs';
import {mergeBahulamShiftEnterKeybinding} from '../src/terminal/vscode-keybindings.mjs';
import {completeCliWords,generateShellCompletion} from '../src/terminal/shell-completions.mjs';

test('Rust theme settings preserve explicit environment priority and auto selection', () => {
 const layers=[{name:'project',data:{tui:{theme:'light'}}}];
 assert.equal(rustTuiEnvironment({env:{},layers}).BAHULAM_THEME,'light');
 assert.equal(rustTuiEnvironment({env:{BAHULAM_THEME:'dark'},layers}).BAHULAM_THEME,'dark');
 assert.equal(rustTuiEnvironment({env:{BAHULAM_THEME:'auto'},layers}).BAHULAM_THEME,'auto');
});

test('Rust settings preserve environment priority and do not mutate Node settings', () => {
 const env={BAHULAM_TUI_MODE:'fullscreen',BAHULAM_TUI_CAPABILITIES:'{"notifications":"off"}'};
 const before=structuredClone(env);
 const result=rustTuiEnvironment({env,userTui:{clipboard:'file',capabilities:{osc8_links:false}},layers:[{name:'project',data:{tui:{clipboard:'osc52',scroll_lines:2}}}]});
 assert.equal(result.BAHULAM_TUI_MODE,'fullscreen');
 assert.equal(result.BAHULAM_CLIPBOARD,'osc52');
 assert.equal(result.BAHULAM_TUI_SCROLL_LINES,'2');
 assert.deepEqual(JSON.parse(result.BAHULAM_TUI_CAPABILITIES),{osc8_links:false,notifications:'off'});
 assert.deepEqual(env,before);
 assert.equal(rustTuiEnvironment({env:{},layers:[]}).BAHULAM_TUI_MOUSE,'full');
});

test('terminal setup preserves JSONC and existing conflicts and is idempotent', () => {
 const original='[\n // existing bindings\n {"key":"ctrl+x","command":"custom"},\n]';
 const merged=mergeBahulamShiftEnterKeybinding(original);
 assert.equal(merged.reason,'added');
 assert.ok(merged.content.includes('// existing bindings'));
 assert.equal(mergeBahulamShiftEnterKeybinding(merged.content).reason,'already-installed');
 const conflict=mergeBahulamShiftEnterKeybinding('[{"key":"shift+enter","command":"custom","when":"terminalFocus"}]');
 assert.ok(conflict.conflicts.includes('shift+enter'));
});

test('completion is static and returns expected subcommands for all supported shells', () => {
 assert.deepEqual(completeCliWords(['completion','p']),['powershell']);
 assert.ok(completeCliWords(['mcp','l']).includes('list'));
 for (const shell of ['bash','zsh','fish','powershell']) assert.ok(generateShellCompletion(shell).includes('__complete'));
 assert.throws(()=>generateShellCompletion('unknown'),/Unsupported shell/);
});
