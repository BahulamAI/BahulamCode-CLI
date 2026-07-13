import { contextToPromptBlock } from './project-context-loader.mjs';

export function buildContextEnvelope({
  cwd = process.cwd(),
  command = null,
  args = [],
  source = 'repl',
  dryRun = false,
  aliasesResolved = [],
  effectivePolicy,
  projectContext,
  activeHints = [],
  projectResources = [],
  agentContext = {},
} = {}) {
  const policy = effectivePolicy?.policy || {};
  const commandTimeouts = policy.commands?.timeouts || {};
  const enabled = policy.commands?.enabled || [];
  const activeCommand = command || null;
  const specificTimeout = activeCommand ? commandTimeouts[`${activeCommand}Seconds`] : null;

  return {
    cwd,
    project_resources: projectResources,
    agent_context: agentContext,
    project_context: {
      loaded_files: projectContext?.loaded || [],
      changed_files: projectContext?.changed?.map(f => ({ label: f.label, path: f.path, hash: f.hash })) || [],
      prompt_block: contextToPromptBlock(projectContext),
    },
    command_context: {
      active_command: activeCommand,
      source,
      args,
      dry_run: dryRun,
      aliases_resolved: aliasesResolved,
      runtime_limits: {
        command_timeout_seconds: specificTimeout || commandTimeouts.defaultSeconds || 300,
        tool_timeout_seconds: 120,
        approval_timeout_seconds: null,
      },
    },
    effective_options: {
      commands_enabled: enabled,
      plan_owner: policy.planning?.owner || 'auto',
      hitl_default_scope: policy.hitl?.defaultScope || 'once',
      reask_after_minutes: policy.hitl?.reaskAfterMinutes ?? 30,
      hook_timeout_seconds: policy.hooks?.timeoutSeconds ?? 5,
    },
    context_hints: activeHints,
    available_skills: projectContext?.available_skills || [],
    task_state: projectContext?.task_state || [],
  };
}
