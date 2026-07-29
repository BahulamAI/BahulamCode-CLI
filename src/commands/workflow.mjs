/**
 * Workflow CLI Commands — create, list, get, run, sync, delete workflows.
 *
 * User-facing term is "workflow" everywhere. Backend stores these as
 * templates (POST /api/templates, table "templates").
 *
 * Commands:
 *   b0 workflow create --file <path>
 *   b0 workflow create-multi --file <path>
 *   b0 workflow run <name> [--instruction "..."] [--config key=val]
 *   b0 workflow run-multi <id> [--instruction "..."] [--pattern sequential|parallel]
 *   b0 workflow sync [--dir <path>]
 *   b0 workflow list
 *   b0 workflow get <name>
 *   b0 workflow delete <name>
 */

import { resolveBackendUrl } from '../core/backend-url.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { TarangStreamClient } from '../core/stream-client.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { EventFormatter } from '../ui/formatter.mjs';
import { loadWorkflowFromFile, loadWorkflowsFromDir, workflowToTemplatePayload } from '../agents/workflow_loader.mjs';
import { loadMultiWorkflowFromFile } from '../agents/multi_workflow_loader.mjs';
import { buildWorkScope } from '../core/work-scope.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

/**
 * Main entry point for all `b0 workflow` subcommands.
 * @param {object} args - parsed CLI args
 */
export async function handleWorkflowCommand(args) {
    const sub = args.workflowSubcommand || 'help';

    switch (sub) {
        case 'create':
            await handleCreate(args);
            break;
        case 'create-multi':
            await handleCreateMulti(args);
            break;
        case 'run':
            await handleRun(args);
            break;
        case 'sync':
            await handleSync(args);
            break;
        case 'list':
            await handleList(args);
            break;
        case 'get':
            await handleGet(args);
            break;
        case 'run-multi':
            await handleRunMulti(args);
            break;
        case 'delete':
            await handleDelete(args);
            break;
        default:
            printWorkflowUsage();
            process.exit(1);
    }
}

function printWorkflowUsage() {
    process.stderr.write(`${BOLD}WORKFLOW COMMANDS${RESET}\n`);
    process.stderr.write(`  ${CYAN}b0 workflow create --file <path>${RESET}               Create single-agent workflow from YAML\n`);
    process.stderr.write(`  ${CYAN}b0 workflow create-multi --file <path>${RESET}         Create multi-agent workflow from YAML\n`);
    process.stderr.write(`  ${CYAN}b0 workflow run <name> [opts]${RESET}                  Run a workflow adhoc\n`);
    process.stderr.write(`  ${CYAN}b0 workflow run-multi <id> [opts]${RESET}              Run a multi-agent workflow\n`);
    process.stderr.write(`  ${CYAN}b0 workflow sync [--dir <path>]${RESET}                Sync single-agent workflow YAML files\n`);
    process.stderr.write(`  ${CYAN}b0 workflow list${RESET}                               List all workflows\n`);
    process.stderr.write(`  ${CYAN}b0 workflow get <name>${RESET}                         Show workflow details\n`);
    process.stderr.write(`  ${CYAN}b0 workflow delete <name>${RESET}                      Delete a workflow\n`);
    process.stderr.write('\n');
}

// ── Helpers ────────────────────────────────────────────────────

function getAuthHeaders() {
    const auth = new TarangAuth();
    const creds = auth.loadCredentials();
    if (!creds.token) {
        process.stderr.write(`${RED}✗ Not authenticated. Run 'b0 login' first.${RESET}\n`);
        process.exit(1);
    }
    return {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
    };
}

function getBaseUrl() {
    const auth = new TarangAuth();
    return auth.loadCredentials().backendUrl || resolveBackendUrl();
}

async function apiFetch(path, options = {}) {
    const baseUrl = getBaseUrl();
    const headers = { ...getAuthHeaders(), ...options.headers };
    const url = `${baseUrl}${path}`;
    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        process.stderr.write(`${RED}✗ Authentication failed. Run 'b0 login' to re-authenticate.${RESET}\n`);
        process.exit(1);
    }

    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = { detail: text };
    }

    if (!response.ok) {
        const msg = payload?.detail || payload?.message || `HTTP ${response.status}`;
        throw new Error(msg);
    }

    return payload;
}

// ── Create ─────────────────────────────────────────────────────

async function handleCreate(args) {
    const filePath = args.workflowFile;
    if (!filePath) {
        process.stderr.write(`${RED}✗ Usage: b0 workflow create --file <path>${RESET}\n`);
        process.exit(1);
    }

    process.stderr.write(`${DIM}Loading workflow from ${filePath}...${RESET}\n`);
    const payload = loadWorkflowFromFile(filePath);

    process.stderr.write(`${DIM}Creating workflow '${payload.slug}'...${RESET}\n`);
    const result = await apiFetch('/api/templates', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    const template = result.template || {};
    const upserted = result.upserted;
    if (upserted) {
        process.stderr.write(`${GREEN}✓ Updated workflow '${template.slug || payload.slug}'${RESET}\n`);
    } else {
        process.stderr.write(`${GREEN}✓ Created workflow '${template.slug || payload.slug}'${RESET}\n`);
    }
    process.stdout.write(JSON.stringify({ slug: template.slug || payload.slug, upserted }, null, 2) + '\n');
}

// ── Create Multi ────────────────────────────────────────────────

async function handleCreateMulti(args) {
    const filePath = args.workflowFile;
    if (!filePath) {
        process.stderr.write(`${RED}✗ Usage: b0 workflow create-multi --file <path>${RESET}\n`);
        process.exit(1);
    }

    process.stderr.write(`${DIM}Loading multi-agent workflow from ${filePath}...${RESET}\n`);
    const payload = loadMultiWorkflowFromFile(filePath);

    process.stderr.write(`${DIM}Creating multi-agent workflow '${payload.name}'...${RESET}\n`);
    const result = await apiFetch('/api/workflows', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    const workflow = result.workflow || {};
    process.stderr.write(`${GREEN}✓ Created multi-agent workflow '${workflow.name || payload.name}'${RESET}\n`);
    process.stderr.write(`  ${DIM}ID: ${workflow.id}${RESET}\n`);
    process.stderr.write(`  ${DIM}Pattern: ${payload.pattern}${RESET}\n`);
    process.stderr.write(`  ${DIM}Agents: ${payload.graph.nodes.filter(n => n.type === 'agent').length}${RESET}\n`);
    process.stdout.write(JSON.stringify({ id: workflow.id, name: workflow.name || payload.name }, null, 2) + '\n');
}

// ── Run ─────────────────────────────────────────────────────────

async function handleRun(args) {
    const slug = args.workflowSlug;
    if (!slug) {
        process.stderr.write(`${RED}✗ Usage: b0 workflow run <name> [--instruction \"...\"]${RESET}\n`);
        process.exit(1);
    }

    const instruction = args.instruction || '';
    if (!instruction) {
        process.stderr.write(`${RED}✗ Usage: b0 workflow run <name> --instruction \"...\"${RESET}\n`);
        process.exit(1);
    }

    const baseUrl = getBaseUrl();
    const headers = getAuthHeaders();
    const url = `${baseUrl}/api/run`;

    const body = JSON.stringify({
        template: slug,
        instruction,
        config: {},
        mode: 'stream',
    });

    process.stderr.write(`${DIM}Running workflow '${slug}'...${RESET}\n`);

    const formatter = new EventFormatter({ verbose: args.verbose });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { ...headers, Accept: 'text/event-stream' },
            body,
        });

        if (response.status === 401) {
            process.stderr.write(`${RED}✗ Authentication failed. Run 'b0 login' to re-authenticate.${RESET}\n`);
            process.exit(1);
        }
        if (response.status === 404) {
            process.stderr.write(`${RED}✗ Workflow '${slug}' not found.${RESET}\n`);
            process.exit(1);
        }
        if (!response.ok) {
            const text = await response.text().catch(() => 'Unknown error');
            process.stderr.write(`${RED}✗ Backend error ${response.status}: ${text}${RESET}\n`);
            process.exit(1);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = 'message';
        let currentData = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
                const trimmed = raw.trim();

                if (!trimmed) {
                    // Empty line = event boundary
                    if (currentData.length > 0) {
                        const rawData = currentData.join('\n');
                        let parsed;
                        try {
                            parsed = JSON.parse(rawData);
                        } catch {
                            parsed = { message: rawData };
                        }
                        const event = { type: currentEvent, data: parsed };
                        formatter.render(event);
                        if (event.type === 'run_error' || event.type === 'error') {
                            const errData = event.data || {};
                            if (errData.fatal) {
                                process.stderr.write(`\n${RED}✗ ${errData.message || 'Run failed'}${RESET}\n`);
                            }
                        }
                    }
                    currentEvent = 'message';
                    currentData = [];
                } else if (trimmed.startsWith('event:')) {
                    currentEvent = trimmed.slice(6).trim();
                } else if (trimmed.startsWith('data:')) {
                    currentData.push(trimmed.slice(5).trim());
                }
            }
        }

        // Flush remaining
        if (currentData.length > 0) {
            const rawData = currentData.join('\n');
            let parsed;
            try {
                parsed = JSON.parse(rawData);
            } catch {
                parsed = { message: rawData };
            }
            formatter.render({ type: currentEvent, data: parsed });
        }

        process.stdout.write('\n');
        process.stderr.write(`${GREEN}✓ Run complete${RESET}\n`);
    } catch (err) {
        if (err.name === 'AbortError') {
            process.stderr.write(`\n${YELLOW}⚠ Run cancelled${RESET}\n`);
        } else {
            process.stderr.write(`${RED}✗ ${err.message}${RESET}\n`);
            process.exit(1);
        }
    }
}

// ── Sync ───────────────────────────────────────────────────────

async function handleSync(args) {
    const dir = args.workflowDir || '.bahulam/workflows';

    process.stderr.write(`${DIM}Scanning ${dir} for workflow YAML files...${RESET}\n`);
    const workflows = loadWorkflowsFromDir(dir);

    if (workflows.length === 0) {
        process.stderr.write(`${YELLOW}⚠ No workflow YAML files found in ${dir}${RESET}\n`);
        process.exit(0);
    }

    process.stderr.write(`Found ${workflows.length} workflow(s)\n\n`);

    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const { file, payload } of workflows) {
        const fileName = file.split('/').pop();
        process.stderr.write(`  ${DIM}${fileName}${RESET} → `);
        try {
            const result = await apiFetch('/api/templates', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            if (result.upserted) {
                process.stderr.write(`${GREEN}updated${RESET}\n`);
                updated++;
            } else {
                process.stderr.write(`${GREEN}created${RESET}\n`);
                created++;
            }
        } catch (err) {
            process.stderr.write(`${RED}failed: ${err.message}${RESET}\n`);
            failed++;
        }
    }

    process.stderr.write(`\n${GREEN}✓ Done: ${created} created, ${updated} updated${failed ? `, ${RED}${failed} failed${RESET}` : ''}${RESET}\n`);
}

// ── List ───────────────────────────────────────────────────────

async function handleList(args) {
    const [templateResult, workflowResult] = await Promise.all([
        apiFetch('/api/templates').catch(() => ({ templates: [] })),
        apiFetch('/api/workflows').catch(() => ({ workflows: [] })),
    ]);

    const templates = templateResult.templates || [];
    const workflows = workflowResult.workflows || [];
    if (templates.length === 0 && workflows.length === 0) {
        process.stderr.write(`${DIM}No workflows found.${RESET}\n`);
        process.exit(0);
    }

    process.stderr.write(`${BOLD}Workflows:${RESET}\n`);
    for (const w of workflows) {
        const pattern = w.orchestration_pattern || w.pattern || 'sequential';
        process.stderr.write(`  ${CYAN}${w.id}${RESET}  ${w.name} ${DIM}(graph · ${pattern})${RESET}\n`);
        if (w.description) {
            process.stderr.write(`    ${DIM}${w.description}${RESET}\n`);
        }
    }
    for (const t of templates) {
        const owner = t.owner_type === 'platform' ? `${DIM}(platform)${RESET}` : `${DIM}(user)${RESET}`;
        process.stderr.write(`  ${CYAN}${t.slug}${RESET}  ${t.name} ${owner}${DIM} · single-agent${RESET}\n`);
        if (t.description) {
            process.stderr.write(`    ${DIM}${t.description}${RESET}\n`);
        }
    }
    process.stdout.write(JSON.stringify({
        workflows: workflows.map(w => ({
            id: w.id,
            name: w.name,
            orchestration_pattern: w.orchestration_pattern || w.pattern || 'sequential',
            status: w.status,
        })),
        templates: templates.map(t => ({ slug: t.slug, name: t.name, owner: t.owner_type })),
    }, null, 2) + '\n');
}

// ── Get ────────────────────────────────────────────────────────

async function handleGet(args) {
    const slug = args.workflowSlug;
    if (!slug) {
        process.stderr.write(`${RED}✗ Usage: b0 workflow get <name>${RESET}\n`);
        process.exit(1);
    }

    const result = isUuid(slug)
        ? await apiFetch(`/api/workflows/${encodeURIComponent(slug)}`)
        : await apiFetch(`/api/templates/${encodeURIComponent(slug)}`);
    if (result.workflow) {
        const workflow = result.workflow;
        process.stderr.write(`${BOLD}${workflow.name}${RESET} (${CYAN}${workflow.id}${RESET})\n`);
        if (workflow.description) process.stderr.write(`  ${DIM}${workflow.description}${RESET}\n`);
        process.stderr.write(`  Type: graph\n`);
        process.stderr.write(`  Pattern: ${workflow.orchestration_pattern || workflow.pattern || 'sequential'}\n`);
        process.stderr.write(`  Agents: ${(workflow.graph?.nodes || []).filter((n) => n.type === 'agent').length}\n`);
        process.stdout.write(JSON.stringify(workflow, null, 2) + '\n');
        return;
    }

    const template = result.template || {};
    process.stderr.write(`${BOLD}${template.name}${RESET} (${CYAN}${template.slug}${RESET})\n`);
    if (template.description) process.stderr.write(`  ${DIM}${template.description}${RESET}\n`);
    process.stderr.write(`  Owner: ${template.owner_type || 'user'}\n`);
    process.stderr.write(`  Model: ${template.model || 'default'}\n`);
    process.stderr.write(`  Max iterations: ${template.max_iterations || 20}\n`);
    process.stderr.write(`  Channel: ${template.channel || 'server'}\n`);
    if (template.tags?.length) process.stderr.write(`  Tags: ${template.tags.join(', ')}\n`);
    if (template.system_prompt) {
        const preview = template.system_prompt.slice(0, 200);
        process.stderr.write(`  System prompt: ${DIM}${preview}${preview.length < template.system_prompt.length ? '...' : ''}${RESET}\n`);
    }
    process.stdout.write(JSON.stringify(template, null, 2) + '\n');
}

// ── Delete ─────────────────────────────────────────────────────

async function handleDelete(args) {
    const slug = args.workflowSlug;
    if (!slug) {
        process.stderr.write(`${RED}✗ Usage: b0 workflow delete <name>${RESET}\n`);
        process.exit(1);
    }

    if (!args.yes) {
        process.stderr.write(`${YELLOW}⚠ Are you sure you want to delete workflow '${slug}'?${RESET} Use ${CYAN}--yes${RESET} to confirm.\n`);
        process.exit(1);
    }

    const path = isUuid(slug)
        ? `/api/workflows/${encodeURIComponent(slug)}`
        : `/api/templates/${encodeURIComponent(slug)}`;
    await apiFetch(path, {
        method: 'DELETE',
    });

    process.stderr.write(`${GREEN}✓ Deleted workflow '${slug}'${RESET}\n`);
    process.stdout.write(JSON.stringify({ slug, deleted: true }) + '\n');
}


// ── Run Multi (multi-agent) ─────────────────────────────────

async function handleRunMulti(args) {
    const workflowId = args.workflowSlug;
    if (!workflowId) {
        process.stderr.write(`${RED}✗ Usage: b0 workflow run-multi <id> [--instruction "..."] [--pattern sequential|parallel]${RESET}\n`);
        process.exit(1);
    }

    const instruction = args.instruction || '';
    const pattern = args.pattern || 'sequential';
    const workScope = buildWorkScope({
        instruction,
        cwd: process.cwd(),
        projectResources: [],
    });

    const baseUrl = getBaseUrl();
    const headers = getAuthHeaders();
    const url = `${baseUrl}/api/workflows/${encodeURIComponent(workflowId)}/run-multi`;
    const approvalAllowedTools = [
        'get_project_overview',
        'write_file',
        'write_project',
        'edit_file',
        'shell',
        'lint_check',
        'validate_build',
        'run_tests',
        'agent_create',
        'agent_sync',
        'workflow_create_multi',
        'workflow_sync_multi',
        'workflow_run_multi',
    ];

    const body = JSON.stringify({
        trigger_input: {
            instruction,
            cwd: process.cwd(),
            project_root: process.cwd(),
            work_scope: workScope,
        },
        global_params: {
            instruction,
            cwd: process.cwd(),
            project_root: process.cwd(),
            project_resources: [],
            work_scope: workScope,
        },
        orchestration_pattern: pattern,
        pattern,
        mode: 'stream',
        approval_scope: {
            approved: true,
            source: 'cli_command',
            scope: 'workflow_run',
            workflow_id: workflowId,
            allowed_tools: approvalAllowedTools,
            allow_destructive: false,
            reason: 'User invoked workflow run command',
        },
    });

    process.stderr.write(`${DIM}Running multi-agent workflow '${workflowId}' (${pattern})...${RESET}\n`);

    const formatter = new EventFormatter({ verbose: args.verbose });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { ...headers, Accept: 'text/event-stream', 'Content-Type': 'application/json' },
            body,
        });

        if (response.status === 401) {
            process.stderr.write(`${RED}✗ Authentication failed. Run 'b0 login' to re-authenticate.${RESET}\n`);
            process.exit(1);
        }
        if (!response.ok) {
            const text = await response.text().catch(() => 'Unknown error');
            process.stderr.write(`${RED}✗ Backend error ${response.status}: ${text}${RESET}\n`);
            process.exit(1);
        }

        const client = new TarangStreamClient({
            baseUrl,
            token: headers.Authorization.replace(/^Bearer\s+/i, ''),
            toolExecutor: createToolExecutor(),
            verbose: args.verbose,
            approvalManager: new ApprovalManager({ autoApprove: args.yes }),
        });

        for await (const event of client.consumeEventStream(response)) {
            formatter.render(event);

            if (event.type === 'agent_complete') {
                const parsed = event.data || {};
                const s = parsed.status || 'completed';
                const icon = s === 'completed' ? GREEN : RED;
                process.stderr.write(`  ${icon}${s === 'completed' ? '✓' : '✗'}${RESET} ${parsed.agent_slug} (${parsed.duration_s || '?'}s, ${parsed.tokens || 0} tok)\n`);
            } else if (event.type === 'orchestration_complete') {
                const parsed = event.data || {};
                process.stderr.write(`\n${GREEN}✓ Multi-agent run complete${RESET} (${parsed.duration_s}s, ${parsed.total_tokens} tok, ${parsed.total_cost || '0'})\n`);
            } else if (event.type === 'run_error') {
                const parsed = event.data || {};
                process.stderr.write(`\n${RED}✗ ${parsed.error || 'Run failed'}${RESET}\n`);
            }
        }

        process.stdout.write('\n');
    } catch (err) {
        if (err.name === 'AbortError') {
            process.stderr.write(`\n${YELLOW}⚠ Run cancelled${RESET}\n`);
        } else {
            process.stderr.write(`${RED}✗ ${err.message}${RESET}\n`);
            process.exit(1);
        }
    }
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
}
