import { SkillInstaller } from '../skills/installer.mjs';
import { SkillsLoader } from '../skills/loader.mjs';

function has(args, flag) {
    return args.includes(flag);
}

function scopeFrom(args) {
    return has(args, '--project') ? 'project' : 'global';
}

function print(value) {
    process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
}

export async function runSkillsCommand(args, { cwd = process.cwd() } = {}) {
    const action = args[0] || 'list';
    const rest = args.slice(1);
    const scope = scopeFrom(rest);
    const installer = new SkillInstaller({ cwd });
    const loader = new SkillsLoader().load(cwd);

    if (action === 'list') {
        const rows = loader.list({ scope: has(rest, '--all') ? '' : scope });
        if (has(rest, '--json')) print(rows);
        else if (!rows.length) print('No skills found.');
        else for (const row of rows) print(`${row.name}\t${row.scope}\t${row.source}\t${row.description}`);
        return;
    }
    if (action === 'view') {
        const name = rest.find(arg => !arg.startsWith('--'));
        if (!name) throw new Error('Usage: b0 skills view <name> [resource-path]');
        const nameIndex = rest.indexOf(name);
        const resource = rest.slice(nameIndex + 1).find(arg => !arg.startsWith('--')) || null;
        print(loader.view(name, resource));
        return;
    }
    if (action === 'install') {
        const source = rest.find(arg => !arg.startsWith('--'));
        print(installer.install(source, { scope, force: has(rest, '--force') }));
        return;
    }
    if (action === 'remove') {
        const name = rest.find(arg => !arg.startsWith('--'));
        print(installer.remove(name, { scope }));
        return;
    }
    if (action === 'update') {
        const name = rest.find(arg => !arg.startsWith('--'));
        print(installer.update(name, { scope }));
        return;
    }
    throw new Error(`Unknown skills command: ${action}`);
}
