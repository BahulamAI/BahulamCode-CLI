/**
 * Agent Teams — multi-agent coordination.
 *
 * Allows registering named agents that can communicate via messages.
 * Each teammate is an agent loop that can be invoked with a prompt.
 */

export class AgentTeams {
    constructor() {
        /** @type {Map<string, { loop: object, role?: string, status: string }>} */
        this.teammates = new Map();
        this.messageLog = [];
    }

    /**
     * Register a named agent.
     * @param {string} name - unique agent name
     * @param {object} agentLoop - agent loop with .run() async generator
     * @param {object} [options]
     * @param {string} [options.role] - agent role description
     */
    register(name, agentLoop, options = {}) {
        if (this.teammates.has(name)) {
            throw new Error(`Agent "${name}" is already registered`);
        }
        this.teammates.set(name, {
            loop: agentLoop,
            role: options.role || 'general',
            status: 'idle',
        });
    }

    /**
     * Unregister an agent.
     * @param {string} name
     * @returns {boolean}
     */
    unregister(name) {
        return this.teammates.delete(name);
    }

    /**
     * Send a message to a teammate and collect all events.
     * @param {string} to - target agent name
     * @param {string} message - prompt to send
     * @returns {Promise<Array<object>>} collected events
     */
    async sendMessage(to, message) {
        const agent = this.teammates.get(to);
        if (!agent) throw new Error(`Unknown teammate: ${to}`);

        agent.status = 'running';
        const results = [];

        try {
            for await (const event of agent.loop.run(message)) {
                results.push(event);
            }
        } finally {
            agent.status = 'idle';
        }

        this.messageLog.push({
            to,
            message: message.substring(0, 100),
            resultCount: results.length,
            timestamp: new Date().toISOString(),
        });

        return results;
    }

    /**
     * Broadcast a message to all teammates.
     * @param {string} message
     * @returns {Promise<Map<string, Array<object>>>} results per agent
     */
    async broadcast(message) {
        const results = new Map();
        const promises = [];

        for (const [name] of this.teammates) {
            promises.push(
                this.sendMessage(name, message)
                    .then(events => results.set(name, events))
                    .catch(err => results.set(name, [{ type: 'error', message: err.message }]))
            );
        }

        await Promise.all(promises);
        return results;
    }

    /**
     * List all registered teammates.
     * @returns {Array<{ name: string, role: string, status: string }>}
     */
    list() {
        return [...this.teammates.entries()].map(([name, info]) => ({
            name,
            role: info.role,
            status: info.status,
        }));
    }

    /**
     * Get the message log.
     * @param {number} [limit] - max entries to return
     * @returns {Array<object>}
     */
    getMessageLog(limit) {
        if (limit) return this.messageLog.slice(-limit);
        return [...this.messageLog];
    }

    /**
     * Get count of registered teammates.
     * @returns {number}
     */
    size() {
        return this.teammates.size;
    }
}
