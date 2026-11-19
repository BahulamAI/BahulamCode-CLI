// Local presentation fixture. No agent/model calls and no automatic browser launch.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startRustTuiHost } from '../src/daemon/rust-tui-host.mjs';
const image = fileURLToPath(new URL('../test/fixtures/rich-preview/gradient.png', import.meta.url));
const pdf = fileURLToPath(new URL('../test/fixtures/rich-preview/report.pdf', import.meta.url));
let seq = 0;
const host = startRustTuiHost({onCommand(command) {
 if(command.type==='prompt' && command.data.text==='/approval') { setTimeout(()=>send('approval_required',{apr_id:'native-test',name:'native_validation',args:{fixture:true},reason:'Native notification validation only; no tool will execute.',available_scopes:['once']}),3000); return; }
 if(command.type==='approve'||command.type==='deny') { send('approval_decided',{apr_id:'native-test',decision:command.type==='approve'?'allow':'deny'}); return; }
 if(command.type==='prompt') send('message_end',{text:`Demo received: ${command.data.text}\nNo model was called.`});
}});
function send(type,data) { host.send({v:2,seq:++seq,ts:'',type,session_id:'rich-demo',turn_id:'demo',agent_id:'main',data}); }
send('session_state',{cwd:process.cwd(),model:'Local rich-view demo'});
send('message_end',{text:'Image, document and flowchart preview test. Browser: https://example.com Resize the terminal, scroll, and switch with /tui fullscreen or /tui inline. Ctrl+C twice exits.'});
send('artifact_created',{item_id:'demo-image',kind:'image',title:'Gradient image',mime:'image/png',path:image,width:96,height:48,bytes:fs.statSync(image).size});
send('artifact_created',{item_id:'demo-document',kind:'document',title:'Example document',mime:'application/pdf',path:pdf,pages:1,pages_read:[1],bytes:fs.statSync(pdf).size});
send('message_end',{text:'```mermaid\nflowchart TD\n A[Request] --> B{Approved?}\n B -->|Yes| C[Run tool]\n B -->|No| D[Explain]\n C --> E[Reply]\n```\nThe original Mermaid source remains available above its preview.\n\n```mermaid\nsequenceDiagram\nparticipant U as User\nparticipant A as Agent\nparticipant T as Tool\nautonumber\nU->>+A: Question\nalt Cached\nA->>A: Use cache\nelse Fetch\nloop Retry\nA->>+T: Read file\nNote over A,T: Read-only\nT-->>-A: File contents\nend\nend\nA-->>-U: Reply delivered\n```'});
