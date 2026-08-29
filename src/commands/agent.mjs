/**
 * Agent CLI Commands — list, get, sync user-defined agents.
 *
 * Commands:
 *   bahulam-code agent list
 *   bahulam-code agent get <slug>
 *   bahulam-code agent sync [--dir <path>]
 */

import { resolveBackendUrl } from '../core/backend-url.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { listLocalAgents, syncAgentsToBackend, agentToSpec, agentContentHash } from '../agents/scaffold.mjs';
import { parseAgentDefinition } from '../agents/parser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

/**
 * Main entry point for all `bahulam-code agent` subcommands.
 * @param {object} args - parsed CLI args
 */
export async function handleAgentCommand(args) {
    const sub = args.agentSubcommand || 'help';

    switch (sub) {
        case 'list':
            await handleList(args);
            break;
        case 'get':
            await handleGet(args);
            break;
        case 'sync':
            await handleSync(args);
            break;
        default:
            printAgentUsage();
            process.exit(1);
    }
}

function printAgentUsage() {
    process.stderr.write(`${BOLD}AGENT COMMANDS${RESET}\n`);
    process.stderr.write(`  ${CYAN}bahulam-code agent list${RESET}                           List user-defined agents\n`);
    process.stderr.write(`  ${CYAN}bahulam-code agent get <slug>${RESET}                     Show agent details\n`);
    process.stderr.write(`  ${CYAN}bahulam-code agent sync [--dir <path>]${RESET}            Sync agent YAML files\n`);
    process.stderr.write('\n');
}

// ── Helpers ────────────────────────────────────────────────────

function getAuth() {
    const auth = new TarangAuth();
    const creds = auth.loadCredentials();
    if (!creds.token) {
        process.stderr.write(`${RED}✗ Not authenticated. Run bahulam-code login first.${RESET}\n`);
        process.exit(1);
    }
    return creds;
}

function getBaseUrl() {
    const auth = new TarangAuth();
    return auth.loadCredentials().backendUrl || resolveBackendUrl();
}

async function apiFetch(path, options = {}) {
    const creds = getAuth();
    const baseUrl = getBaseUrl();
    const headers = {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'X-Product': 'bahulam',
        ...options.headers,
    };
    const url = `${baseUrl}${path}`;
    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        process.stderr.write(`${RED}✗ Authentication failed. Run bahulam-code login to re-authenticate.${RESET}\n`);
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

// ── List ───────────────────────────────────────────────────────

async function handleList(args) {
    const result = await apiFetch('/api/user/agents');

    const agents = result.agents || [];
    if (agents.length === 0) {
        process.stderr.write(`${DIM}No user-defined agents found.${RESET}\n`);
        process.exit(0);
    }

    process.stderr.write(`${BOLD}User-defined Agents:${RESET}\n`);
    for (const a of agents) {
        const source = a.source === 'platform' ? `${DIM}(platform)${RESET}` : `${DIM}(user)${RESET}`;
        process.stderr.write(`  ${CYAN}${a.slug}${RESET}  ${a.name || a.slug} ${source}\n`);
        if (a.description) {
            process.stderr.write(`    ${DIM}${a.description}${RESET}\n`);
        }
    }
    process.stdout.write(JSON.stringify(agents.map(a => ({ slug: a.slug, name: a.name, source: a.source })), null, 2) + '\n');
}

// ── Get ────────────────────────────────────────────────────────

async function handleGet(args) {
    const slug = args.agentSlug;
    if (!slug) {
        process.stderr.write(`${RED}✗ Usage: bahulam-code agent get <slug>${RESET}\n`);
        process.exit(1);
    }

    const result = await apiFetch(`/api/user/agents/${encodeURIComponent(slug)}`);

    process.stderr.write(`${BOLD}${result.name || result.slug}${RESET} (${CYAN}${result.slug}${RESET})\n`);
    if (result.description) process.stderr.write(`  ${DIM}${result.description}${RESET}\n`);
    process.stderr.write(`  Source: ${result.source || 'user'}\n`);
    const spec = result.spec || {};
    const role = spec.role || 'specialist';
    process.stderr.write(`  Role: ${role}\n`);
    const caps = spec.capabilities || [];
    if (caps.length) process.stderr.write(`  Capabilities: ${caps.join(', ')}\n`);
    const tools = spec.tools || [];
    if (tools.length) process.stderr.write(`  Tools: ${tools.join(', ')}\n`);
    if (spec.system_prompt || spec.prompt) {
        const prompt = spec.system_prompt || spec.prompt || '';
        const preview = prompt.slice(0, 200);
        process.stderr.write(`  System prompt: ${DIM}${preview}${preview.length < prompt.length ? '...' : ''}${RESET}\n`);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// ── Sync ───────────────────────────────────────────────────────

async function handleSync(args) {
    let localAgents;
    try {
        localAgents = args.agentDir
            ? listAgentsFromDir(args.agentDir)
            : listLocalAgents(process.cwd());
    } catch (err) {
        process.stderr.write(`${YELLOW}⚠ ${err.message}${RESET}\n`);
        process.exit(0);
    }
    const selected = args.agentSlug
        ? localAgents.filter(agent => agent.slug === args.agentSlug || agent.name === args.agentSlug)
        : localAgents;

    if (selected.length === 0) {
        const target = args.agentSlug ? ` matching '${args.agentSlug}'` : '';
        process.stderr.write(`${YELLOW}⚠ No local agents${target} found.${RESET}\n`);
        process.exit(0);
    }

    try {
        const creds = getAuth();
        const result = await syncAgentsToBackend({
            backendUrl: getBaseUrl(),
            token: creds.token,
            agents: selected,
        });
        const synced = result.synced ?? selected.length;
        process.stderr.write(`${GREEN}✓ Synced ${synced} agent${synced === 1 ? '' : 's'} to Supabase.${RESET}\n`);
        process.stdout.write(JSON.stringify({ synced, agents: result.agents || [] }, null, 2) + '\n');
    } catch (err) {
        process.stderr.write(`${RED}✗ Agent sync failed: ${err.message}${RESET}\n`);
        process.exit(1);
    }
}

function listAgentsFromDir(dir) {
    const agents = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        throw new Error(`No agent directory found: ${dir}`);
    }
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name);
        if (!['.yaml', '.yml', '.json', '.md'].includes(ext)) continue;
        const filePath = path.join(dir, entry.name);
        const content = fs.readFileSync(filePath, 'utf-8');
        const agent = parseAgentDefinition(content, ext);
        const spec = agentToSpec(agent);
        agents.push({
            ...agent,
            slug: spec.slug,
            spec,
            source: filePath,
            source_scope: 'project',
            content_hash: agentContentHash(agent),
        });
    }
    return agents;
}
