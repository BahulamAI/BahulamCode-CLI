/**
 * CronDelete Tool — delete a scheduled task.
 */

import { cronStore } from './cron-create.mjs';

export const CronDeleteTool = {
    name: 'CronDelete',
    description: 'Delete a scheduled task by ID or name.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Cron job ID to delete' },
            name: { type: 'string', description: 'Cron job name to delete (alternative to id)' },
        },
        required: [],
    },

    validateInput(input) {
        if (!input.id && !input.name) return ['Either id or name is required'];
        return [];
    },

    async call(input) {
        let target = null;

        if (input.id) {
            target = cronStore.get(input.id);
        } else if (input.name) {
            for (const [, job] of cronStore) {
                if (job.name === input.name) {
                    target = job;
                    break;
                }
            }
        }

        if (!target) {
            return `No cron job found matching ${input.id || input.name}`;
        }

        if (target.timer) {
            clearInterval(target.timer);
        }
        cronStore.delete(target.id);

        return `Deleted cron job: ${target.id} (${target.name})`;
    },
};
