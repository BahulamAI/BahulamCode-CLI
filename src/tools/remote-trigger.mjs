/**
 * RemoteTrigger Tool — trigger remote execution of a task.
 *
 * Sends a task to a remote agent endpoint for execution.
 * Used for distributed agent workflows and scheduled tasks.
 */

export const RemoteTriggerTool = {
    name: 'RemoteTrigger',
    description: 'Trigger remote execution of a task on a remote agent.',
    inputSchema: {
        type: 'object',
        properties: {
            endpoint: {
                type: 'string',
                description: 'Remote agent endpoint URL',
            },
            task: {
                type: 'string',
                description: 'Task description or prompt to execute remotely',
            },
            timeout: {
                type: 'number',
                description: 'Timeout in milliseconds (default: 300000)',
            },
            async: {
                type: 'boolean',
                description: 'Fire-and-forget mode (default: false)',
            },
        },
        required: ['task'],
    },

    validateInput(input) {
        return input.task ? [] : ['task is required'];
    },

    async call(input) {
        const endpoint = input.endpoint || process.env.REMOTE_AGENT_URL;
        if (!endpoint) {
            return 'No remote endpoint configured. Set endpoint parameter or REMOTE_AGENT_URL env var.';
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(
                () => controller.abort(),
                input.timeout || 300000
            );

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.REMOTE_AGENT_TOKEN && {
                        Authorization: `Bearer ${process.env.REMOTE_AGENT_TOKEN}`,
                    }),
                },
                body: JSON.stringify({
                    task: input.task,
                    async: input.async || false,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!res.ok) {
                return `Remote error: HTTP ${res.status} ${res.statusText}`;
            }

            if (input.async) {
                return `Task submitted to ${endpoint} (async mode)`;
            }

            const data = await res.json();
            return typeof data.result === 'string'
                ? data.result
                : JSON.stringify(data, null, 2);
        } catch (err) {
            return `Remote trigger error: ${err.message}`;
        }
    },
};
