import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rustAttachmentArtifacts, rustResumeItems } from '../src/daemon/rust-tui-snapshot.mjs';
test('attachment previews use the resolved local file without image bytes or clipboard rereads', () => {
  const data = { attachments: [{id:'image-1',kind:'image',source:'clipboard',path:'/tmp/copied image.png',name:'copied image.png',mime_type:'image/png',bytes:123,width:96,height:48,data:'must not be copied'}] };
  const before=JSON.stringify(data);
  const [artifact]=rustAttachmentArtifacts(data);
  assert.equal(artifact.type,'artifact_created');
  assert.equal(artifact.data.path,'/tmp/copied image.png');
  assert.equal(artifact.data.width,96);
  assert.equal(artifact.data.data,undefined);
  assert.equal(JSON.stringify(data),before);
  const items=rustResumeItems([], [{order:1,event:{type:'attachments',data}}], []);
  assert.equal(items[0].event.type,'artifact_created');
  assert.equal(items[0].event.data.path,artifact.data.path);
});
