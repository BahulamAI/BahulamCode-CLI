import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-local-service-'));
const previousHome = process.env.BAHULAM_HOME;
const previousBackendUrl = process.env.TARANG_BACKEND_URL;
process.env.BAHULAM_HOME = path.join(tmp, '.bahulam');

try {
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Local Workspace\n');

  const { createLocalWorkspaceSession, loadLocalWorkspaceSession, verifyLocalAccessToken } =
    await import('../src/local-service/session-store.mjs');
  const { listWorkspacePath } = await import('../src/local-service/file-access.mjs');
  const { getLocalMachineIdentity, isLoopbackAddress, normalizeLoopbackHost } =
    await import('../src/local-service/machine.mjs');
  const { startLocalWorkspaceService } = await import('../src/local-service/server.mjs');
  const { JsonlWriter } = await import('../src/core/jsonl-writer.mjs');

  const { session, token } = createLocalWorkspaceSession({ targetPath: workspace });
  assert.equal(session.product, 'bahulam-local-service');
  assert.equal(session.machine_id, getLocalMachineIdentity().id);
  assert.equal(session.root_path, fs.realpathSync(workspace));
  assert.equal(session.focus_path, '');
  assert.ok(!('token_hash' in session));
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.5'), false);
  assert.equal(normalizeLoopbackHost('localhost'), '127.0.0.1');
  assert.throws(() => normalizeLoopbackHost('0.0.0.0'), /loopback/);

  const stored = loadLocalWorkspaceSession(session.id);
  assert.equal(verifyLocalAccessToken(stored, token), true);
  assert.equal(verifyLocalAccessToken(stored, 'wrong'), false);

  const listing = listWorkspacePath(session, '.');
  assert.equal(listing.type, 'directory');
  assert.equal(listing.entries.some((entry) => entry.name === 'README.md'), true);

  assert.throws(
    () => listWorkspacePath(session, '../outside'),
    /outside the granted workspace root/,
  );

  const seededWriter = new JsonlWriter(workspace, 'test');
  seededWriter.setSessionId('resume-local-service');
  seededWriter.writeUserTurn('previous local question');
  seededWriter.accumulateContent('previous local answer');
  seededWriter.flushAssistantTurn();
  await seededWriter.close();

  const service = await startLocalWorkspaceService({ session, token, port: 0 });
  try {
    const health = await fetch(`http://127.0.0.1:${service.port}/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.product, 'bahulam-local-service');

    const unauthorized = await fetch(`http://127.0.0.1:${service.port}/api/session`);
    assert.equal(unauthorized.status, 401);

    const sessionRes = await fetch(`http://127.0.0.1:${service.port}/api/session?token=${encodeURIComponent(token)}`).then((res) => res.json());
    assert.equal(sessionRes.ok, true);
    assert.equal(sessionRes.session.id, session.id);

    const htmlRes = await fetch(service.url);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Bahulam/);
    assert.match(html, /Cloud IDE/);
    assert.match(html, /src="\/assets\/bahulam-mark\.png"/);
    assert.match(html, /Subscriptions/);
    assert.match(html, /CLI login needed/);
    assert.match(html, /id="threadInner"/);
    assert.match(html, /data-resize="left"/);
    assert.match(html, /function renderTable/);
    assert.match(html, /loadChatHistory/);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Function(match[1]));
    }

    const brandRes = await fetch(`http://127.0.0.1:${service.port}/assets/bahulam-mark.png`);
    assert.equal(brandRes.status, 200);
    assert.match(brandRes.headers.get('content-type') || '', /^image\//);

    const historyRes = await fetch(`http://127.0.0.1:${service.port}/api/chat/history?token=${encodeURIComponent(token)}`).then((res) => res.json());
    assert.equal(historyRes.ok, true);
    assert.equal(historyRes.backend_session_id, 'resume-local-service');
    assert.equal(historyRes.messages.some((msg) => msg.role === 'user' && msg.content === 'previous local question'), true);
    assert.equal(historyRes.messages.some((msg) => msg.role === 'assistant' && msg.content === 'previous local answer'), true);

    const filesRes = await fetch(`http://127.0.0.1:${service.port}/api/files?token=${encodeURIComponent(token)}&path=README.md`).then((res) => res.json());
    assert.equal(filesRes.type, 'file');
    assert.equal(filesRes.preview.content, '# Local Workspace\n');

    const bridgeRes = await fetch(`http://127.0.0.1:${service.port}/api/agent/turn?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert.equal(bridgeRes.status, 401);
    assert.equal(bridgeRes.body.error, 'auth_required');

    fs.mkdirSync(process.env.BAHULAM_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.BAHULAM_HOME, 'config.json'), JSON.stringify({
      token: 'test-token',
      model_config: { reasoning: 'test/reasoning' },
      model_mode: 'coding',
      route_preference: 'platform',
    }));

    const mockBackend = await startMockBackend();
    process.env.TARANG_BACKEND_URL = `http://127.0.0.1:${mockBackend.port}`;
    try {
      const relayRes = await fetch(`http://127.0.0.1:${service.port}/api/agent/turn?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'say relay ok', path: 'README.md' }),
      }).then(async (res) => ({ status: res.status, body: await res.json() }));
      assert.equal(relayRes.status, 200);
      assert.equal(relayRes.body.ok, true);
      assert.equal(relayRes.body.content, 'relay ok');
      assert.equal(relayRes.body.transcript_session_id, 'resume-local-service');
      assert.equal(mockBackend.requests.length, 1);
      assert.match(mockBackend.requests[0].instruction, /Bahulam Local IDE/);
      assert.match(mockBackend.requests[0].instruction, /say relay ok/);
      assert.equal(mockBackend.requests[0].session_id, 'resume-local-service');
      assert.equal(mockBackend.requests[0].messages.some((msg) => msg.role === 'user' && msg.content === 'previous local question'), true);
      assert.equal(mockBackend.requests[0].messages.some((msg) => msg.role === 'assistant' && msg.content === 'previous local answer'), true);
      assert.equal(mockBackend.requests[0].context.cwd, fs.realpathSync(workspace));
      assert.equal(mockBackend.requests[0].context.model_override, 'test/reasoning');
      assert.equal(mockBackend.requests[0].context.model_mode, 'coding');
      assert.equal(mockBackend.requests[0].context.model_route, 'platform');
      assert.equal(mockBackend.requests[0].context.local_service.session_id, session.id);

      const updatedHistory = await fetch(`http://127.0.0.1:${service.port}/api/chat/history?token=${encodeURIComponent(token)}`).then((res) => res.json());
      assert.equal(updatedHistory.messages.some((msg) => msg.role === 'user' && msg.content === 'say relay ok'), true);
      assert.equal(updatedHistory.messages.some((msg) => msg.role === 'assistant' && msg.content === 'relay ok'), true);
    } finally {
      await mockBackend.close();
    }
  } finally {
    await service.close();
  }

  console.log('local-service tests passed');
} finally {
  if (previousHome === undefined) delete process.env.BAHULAM_HOME;
  else process.env.BAHULAM_HOME = previousHome;
  if (previousBackendUrl === undefined) delete process.env.TARANG_BACKEND_URL;
  else process.env.TARANG_BACKEND_URL = previousBackendUrl;
  fs.rmSync(tmp, { recursive: true, force: true });
}

function startMockBackend() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/execute') {
      const body = await readRequestJson(req);
      requests.push(body);
      const backendSessionId = body.session_id || 'backend_session_local';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Task-ID': 'task_local_relay',
      });
      res.write(`event: session_info\ndata: ${JSON.stringify({ session_id: backendSessionId, model: 'test/reasoning' })}\n\n`);
      res.write(`event: content\ndata: ${JSON.stringify({ text: 'relay ok' })}\n\n`);
      res.write(`event: complete\ndata: ${JSON.stringify({ summary: 'done' })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
    server.once('error', reject);
  });
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}
