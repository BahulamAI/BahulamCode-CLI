/**
 * AskUser Tool — prompt the user with a question and return their response.
 *
 * Used when the agent needs clarification or confirmation from the user.
 * In non-interactive mode, returns a default or times out.
 */

import readline from 'readline';

export const AskUserTool = {
    name: 'AskUser',
    description: 'Ask the user a question and wait for their response.',
    inputSchema: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description: 'The question to ask the user',
            },
            default_value: {
                type: 'string',
                description: 'Default value if user provides no input',
            },
            timeout: {
                type: 'number',
                description: 'Timeout in milliseconds (default: 60000)',
            },
        },
        required: ['question'],
    },

    validateInput(input) {
        return input.question ? [] : ['question is required'];
    },

    async call(input) {
        // In non-interactive mode, return default
        if (!process.stdin.isTTY) {
            return input.default_value || '[non-interactive: no user input available]';
        }

        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stderr,
            });

            const timeout = setTimeout(() => {
                rl.close();
                resolve(input.default_value || '[timeout: no response]');
            }, input.timeout || 60000);

            process.stderr.write(`\n\x1b[36m? ${input.question}\x1b[0m\n> `);
            rl.question('', (answer) => {
                clearTimeout(timeout);
                rl.close();
                resolve(answer.trim() || input.default_value || '');
            });
        });
    },
};
