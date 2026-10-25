// Browser presentation helpers. Execution and follow-up routing stay in the relay.
const assistantSegments = [];
const followupByClient = new Map();
const followupByIntervention = new Map();
const pendingFollowupStatus = new Map();
const seenRelayEvents = new Set();
let queuedFollowupInFlight = null;
let threadFollowing = true;

function messageTime(value = Date.now()) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '' : '<time datetime="' + time.toISOString() + '" title="' + esc(time.toLocaleString()) + '">' + esc(time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '</time>';
}
function sealAssistantMessage() {
  if (!activeTurn) return;
  activeTurn.active = false;
  activeTurn.el.querySelector('[data-streaming]').textContent = '';
  renderActivity(activeTurn);
  activeTurn = null;
}
function finishAssistantTurns() {
  for (const turn of assistantSegments) {
    turn.active = false;
    turn.el.querySelector('[data-streaming]').textContent = '';
    renderActivity(turn);
  }
  activeTurn = null;
}
function addUserMessage(text, attachments = [], options = {}) {
  sealAssistantMessage();
  document.getElementById('emptyChat')?.remove();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = '<div class="user-stack"><div class="message-meta"><span>You' + (options.followup ? ' · Follow-up' : '') + '</span>' + messageTime(options.timestamp || Date.now()) + '</div><div class="bubble">' + esc(text) + attachmentHtml(attachments) + '</div><div class="followup-status" role="status" hidden></div></div>';
  document.getElementById('threadInner').appendChild(el);
  el.querySelectorAll('[data-open-upload]').forEach(btn => btn.addEventListener('click', () => openFile(btn.dataset.openUpload)));
  const message = { el, prompt: text, attachments, path: currentPath, status: 'sending', clientId: options.clientId || 'followup-' + (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2)) };
  if (options.followup) {
    followupByClient.set(message.clientId, message);
    updateFollowup({ client_id: message.clientId, intervention_id: options.interventionId, status: options.status || 'sending' });
  }
  scrollThread(true);
  return message;
}
function addAssistantMessage(text, options = {}) {
  sealAssistantMessage();
  appendAssistantText(text, { author: options.author || 'Assistant', message_id: options.message_id, partial: false, timestamp: options.timestamp });
  sealAssistantMessage();
}
function ensureAssistantTurn(options = {}) {
  if (activeTurn) return activeTurn;
  document.getElementById('emptyChat')?.remove();
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = '<div class="assistant-stack"><div class="message-meta"><span data-author></span>' + messageTime(options.timestamp || Date.now()) + '<span data-streaming></span></div><div class="activity-card" data-activity><button class="activity-head" type="button" aria-expanded="false"><span class="activity-label">Working…</span><span class="activity-rollup"></span><span class="activity-chevron" aria-hidden="true">›</span></button><div class="activity-rows"></div></div><div class="assistant-bubble message-content" data-content></div></div>';
  el.querySelector('[data-author]').textContent = options.author || 'Assistant';
  document.getElementById('threadInner').appendChild(el);
  const turn = { id: 'local_' + (++turnSeq), el, text: '', activity: [], byKey: new Map(), active: true, messageId: options.message_id || null, turnId: options.turn_id || null, author: options.author || 'Assistant', messageDone: false };
  assistantSegments.push(turn);
  const card = el.querySelector('[data-activity]');
  card.querySelector('.activity-head').addEventListener('click', () => {
    card.classList.toggle('expanded'); renderActivity(turn);
  });
  activeTurn = turn;
  return turn;
}
function findActivityRow(key) {
  if (!key) return null;
  for (let i = assistantSegments.length - 1; i >= 0; i--) {
    const turn = assistantSegments[i], row = turn.byKey.get(key);
    if (row) return { turn, row };
  }
  return null;
}
function addActivity(level, message, opts = {}) {
  const existing = findActivityRow(opts.key);
  if (existing) {
    Object.assign(existing.row, { level, message, ...opts }); renderActivity(existing.turn); return;
  }
  if (activeTurn?.text && (opts.kind === 'tool' || activeTurn.messageDone)) sealAssistantMessage();
  const turn = ensureAssistantTurn();
  const row = { key: opts.key || null, level, message, ts: Date.now(), ...opts };
  turn.activity.push(row);
  if (row.key) turn.byKey.set(row.key, row);
  renderActivity(turn);
  scrollThread();
}
function renderActivity(turn) {
  const card = turn.el.querySelector('[data-activity]');
  const rows = turn.activity.filter(row => row.message && String(row.message).trim());
  card.classList.toggle('active', rows.length > 0 || turn.active && !turn.text);
  if (!rows.length && (!turn.active || turn.text)) return;
  const tools = rows.filter(row => row.kind === 'tool'), errors = rows.filter(row => row.level === 'error');
  const latest = rows[rows.length - 1];
  card.querySelector('.activity-label').textContent = turn.active ? latest?.message || 'Working…' : tools.length ? 'Tool activity' : 'Activity';
  card.querySelector('.activity-rollup').textContent = [tools.length ? tools.length + ' tools' : '', errors.length ? errors.length + ' errors' : ''].filter(Boolean).join(' · ');
  const approvalOpen = rows.some(row => row.approval && !row.approvalFading);
  card.classList.toggle('has-approval', approvalOpen);
  card.querySelector('.activity-head').setAttribute('aria-expanded', String(card.classList.contains('expanded') || approvalOpen));
  card.querySelector('.activity-rows').innerHTML = rows.map(row => {
    const approval = row.approval ? activityApprovalHtml(row.approval, row.approvalFading) : '';
    const result = row.approvalResult ? '<div class="activity-result">' + approvalLineHtml(row.approvalResult.approval, row.approvalResult.decision, row.approvalResult.message) + '</div>' : '';
    const detail = row.detail ? '<pre>' + esc(row.detail) + '</pre>' : '';
    return '<div class="activity-row ' + esc(row.level || '') + '" data-activity-key="' + esc(row.key || '') + '"><span class="status-dot"></span><span class="activity-main"><span class="activity-message">' + esc(row.message) + '</span>' + approval + result + detail + '</span></div>';
  }).join('');
  card.querySelectorAll('[data-approval-decision]').forEach(btn => btn.addEventListener('click', () => submitApproval(btn.dataset.approvalDecision)));
}
function appendAssistantText(text, data = {}) {
  if (!text && !data.replace) {
    if (activeTurn?.messageId === data.message_id && data.partial === false) {
      activeTurn.messageDone = true;
      activeTurn.el.querySelector('[data-streaming]').textContent = '';
      renderMermaidBlocks(activeTurn.el.querySelector('[data-content]'));
    }
    return;
  }
  if (activeTurn && ((activeTurn.messageId && data.message_id && activeTurn.messageId !== data.message_id) || (activeTurn.turnId && data.turn_id && activeTurn.turnId !== data.turn_id) || (activeTurn.text && activeTurn.author !== (data.author || 'Assistant')) || (activeTurn.messageDone && !data.replace))) sealAssistantMessage();
  const turn = ensureAssistantTurn(data);
  turn.messageId = data.message_id || turn.messageId;
  turn.turnId = data.turn_id || turn.turnId;
  turn.author = data.author || turn.author;
  turn.el.querySelector('[data-author]').textContent = turn.author;
  turn.text = data.replace ? text : turn.text + (text || '');
  turn.messageDone = data.partial === false;
  turn.el.querySelector('[data-content]').innerHTML = markdown(turn.text);
  turn.el.querySelector('[data-streaming]').textContent = turn.messageDone ? '' : 'Writing…';
  renderActivity(turn);
  if (turn.messageDone) renderMermaidBlocks(turn.el.querySelector('[data-content]'));
  scrollThread();
}
function scrollThread(force = false) {
  const thread = document.getElementById('thread');
  if (force || threadFollowing) { thread.scrollTop = thread.scrollHeight; threadFollowing = true; }
}
function followupMessage(data) {
  const labels = { sending: 'Sending follow-up…', accepted: 'Sent · waiting for the agent to pick it up', delivered: 'Delivered to agent', queued: 'Queued', waiting_for_task: 'Waiting for the agent task', duplicate: 'Already received', queued_next_turn: 'Queued for the next turn', no_task: 'Queued for the next turn', promoted_to_new_turn: 'Started as a new turn', started: 'Running', completed: 'Completed', held: 'Not delivered · waiting for your next instruction', error: 'Could not deliver', unconfirmed: 'Turn finished · delivery not confirmed' };
  return labels[String(data?.status || '')] || 'Delivery not yet confirmed';
}
function followupFor(data = {}) {
  return followupByClient.get(data.client_id) || followupByIntervention.get(data.intervention_id) || null;
}
function updateFollowup(data, fallback = null) {
  const message = followupFor(data) || fallback;
  if (!message) {
    if (data.intervention_id) pendingFollowupStatus.set(data.intervention_id, data);
    return null;
  }
  if (data.intervention_id) {
    followupByIntervention.set(data.intervention_id, message);
    message.interventionId = data.intervention_id;
  }
  const rank = { sending: 0, waiting_for_task: 1, queued: 2, accepted: 3, duplicate: 3, unconfirmed: 3.5, no_task: 4, queued_next_turn: 4, started: 5, promoted_to_new_turn: 5, delivered: 6, completed: 7 };
  if (message.status !== 'completed' && (message.status !== 'delivered' || data.status === 'completed')) {
    if (['error', 'held'].includes(data.status) || (rank[data.status] ?? -1) >= (rank[message.status] ?? -1)) message.status = data.status || message.status;
  }
  const badge = message.el.querySelector('.followup-status');
  badge.hidden = false;
  badge.dataset.status = message.status;
  badge.textContent = followupMessage({ status: message.status });
  badge.title = data.error || '';
  const pending = pendingFollowupStatus.get(data.intervention_id);
  if (pending) { pendingFollowupStatus.delete(data.intervention_id); updateFollowup(pending, message); }
  return message;
}
function finishFollowupPresentation() {
  for (const message of followupByClient.values()) {
    if (['sending', 'waiting_for_task', 'queued', 'accepted', 'duplicate'].includes(message.status)) updateFollowup({ status: 'unconfirmed' }, message);
  }
}
