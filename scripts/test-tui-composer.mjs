// Real Rust/Node host with fake native helpers: no actual clipboard or model access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if (process.platform === 'win32') { console.log('SKIP: Unix PTY fixture'); process.exit(0); }
const root = fileURLToPath(new URL('../',import.meta.url));
const fixture = path.join(root,'scripts/tui_composer_fixture.py');
for (const mode of ['inline','fullscreen']) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'bahulam-composer-'));
  const driver = path.join(temp,'driver.mjs');
  const fence = String.fromCharCode(96).repeat(3);
  const full = fence+'js\n' + Array.from({length:30},(_,i)=>'const value'+i+' = "界";').join('\n') + '\n'+fence;
  fs.writeFileSync(path.join(temp,'history.jsonl'),[{display:'older prompt'},{display:'newer prompt'}].map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(temp,'clip-mode'),'text');
  for (const name of ['pbpaste','wl-paste','pbcopy','wl-copy','fake editor']) {
    fs.copyFileSync(fixture,path.join(temp,name)); fs.chmodSync(path.join(temp,name),0o700);
  }
  fs.writeFileSync(driver,[
    "import fs from 'node:fs';",
    'import {startRustTuiHost} from '+JSON.stringify(new URL('../src/daemon/rust-tui-host.mjs',import.meta.url).href)+';',
    'const commands=[];',
    'const host=startRustTuiHost({mode:'+JSON.stringify(mode)+',onCommand:c=>{',
    'commands.push(c);fs.writeFileSync('+JSON.stringify(path.join(temp,'commands.json'))+',JSON.stringify(commands));',
    "if(c.type==='show_details')host.send({v:2,seq:1,ts:'',type:'detail_loaded',session_id:'composer',agent_id:'main',data:{payload_ref:'fixture:full',detail:"+JSON.stringify(full)+"}});",
    '}});',
    "host.send({v:2,seq:1,ts:'',type:'tool_finished',session_id:'composer',agent_id:'main',payload_ref:'fixture:full',data:{tool_id:'fixture',preview:'TOOL_PREVIEW',ok:true}});",
    'setTimeout(()=>host.close(),20000).unref();',
  ].join('\n'));
  try {
    const result=spawnSync('python3',[fixture,process.execPath,driver],{
      encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024,
      env:{...process.env,BAHULAM_HOME:temp,PATH:temp+path.delimiter+process.env.PATH,
        VISUAL:'"'+path.join(temp,'fake editor')+'" --wait',BAHULAM_CLIPBOARD:'native',
        BAHULAM_TUI_BINARY:path.join(root,'rust/target/debug/bahulam-tui')},
    });
    assert.equal(result.status,0,mode+': '+result.stdout+'\n'+result.stderr);
    assert.equal(fs.readFileSync(path.join(temp,'copied'),'utf8'),full);
    console.log('PASS '+mode+': history/search, editor handoff/failure, native paste/copy, stale paste, timeout and terminal restore.');
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}
