import { readFile, stat } from 'node:fs/promises';
import { createAdoBrokerTransport } from '../azure-devops-broker.mjs';
import { loadHostedRuntime } from './hosted-runtime.mjs';

export function activityIdentity(activity) {
  if (activity.channelId !== 'msteams' || activity.conversation?.conversationType !== 'personal') {
    throw new Error('Open Bahulam in personal chat to use your Azure DevOps connection.');
  }
  return { channel_id: activity.channelId, tenant_id: activity.channelData?.tenant?.id,
    actor_id: activity.from?.aadObjectId, conversation_id: activity.conversation?.id,
    conversation_type: 'personal', activity_id: activity.id };
}

export function createHostedTeamsHandler({ platform, runAgent, transportFactory, setupUrl }) {
  return async ({ activity, send }) => {
    let run;
    try {
      const identity = activityIdentity(activity);
      const text = String(activity.text || '').replace(/<at\b[^>]*>.*?<\/at>/gs, '').trim();
      if (!text || text.length > 16000) throw new Error('Invalid message.');
      run = await platform('begin', identity);
      if (run.duplicate) return;
      const invoke = transportFactory(async ({ connectionId, operation }) => platform('authorize', {
        run_id: run.run_id, connection_id: connectionId, operation }));
      const result = await runAgent({ text, sessionId: run.session_id, connectionId: run.connection_id,
        invoke, signal: AbortSignal.timeout(180000) });
      // Settlement must succeed before presenting this run as complete. If the
      // host crashes, its reservation remains for reconciliation; never guess 0.
      await platform('settle', { run_id: run.run_id, usage: result.usage });
      const reply = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
      for (let i = 0; i < reply.length; i += 3000) await send(reply.slice(i, i + 3000));
    } catch {
      await send(`This request could not complete. Check your connection, organization readiness and approvals at ${setupUrl}. Check Azure DevOps before retrying a write.`);
    }
  };
}

export async function startHostedTeamsServer({ App, env = process.env }) {
  for (const key of ['CLIENT_ID', 'CLIENT_SECRET', 'TENANT_ID', 'BAHULAM_PLATFORM_URL', 'BAHULAM_ADO_BROKER_URL',
    'BAHULAM_INTEGRATION_SERVICE_TOKEN_FILE', 'BAHULAM_PLUGIN_DIR', 'BAHULAM_ADO_PLUGIN_DIGEST', 'BAHULAM_APP_URL']) {
    if (!env[key]) throw new Error(`${key} is required for hosted Teams.`);
  }
  for (const key of ['BAHULAM_PLATFORM_URL', 'BAHULAM_ADO_BROKER_URL', 'BAHULAM_APP_URL']) {
    const url = new URL(env[key]);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${key} must be HTTPS.`);
  }
  if ((await stat(env.BAHULAM_INTEGRATION_SERVICE_TOKEN_FILE)).mode & 0o077) throw new Error('Service token file permissions must be 0600.');
  const secret = (await readFile(env.BAHULAM_INTEGRATION_SERVICE_TOKEN_FILE, 'utf8')).trim();
  if (secret.length < 32) throw new Error('Integration service token is invalid.');
  const platform = async (action, body) => {
    const response = await fetch(`${env.BAHULAM_PLATFORM_URL.replace(/\/$/, '')}/api/integration-connections/teams/${action}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', 'X-Integration-Service': secret }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Integration service denied request.');
    return response.json();
  };
  const runAgent = loadHostedRuntime({ pluginDir: env.BAHULAM_PLUGIN_DIR, expectedDigest: env.BAHULAM_ADO_PLUGIN_DIGEST,
    credentials: { apiKey: env.ANTHROPIC_API_KEY, openRouterKey: env.OPENROUTER_API_KEY }, model: env.BAHULAM_MODEL });
  const app = new App({ clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET, tenantId: env.TENANT_ID,
    dangerouslyAllowUnauthenticatedRequests: false });
  app.on('message', createHostedTeamsHandler({ platform, runAgent,
    transportFactory: getInvocationAuthorization => createAdoBrokerTransport({ brokerUrl: env.BAHULAM_ADO_BROKER_URL, getInvocationAuthorization }),
    setupUrl: `${env.BAHULAM_APP_URL.replace(/\/$/, '')}/dashboard/integrations/azure-devops` }));
  for (const [event, action] of [['install.add', 'installed'], ['install.remove', 'uninstalled']]) {
    app.on(event, async ({ activity }) => { await platform(action, activityIdentity(activity)); });
  }
  await app.start(Number(env.PORT || 3978));
  return app;
}
