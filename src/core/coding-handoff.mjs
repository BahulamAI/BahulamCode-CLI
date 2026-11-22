// Wire format shared with app/services/coding_handoff.py for mode switches and resume.
const section = '\n\n[Coding handoff v1]\n';
const ack = 'Understood — continuing from the summarized context above.';
const argumentsToKeep = ['project_id', 'path', 'file_path', 'file_paths', 'start_line', 'end_line',
    'operation', 'file', 'target', 'specifier', 'offset', 'limit', 'query', 'pattern', 'command'];

function visibleText(row) {
    if (typeof row?.content === 'string') return row.content;
    return Array.isArray(row?.content) ? row.content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
}

function decoded(value) {
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
        try { return JSON.parse(value); } catch { /* ordinary output */ }
    }
    return value;
}

function excerpt(text) {
    return text.length <= 480 ? text : text.slice(0, 300) + ' […] ' + text.slice(-160);
}

function withoutDiagnostics(text) {
    return text.replace(/^[^\S\n]*(?:error|fatal|exception|traceback)\b[^\n]*(?:\n|$)/gim, '');
}

function failedResult(block, value) {
    return block.is_error ?? (value?.success === false);
}

function retainedResult(block) {
    const value = decoded(block.content);
    if (!failedResult(block, value)) return block;
    let content = block.content;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const {error, traceback, ...remaining} = value;
        if (error && typeof error === 'object') remaining.error = Object.fromEntries(
            Object.entries(error).filter(([key]) => ['code', 'type', 'status'].includes(key)));
        if (typeof remaining.stderr === 'string') remaining.stderr = withoutDiagnostics(remaining.stderr);
        if (typeof remaining.output === 'string') remaining.output = withoutDiagnostics(remaining.output);
        content = typeof content === 'string' ? JSON.stringify(remaining) : remaining;
    } else if (typeof content === 'string') content = withoutDiagnostics(content);
    return {...block, is_error: true, content};
}

export function codingHandoff(messages, split) {
    const older = messages.slice(0, split);
    let state = {original_task: '', latest_instruction: '', decision_notes: [], graph_lineage: [], last_actions: []};
    let start = 0;
    if (visibleText(messages[1]) === ack) {
        const first = visibleText(messages[0]);
        const at = first.lastIndexOf(section);
        const prior = at < 0 ? null : decoded(first.slice(at + section.length));
        if (prior && typeof prior.original_task === 'string' && typeof prior.latest_instruction === 'string' &&
                ['decision_notes', 'graph_lineage', 'last_actions'].every(k => Array.isArray(prior[k]))) {
            state = prior;
            older[0] = {role: 'user', content: first.slice(0, at)};
        }
        start = 2;
    }
    const actions = new Map();
    const protectedRows = [];
    for (let i = start; i < messages.length; i++) {
        const row = messages[i];
        const text = visibleText(row);
        if (row.role === 'user' && text && !text.startsWith('[Operating context]\n')) {
            if (!state.original_task && !start) state.original_task = text;
            state.latest_instruction = text;
        }
        if (i < split && row.role === 'assistant' && text && text !== ack) {
            const note = excerpt(text);
            if (!state.decision_notes.includes(note)) state.decision_notes = [...state.decision_notes, note].slice(-5);
        }
        const blocks = Array.isArray(row.content) ? row.content : [];
        const clean = i < split ? blocks.map(block => block?.type === 'tool_result' ? retainedResult(block) : block) : blocks;
        const toolBlocks = clean.filter(b => ['tool_use', 'tool_result'].includes(b?.type));
        if (i < split && toolBlocks.length) {
            protectedRows.push({role: row.role, content: toolBlocks});
            older[i] = {...row, content: clean};
        }
        for (const block of clean) {
            if (row.role === 'assistant' && block?.type === 'tool_use' && block.id) {
                const args = Object.fromEntries(Object.entries(block.input || {}).filter(([k]) => argumentsToKeep.includes(k)));
                actions.set(block.id, {id: block.id, tool: block.name, args, status: 'pending'});
            } else if (block?.type === 'tool_result' && actions.has(block.tool_use_id)) {
                const action = actions.get(block.tool_use_id);
                const value = decoded(block.content ?? '');
                const output = value?.output ?? value;
                const failed = failedResult(block, value);
                action.status = failed ? 'error' : 'returned';
                action.outcome = excerpt(typeof output === 'string' ? output : JSON.stringify(output));
                if (action.tool === 'query_code_graph' && !failed && i < split) {
                    const graph = {query: action.args, result_call_id: block.tool_use_id};
                    if (!state.graph_lineage.some(item => JSON.stringify(item) === JSON.stringify(graph))) state.graph_lineage.push(graph);
                }
            }
        }
    }
    state.last_actions = [...actions.values()].slice(-5);
    return {older, state, protectedRows};
}

export function attachHandoff(summary, state) {
    return summary + section + JSON.stringify(state);
}
