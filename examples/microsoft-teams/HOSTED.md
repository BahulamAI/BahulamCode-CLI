# Enterprise ADO through Teams: setup and release checks

Hosted mode is the default. It uses delegated Entra OAuth, never an ADO PAT.
Bahulam owns the runtime and credential broker. The approved `azure-devops` plugin
executes seven bounded PR tools in child processes and receives no provider tokens,
database credentials, signing keys, model credentials or service authentication.

The application implementation and development database migrations are available.
Live Microsoft registration, external HTTPS endpoints, customer consent, payment
configuration and a real Teams/ADO acceptance run remain deployment requirements.
Installing a Teams app does not register a paid Bahulam organization or grant ADO access.

## 1. Microsoft setup outside the application

1. Create Bahulam's Microsoft publisher account/Partner Center organization, verify
   the publisher/domain, and prepare support, privacy and terms URLs and branding.
   Public Teams Store publication requires package validation and Microsoft review.
   An approved organization-catalog upload can be used for the enterprise pilot.
2. Register the Bahulam **OAuth application** in Entra. For the shared SaaS product,
   select accounts in organizational directories (multi-tenant). Configure the web
   redirect exactly as `https://<bahulam-app>/api/integration-connections/callback`.
   Configure delegated Azure DevOps `user_impersonation`; member authorization also
   requests `openid profile offline_access`. Keep the client secret in the broker.
3. The current administrator-verification implementation additionally requires
   delegated Microsoft Graph `Directory.Read.All`. Configure the ID token's optional
   `wids` claim so the broker can verify a supported tenant-admin role. The admin
   explicitly consents to directory-read access during setup. The Graph token is
   transient; it is not stored or shared with members or plugins. This permission
   is broader than member PR access and must be explained to the customer's admin.
4. Separately provision a **supported Teams bot identity/resource**, enable its
   Teams channel and set its HTTPS messaging endpoint to the host's `/api/messages`.
   The bot identity and the ADO OAuth client have separate responsibilities. Keep
   bot credentials only in the authenticated Teams ingress service.
5. Validate the bot's actual tenancy model before offering cross-tenant installation.
   Microsoft no longer supports creating new legacy multi-tenant Azure Bots after
   July 31, 2025. Multi-tenant OAuth registration alone does not solve bot tenancy.
   A customer-specific bot can support the initial pilot; one centrally distributed
   Bahulam app still needs supported provisioning and a two-customer-tenant test.
6. Build the Teams package using registered IDs and approved icons:

   ```bash
   python3 build-package.py \
     --app-id <teams-app-uuid> --bot-id <bot-client-uuid> \
     --website https://<bahulam-app> \
     --privacy https://<bahulam-app>/privacy \
     --terms https://<bahulam-app>/terms \
     --color /approved/color-192.png --outline /approved/outline-32.png \
     --output /release/bahulam-teams.zip
   ```

   Validate in Teams Developer Portal. The outline icon must be white on transparent.
   The package enables personal chat only; channel/group chat is rejected by the host.
   The customer Teams admin uploads/allows the package in Teams admin center and
   assigns it to the intended members. Public Store approval is a separate step.

References: [ADO Entra OAuth](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops),
[Graph grant inspection](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-list?view=graph-rest-1.0),
[bot provisioning](https://learn.microsoft.com/en-us/azure/bot-service/abs-quickstart),
[Teams publication](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/appsource/publish).

## 2. Database and local Docker deployment

The workspace's authoritative Compose file is
`codekepler-deploy-dashboard/docker-compose.yml`. Its `backend-api` uses
`retail.settings`, per-service env files and private secret mounts. Consult the
workspace `AGENTS.md` before changing deployment configuration.

There are two Supabase projects: development `brdrigfulplpfivgmhnx` (also local
testing) and production `rfipzmzszablelnqmuhz`. Do not create new application tables
in Docker PostgreSQL. Verify the target explicitly; the local Supabase CLI link
was pointing at production during implementation.

- Apply Supabase `00117_ado_run_credit_reservations.sql` **and**
  `00118_ado_credit_rpc_permissions.sql`. The second migration removes explicit
  browser-role grants inherited from Supabase defaults. Apply both before exposing
  execution endpoints. These extend the existing organization credit ledger and
  create the non-API `bahulam_connections` schema.
- Run the Django app's three migrations on alias `integration_connections`, which
  uses that private schema. A generic default-database migration does not do this:

  ```bash
  # From codekepler-backend-api; file is private, mounted, and environment-specific.
  BAHULAM_ENVIRONMENT=development \
  BAHULAM_CONNECTION_DB_CONFIG_FILE=/run/secrets/ado-dev-database.json \
  python -m django migrate integration_connections \
    --database integration_connections \
    --settings=services.integration_connections.migration_settings --noinput
  ```

- The JSON database configuration contains `project_ref`, `host`, `user`, and
  `password`. Use the selected project's session pooler on port 5432 or its direct
  host; TLS is required. Mode must be `0600`. Production configuration must match
  the production project; local/development configuration must match development.
  Do not put this file into Git or expose the private schema in Supabase Data API.
- The local Compose mount is `secrets/local/ado-dev-database.json` to
  `/run/secrets/ado-dev-database.json`, read-only. Its path is set in the ignored
  `config-backend-api/.env.local` (the path is not a credential). The password
  remains only in the private mounted JSON file. A host-shell run uses a separate
  host-valid path.
- Development migrations were applied on 2026-10-17. Production has not been
  migrated by this work. Verify live migration state before applying either target.

## 3. Runtime configuration

| Service | Configuration |
| --- | --- |
| Django broker | `BAHULAM_CONNECTION_DB_CONFIG_FILE`, `BAHULAM_CONNECTION_KEYRING_FILE`, `BAHULAM_ADO_CLIENT_ID`, `BAHULAM_ADO_CLIENT_SECRET_FILE`, `BAHULAM_ADO_REDIRECT_URI`, `BAHULAM_ADO_PLUGIN_DIGESTS`, `BAHULAM_INTEGRATION_SERVICE_TOKEN_FILE` |
| FastAPI platform | Existing Django API base URL, existing isolation backend signing keys/`ACTIVE_backend` marker, `BAHULAM_ADO_PLUGIN_DIGEST`, `BAHULAM_INTEGRATION_SERVICE_TOKEN_FILE` |
| Teams host | `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`, `BAHULAM_PLATFORM_URL`, `BAHULAM_ADO_BROKER_URL`, `BAHULAM_APP_URL`, `BAHULAM_PLUGIN_DIR`, `BAHULAM_ADO_PLUGIN_DIGEST`, `BAHULAM_INTEGRATION_SERVICE_TOKEN_FILE`, approved model and model credential |

The broker keyring is a private `0600` JSON file with `active` key ID and `keys`
mapping IDs to base64-encoded 32-byte AES keys. Generate it with a secure random
source; retain it separately from database backups. OAuth client secrets and the
shared integration service token also use private files. The service token must
be at least 32 characters and shared only among the trusted services above.
Reuse PRD-104.1 verification keys/trusted issuers for signed runtime authorization.

The host broker URL is `https://<broker>/api/integration-connections/`; platform and
application URLs are HTTPS origins. Set up DNS/TLS, health checks and the Teams SDK
endpoint. Never disable SDK activity authentication. Do not log request bodies,
Authorization headers or callback query strings in proxies, APM or analytics.

Pin the exact deployed plugin files and use the same digest on host/platform/broker:

```bash
# From codekepler-npm
node --input-type=module -e \
  'import {adoPluginDigest} from "./src/connectors/microsoft-teams/hosted-runtime.mjs"; console.log(adoPluginDigest(process.argv[1]));' \
  /absolute/path/to/plugins/azure-devops
```

Deploy the plugin directory read-only. Install the runtime dependencies at the
repository root, run `npm ci --ignore-scripts` in this example directory, then
`npm start` with Node 22.13+. See `hosted.env.example`. Model credentials stay in
the host; OAuth tokens stay in the broker. Neither is injected into plugin workers.

## 4. Enterprise activation and acceptance flow

1. Provision the existing Bahulam organization, owner/member accounts, seats and
   subscription or valid contract. Existing payment-provider webhooks remain
   authoritative; a checkout return URL or Microsoft consent is not payment proof.
2. Owner/admin opens `/dashboard/integrations/azure-devops`, saves the approved
   Microsoft tenant and ADO organization/project/repository, grants Microsoft admin
   consent, then runs **Verify consent**. The informational admin-consent callback
   cannot activate a tenant; signed identity and provider grant inspection do that.
3. Every member signs into Bahulam and connects their own Microsoft identity with
   delegated OAuth. Mapping uses verified tenant/object IDs, not matching emails.
   This release maps one Bahulam organization per Microsoft tenant per product.
4. Install the Teams package, then message it in personal chat. The first verified
   personal message can establish the installation after account linking. Readiness
   shows organization, consent, billing, member connection and installation states.
5. Ask for a specific PR review. Verify metadata, iterations, changed paths and
   source/target file retrieval. Files are pinned to PR commit IDs; each response
   is bounded. Large PRs may need further pagination/source retrieval work.
6. Ask the agent to propose a review comment. Open Bahulam approvals, inspect the
   exact repository/PR/text and approve it. Return to the same personal conversation
   and ask it to publish that approval ID. Proposals expire after 15 minutes and
   cannot publish twice; an uncertain write requires checking ADO before a new one.
7. Check the organization ledger reservation and metered settlement. Remove a member,
   disable policy, disconnect OAuth and uninstall Teams in separate tests; the next
   authorization must fail. Confirm no personal connection/balance fallback.
8. Exercise token expiry/refresh, Microsoft revocation/reconnect and a host crash.
   Confirm no provider credentials in prompts, tool results, browser state or logs.

Paid runs reserve 100 credits by default (`BAHULAM_ADO_RUN_RESERVE_CREDITS`, maximum
1000), then settle actual priced model usage on the existing organization ledger.
There is no separate Microsoft commerce implementation. Selling through Teams
commerce would require a separate SaaS offer/fulfillment integration. Existing
Bahulam payment keys, prices, webhook delivery and live settlement still need validation.

## 5. Operations and remaining release gates

- Refresh is serialized with database row locks. Rotation is broker-side:
  retain old keys, activate the new key, run `rotate_connection_keys`, then verify
  decrypt/restore before retiring keys. Never discard keys needed by backups.
- Run `reconcile_integration_runs` periodically. It retries persisted settlements
  and reports expired runs with unknown usage for operator investigation. A crash
  with missing usage must not be silently billed as zero or automatically refunded.
- Host runs have a 180-second abort signal, ten agent turns, per-tool timeout and
  bounded responses. Reserved credits cap the customer charge; excess actual cost
  is recorded as unbilled overshoot. This is not a hard provider-spend cutoff.
- Workers have an empty inherited secret environment and Node filesystem/process
  restrictions. Node's permission mode does **not** deny network egress. This
  implementation is limited to the reviewed, digest-pinned first-party plugin.
  Arbitrary third-party plugins require OS/container egress and resource isolation.
- Do not market public cross-tenant distribution, unattended workloads, Teams
  channels, full large-PR source coverage, autonomous PRD-116 review, customer-managed
  keys or enterprise audit export as complete. They remain separate acceptance work.
- Unit tests and the development PostgreSQL validation script do not replace a live
  Microsoft OAuth/Teams/ADO run or production deployment verification.
