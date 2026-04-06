/**
 * Skill Tool — invoke a loaded skill by name.
 *
 * Skills are loaded from .claude/skills/{name}/SKILL.md and provide
 * specialized prompts injected into the conversation.
 */

export const SkillTool = {
    name: 'Skill',
    description: 'Invoke a skill within the conversation. Skills provide specialized capabilities.',
    inputSchema: {
        type: 'object',
        properties: {
            skill: {
                type: 'string',
                description: 'The skill name to invoke (e.g., "commit", "review-pr")',
            },
            args: {
                type: 'string',
                description: 'Optional arguments for the skill',
            },
        },
        required: ['skill'],
    },

    // Set by skills loader
    _skillsLoader: null,

    validateInput(input) {
        return input.skill ? [] : ['skill name is required'];
    },

    async call(input) {
        if (!this._skillsLoader) {
            return 'Skills system not initialized. No skills available.';
        }

        try {
            const skill = this._skillsLoader.get(input.skill);
            if (!skill) {
                const available = this._skillsLoader.list();
                const names = available.map(s => s.name).join(', ');
                return `Unknown skill: "${input.skill}". Available: ${names || 'none'}`;
            }

            const result = await this._skillsLoader.run(input.skill, input.args);
            return result;
        } catch (err) {
            return `Skill error: ${err.message}`;
        }
    },
};
