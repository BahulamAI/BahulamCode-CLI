> Local legacy prototype only. Enable explicitly with `BAHULAM_TEAMS_LEGACY_PAT=true`. Hosted deployments use [HOSTED.md](HOSTED.md).

# Bahulam Microsoft Teams host

Infrastructure entry point for a registered organization's ADO plugin installation.
Bahulam owns the channel, agent runtime and connection credentials. The plugin owns
its tools, instructions and configuration schema. Teams users do not need separate
Bahulam accounts or agent teams; provisioning maps their Entra object IDs.

This first host is one process per registered organization/Entra tenant and one
provisioned plugin. Its state volume must be dedicated to that organization.
The core Teams handler and manifest runtime are reusable; `server.mjs` currently
selects Bahulam's ADO connection provider. It is not yet a general connector catalog.

## Provision and run

1. Provision the customer organization in Bahulam and verify its entitlement. This
   example consumes that provisioned identity; it does not call a registration API.
2. Register/configure the customer's Teams bot and HTTPS messaging endpoint using
   the [Teams SDK setup](https://microsoft.github.io/teams-sdk/typescript/getting-started/quickstart/).
   Configure its Entra app credentials; allow personal/team scope as required.
3. Install the Bahulam runtime dependencies at the repository root, then run
   `npm ci --ignore-scripts` in this directory for the pinned Teams SDK.
4. Copy `bindings.example.json` to a private deployment path. Set the registered
   organization ID, Entra tenant, Microsoft team/channel, ADO org/project/team and
   each permitted user's Entra object ID → secret environment-variable reference.
   Store actual PATs only in deployment secrets. The user must own their PAT.
5. Supply the environment below through the deployment secret/config service and
   run `npm start` in this directory. Expose the SDK's `/api/messages` endpoint
   over HTTPS and install the Teams application for the customer's tenant.

| Environment | Purpose |
|---|---|
| `BAHULAM_ORGANIZATION_ID` | Registered customer organization ID |
| `BAHULAM_HOME` | Dedicated writable persistent state directory |
| `BAHULAM_PLUGIN_DIR` | Absolute path to the installed `azure-devops` plugin |
| `ADO_BINDINGS_FILE` | Absolute path to the private provisioning JSON |
| `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` | Customer Teams bot credentials |
| `ADO_PAT_USER_ONE` etc. | User-owned ADO credentials referenced by bindings |
| `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` | Runtime model credential |
| `BAHULAM_MODEL` | Optional model selection |
| `PORT` | Optional HTTP port; defaults to 3978 |

Use Node 22.13+ for SQLite and abort-signal support. The SDK stays in this
deployment package; installing the terminal CLI does not install a Teams server.
Channel authentication follows the [Teams SDK authentication model](https://microsoft.github.io/teams-sdk/typescript/essentials/app-authentication/).

Bindings reload on every message. Removing a user disables subsequent requests;
already-running work is not cancelled. Personal chat requires exactly one mapping
with `personal: true` for that user. Channel chat requires exact tenant, team,
channel and user matches. Group chats are not supported. When a user belongs to
several teams, designate one personal mapping and use channels for the others.
Only mention text is stripped; requests remain user data, not routing instructions.

## Execution contract

```js
await tool.call(argumentsFromModel, {
  state,              // isolated plugin state and non-secret installation settings
  connection: {
    config,           // organization, project, team and enforced routing restrictions
    request,          // Bahulam authenticates and sends the ADO request
  },
  signal,
});
```

Neither model tool arguments nor plugin code receive the hosted PAT. The runtime
exposes only the plugin's declared tools; no shell/filesystem tool executor is attached.
The current modules run in the trusted host process: this is a credential access
boundary, not a sandbox for untrusted third-party JavaScript. Production untrusted
plugins need separate workers with brokered connection calls and egress policy.

The host uses the real Bahulam manifest parser, SQLite state and graph dispatcher.
It retains the last 12 conversation messages, separated by user, conversation and
mapped ADO connection. State is stored under a hashed `teams-*` namespace. ADO work
items remain the authoritative result, and plugin actions include actor attribution.

Activity receipts are stored before execution. Duplicate deliveries are suppressed,
including after restart. A crash after receipt creation does not automatically retry
the operation; inspect ADO before submitting a fresh request. This avoids claiming
exactly-once delivery across an external API. The host does not retry ADO writes.

When a tool proposes an update requiring consent, the exact arguments are retained
for 15 minutes. Only the same mapped user/conversation can consume the one-use
`/approve <id>` command. Ordinary explicitly requested work runs directly. These
consent controls complement ADO permissions; they are not an RBAC implementation.

## Current limits and pilot checks

This implementation uses an administrator-provisioned binding file and per-user PAT
secret references. Connect OAuth consent, token refresh, live organization membership,
entitlements, audit retention and rate limits in Bahulam's control plane before broad
SaaS rollout. The example does not create Azure resources or publish a Teams app.
Run one replica per organization for now; cross-replica session serialization and
distributed storage have not been implemented. Do not expose local plugin-state APIs
as an organization-wide dashboard.

Before replacing ADOIntegration, validate a real user's Teams identity, their own
ADO PAT, a channel mapping, `my tasks`, sprint lookup, one create/comment/update,
approval, access revocation and retry behavior. No live integration was exercised
by the offline tests. Marketplace billing and scheduled notifications remain outside
this connector and plugin migration.

```bash
# From codekepler-npm
node test/test-teams-connector.mjs
```

This design follows the separation between authenticated tools and channels in
[Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-enduser-authentication)
and the separation of runtime and tool execution described by
[Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents).
MCP can expose the same tool contract later; it does not replace the Teams channel,
customer identity model or credential broker.
