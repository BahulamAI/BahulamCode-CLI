import { contextToPromptBlock, directoryInstructions } from './project-context-loader.mjs';

export function instructionContext(projectContext, agentContext = {}) {
  const skills = new Map((projectContext?.available_skills || []).map(skill => [skill.name, skill]));
  for (const skill of agentContext.global_skills || []) skills.set(skill.name, skill);
  const availableSkills = [...skills.values()];
  const instructions = directoryInstructions(projectContext?.files);
  const catalog = availableSkills.length ? [
    'Available skills. When a skill matches the task or the user names it, read its SKILL.md using skill_view or read_file before following it.',
    ...availableSkills.map(skill => `- ${skill.name}: ${skill.description || ''}${skill.path ? ' (' + skill.path + ')' : ''}`),
  ].join('\n') : '';
  return {
    agent_context: instructions ? { ...agentContext, directory_instructions: instructions } : agentContext,
    project_context: {
      loaded_files: projectContext?.loaded || [],
      changed_files: projectContext?.changed?.map(f => ({ label: f.label, path: f.path, hash: f.hash })) || [],
      prompt_block: [contextToPromptBlock(projectContext, instructions), catalog].filter(Boolean).join('\n\n'),
    },
    available_skills: availableSkills,
  };
}

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
    ...instructionContext(projectContext, agentContext),
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
    task_state: projectContext?.task_state || [],
  };
}
