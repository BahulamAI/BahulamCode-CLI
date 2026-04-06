/**
 * Ink UI Components — React components for the terminal interface.
 *
 * Uses React.createElement (no JSX transpiler needed).
 *
 * Components:
 * - StatusBar: persistent bottom bar (model, context%, cost, time, mode)
 * - Message: renders different message types
 * - AssistantMessage: markdown-formatted assistant output
 * - UserMessage: user input display
 * - ToolMessage: tool execution with spinner
 * - ThinkingMessage: dim italic thinking blocks
 * - CodeBlock: bordered code display
 * - PermissionPrompt: interactive y/n/a prompt
 * - LoadingIndicator: spinner during API calls
 * - WelcomeBanner: startup banner
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { renderMarkdown } from './markdown.mjs';

const h = React.createElement;

/**
 * Format duration in seconds to human-readable string.
 */
function formatDuration(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m${secs}s`;
}

/**
 * Truncate text to a maximum length.
 */
function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.slice(0, max) + '...';
}

/**
 * Format cost to display string.
 */
function formatCost(cost) {
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}

// ---- Status Bar ----

export function StatusBar({ model, tokens, cost, mode, startTime, contextMax }) {
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setElapsed(Math.floor((Date.now() - (startTime || Date.now())) / 1000));
        }, 1000);
        return () => clearInterval(interval);
    }, [startTime]);

    const totalTokens = (tokens?.input || 0) + (tokens?.output || 0);
    const maxCtx = contextMax || 200000;
    const contextPct = Math.min(100, Math.round((totalTokens / maxCtx) * 100));
    const ctxColor = contextPct > 80 ? 'red' : contextPct > 50 ? 'yellow' : 'green';

    return h(Box, null,
        h(Text, { color: 'cyan', bold: true }, '\u258A '),
        h(Text, { color: 'white' }, 'open-claude-code'),
        h(Text, { color: 'gray' }, ' \u2502 '),
        h(Text, { color: 'green' }, model || 'default'),
        h(Text, { color: 'gray' }, ' \u2502 '),
        h(Text, { color: 'yellow' }, '\u23F1 ', formatDuration(elapsed)),
        h(Text, { color: 'gray' }, ' \u2502 '),
        h(Text, { color: ctxColor }, '\u25CF ', contextPct, '% ctx'),
        h(Text, { color: 'gray' }, ' \u2502 '),
        h(Text, { color: 'white' }, formatCost(cost || 0)),
        h(Text, { color: 'gray' }, ' \u2502 '),
        h(Text, { color: 'magenta' }, mode || 'default'),
    );
}

// ---- Message Components ----

export function Message({ role, content, toolName, toolResult, toolStatus, thinking }) {
    if (role === 'assistant') return h(AssistantMessage, { content });
    if (role === 'tool') return h(ToolMessage, { name: toolName, result: toolResult, status: toolStatus });
    if (role === 'thinking') return h(ThinkingMessage, { content: thinking });
    if (role === 'user') return h(UserMessage, { content });
    if (role === 'error') return h(ErrorMessage, { content });
    if (role === 'system') return h(SystemMessage, { content });
    return null;
}

export function AssistantMessage({ content }) {
    if (!content) return null;
    const rendered = renderMarkdown(content);
    return h(Box, { marginLeft: 0, marginBottom: 0 },
        h(Text, null, rendered),
    );
}

export function UserMessage({ content }) {
    if (!content) return null;
    return h(Box, { marginBottom: 0 },
        h(Text, { color: 'blue', bold: true }, 'You: '),
        h(Text, null, content),
    );
}

export function ToolMessage({ name, result, status }) {
    const children = [
        h(Text, { color: 'yellow', key: 'label' }, '[', name, '] '),
    ];

    if (status === 'running') {
        children.push(
            h(Text, { color: 'cyan', key: 'spinner' },
                h(Spinner, { type: 'dots' }),
                ' running...',
            ),
        );
    }
    if (status === 'done' && result) {
        children.push(
            h(Text, { color: 'gray', key: 'result' }, ' ', truncate(String(result), 200)),
        );
    }
    if (status === 'error' && result) {
        children.push(
            h(Text, { color: 'red', key: 'error' }, ' ', truncate(String(result), 200)),
        );
    }

    return h(Box, null, ...children);
}

export function ThinkingMessage({ content }) {
    if (!content) return null;
    return h(Box, null,
        h(Text, { dimColor: true, italic: true }, '\uD83D\uDCAD ', truncate(content, 500)),
    );
}

export function ErrorMessage({ content }) {
    return h(Box, null,
        h(Text, { color: 'red', bold: true }, 'Error: '),
        h(Text, { color: 'red' }, content),
    );
}

export function SystemMessage({ content }) {
    return h(Box, null,
        h(Text, { dimColor: true }, content),
    );
}

// ---- Code Block ----

export function CodeBlock({ code, language }) {
    if (!code) return null;
    const children = [];
    if (language) {
        children.push(h(Text, { dimColor: true, key: 'lang' }, language));
    }
    children.push(h(Text, { key: 'code' }, code));

    return h(Box, {
        borderStyle: 'single',
        borderColor: 'gray',
        paddingX: 1,
        marginLeft: 2,
    }, ...children);
}

// ---- Permission Prompt ----

export function PermissionPrompt({ toolName, command }) {
    const children = [
        h(Text, { color: 'yellow', key: 'allow' }, 'Allow '),
        h(Text, { bold: true, key: 'tool' }, toolName),
    ];
    if (command) {
        children.push(
            h(Text, { color: 'gray', key: 'cmd' }, ': ', truncate(command, 60)),
        );
    }
    children.push(h(Text, { key: 'prompt' }, ' [y/n/a] '));

    return h(Box, {
        borderStyle: 'round',
        borderColor: 'yellow',
        paddingX: 1,
    }, ...children);
}

// ---- Loading Indicator ----

export function LoadingIndicator({ tool }) {
    return h(Box, null,
        h(Text, { color: 'cyan' },
            h(Spinner, { type: 'dots' }),
        ),
        h(Text, { dimColor: true }, ' ', tool ? `Running ${tool}...` : 'Thinking...'),
    );
}

// ---- Welcome Banner ----

export function WelcomeBanner({ model, toolCount }) {
    return h(Box, { flexDirection: 'column', marginBottom: 1 },
        h(Text, { bold: true }, 'open-claude-code v2'),
        h(Text, { dimColor: true }, 'Model: ', model || 'default', ' | Tools: ', toolCount || 0),
        h(Text, { dimColor: true }, 'Type your prompt or /help. Press Ctrl+C to exit.'),
    );
}
