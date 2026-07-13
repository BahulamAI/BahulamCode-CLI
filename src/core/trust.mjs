import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TIERS } from './risk-tier.mjs';

function trustPath(cwd) {
  return path.join(cwd, '.kepler', 'trust.json');
}

function nowIso() {
  return new Date().toISOString();
}

function commandShape(command) {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).join(' ');
}

function shellPattern(args) {
  const shape = commandShape(args?.command);
  return shape ? `${shape}*` : '*';
}

function pathPattern(args) {
  const p = String(args?.file_path || args?.path || '').trim();
  if (!p) return '*';
  const dir = path.dirname(p);
  return dir === '.' ? p : path.join(dir, '**');
}

export function patternFor(tool, args = {}) {
  if (tool === 'shell') return shellPattern(args);
  return pathPattern(args);
}

function matches(pattern, value) {
  if (!pattern || pattern === '*') return true;
  if (pattern.endsWith('*')) return String(value || '').startsWith(pattern.slice(0, -1));
  if (pattern.endsWith('/**')) return String(value || '').startsWith(pattern.slice(0, -3));
  return pattern === value;
}

function valueFor(tool, args = {}) {
  if (tool === 'shell') return String(args.command || '');
  return String(args.file_path || args.path || '');
}

export class TrustStore {
  constructor({ cwd = process.cwd(), policy = {} } = {}) {
    this.cwd = cwd;
    this.policy = policy;
    this.sessionRules = [];
  }

  loadProjectRules() {
    try {
      const file = trustPath(this.cwd);
      if (!fs.existsSync(file)) return [];
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(data.rules) ? data.rules : [];
    } catch {
      return [];
    }
  }

  saveProjectRules(rules) {
    const file = trustPath(this.cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, rules }, null, 2) + '\n');
  }

  allRules() {
    return [...this.sessionRules, ...this.loadProjectRules()];
  }

  find(tool, args = {}, tier = '') {
    const value = valueFor(tool, args);
    const rules = this.allRules().filter(rule => rule.tool === tool && matches(rule.pattern, value));
    const deny = rules.find(rule => rule.decision === 'deny');
    if (deny) return { decision: 'deny', rule: deny };
    const allow = rules.find(rule => rule.decision === 'allow');
    if (!allow) return null;

    const reask = this.shouldReask(allow, args, tier);
    if (reask) return { decision: 'reask', rule: allow, reason: reask };
    return { decision: 'allow', rule: allow };
  }

  shouldReask(rule, args = {}, tier = '') {
    const reask = rule.reask || {};
    const after = reask.after_minutes ?? this.policy.hitl?.reaskAfterMinutes;
    if (after && rule.created_at) {
      const ageMs = Date.now() - Date.parse(rule.created_at);
      if (Number.isFinite(ageMs) && ageMs > after * 60 * 1000) {
        return `approval expired after ${after}m`;
      }
    }
    if ((reask.on_risk_increase ?? this.policy.hitl?.reaskOnRiskIncrease) && rule.tier && tier) {
      const order = [TIERS.READ, TIERS.SHELL_SAFE, TIERS.LOCAL_EDIT, TIERS.SHELL_MEDIUM, TIERS.NETWORK, TIERS.SHELL_DANGEROUS, TIERS.DESTRUCTIVE];
      if (order.indexOf(tier) > order.indexOf(rule.tier)) return 'risk tier increased';
    }
    if ((this.policy.hitl?.alwaysAskForDangerous ?? true) && (tier === TIERS.SHELL_DANGEROUS || tier === TIERS.DESTRUCTIVE)) {
      return 'dangerous tier requires fresh approval';
    }
    if ((reask.on_command_shape_change ?? this.policy.hitl?.reaskOnCommandShapeChange) && rule.command_shape && args.command) {
      if (rule.command_shape !== commandShape(args.command)) return 'command shape changed';
    }
    return '';
  }

  add({ tool, args = {}, tier, scope = 'SESSION', decision = 'allow' }) {
    const normalizedScope = String(scope || 'SESSION').toUpperCase();
    const pattern = patternFor(tool, args);
    const id = `${tool}-${crypto.createHash('sha1').update(pattern + normalizedScope).digest('hex').slice(0, 10)}`;
    const ttl = this.policy.hitl?.reaskAfterMinutes ?? 30;
    const rule = {
      id,
      tool,
      pattern,
      scope: normalizedScope,
      decision,
      tier,
      command_shape: tool === 'shell' ? commandShape(args.command) : undefined,
      created_at: nowIso(),
      expires_at: normalizedScope === 'SESSION'
        ? new Date(Date.now() + ttl * 60 * 1000).toISOString()
        : undefined,
      reask: {
        after_minutes: ttl,
        on_command_shape_change: this.policy.hitl?.reaskOnCommandShapeChange ?? true,
        on_risk_increase: this.policy.hitl?.reaskOnRiskIncrease ?? true,
        on_path_boundary_change: this.policy.hitl?.reaskOnPathBoundaryChange ?? true,
      },
    };
    if (normalizedScope === 'PROJECT') {
      const rules = this.loadProjectRules().filter(r => r.id !== id);
      rules.push(rule);
      this.saveProjectRules(rules);
    } else {
      this.sessionRules = this.sessionRules.filter(r => r.id !== id);
      this.sessionRules.push(rule);
    }
    return rule;
  }

  revoke() {
    const active = this.sessionRules.length > 0;
    this.sessionRules = [];
    return active;
  }

  summary() {
    return {
      sessionRules: this.sessionRules.length,
      projectRules: this.loadProjectRules().length,
    };
  }
}
