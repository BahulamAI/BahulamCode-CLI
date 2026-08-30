import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { loadKeplerSettings } from './settings-loader.mjs';

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesHook(hook, toolName) {
  const matcher = hook.matcher || hook.toolName || hook.tool;
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function runCommand(command, { cwd, env, timeoutMs, input }) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-lc', command], {
      cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      let parsed = null;
      try { parsed = stdout.trim() ? JSON.parse(stdout.trim()) : null; }
      catch { parsed = stdout.trim() ? { output: stdout.trim() } : null; }
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal || null,
        stdout,
        stderr,
        parsed,
        error,
      });
    });
    if (input) child.stdin?.end(JSON.stringify(input));
  });
}

export class HookRunner {
  constructor({ cwd = process.cwd(), settings = null, sessionId = null } = {}) {
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.settings = settings || loadKeplerSettings({ cwd }).settings;
  }

  reload() {
    this.settings = loadKeplerSettings({ cwd: this.cwd }).settings;
  }

  hooksFor(event) {
    return asArray(this.settings?.hooks?.[event]);
  }

  async run(event, payload = {}) {
    const results = [];
    for (const hook of this.hooksFor(event)) {
      const toolName = payload.toolName || payload.tool || '';
      if ((event === 'PreToolUse' || event === 'PostToolUse') && !matchesHook(hook, toolName)) continue;
      const timeoutSeconds = hook.timeout ?? this.settings?.hooks?.timeout ?? 5;
      const input = {
        event,
        tool_name: toolName,
        tool_input: payload.input || payload.args || {},
        tool_result: payload.result || null,
        project_dir: this.cwd,
        session_id: this.sessionId || '',
      };
      const env = {
        ...process.env,
        ...(this.settings?.env || {}),
        BAHULAM_TOOL_NAME: toolName,
        BAHULAM_TOOL_INPUT_FILE_PATH: input.tool_input.file_path || input.tool_input.path || '',
        BAHULAM_PROJECT_DIR: this.cwd,
        BAHULAM_SESSION_ID: this.sessionId || '',
        BAHULAM_TURN_ID: payload.turnId || '',
        // Legacy names kept for backward compat with existing hook scripts
        KEPLER_TOOL_NAME: toolName,
        KEPLER_TOOL_INPUT_FILE_PATH: input.tool_input.file_path || input.tool_input.path || '',
        KEPLER_PROJECT_DIR: this.cwd,
        KEPLER_SESSION_ID: this.sessionId || '',
        KEPLER_TURN_ID: payload.turnId || '',
      };
      const result = await runCommand(hook.command, {
        cwd: path.resolve(this.cwd),
        env,
        timeoutMs: timeoutSeconds * 1000,
        input,
      });
      results.push({ hook, ...result });
      if (result.code === 2 || result.parsed?.block === true || result.parsed?.decision === 'deny') {
        return {
          blocked: true,
          message: result.parsed?.message || result.stderr?.trim() || `Blocked by hook: ${hook.command}`,
          results,
        };
      }
    }
    return { blocked: false, results };
  }
}
