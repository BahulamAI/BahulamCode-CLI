/**
 * TodoWrite Tool — in-memory task management.
 *
 * Maintains a task list that the agent can use to track work items.
 * State persists for the duration of the session.
 */

const todos = [];
let nextId = 1;

export const TodoWriteTool = {
    name: 'TodoWrite',
    description: 'Manage a task list. Supports add, update, complete, and list operations.',
    inputSchema: {
        type: 'object',
        properties: {
            todos: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Task ID (auto-assigned if adding)' },
                        content: { type: 'string', description: 'Task description' },
                        status: {
                            type: 'string',
                            enum: ['pending', 'in_progress', 'completed'],
                            description: 'Task status',
                        },
                        priority: {
                            type: 'string',
                            enum: ['high', 'medium', 'low'],
                            description: 'Task priority',
                        },
                    },
                    required: ['content', 'status'],
                },
                description: 'Array of todo items to write (replaces all todos)',
            },
        },
        required: ['todos'],
    },

    validateInput(input) {
        if (!input.todos || !Array.isArray(input.todos)) return ['todos must be an array'];
        return [];
    },

    async call(input) {
        // Replace entire todo list (matches Claude Code behavior)
        todos.length = 0;
        nextId = 1;

        for (const item of input.todos) {
            todos.push({
                id: item.id || String(nextId++),
                content: item.content,
                status: item.status || 'pending',
                priority: item.priority || 'medium',
            });
        }

        const summary = todos.map(t =>
            `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.id}. ${t.content} (${t.priority})`
        ).join('\n');

        return `Updated ${todos.length} todos:\n${summary}`;
    },
};
