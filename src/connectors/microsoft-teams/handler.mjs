import { randomUUID } from 'node:crypto';
import { resolveBinding, scopedState } from './bindings.mjs';

const failure = output => ({ success: false, output });

export function createTeamsHandler({ loadBindings, openState, runAgent, tools, resolveConnection }) {
  // Serializes turns for a user/conversation. Durable receipts also prevent
  // duplicate activity execution across processes/restarts (SQLite unique key).
  const queues = new Map();

  return async function handle({ activity, send }) {
    if (activity.type !== 'message') return;
    let resolved;
    try { resolved = resolveBinding(activity, await loadBindings()); }
    catch (error) { await send(error.message); return; }
    const previous = queues.get(resolved.scope) || Promise.resolve();
    const turn = previous.catch(() => {}).then(() => processTurn(resolved, activity, send));
    queues.set(resolved.scope, turn);
    try { await turn; } finally { if (queues.get(resolved.scope) === turn) queues.delete(resolved.scope); }
  };

  async function processTurn(resolved, activity, send) {
    const raw = await openState(resolved.scope);
    try {
      const state = scopedState(raw, resolved);
      const connection = await resolveConnection(resolved);
      const prior = state.query('SELECT status FROM teams_receipts WHERE id = ?', [resolved.receipt]);
      if (prior.length) return; // A retry must never replay a mutation.
      try {
        state.query('INSERT INTO teams_receipts (id, status, created_at) VALUES (?, ?, ?)',
          [resolved.receipt, 'started', new Date().toISOString()]);
      } catch (error) {
        if (state.query('SELECT status FROM teams_receipts WHERE id = ?', [resolved.receipt]).length) return;
        throw error;
      }
      let text = String(activity.text || '').replace(/<at\b[^>]*>.*?<\/at>/gs, '').trim();
      if (!text || text.length > 16000) throw new Error('Send a text request of up to 16,000 characters.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180000);
      let output;
      try {
        const approval = text.match(/^\/approve ([a-f0-9-]{36})$/i);
        if (approval) {
          const key = `approval:${resolved.session}:${approval[1]}`;
          const pending = state.get(key);
          if (!pending || pending.expires < Date.now()) throw new Error('This approval is missing, expired, or already used.');
          // Consume before the external write. An uncertain outcome is not retried.
          const consumed = state.query('DELETE FROM kv WHERE key = ?', [key]);
          if (Number(consumed.changes) !== 1) throw new Error('Approval was already used.');
          const result = await tools.get(pending.name).call({ ...pending.args, approved: true }, { state, connection, signal: controller.signal });
          output = JSON.stringify(result);
          const history = state.get(`history:${resolved.session}`, []);
          state.set(`history:${resolved.session}`, [...history, { role: 'user', content: text },
            { role: 'assistant', content: output.slice(0, 12000) }].slice(-12));
        } else {
          const execute = async (name, args = {}) => {
            if (controller.signal.aborted) return failure('Request cancelled.');
            const tool = tools.get(name);
            if (!tool) return failure('Tool is not available in this plugin.');
            if (tool.approvalArgument && args[tool.approvalArgument]) return failure('Approval must come from the user’s /approve command.');
            const result = await tool.call(args, { state, connection, signal: controller.signal });
            if (result.output?.needs_approval) {
              const token = randomUUID();
              state.set(`approval:${resolved.session}:${token}`, { name, args: structuredClone(args), expires: Date.now() + 15 * 60000 });
              return { ...result, output: { ...result.output, approval_command: `/approve ${token}`,
                message: 'Show the proposed change and this command to the user. It expires in 15 minutes.' } };
            }
            return result;
          };
          const history = state.get(`history:${resolved.session}`, []);
          output = await runAgent({ text, history, execute, signal: controller.signal, sessionId: resolved.session });
          const reply = typeof output === 'string' ? output : JSON.stringify(output);
          state.set(`history:${resolved.session}`, [...history, { role: 'user', content: text },
            { role: 'assistant', content: reply.slice(0, 12000) }].slice(-12));
        }
        const reply = String(output || 'No response was produced.');
        // Smaller than Teams' activity payload limit, even with multibyte text.
        for (let offset = 0; offset < reply.length; offset += 3000) await send(reply.slice(offset, offset + 3000));
        state.query('UPDATE teams_receipts SET status = ? WHERE id = ?', ['completed', resolved.receipt]);
      } finally { clearTimeout(timer); }
    } catch (error) {
      stateSafeFailure(raw, resolved.receipt);
      // Do not expose SDK, model-provider or credential errors to a channel.
      await send('The request could not be completed. Check Azure DevOps before retrying a change; it may already have been applied. Ask your administrator to check this connection if the problem persists.');
    } finally { raw.close?.(); }
  }
}

function stateSafeFailure(state, id) {
  try { state.query('UPDATE teams_receipts SET status = ? WHERE id = ?', ['failed', id]); } catch { /* original failure wins */ }
}
