/**
 * CronCreate Tool — create a scheduled task.
 *
 * Stores cron definitions in memory and optionally persists them
 * to ~/.claude/cron.json. Uses setTimeout-based scheduling for
 * the duration of the session.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// Shared cron store
export const cronStore = new Map();
let cronIdCounter = 1;

export const CronCreateTool = {
    name: 'CronCreate',
    description: 'Create a scheduled task that runs on a cron schedule.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Name for the scheduled task' },
            schedule: {
                type: 'string',
                description: 'Cron expression (e.g., "*/5 * * * *") or interval (e.g., "5m", "1h")',
            },
            command: {
                type: 'string',
                description: 'Command or prompt to execute on schedule',
            },
            type: {
                type: 'string',
                enum: ['command', 'prompt'],
                description: 'Whether to run as shell command or agent prompt',
            },
        },
        required: ['name', 'schedule', 'command'],
    },

    validateInput(input) {
        const errors = [];
        if (!input.name) errors.push('name is required');
        if (!input.schedule) errors.push('schedule is required');
        if (!input.command) errors.push('command is required');
        return errors;
    },

    async call(input) {
        if (process.env.CLAUDE_CODE_DISABLE_CRON === '1') {
            return 'Cron tasks are disabled (CLAUDE_CODE_DISABLE_CRON=1)';
        }

        const id = `cron_${cronIdCounter++}`;
        const intervalMs = parseSchedule(input.schedule);

        const job = {
            id,
            name: input.name,
            schedule: input.schedule,
            command: input.command,
            type: input.type || 'command',
            intervalMs,
            createdAt: new Date().toISOString(),
            lastRun: null,
            runCount: 0,
            timer: null,
        };

        // Set up interval timer
        if (intervalMs > 0) {
            job.timer = setInterval(() => {
                job.lastRun = new Date().toISOString();
                job.runCount++;
                // Execution is handled by the cron runner in the main loop
            }, intervalMs);
        }

        cronStore.set(id, job);
        persistCronJobs();

        return `Created scheduled task:\n  ID: ${id}\n  Name: ${input.name}\n  Schedule: ${input.schedule}\n  Interval: ${intervalMs}ms\n  Type: ${job.type}`;
    },
};

/**
 * Parse a schedule string into milliseconds.
 * Supports cron shorthand: "5m", "1h", "30s", "1d"
 */
function parseSchedule(schedule) {
    const match = schedule.match(/^(\d+)(s|m|h|d)$/);
    if (match) {
        const value = parseInt(match[1], 10);
        const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
        return value * (units[match[2]] || 60000);
    }
    // Default: treat as minutes for simple numbers
    const num = parseInt(schedule, 10);
    if (!isNaN(num)) return num * 60000;
    // For full cron expressions, default to 5 minutes
    return 300000;
}

function persistCronJobs() {
    try {
        const cronDir = path.join(os.homedir(), '.claude');
        fs.mkdirSync(cronDir, { recursive: true });
        const jobs = [];
        for (const [, job] of cronStore) {
            const { timer, ...rest } = job;
            jobs.push(rest);
        }
        fs.writeFileSync(
            path.join(cronDir, 'cron.json'),
            JSON.stringify(jobs, null, 2)
        );
    } catch {
        // Best effort
    }
}
