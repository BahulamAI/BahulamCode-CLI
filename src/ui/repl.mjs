/**
 * REPL — interactive read-eval-print loop for open-claude-code.
 *
 * Supports all 39 slash commands, skill invocation, enhanced UI,
 * and streaming output with spinner and token display.
 */

import readline from 'readline';
import { executeCommand, getCompletions, COMMANDS } from './commands.mjs';
import { Spinner, highlightCode, renderStatusBar, renderToolProgress } from './ink-app.mjs';

/**
 * Start the interactive REPL.
 * @param {object} loop - agent loop instance (from createAgentLoop)
 * @param {object} settings - loaded settings
 */
export async function startRepl(loop, settings) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        completer: (line) => {
            if (line.startsWith('/')) {
                const completions = getCompletions(line);
                return [completions, line];
            }
            return [[], line];
        },
    });

    console.log('\x1b[1mopen-claude-code v2\x1b[0m — type your prompt or /help');
    console.log('\x1b[2mModel: %s | Tools: %d\x1b[0m', loop.state.model || 'default', loop.state.tools?.list?.()?.length || 0);
    console.log('');

    const askPrompt = () => {
        rl.question('\x1b[36m>\x1b[0m ', async (input) => {
            const trimmed = input.trim();
            if (!trimmed) { askPrompt(); return; }

            // Handle slash commands
            if (trimmed.startsWith('/')) {
                // Check if it is a skill invocation
                const cmdName = trimmed.split(/\s+/)[0].toLowerCase();
                if (!COMMANDS[cmdName] && loop.state._skillsLoader) {
                    const skill = loop.state._skillsLoader.get(cmdName.slice(1));
                    if (skill) {
                        const args = trimmed.slice(cmdName.length).trim();
                        try {
                            for await (const event of loop.run(`[Skill: ${skill.name}]\n${skill.prompt}${args ? `\nArguments: ${args}` : ''}`)) {
                                renderEvent(event);
                            }
                            console.log('');
                        } catch (err) {
                            console.error(`\x1b[31mSkill error: ${err.message}\x1b[0m`);
                        }
                        askPrompt();
                        return;
                    }
                }

                const { response, exit } = executeCommand(trimmed, loop.state);
                if (exit) { rl.close(); return; }
                console.log(response);
                askPrompt();
                return;
            }

            // Run through agent loop
            const spinner = new Spinner('Thinking...');
            spinner.start();

            try {
                let firstEvent = true;
                for await (const event of loop.run(trimmed)) {
                    if (firstEvent) {
                        spinner.stop();
                        firstEvent = false;
                    }
                    renderEvent(event);
                }
                console.log('');

                // Show status bar if enabled
                if (settings.showTokenUsage !== false) {
                    process.stderr.write(renderStatusBar(loop.state) + '\n');
                }
            } catch (err) {
                spinner.stop();
                console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
            }

            askPrompt();
        });
    };

    askPrompt();

    return new Promise((resolve) => {
        rl.on('close', resolve);
    });
}

/**
 * Render a single agent loop event to the terminal.
 */
function renderEvent(event) {
    switch (event.type) {
        case 'stream_event':
            process.stdout.write(event.text || '');
            break;
        case 'thinking':
            if (process.env.SHOW_THINKING) {
                process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
            }
            break;
        case 'tool_progress':
            process.stderr.write(`${renderToolProgress(event.tool, event.status || 'running')}\n`);
            break;
        case 'result':
            if (process.env.SHOW_TOOL_RESULTS) {
                const display = String(event.result).slice(0, 300);
                console.log(`\x1b[36m[${event.tool}]\x1b[0m ${display}`);
            }
            break;
        case 'assistant':
            if (event.content) {
                process.stdout.write(highlightCode(event.content));
            }
            break;
        case 'compaction':
            process.stderr.write(`\x1b[2m[compaction #${event.count}]\x1b[0m\n`);
            break;
        case 'hookPermissionResult':
            if (!event.allowed) {
                process.stderr.write(`\x1b[31m[blocked: ${event.tool}]\x1b[0m\n`);
            }
            break;
        case 'stop':
            break;
        case 'error':
            console.error(`\x1b[31mError: ${event.message}\x1b[0m`);
            break;
    }
}
