/**
 * Host action broker.
 *
 * PRD-108 section 11.2: a button declares an action id and typed arguments; the
 * host maps ids to handlers. Section 2 invariant 4 and AC-10: the same policy
 * protects an agent-originated and a UI-originated call, so both arrive here.
 *
 * An action id is NOT a tool name. The indirection is the point — a document
 * cannot name a tool, so what it can trigger is bounded by the manifest.
 */

export class UnregisteredActionError extends Error {
  constructor(actionId, available) {
    super(
      `"${actionId}" is not a registered action. This plugin registers: ` +
        (available.length ? available.join(', ') : '(none)'),
    );
    this.name = 'UnregisteredActionError';
  }
}

/**
 * @param {object} options
 * @param {{id:string,tool:string,summary:string,requiresApproval:boolean}[]} options.actions
 * @param {(name: string, args: object) => Promise<object>} options.execute  runs a plugin tool
 * @param {(request: object) => Promise<boolean>} [options.approve]  asks a human
 */
export function createActionBroker({ actions = [], execute, approve = null }) {
  const byId = new Map(actions.map((action) => [action.id, action]));

  return {
    async listRegistered() {
      return actions.map((action) => ({ actionId: action.id, summary: action.summary }));
    },

    async request({ actionId, arguments: args = {} }) {
      const action = byId.get(String(actionId));
      if (!action) throw new UnregisteredActionError(actionId, [...byId.keys()]);

      if (action.requiresApproval) {
        if (!approve) {
          // Refusing beats running it unapproved. An action the author marked
          // as needing a decision must not proceed because no one was asked.
          return {
            status: 'approval-required',
            approvalId: `${action.id}:${Date.now().toString(36)}`,
            summary: `${action.summary} — this host cannot ask for approval, so it was not run.`,
          };
        }
        const granted = await approve({ actionId: action.id, summary: action.summary, arguments: args });
        if (!granted) {
          return { status: 'approval-required', approvalId: `${action.id}:denied`, summary: 'Not approved.' };
        }
      }

      const result = await execute(action.tool, args);
      return { status: 'completed', result };
    },
  };
}
