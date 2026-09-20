import { randomUUID } from 'node:crypto';

/** One turn's user instructions. Acceptance is not delivery. */
export class TurnFollowups {
  constructor({ persist, send, onDelivered = () => {} }) {
    this.persist = persist;
    this.send = send;
    this.onDelivered = onDelivered;
    this.items = new Map();
    this.pending = new Set();
    this.ended = false;
  }

  submit(instruction) {
    const item = { id: randomUUID(), instruction: String(instruction).trim(), status: 'pending', durable: true };
    if (!item.instruction) return Promise.resolve(null);
    this.items.set(item.id, item);
    const request = this._submit(item);
    this.pending.add(request);
    request.then(() => this.pending.delete(request), () => this.pending.delete(request));
    return request;
  }

  async _submit(item) {
    try { await this.persist(item, { initial: true }); }
    catch (error) { this.items.delete(item.id); throw error; }
    let result;
    try {
      if (!this.ended) {
        item.status = 'sending';
        await this.persist(item);
      }
      result = this.ended ? { status: 'queued_next_turn' }
        : await this.send(item.instruction, { idempotencyKey: item.id, timeoutMs: 5000 });
    } catch (error) { result = { status: 'error', error: error.message }; }
    // A delivery event may beat the HTTP response. Never downgrade it.
    if (item.status === 'delivered') return { ...result, status: 'delivered', interventionId: item.id };
    if (result?.status === 'delivered') await this.delivered(item.id);
    else {
      item.status = ['accepted', 'duplicate'].includes(result?.status) ? 'accepted' : 'queued';
      await this.persist(item);
    }
    return { ...result, status: item.status, interventionId: item.id };
  }

  async delivered(id) {
    const item = this.items.get(id);
    if (!item || item.status === 'delivered') return;
    item.status = 'delivered';
    await this.persist(item);
    this.onDelivered(item);
  }

  async observe(event) {
    if (event.type === 'user_intervention_delivered') await this.delivered(event.data?.intervention_id);
    // Terminal snapshots reconcile delivery even if a reconnect missed the ack.
    for (const id of event.data?.user_interventions?.delivered_ids || []) await this.delivered(id);
  }

  async finish({ continueAutomatically = true } = {}) {
    if (this.finished) return [];
    this.finished = true;
    this.ended = true;
    // Input listener is detached first. Requests already in flight have a deadline.
    await Promise.allSettled([...this.pending]);
    const queued = [];
    for (const item of this.items.values()) {
      if (item.status === 'delivered') continue;
      item.status = continueAutomatically ? 'queued' : 'held';
      await this.persist(item);
      if (continueAutomatically) queued.push({ instruction: item.instruction, followupId: item.id });
    }
    return queued;
  }
}

/** Fold durable and legacy intervention events without duplicating SSE echoes. */
export function followupsFromTranscript(detail) {
  const items = new Map();
  for (const entry of detail.entries || []) if (entry.interventionId) {
    items.set(entry.interventionId, { id: entry.interventionId, instruction: entry.content,
      order: entry.order, timestamp: entry.timestamp, status: 'pending', durable: true, hasMessage: true });
  }
  for (const row of detail.replayEvents || []) {
    const { type, data = {} } = row.event || {};
    if (type === 'complete') {
      const delivered = new Set(data.user_interventions?.delivered_ids || []);
      for (const item of items.values()) {
        if (item.order >= row.order || ['delivered', 'started', 'completed', 'held'].includes(item.status)) continue;
        item.status = delivered.has(item.id) ? 'delivered' : 'queued';
      }
      continue;
    }
    if (!type?.startsWith('user_intervention')) continue;
    const id = data.intervention_id || (type === 'user_intervention' ? `legacy-${row.order}` : null);
    if (!id) continue;
    let item = items.get(id);
    if (!item && data.instruction) {
      item = { id, instruction: data.instruction, order: row.order, timestamp: row.timestamp,
        status: 'pending', durable: Boolean(data.durable), hasMessage: false };
      items.set(id, item);
    }
    if (!item) continue;
    const status = type === 'user_intervention_delivered' ? 'delivered'
      : type === 'user_intervention_queued' ? 'queued'
        : type === 'user_intervention_accepted' ? 'accepted' : data.status;
    if (['delivered', 'started', 'completed'].includes(item.status)
      && !['started', 'completed'].includes(status)) continue;
    if (item.status === 'queued' && ['pending', 'sending', 'accepted'].includes(status)) continue;
    if (status === 'started') item.executionOrder = row.order;
    if (status) item.status = status;
  }
  return [...items.values()].sort((a, b) => a.order - b.order);
}

/** A late enqueue must wake an idle runner; only one drain owns the FIFO. */
export function createInstructionQueue(run, onError = () => {}) {
  const pending = [];
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        try { await run(pending.shift()); } catch (error) { onError(error); }
      }
    } finally { running = false; }
  }
  const enqueue = instruction => { pending.push(instruction); void drain(); };
  enqueue.remove = predicate => {
    const removed = pending.filter(predicate);
    for (let i = pending.length - 1; i >= 0; i--) if (predicate(pending[i])) pending.splice(i, 1);
    return removed;
  };
  return enqueue;
}
