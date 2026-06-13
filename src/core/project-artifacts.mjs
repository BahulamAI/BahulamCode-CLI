import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Persist generated session artifacts only beneath roots registered by the CLI.
 */
export function persistProjectArtifacts(data, resources, log = () => {}) {
    const projectIds = new Set(
        Array.isArray(data?.project_ids) ? data.project_ids.filter(Boolean) : []
    );
    const registered = Array.isArray(resources) ? resources : [];
    const targets = projectIds.size > 0
        ? registered.filter(resource => projectIds.has(resource.project_id))
        : registered.length === 1 ? registered : [];
    const artifacts = [
        ['goal', 'goal.md'],
        ['plan', 'plan.md'],
    ].filter(([field]) => typeof data?.[field] === 'string' && data[field].trim());
    const written = [];

    for (const resource of targets) {
        for (const [field, filename] of artifacts) {
            try {
                const keplerDir = path.join(resource.root, '.kepler');
                fs.mkdirSync(keplerDir, { recursive: true });
                const artifactPath = path.join(keplerDir, filename);
                fs.writeFileSync(artifactPath, data[field], 'utf-8');
                resource[field] = data[field];
                written.push(artifactPath);
                log(`${field} saved -> ${artifactPath}`);
            } catch {
                // Persistence is helpful but must not stop the agent.
            }
        }
    }
    return written;
}
