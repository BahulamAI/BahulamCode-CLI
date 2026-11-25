import { safeMcpError } from './credentials.mjs';

export async function promptMcpKey({ input = process.stdin, output = process.stderr } = {}) {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
        throw safeMcpError('API-key entry requires an interactive terminal. Use an environment reference in --header instead.');
    }
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    output.write('API key (masked; Esc cancels): ');
    input.setRawMode(true);
    input.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const finish = (error) => {
            input.off('data', onData);
            input.off('end', onEnd);
            input.setRawMode(Boolean(wasRaw));
            if (wasPaused || input.listenerCount('data') === 0) input.pause();
            output.write('\n');
            if (error) reject(error); else resolve(value);
            value = '';
        };
        const onEnd = () => finish(safeMcpError('API-key entry cancelled.'));
        const onData = data => {
            const text = String(data).replace(/\x1b\[20[01]~/g, '');
            for (const char of text) {
                if (char === '\x03' || char === '\x1b') return onEnd();
                if (char === '\r' || char === '\n') return finish(value ? undefined : safeMcpError('API key cannot be empty.'));
                if (char === '\x7f' || char === '\b') {
                    if (value) { value = value.slice(0, -1); output.write('\b \b'); }
                } else if (char.charCodeAt(0) >= 32 && value.length < 8192) {
                    value += char; output.write('*');
                }
            }
        };
        input.on('data', onData);
        input.once('end', onEnd);
    });
}
