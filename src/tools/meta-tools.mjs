/**
 * Sub-agent meta-tools: explore, plan, verify, debug, refactor.
 *
 * These are the LLM-visible peer-agent tools that map to gateway
 * /v1/agent/subagent calls. For branch-01 they are registered with
 * full schema parity to the Python originals (tool_bridge.py);
 * the actual dispatch becomes a gateway call in a later phase.
 */

const HANDOFF_SCHEMA = {
    type: 'object',
    description: 'Optional compact handoff envelope. Pass known facts so the peer starts with context.',
    properties: {
        objective: { type: 'string' },
        context: { type: 'string' },
        files: { type: 'array', items: { type: 'object' } },
        findings: { type: 'array', items: { type: 'object' } },
        constraints: { type: 'array', items: { type: 'string' } },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        output_contract: { type: 'string' },
    },
};

/** Stub call — signals this is a gateway-dispatched sub-agent. */
async function stubCall(_input) {
    // Actual dispatch goes through gateway /v1/agent/subagent in a later phase.
    // The LLM sees this tool registered so the gateway can serve its schema.
    return 'Sub-agent dispatch via gateway — not yet implemented client-side.';
}

function metaTool(name, description, params) {
    return {
        name,
        description,
        inputSchema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'The task to delegate to this sub-agent.' },
                handoff: HANDOFF_SCHEMA,
                ...params,
            },
            required: ['task'],
        },
        validateInput(input) { return input.task ? [] : ['task required']; },
        async call(input) { return stubCall(input); },
    };
}

export const ExploreTool = metaTool(
    'explore',
    'Read-only codebase investigation and orientation.',
    {
        thoroughness: {
            type: 'string',
            enum: ['quick', 'medium', 'thorough'],
            description: 'How deep to investigate.',
            default: 'medium',
        },
    },
);

export const PlanTool = metaTool(
    'plan',
    'Sequencing, design, and risk analysis for multi-file changes.',
    {},
);

export const VerifyTool = metaTool(
    'verify',
    'Tests, lint, build checks, and evidence gathering.',
    {},
);

export const DebugTool = metaTool(
    'debug',
    'Failure reproduction and root-cause investigation.',
    {},
);

export const RefactorTool = metaTool(
    'refactor',
    'Mechanical broad cleanup, renames, and structure-only changes.',
    {},
);