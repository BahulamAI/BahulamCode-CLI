// A label returned to the model must resolve against the same project on its next call.
import path from 'node:path';

export function owningProject(value, projects, projectId) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return undefined;
    let owner;
    for (const project of projects) {
        const root = project.root;
        if (!root || (projectId && project.project_id !== projectId)) continue;
        const rel = path.relative(root, value);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) continue;
        if (!owner || root.length > owner.root.length) owner = project;
    }
    return owner;
}

export function projectPathLabel(value, projects, projectId) {
    const owner = owningProject(value, projects, projectId);
    return owner ? path.relative(owner.root, value) || '.' : value;
}

const fileTools = new Set(['read_file', 'write_file', 'create_file', 'edit_file', 'delete_file', 'get_file_info',
    'analyze_code', 'validate_file', 'list_files', 'search_code', 'search_files', 'grep']);
const batchTools = new Set(['read_files', 'read_batch', 'write_project']);

export function toolPathArgument(name, args) {
    return fileTools.has(name) ? args.file_path || args.path : undefined;
}

// Presentation copy. The executor still resolves and authorizes the original request.
export function projectToolArgs(name, args, projects) {
    if (fileTools.has(name)) {
        const key = args.file_path ? 'file_path' : 'path';
        const label = projectPathLabel(args[key], projects, args.project_id);
        return label === args[key] ? args : { ...args, [key]: label };
    }
    if (batchTools.has(name)) {
        const key = ['items', 'files', 'file_paths', 'paths'].find(key => Array.isArray(args[key]));
        if (key) return { ...args, [key]: args[key].map(item => typeof item === 'string'
            ? projectPathLabel(item, projects, args.project_id)
            : item && projectToolArgs('read_file', { project_id: args.project_id, ...item }, projects)) };
    }
    return args;
}
