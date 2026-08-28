import { randomUUID } from 'node:crypto';
import { ApprovalManager } from '../core/approval.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class BrowserApprovalManager extends ApprovalManager {
  constructor({ emit, timeoutMs = DEFAULT_TIMEOUT_MS, ...options } = {}) {
    super({ ...options, autoApprove: false });
    if (typeof emit !== 'function') throw new Error('BrowserApprovalManager requires emit');
    this.emit = emit;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  setAutoMode(enabled) {
    this.autoApprove = false;
    this.approveAll = Boolean(enabled);
    if (!enabled) this.approvedToolTypes.clear();
    return this.browserSummary();
  }

  browserSummary() {
    const summary = this.getSummary();
    return {
      mode: this.approveAll ? 'auto' : 'ask',
      auto: Boolean(this.approveAll),
      total: summary.total,
      approved: summary.approved,
      denied: summary.denied,
      trust: summary.trust,
    };
  }

  _optionsFor(tier, toolName, args) {
    return super._optionsFor(tier, toolName, args)
      .filter((option) => option.value === 'approve' || option.value === 'reject');
  }

  async _prompt(toolName, args, context = {}) {
    const tier = context.tier;
    const why = context.reason || context.why || '';
    const options = this._optionsFor(tier, toolName, args);
    const approvalId = `approval_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const prompt = promptForBrowser(toolName, args, tier, why);

    this.emit('agent_approval_required', {
      approval_id: approvalId,
      tool_id: context.tool_id || context.call_id || context.request_id || '',
      call_id: context.call_id || context.request_id || context.tool_id || '',
      tool: toolName,
      args: args || {},
      tier,
      reason: why,
      prompt,
      options: options.map((option) => ({
        key: option.key,
        label: option.label,
        value: option.value,
        hint: option.hint || '',
      })),
    });

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        const reason = `Approval timed out for ${toolName}`;
        this.history.push({ tool: toolName, decision: 'timeout', tier, time: Date.now(), reason });
        this.approvalLog.append({ tool: toolName, args, tier, decision: 'timeout', scope: 'once', reason, prompt });
        this._rememberRejection({ tool: toolName, args, tier, decision: 'reject', reason, note: '' });
        this.emit('agent_approval_resolved', {
          approval_id: approvalId,
          tool_id: context.tool_id || context.call_id || context.request_id || '',
          call_id: context.call_id || context.request_id || context.tool_id || '',
          tool: toolName,
          approved: false,
          reason,
        });
        resolve({ approved: false, tier, reason });
      }, this.timeoutMs);

      this.pending.set(approvalId, {
        toolName,
        args: args || {},
        tier,
        prompt,
        options,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(this._decisionResult(decision, { approvalId, toolName, args: args || {}, tier, prompt, context }));
        },
      });
    });
  }

  decide(approvalId, decision = {}) {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      const err = new Error(`Approval request not found or already resolved: ${approvalId}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    this.pending.delete(approvalId);
    pending.resolve(decision);
    return { ok: true, approval_id: approvalId };
  }

  rejectAll(reason = 'Local workspace session closed') {
    for (const [approvalId, pending] of this.pending.entries()) {
      this.pending.delete(approvalId);
      pending.resolve({ decision: 'reject', reason });
    }
  }

  _decisionResult(decision, { approvalId, toolName, args, tier, prompt, context = {} }) {
    const value = normalizeDecision(decision);
    const note = String(decision?.reason || decision?.note || '').trim();

    switch (value) {
      case 'approve':
        this.history.push({ tool: toolName, decision: 'yes', tier, time: Date.now() });
        this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve', scope: 'once', prompt });
        this.emitResolved(approvalId, toolName, true, 'once', '', context);
        return { approved: true, tier, scope: 'once' };

      case 'allow-session': {
        if (!this.policy.hitl?.allowSessionTrust) {
          this.history.push({ tool: toolName, decision: 'yes', tier, time: Date.now() });
          this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve', scope: 'once', prompt });
          this.emitResolved(approvalId, toolName, true, 'once', '', context);
          return { approved: true, tier, scope: 'once' };
        }
        const rule = this.trustStore.add({ tool: toolName, args, tier, scope: 'SESSION' });
        this.history.push({ tool: toolName, decision: 'session-trust', tier, time: Date.now(), rule_id: rule.id });
        this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve_trusted', scope: 'SESSION', rule_id: rule.id, prompt });
        this.emitResolved(approvalId, toolName, true, 'SESSION', '', context);
        return { approved: true, tier, scope: 'SESSION', rule_id: rule.id };
      }

      case 'allow-project': {
        if (!this.policy.hitl?.allowProjectTrust) {
          this.history.push({ tool: toolName, decision: 'yes', tier, time: Date.now() });
          this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve', scope: 'once', prompt });
          this.emitResolved(approvalId, toolName, true, 'once', '', context);
          return { approved: true, tier, scope: 'once' };
        }
        const rule = this.trustStore.add({ tool: toolName, args, tier, scope: 'PROJECT' });
        this.history.push({ tool: toolName, decision: 'project-trust', tier, time: Date.now(), rule_id: rule.id });
        this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve_trusted', scope: 'PROJECT', rule_id: rule.id, prompt });
        this.emitResolved(approvalId, toolName, true, 'PROJECT', '', context);
        return { approved: true, tier, scope: 'PROJECT', rule_id: rule.id };
      }

      case 'allow-type':
        this.approvedToolTypes.add(toolName);
        this.history.push({ tool: toolName, decision: 'type-approve', tier, time: Date.now() });
        this.approvalLog.append({ tool: toolName, args, tier, decision: 'type-approve', scope: 'session', prompt });
        this.emitResolved(approvalId, toolName, true, 'type', '', context);
        return { approved: true, tier, scope: 'type' };

      case 'allow-all':
        this.approveAll = true;
        this.history.push({ tool: toolName, decision: 'approve-all', tier, time: Date.now() });
        this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve-all', scope: 'session', prompt });
        this.emitResolved(approvalId, toolName, true, 'all', '', context);
        return { approved: true, tier, scope: 'all' };

      case 'reject':
      default: {
        const reason = note || 'User stopped the command';
        this.history.push({ tool: toolName, decision: 'no', tier, time: Date.now(), reason });
        this.approvalLog.append({ tool: toolName, args, tier, decision: 'reject', scope: 'once', reason, prompt });
        this._rememberRejection({ tool: toolName, args, tier, decision: 'reject', reason, note });
        this.emitResolved(approvalId, toolName, false, 'once', reason, context);
        return { approved: false, tier, reason };
      }
    }
  }

  emitResolved(approvalId, toolName, approved, scope, reason = '', context = {}) {
    this.emit('agent_approval_resolved', {
      approval_id: approvalId,
      tool_id: context.tool_id || context.call_id || context.request_id || '',
      call_id: context.call_id || context.request_id || context.tool_id || '',
      tool: toolName,
      approved,
      scope,
      reason,
    });
  }
}

function normalizeDecision(decision = {}) {
  const value = String(decision.decision || decision.value || '').trim();
  switch (value) {
    case 'approve':
    case 'allow-session':
    case 'allow-project':
    case 'allow-type':
    case 'allow-all':
    case 'reject':
      return value;
    case 'grant':
      return 'approve';
    case 'deny':
    default:
      return 'reject';
  }
}

function promptForBrowser(tool, args, tier, why) {
  return {
    title: `Approval · ${String(tier || '').toUpperCase()} · ${tool || 'tool'}`,
    subject: approvalSubject(tool, args),
    reason: why || '',
  };
}

function approvalSubject(tool, args = {}) {
  if (tool === 'shell') return args.command || args.cmd || 'shell command';
  const target = args.path || args.file_path || args.file || args.target || '';
  return target ? `${tool} ${target}` : String(tool || 'tool');
}
