import { readFile } from 'node:fs/promises';
import { loadRuntime } from './runtime.mjs';
import { createTeamsHandler } from './handler.mjs';
import { createAzureDevOpsConnection } from '../azure-devops.mjs';

// The deployment supplies the SDK so terminal installations do not acquire a
// web-server dependency. SDK authentication is mandatory in this host.
export async function startTeamsServer({ App }) {
  const env = process.env;
  if (env.BAHULAM_TEAMS_LEGACY_PAT !== 'true') {
    const { startHostedTeamsServer } = await import('./hosted-server.mjs');
    return startHostedTeamsServer({ App });
  }
  for (const key of ['CLIENT_ID', 'CLIENT_SECRET', 'TENANT_ID', 'ADO_BINDINGS_FILE', 'BAHULAM_ORGANIZATION_ID', 'BAHULAM_HOME', 'BAHULAM_PLUGIN_DIR']) {
    if (!env[key]) throw new Error(`${key} must be supplied by the organization's infrastructure deployment.`);
  }
  if (!env.ANTHROPIC_API_KEY && !env.OPENROUTER_API_KEY) throw new Error('A Bahulam runtime model credential is required.');

  const loadBindings = async () => {
    const bindings = JSON.parse(await readFile(env.ADO_BINDINGS_FILE, 'utf8'));
    if (!Array.isArray(bindings) || !bindings.length || bindings.some(binding =>
      binding.bahulam_organization_id !== env.BAHULAM_ORGANIZATION_ID
      || binding.teams_tenant_id !== env.TENANT_ID)) {
      throw new Error('Bindings must belong to this registered organization and Microsoft tenant.');
    }
    return bindings;
  };
  await loadBindings(); // Fail startup on wrong infrastructure tenant configuration.
  const runtime = await loadRuntime({ pluginDir: env.BAHULAM_PLUGIN_DIR,
    credentials: { apiKey: env.ANTHROPIC_API_KEY, openRouterKey: env.OPENROUTER_API_KEY },
    model: env.BAHULAM_MODEL });
  const resolveConnection = ({ binding, user }) => createAzureDevOpsConnection({
    organization: binding.organization, project: binding.project, team: binding.team, pat: env[user.pat_env],
  });
  const handle = createTeamsHandler({ ...runtime, loadBindings, resolveConnection });
  const app = new App({ clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET, tenantId: env.TENANT_ID,
    dangerouslyAllowUnauthenticatedRequests: false });
  app.on('message', handle);
  await app.start(Number(env.PORT || 3978));
  return app;
}
