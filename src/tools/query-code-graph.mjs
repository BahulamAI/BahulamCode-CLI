import path from 'node:path';

const operations = ['imports', 'importers', 'resolve', 'trace'];
const pageSize = 50;

export const QueryCodeGraphTool = {
    name: 'query_code_graph',
    description: 'Query indexed dependencies in a registered project. Each edge gives its source file and line, target, kind and resolution status. Trace follows up to six resolved edges.',
    inputSchema: {
        type: 'object',
        properties: {
            project_id: { type: 'string', description: 'Project ID returned by get_project_overview.' },
            operation: { type: 'string', enum: operations },
            file: { type: 'string', description: 'Project-relative file. For importers, the imported file. For resolve and trace, the starting file.' },
            specifier: { type: 'string', description: 'Module specifier as written in the source, required for resolve.' },
            target: { type: 'string', description: 'Destination file in the same project, required for trace.' },
            offset: { type: 'integer', minimum: 0, description: 'Continue a result page using next_offset.' },
        },
        required: ['project_id', 'operation', 'file'],
        additionalProperties: false,
    },
    async call({ project_id, operation, file, specifier, target, offset = 0 }, { projectRegistry } = {}) {
        const project = projectRegistry?.get(project_id);
        if (!project) throw new Error('A registered project_id from get_project_overview is required.');
        if (!operations.includes(operation)) throw new Error('Expected operation: ' + operations.join(', '));
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Expected a non-negative integer offset.');
        if (operation === 'resolve' && (typeof specifier !== 'string' || !specifier.trim())) {
            throw new Error('A module specifier is required for resolve.');
        }
        const { root } = project.resource;
        async function scopedFile(value) {
            if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a file path.');
            const absolute = await projectRegistry.resolvePath(value, project_id);
            const relative = path.relative(root, absolute);
            if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
                throw new Error('File must belong to the selected project.');
            }
            return relative.split(path.sep).join('/');
        }
        const source = await scopedFile(file);
        const destination = operation === 'trace' ? await scopedFile(target) : null;
        if (project.resource.index_status === 'deferred') {
            await projectRegistry.register(root, { bypassProjectMarkers: true });
        }
        const { retriever } = projectRegistry.get(project_id);
        retriever.refreshChangedFiles();
        const graph = retriever.graphIndexer;
        if (!graph) throw new Error('The project graph is unavailable.');
        for (const input of [source, destination].filter(Boolean)) {
            const node = graph.nodes.get(input);
            if (!node) throw new Error('File is outside graph coverage: ' + input);
            if (node.referencesSkipped && input === source && operation !== 'importers') {
                throw new Error('Outgoing references unavailable for ' + input + ': ' + node.referencesSkipped);
            }
        }
        let edges;
        switch (operation) {
            case 'imports':
                edges = graph.getImports(source).map(edge => ({ ...edge, from: source }));
                break;
            case 'importers':
                edges = graph.getImporters(source).map(edge => ({ ...edge, to: source }));
                break;
            case 'trace':
                edges = graph.tracePath(source, destination);
                break;
            case 'resolve':
                edges = graph.edges.filter(edge => edge.from === source && (edge.spec ?? edge.to) === specifier);
                if (!edges.length) {
                    const resolved = graph.resolvePath(specifier, source);
                    const indexed = graph.nodes.has(resolved);
                    edges = [{ from: source, to: indexed ? resolved : specifier, line: null,
                        kind: 'module-resolution', status: indexed ? 'resolved' : 'unresolved' }];
                }
                break;
        }
        const results = edges.slice(offset, offset + pageSize).map(edge => ({
            file: edge.from, line: edge.line, target: edge.to, edge_type: edge.kind, status: edge.status,
            ...(edge.candidates?.length ? { candidates: edge.candidates } : {}),
        }));
        const payload = { project_id, operation, total: edges.length, results };
        if (offset + pageSize < edges.length) payload.next_offset = offset + pageSize;
        return { success: true, _tool: 'query_code_graph', output: JSON.stringify(payload), ...payload };
    },
};
