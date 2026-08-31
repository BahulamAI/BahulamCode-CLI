import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-local-service-'));
const previousHome = process.env.BAHULAM_HOME;
const previousBackendUrl = process.env.TARANG_BACKEND_URL;
const previousLibreOfficePath = process.env.BAHULAM_LIBREOFFICE_PATH;
process.env.BAHULAM_HOME = path.join(tmp, '.bahulam');
process.env.BAHULAM_LIBREOFFICE_PATH = path.join(tmp, 'missing-soffice');

try {
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Local Workspace\n');
  fs.writeFileSync(path.join(workspace, 'flow.mmd'), 'graph TD\n  A[Start] --> B[Done]\n');
  fs.writeFileSync(path.join(workspace, 'diagram.drawio'), '<mxfile><diagram name="Page-1">abc</diagram></mxfile>\n');
  fs.writeFileSync(path.join(workspace, 'legacy.ipynb'), JSON.stringify({
    metadata: { language: 'python' },
    nbformat: 3,
    nbformat_minor: 0,
    worksheets: [{
      cells: [
        { cell_type: 'heading', level: 1, source: ['Legacy notebook'] },
        { cell_type: 'code', input: ['print("hello")\n'], prompt_number: 1, outputs: [{ output_type: 'pyout', text: ['hello\n'] }] },
      ],
    }],
  }));
  fs.writeFileSync(path.join(workspace, 'deck.pptx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const XLSX = (await import('xlsx')).default || await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Name', 'Amount', 'Tax'],
    ['Alpha', 10, { f: 'B2*0.1', v: 1 }],
    ['Beta', 20, { f: 'B3*0.1', v: 2 }],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Summary');
  XLSX.writeFile(workbook, path.join(workspace, 'data.xlsx'));

  const { createLocalWorkspaceSession, loadLocalWorkspaceSession, verifyLocalAccessToken } =
    await import('../src/local-service/session-store.mjs');
  const { listWorkspacePath } = await import('../src/local-service/file-access.mjs');
  const { getLocalMachineIdentity, isLoopbackAddress, normalizeLoopbackHost } =
    await import('../src/local-service/machine.mjs');
  const { startLocalWorkspaceService } = await import('../src/local-service/server.mjs');
  const { JsonlWriter } = await import('../src/core/jsonl-writer.mjs');
  const { BrowserApprovalManager } = await import('../src/local-service/approval-bridge.mjs');
  const { LocalAgentRelay } = await import('../src/local-service/agent-relay.mjs');

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

  const mermaidListing = listWorkspacePath(session, 'flow.mmd');
  assert.equal(mermaidListing.file.viewer, 'mermaid');
  assert.equal(mermaidListing.file.text_like, true);

  const deckListing = listWorkspacePath(session, 'deck.pptx');
  assert.equal(deckListing.file.viewer, 'presentation');
  assert.equal(deckListing.file.text_like, false);
  assert.equal(deckListing.preview, null);

  const workbookListing = listWorkspacePath(session, 'data.xlsx');
  assert.equal(workbookListing.file.viewer, 'spreadsheet');
  assert.equal(workbookListing.file.text_like, false);
  assert.equal(workbookListing.preview, null);

  assert.throws(
    () => listWorkspacePath(session, '../outside'),
    /outside the granted workspace root/,
  );

  const approvalEvents = [];
  const approval = new BrowserApprovalManager({
    cwd: workspace,
    emit: (type, data) => approvalEvents.push({ type, data }),
  });
  const approvalPromise = approval.check('shell', { command: 'npm install' }, true, { reason: 'Install dependencies' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(approvalEvents[0].type, 'agent_approval_required');
  assert.equal(approvalEvents[0].data.tool, 'shell');
  assert.deepEqual(approvalEvents[0].data.options.map((option) => option.value), ['approve', 'reject']);
  approval.decide(approvalEvents[0].data.approval_id, { decision: 'approve' });
  const approvalResult = await approvalPromise;
  assert.equal(approvalResult.approved, true);
  assert.equal(approvalEvents.some((event) => event.type === 'agent_approval_resolved' && event.data.approved === true), true);

  const relayFollowupEvents = [];
  const relayFollowupCalls = [];
  const relayFollowupJsonl = [];
  const relayForFollowup = new LocalAgentRelay({
    session,
    emit: (type, data) => relayFollowupEvents.push({ type, data }),
  });
  relayForFollowup.running = true;
  relayForFollowup.client = {
    currentTaskId: 'task-followup',
    sendIntervention: async (instruction, opts) => {
      relayFollowupCalls.push({ instruction, opts });
      return { status: 'accepted', interventionId: opts.idempotencyKey };
    },
  };
  relayForFollowup._ensureJsonlWriter = () => ({
    writeBahulamEvent: (event) => relayFollowupJsonl.push(event),
  });
  const relayFollowupResult = await relayForFollowup.sendFollowup({ instruction: 'switch to the safer plan' });
  assert.equal(relayFollowupResult.status, 'accepted');
  assert.equal(relayFollowupResult.role, 'user');
  assert.equal(relayFollowupResult.message_type, 'user_intervention');
  assert.equal(relayFollowupResult.priority, 'high');
  assert.equal(relayFollowupCalls.length, 1);
  assert.equal(relayFollowupCalls[0].instruction, 'switch to the safer plan');
  assert.equal(relayFollowupCalls[0].opts.priority, 'high');
  assert.equal(relayFollowupJsonl[0].type, 'user_intervention');
  assert.equal(relayFollowupJsonl[0].data.role, 'user');
  assert.equal(relayFollowupEvents.some((event) => event.type === 'tool_call'), false);

  const relayCancelEvents = [];
  let relayCancelCalls = 0;
  let relayRejectAllReason = '';
  const relayForCancel = new LocalAgentRelay({
    session,
    emit: (type, data) => relayCancelEvents.push({ type, data }),
  });
  relayForCancel.running = true;
  relayForCancel.client = {
    currentTaskId: 'task-cancel',
    cancel: async () => { relayCancelCalls += 1; },
  };
  relayForCancel.approvalManager = {
    rejectAll: (reason) => { relayRejectAllReason = reason; },
  };
  const relayCancelResult = await relayForCancel.cancelTurn('Cancelled by user');
  assert.equal(relayCancelResult.status, 'cancelled');
  assert.equal(relayCancelResult.task_id, 'task-cancel');
  assert.equal(relayForCancel.cancellationRequested, true);
  assert.equal(relayCancelCalls, 1);
  assert.equal(relayRejectAllReason, 'Cancelled by user');
  assert.equal(relayCancelEvents.some((event) => event.type === 'agent_cancel_requested'), true);

  const seededWriter = new JsonlWriter(workspace, 'test');
  seededWriter.setSessionId('resume-local-service');
  seededWriter.writeUserTurn('previous local question');
  seededWriter.accumulateToolCall('call_history', 'shell', { command: 'ls' });
  seededWriter.accumulateContent('previous local answer');
  seededWriter.recordToolResult('call_history', 'README.md', false, { tool: 'shell' });
  seededWriter.flushAssistantTurn();
  await seededWriter.close();

  const relayHistoryEvents = [];
  const relayForHistory = new LocalAgentRelay({
    session,
    emit: (type, data) => relayHistoryEvents.push({ type, data }),
  });
  relayForHistory.turnCount = 2;
  relayForHistory.resumeLoaded = true;
  relayForHistory.resumeSessionId = 'prior-local-service';
  relayForHistory.displayHistory = [{ role: 'user', content: 'old turn' }];
  relayForHistory.agentHistory = [{ role: 'user', content: 'old turn' }];
  relayForHistory.client = { sessionId: 'prior-local-service', currentTaskId: 'task-prior' };
  const freshHistory = await relayForHistory.startNewHistory();
  assert.equal(freshHistory.ok, true);
  assert.equal(freshHistory.backend_session_id, null);
  assert.deepEqual(freshHistory.messages, []);
  assert.equal(relayForHistory.turnCount, 0);
  assert.equal(relayForHistory.client.sessionId, null);
  assert.equal(relayForHistory.client.currentTaskId, null);
  assert.equal(relayHistoryEvents.some((event) => event.type === 'agent_history_new'), true);

  relayForHistory.turnCount = 3;
  relayForHistory.resumeSessionId = 'another-local-service';
  relayForHistory.client = { sessionId: 'another-local-service' };
  const resumedHistory = await relayForHistory.resumeHistory('resume-local-service');
  assert.equal(resumedHistory.ok, true);
  assert.equal(resumedHistory.backend_session_id, 'resume-local-service');
  assert.equal(resumedHistory.messages.some((msg) => msg.role === 'user' && msg.content === 'previous local question'), true);
  assert.equal(relayForHistory.turnCount, 0);
  assert.equal(relayForHistory.client.sessionId, 'resume-local-service');

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
    assert.match(html, /id="approvalAuto"/);
    assert.match(html, /Auto off/);
    assert.match(html, /id="threadInner"/);
    assert.match(html, /id="attachFiles"/);
    assert.match(html, /id="fileUpload"/);
    assert.match(html, /id="uploadTray"/);
    assert.match(html, /\/api\/files\/upload/);
    assert.match(html, /\/api\/file\/save/);
    assert.match(html, /\/api\/approvals\/mode/);
    assert.match(html, /\/api\/agent\/followup/);
    assert.match(html, /\/api\/agent\/cancel/);
    assert.match(html, /id="stopAgent"/);
    assert.match(html, /Stop/);
    assert.match(html, /data-save-file/);
    assert.match(html, /data-edit-source/);
    assert.match(html, /function saveCurrentFile/);
    assert.match(html, /function setNotebookCellSource/);
    assert.match(html, /readOnly:!editable/);
    assert.match(html, /data-resize="left"/);
    assert.match(html, /function renderTable/);
    assert.match(html, /\/vendor\/monaco\/vs\/loader\.js/);
    assert.match(html, /function renderCodeEditor/);
    assert.match(html, /function importWithoutAmdDefine/);
    assert.match(html, /function renderMermaidBlocks/);
    assert.match(html, /function renderSpreadsheetFile/);
    assert.match(html, /function renderOfficeFile/);
    assert.match(html, /function renderNotebookFile/);
    assert.match(html, /function notebookCells/);
    assert.match(html, /worksheets/);
    assert.match(html, /Auto detect/);
    assert.match(html, /Jupyter Notebook \(\.ipynb\)/);
    assert.match(html, /data-preview-maximize/);
    assert.match(html, /data-preview-new-tab/);
    assert.match(html, /file-icon-action/);
    assert.match(html, /function iconSvg/);
    assert.match(html, /fileIconButton/);
    assert.match(html, /\/api\/file\/spreadsheet-preview/);
    assert.match(html, /\/api\/file\/office-preview/);
    assert.match(html, /data-ask-file/);
    assert.match(html, /viewer-note-card/);
    assert.match(html, /loadSessionChoices/);
    assert.match(html, /id="sessionMenuButton"/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, /id="sessionModal"/);
    assert.match(html, /role="dialog"/);
    assert.match(html, /id="sessionMenu"/);
    assert.match(html, /id="chatTab"/);
    assert.match(html, /id="traceTab"/);
    assert.doesNotMatch(html, /id="traceToggle"/);
    assert.match(html, /id="approvalModal"/);
    assert.match(html, /agent_approval_required/);
    assert.match(html, /\/api\/approvals\//);
    assert.match(html, /approval-inline/);
    assert.match(html, /activity-approval/);
    assert.match(html, /activityApprovalHtml/);
    assert.match(html, /approval-result-line/);
    assert.match(html, /approval-approve/);
    assert.match(html, /approval-reject/);
    assert.match(html, /pendingApprovalEl/);
    assert.match(html, /resolveInlineApproval/);
    assert.match(html, /function setApprovalAutoMode/);
    assert.match(html, /function handleLocalSlashCommand/);
    assert.match(html, /command!=='\/auto'/);
    assert.match(html, /if\(await handleLocalSlashCommand\(rawPrompt\)\)/);
    assert.match(html, /\/auto full is available only in the terminal CLI/);
    assert.match(html, /function setTurnRunning/);
    assert.match(html, /function stopAgentTurn/);
    assert.match(html, /function finishCancelledTurn/);
    assert.match(html, /followupMessage/);
    assert.match(html, /agent_turn_cancelled/);
    assert.match(html, /status==='queued_next_turn'\|\|status==='no_task'/);
    assert.doesNotMatch(html, /status==='queued_next_turn'\|\|status==='no_task'\|\|status==='error'/);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Function(match[1]));
    }

    const brandRes = await fetch(`http://127.0.0.1:${service.port}/assets/bahulam-mark.png`);
    assert.equal(brandRes.status, 200);
    assert.match(brandRes.headers.get('content-type') || '', /^image\//);

    const monacoRes = await fetch(`http://127.0.0.1:${service.port}/vendor/monaco/vs/loader.js`);
    assert.equal(monacoRes.status, 200);
    assert.match(monacoRes.headers.get('content-type') || '', /javascript/);

    const mermaidRes = await fetch(`http://127.0.0.1:${service.port}/vendor/mermaid/mermaid.esm.min.mjs`);
    assert.equal(mermaidRes.status, 200);
    assert.match(mermaidRes.headers.get('content-type') || '', /javascript/);

    const sessionListRes = await fetch(`http://127.0.0.1:${service.port}/api/chat/sessions?token=${encodeURIComponent(token)}`).then((res) => res.json());
    assert.equal(sessionListRes.ok, true);
    assert.equal(sessionListRes.sessions.some((item) => item.session_id === 'resume-local-service'), true);

    const emptyHistoryRes = await fetch(`http://127.0.0.1:${service.port}/api/chat/history?token=${encodeURIComponent(token)}`).then((res) => res.json());
    assert.equal(emptyHistoryRes.ok, true);
    assert.equal(emptyHistoryRes.backend_session_id, null);
    assert.deepEqual(emptyHistoryRes.messages, []);

    const approvalModeRes = await fetch(`http://127.0.0.1:${service.port}/api/approvals/mode?token=${encodeURIComponent(token)}`).then((res) => res.json());
    assert.equal(approvalModeRes.ok, true);
    assert.equal(approvalModeRes.auto, false);
    const approvalModeOnRes = await fetch(`http://127.0.0.1:${service.port}/api/approvals/mode?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: true }),
    }).then((res) => res.json());
    assert.equal(approvalModeOnRes.ok, true);
    assert.equal(approvalModeOnRes.mode, 'auto');
    assert.equal(approvalModeOnRes.auto, true);

    const followupNoTurn = await fetch(`http://127.0.0.1:${service.port}/api/agent/followup?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'one more thing' }),
    });
    assert.equal(followupNoTurn.status, 409);

    const cancelIdleRes = await fetch(`http://127.0.0.1:${service.port}/api/agent/cancel?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Cancelled by user' }),
    }).then((res) => res.json());
    assert.equal(cancelIdleRes.ok, true);
    assert.equal(cancelIdleRes.status, 'idle');

    const newHistoryRes = await fetch(`http://127.0.0.1:${service.port}/api/chat/new?token=${encodeURIComponent(token)}`, {
      method: 'POST',
    }).then((res) => res.json());
    assert.equal(newHistoryRes.ok, true);
    assert.equal(newHistoryRes.history_mode, 'new');
    assert.deepEqual(newHistoryRes.messages, []);

    const historyRes = await fetch(`http://127.0.0.1:${service.port}/api/chat/resume?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'resume-local-service' }),
    }).then((res) => res.json());
    assert.equal(historyRes.ok, true);
    assert.equal(historyRes.backend_session_id, 'resume-local-service');
    assert.equal(historyRes.messages.some((msg) => msg.role === 'user' && msg.content === 'previous local question'), true);
    assert.equal(historyRes.messages.some((msg) => msg.role === 'assistant' && msg.content === 'previous local answer'), true);
    assert.equal(historyRes.messages.some((msg) => msg.role === 'tool'), false);
    assert.equal(historyRes.trace.some((item) => item.type === 'history_tool_call' && item.tool === 'shell'), true);
    assert.equal(historyRes.trace.some((item) => item.type === 'history_tool_result'), true);

    const filesRes = await fetch(`http://127.0.0.1:${service.port}/api/files?token=${encodeURIComponent(token)}&path=README.md`).then((res) => res.json());
    assert.equal(filesRes.type, 'file');
    assert.equal(filesRes.preview.content, '# Local Workspace\n');
    assert.equal(filesRes.file.viewer, 'markdown');
    assert.equal(filesRes.file.language, 'markdown');

    const saveRes = await fetch(`http://127.0.0.1:${service.port}/api/file/save?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'README.md', content: '# Local Workspace\n\nEdited in browser.\n' }),
    }).then((res) => res.json());
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.path, 'README.md');
    assert.equal(saveRes.preview.content, '# Local Workspace\n\nEdited in browser.\n');
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), '# Local Workspace\n\nEdited in browser.\n');

    const rejectedSave = await fetch(`http://127.0.0.1:${service.port}/api/file/save?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'deck.pptx', content: 'not a deck' }),
    });
    assert.equal(rejectedSave.status, 400);

    const drawioRes = await fetch(`http://127.0.0.1:${service.port}/api/files?token=${encodeURIComponent(token)}&path=diagram.drawio`).then((res) => res.json());
    assert.equal(drawioRes.file.viewer, 'drawio');
    assert.equal(drawioRes.file.language, 'xml');

    const legacyNotebookRes = await fetch(`http://127.0.0.1:${service.port}/api/files?token=${encodeURIComponent(token)}&path=legacy.ipynb`).then((res) => res.json());
    assert.equal(legacyNotebookRes.file.viewer, 'notebook');
    assert.equal(legacyNotebookRes.file.kind, 'notebook');
    assert.match(legacyNotebookRes.preview.content, /worksheets/);

    const legacyNotebook = JSON.parse(legacyNotebookRes.preview.content);
    legacyNotebook.worksheets[0].cells[1].input = ['print("saved")\n'];
    const notebookSaveRes = await fetch(`http://127.0.0.1:${service.port}/api/file/save?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'legacy.ipynb', content: JSON.stringify(legacyNotebook, null, 2) + '\n' }),
    }).then((res) => res.json());
    assert.equal(notebookSaveRes.file.viewer, 'notebook');
    const savedNotebook = JSON.parse(fs.readFileSync(path.join(workspace, 'legacy.ipynb'), 'utf8'));
    assert.equal(savedNotebook.worksheets[0].cells[1].input[0], 'print("saved")\n');

    const uploadRes = await fetch(`http://127.0.0.1:${service.port}/api/files/upload?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          {
            name: 'uploaded image.png',
            mime_type: 'image/png',
            data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/l9zI3wAAAABJRU5ErkJggg==',
          },
          {
            name: 'analysis.ipynb',
            mime_type: 'application/x-ipynb+json',
            data_base64: Buffer.from(JSON.stringify({
              cells: [{ cell_type: 'markdown', source: ['# Uploaded notebook\n'] }],
              metadata: {},
              nbformat: 4,
              nbformat_minor: 5,
            })).toString('base64'),
          },
        ],
      }),
    }).then((res) => res.json());
    assert.equal(uploadRes.ok, true);
    assert.equal(uploadRes.files.length, 2);
    assert.match(uploadRes.directory, /^bahulam-uploads\//);
    assert.equal(uploadRes.files[0].viewer, 'image');
    assert.equal(uploadRes.files[0].kind, 'image');
    assert.equal(uploadRes.files[1].extension, 'ipynb');
    assert.equal(uploadRes.files[1].viewer, 'notebook');
    assert.equal(uploadRes.files[1].kind, 'notebook');
    assert.equal(uploadRes.files[1].uploaded, true);
    assert.equal(fs.existsSync(path.join(workspace, uploadRes.files[0].path)), true);
    assert.deepEqual(fs.readFileSync(path.join(workspace, uploadRes.files[0].path)).subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const uploadedImageRes = await fetch(`http://127.0.0.1:${service.port}/api/files?token=${encodeURIComponent(token)}&path=${encodeURIComponent(uploadRes.files[0].path)}`).then((res) => res.json());
    assert.equal(uploadedImageRes.file.viewer, 'image');
    assert.equal(uploadedImageRes.preview, null);

    const deckRes = await fetch(`http://127.0.0.1:${service.port}/api/files?token=${encodeURIComponent(token)}&path=deck.pptx`).then((res) => res.json());
    assert.equal(deckRes.file.viewer, 'presentation');
    assert.equal(deckRes.preview, null);

    const workbookPreview = await fetch(`http://127.0.0.1:${service.port}/api/file/spreadsheet-preview?token=${encodeURIComponent(token)}&path=data.xlsx`).then((res) => res.json());
    assert.equal(workbookPreview.ok, true);
    assert.equal(workbookPreview.sheet_count, 1);
    assert.equal(workbookPreview.sheets[0].name, 'Summary');
    assert.equal(workbookPreview.sheets[0].columns.slice(0, 3).join(','), 'A,B,C');
    assert.equal(workbookPreview.sheets[0].rows[1].cells[0].value, 'Alpha');
    assert.equal(workbookPreview.sheets[0].rows[1].cells[2].formula, '=B2*0.1');

    const officePreview = await fetch(`http://127.0.0.1:${service.port}/api/file/office-preview?token=${encodeURIComponent(token)}&path=deck.pptx`).then((res) => res.json());
    assert.equal(officePreview.ok, false);
    assert.equal(officePreview.code, 'libreoffice_missing');

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
        body: JSON.stringify({
          prompt: 'say relay ok',
          path: 'README.md',
          attachments: uploadRes.files,
        }),
      }).then(async (res) => ({ status: res.status, body: await res.json() }));
      assert.equal(relayRes.status, 200);
      assert.equal(relayRes.body.ok, true);
      assert.equal(relayRes.body.content, 'relay ok');
      assert.equal(relayRes.body.transcript_session_id, 'resume-local-service');
      assert.equal(mockBackend.requests.length, 1);
      assert.match(mockBackend.requests[0].instruction, /Bahulam Local IDE/);
      assert.match(mockBackend.requests[0].instruction, /say relay ok/);
      assert.match(mockBackend.requests[0].instruction, /Attached files for this turn:/);
      assert.match(mockBackend.requests[0].instruction, /suggested_tool=analyze_image/);
      assert.match(mockBackend.requests[0].instruction, /Use read_attachment\(path=\.\.\.\) for text, PDFs, Markdown, JSON\/YAML, and Jupyter notebooks\./);
      assert.match(mockBackend.requests[0].instruction, new RegExp(uploadRes.files[0].path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(mockBackend.requests[0].session_id, 'resume-local-service');
      assert.equal(mockBackend.requests[0].messages.some((msg) => msg.role === 'user' && msg.content === 'previous local question'), true);
      assert.equal(mockBackend.requests[0].messages.some((msg) => msg.role === 'assistant' && String(msg.content || '').includes('previous local answer')), true);
      assert.equal(mockBackend.requests[0].context.cwd, fs.realpathSync(workspace));
      assert.equal(mockBackend.requests[0].context.model_override, 'test/reasoning');
      assert.equal(mockBackend.requests[0].context.model_mode, 'coding');
      assert.equal(mockBackend.requests[0].context.model_route, 'platform');
      assert.equal(mockBackend.requests[0].context.local_service.session_id, session.id);
      assert.equal(mockBackend.requests[0].context.skip_permissions, undefined);

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
  if (previousLibreOfficePath === undefined) delete process.env.BAHULAM_LIBREOFFICE_PATH;
  else process.env.BAHULAM_LIBREOFFICE_PATH = previousLibreOfficePath;
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
