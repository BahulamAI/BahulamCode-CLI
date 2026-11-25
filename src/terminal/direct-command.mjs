import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function isDirectTerminalCommand(input) {
    const text = String(input).trimStart();
    return text.startsWith('!') || /^\/mcp\s+(?:login\b|add\b.*--api-key\b)/.test(text);
}

// Parse CLI words, not shell expressions. Single-quoted environment references
// remain literal so MCP settings can resolve them at connection time.
export function splitCommandWords(text) {
    const words = [];
    let word = '', quote = '', started = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '\\' && quote !== "'") {
            if (++i === text.length) throw new Error('Incomplete command escape.');
            word += text[i]; started = true;
        } else if (quote) {
            if (char === quote) quote = ''; else word += char;
        } else if (char === '"' || char === "'") { quote = char; started = true; }
        else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
        else { word += char; started = true; }
    }
    if (quote) throw new Error('Unclosed quote in command.');
    if (started) words.push(word);
    return words;
}

export function directCommandSpec(input) {
    const command = String(input).trim().replace(/^!/, '').trim();
    if (!command) throw new Error('Type a command after !, for example !bahulam mcp list.');
    if (/^bahulam(?:-code)?\s+mcp(?:\s|$)/.test(command)) {
        const words = splitCommandWords(command);
        if (words.some(word => ['|', '||', '&&', ';', '>', '<'].includes(word))) throw new Error('Run MCP registration as a single command.');
        return { command: process.execPath, args: [fileURLToPath(new URL('./main.mjs', import.meta.url)), ...words.slice(1)], shell: false };
    }
    return { command, args: [], shell: true };
}

export async function runDirectCommand(input, { cwd = process.cwd(), spawnCommand = spawn, waitForReturn = false } = {}) {
    const spec = directCommandSpec(input);
    // Inherited stdio is intentional: interactive browser/credential commands
    // need the real terminal, and their output must not become model context.
    const result = await new Promise((resolve, reject) => {
        const child = spawnCommand(spec.command, spec.args, { cwd, shell: spec.shell, stdio: 'inherit', env: process.env });
        child.once('error', () => reject(new Error('Could not start the direct command. Check the executable and working directory.')));
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (waitForReturn) {
        await new Promise(resolve => {
            // A separate process owns the terminal until Enter, so neither
            // Node's old readline listeners nor Rust can consume this input.
            const child = spawnCommand(process.execPath, ['--input-type=module', '-e',
                'import readline from "node:readline"; const rl = readline.createInterface({input:process.stdin,output:process.stderr}); rl.question("Press Enter to return to Bahulam…",()=>rl.close());'],
                { cwd, stdio: 'inherit' });
            child.once('error', resolve);
            child.once('exit', resolve);
        });
    }
    return result;
}
