/**
 * Skills Runner — executes a skill by injecting its prompt.
 *
 * When a skill is invoked, its prompt is injected as a system message
 * into the conversation context, guiding the agent's behavior.
 */

export class SkillRunner {
    /**
     * @param {object} loader - SkillsLoader instance
     * @param {object} agentLoop - agent loop instance
     */
    constructor(loader, agentLoop) {
        this.loader = loader;
        this.loop = agentLoop;
    }

    /**
     * Execute a skill.
     * @param {string} name - skill name
     * @param {string} [args] - optional arguments
     * @returns {AsyncGenerator} event stream from agent loop
     */
    async *execute(name, args) {
        const skill = this.loader.get(name);
        if (!skill) {
            yield { type: 'error', message: `Unknown skill: ${name}` };
            return;
        }

        // Build the skill prompt
        let prompt = skill.prompt;
        if (args) {
            prompt = prompt.replace(/\$ARGUMENTS/g, args);
        }

        // Inject skill context as a user message
        const message = `[Invoking skill: ${skill.name}]\n\n${prompt}${args ? `\n\nArguments: ${args}` : ''}`;

        // Run through agent loop
        yield* this.loop.run(message);
    }

    /**
     * List available skills for display.
     * @returns {Array<{name: string, description: string}>}
     */
    listAvailable() {
        return this.loader.list().map(s => ({
            name: s.name,
            description: s.description,
            aliases: s.aliases || [],
        }));
    }
}
