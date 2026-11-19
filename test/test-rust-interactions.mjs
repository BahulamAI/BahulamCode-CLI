import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {createRustInteractions} from '../src/daemon/rust-interactions.mjs';
import {askUserForm} from '../src/terminal/repl-ask-form.mjs';
const options=[{label:'Yes',value:'yes'},{label:'No',value:'no'}];
function fixture(timeoutMs=1000) {
 const frames=[];
 const bridge=createRustInteractions({send:e=>{frames.push(e);return true;},getSessionId:()=> 'fixture',timeoutMs});
 return {frames,bridge};
}
test('attached questions never take Node stdin and serialize concurrent requests',async()=>{
 const {frames,bridge}=fixture();
 try {
  const first=askUserForm({rl:{pause(){throw Error('Node input was touched');}},question:'one',options:['Yes','No'],choose:bridge.choose});
  const second=bridge.choose('two',options);
  await tick();
  assert.equal(frames.length,1);
  assert.equal(frames[0].data.allow_free_text,true);
  assert.equal(bridge.answer({request_id:'stale',value:'yes'}),false);
  bridge.answer({request_id:frames[0].data.request_id,value:'custom answer'});
  assert.deepEqual(await first,{answer:'custom answer',source:'free_text'});
  await tick();
  const active=frames.at(-1).data;
  assert.equal(active.title,'two');
  assert.equal(bridge.answer({request_id:active.request_id,value:'unknown'}),false);
  bridge.answer({request_id:active.request_id,value:'yes'});
  assert.equal(await second,'yes');
 } finally {bridge.close();}
});
test('timeout cancels only its matching popup and advances the queue',async()=>{
 const {frames,bridge}=fixture(30);
 try {
  const first=bridge.choose('one',options),second=bridge.choose('two',options);
  await tick();const old=frames[0].data.request_id;
  assert.equal(await first,null);await tick();
  assert.ok(frames.some(f=>f.data.request_id===old&&f.data.cancelled));
  assert.equal(frames.at(-1).data.title,'two');
  assert.equal(bridge.answer({request_id:old,value:'yes'}),false);
  bridge.answer({request_id:frames.at(-1).data.request_id,value:'no'});
  assert.equal(await second,'no');
 } finally {bridge.close();}
});
test('interrupt drains questions; detach closes pending and future questions',async()=>{
 const {bridge,frames}=fixture();
 const pending=[bridge.choose('one',options),bridge.choose('two',options)];
 bridge.cancel();assert.deepEqual(await Promise.all(pending),[null,null]);
 await tick();assert.ok(frames.every(frame=>frame.data.cancelled),'cancelled queued work must not reopen a picker');
 const next=bridge.choose('three',options);bridge.close();assert.equal(await next,null);
 assert.equal(await bridge.choose('four',options),null);
});
test('failed sends release the waiter and do not leave a timeout',async()=>{
 for(const send of [()=>false,()=>{throw Error('closed');}]) {
  const bridge=createRustInteractions({send,getSessionId:()=> 'fixture',timeoutMs:1000});
  assert.equal(await bridge.choose('one',options),null);bridge.close();
 }
});
