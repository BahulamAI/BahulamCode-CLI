/**
 * CronList Tool — list all scheduled tasks.
 */

import { cronStore } from './cron-create.mjs';

export const CronListTool = {
    name: 'CronList',
    description: 'List all scheduled tasks.',
    inputSchema: {
        type: 'object',
        properties: {},
        required: [],
    },

    validateInput() { return []; },

    async call() {
        if (cronStore.size === 0) {
            return 'No scheduled tasks.';
        }

        const lines = [];
        for (const [, job] of cronStore) {
            lines.push(
                `  ${job.id}: ${job.name}\n` +
                `    Schedule: ${job.schedule} (${job.intervalMs}ms)\n` +
                `    Type: ${job.type}\n` +
                `    Runs: ${job.runCount}\n` +
                `    Last: ${job.lastRun || 'never'}\n` +
                `    Created: ${job.createdAt}`
            );
        }

        return `Scheduled tasks (${cronStore.size}):\n${lines.join('\n\n')}`;
    },
};
