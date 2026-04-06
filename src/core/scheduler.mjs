/**
 * Scheduler — cron-based task scheduling.
 *
 * Stores scheduled tasks in ~/.claude/scheduled_tasks.json.
 * Tasks have a cron expression, prompt, and optional environment.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export class Scheduler {
    /**
     * @param {string} [tasksFile] - path to scheduled tasks JSON
     */
    constructor(tasksFile) {
        this.tasksFile = tasksFile ||
            path.join(os.homedir(), '.claude', 'scheduled_tasks.json');
        this.timers = new Map();
    }

    /**
     * Create a new scheduled task.
     * @param {string} cron - cron expression or interval shorthand (e.g., "5m", "1h")
     * @param {string} prompt - prompt to execute
     * @param {object} [options]
     * @param {string} [options.name] - human-readable name
     * @param {string} [options.model] - model to use
     * @param {boolean} [options.enabled] - whether task is enabled (default: true)
     * @returns {object} created task
     */
    async create(cron, prompt, options = {}) {
        const tasks = this._loadTasks();
        const task = {
            id: `task_${crypto.randomBytes(4).toString('hex')}`,
            name: options.name || `Task ${tasks.length + 1}`,
            cron,
            prompt,
            model: options.model || null,
            enabled: options.enabled !== false,
            createdAt: new Date().toISOString(),
            lastRun: null,
            runCount: 0,
            intervalMs: parseCronInterval(cron),
        };

        tasks.push(task);
        this._saveTasks(tasks);
        return task;
    }

    /**
     * Delete a scheduled task by ID.
     * @param {string} taskId
     * @returns {boolean} true if deleted
     */
    async delete(taskId) {
        const tasks = this._loadTasks();
        const idx = tasks.findIndex(t => t.id === taskId);
        if (idx === -1) return false;

        tasks.splice(idx, 1);
        this._saveTasks(tasks);

        // Clear timer if running
        if (this.timers.has(taskId)) {
            clearInterval(this.timers.get(taskId));
            this.timers.delete(taskId);
        }

        return true;
    }

    /**
     * List all scheduled tasks.
     * @returns {Array<object>}
     */
    async list() {
        return this._loadTasks();
    }

    /**
     * Check and return tasks that are due to run.
     * @returns {Array<object>} tasks that are due
     */
    async runDue() {
        const tasks = this._loadTasks();
        const due = [];
        const now = Date.now();

        for (const task of tasks) {
            if (!task.enabled) continue;
            if (!task.intervalMs) continue;

            const lastRun = task.lastRun ? new Date(task.lastRun).getTime() : 0;
            if (now - lastRun >= task.intervalMs) {
                task.lastRun = new Date().toISOString();
                task.runCount = (task.runCount || 0) + 1;
                due.push(task);
            }
        }

        if (due.length > 0) {
            this._saveTasks(tasks);
        }

        return due;
    }

    /**
     * Enable or disable a task.
     * @param {string} taskId
     * @param {boolean} enabled
     * @returns {boolean}
     */
    async setEnabled(taskId, enabled) {
        const tasks = this._loadTasks();
        const task = tasks.find(t => t.id === taskId);
        if (!task) return false;

        task.enabled = enabled;
        this._saveTasks(tasks);
        return true;
    }

    /**
     * Load tasks from disk.
     * @returns {Array<object>}
     */
    _loadTasks() {
        try {
            const raw = fs.readFileSync(this.tasksFile, 'utf-8');
            return JSON.parse(raw);
        } catch {
            return [];
        }
    }

    /**
     * Save tasks to disk.
     * @param {Array<object>} tasks
     */
    _saveTasks(tasks) {
        try {
            const dir = path.dirname(this.tasksFile);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.tasksFile, JSON.stringify(tasks, null, 2));
        } catch {
            // Best effort
        }
    }
}

/**
 * Parse a cron expression or interval shorthand into milliseconds.
 * @param {string} cron
 * @returns {number}
 */
export function parseCronInterval(cron) {
    const match = cron.match(/^(\d+)(s|m|h|d)$/);
    if (match) {
        const value = parseInt(match[1], 10);
        const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
        return value * (units[match[2]] || 60000);
    }

    const num = parseInt(cron, 10);
    if (!isNaN(num)) return num * 60000;

    // Full cron expression — default to 5 minutes
    return 300000;
}
