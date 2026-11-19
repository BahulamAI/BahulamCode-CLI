import { randomUUID } from 'node:crypto';

// One attached renderer owns all picker/question input. Queue concurrent agent
// questions; never install another stdin listener or overwrite an active picker.
export function createRustInteractions({ send, getSessionId, timeoutMs = 5 * 60_000 }) {
  let active = null;
  let closed = false;
  const queue = [];
  const publish = async (item, data) => send({ v: 2, seq: 1, ts: new Date().toISOString(),
    type: 'interaction_requested', session_id: item.sessionId, agent_id: 'main', data });
  function finish(value, clear = false) {
    const item = active;
    if (!item) return;
    active = null;
    clearTimeout(item.timer);
    if (clear) Promise.resolve(publish(item, { request_id: item.id, title: '', options: [], cancelled: true })).catch(() => {});
    item.resolve(value);
    advance();
  }
  function advance() {
    if (closed || active || !queue.length) return;
    const item = queue.shift();
    active = item;
    item.timer = setTimeout(() => finish(null, true), timeoutMs);
    Promise.resolve().then(() => active === item && !closed ? publish(item, { request_id: item.id, title: item.title,
      message: item.message, options: item.options, allow_free_text: item.allowFreeText }) : false)
      .then(sent => { if (sent === false && active === item) finish(null, true); })
      .catch(() => { if (active === item) finish(null, true); });
  }
  return {
    choose(title, options, message = '', { allowFreeText = false } = {}) {
      if (closed) return Promise.resolve(null);
      const sessionId = getSessionId();
      if (!sessionId) return Promise.resolve(null);
      return new Promise(resolve => {
        queue.push({ id: randomUUID(), sessionId, title: String(title), message: String(message),
          options: options.map(option => ({ label: String(option.label), value: String(option.value) })),
          allowFreeText, resolve });
        advance();
      });
    },
    answer(data) {
      if (!active || active.id !== data.request_id) return false;
      if (data.cancelled) { finish(null, true); return true; }
      if (typeof data.value !== 'string' || !data.value.trim() || Buffer.byteLength(data.value) > 5 * 1024 * 1024) return false;
      if (!active.allowFreeText && !active.options.some(option => option.value === data.value)) return false;
      finish(data.value, true);
      return true;
    },
    cancel() {
      for (const item of queue.splice(0)) item.resolve(null);
      finish(null, true);
    },
    close() {
      closed = true;
      this.cancel();
    },
  };
}
