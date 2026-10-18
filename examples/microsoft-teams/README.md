# Bahulam Microsoft Teams host

The default host uses delegated Microsoft Entra OAuth for Azure DevOps. Bahulam
owns organization/account linking, encrypted credentials, refresh, billing and
the agent runtime. The plugin receives non-secret configuration and named operation
results through a separate worker process.

Follow [HOSTED.md](HOSTED.md) for Microsoft registration, Teams distribution,
Supabase migrations, secret mounts, deployment and the enterprise acceptance flow.
Use `hosted.env.example` as a configuration checklist; supply actual secrets through
private deployment files. No ADO PAT is required or accepted by hosted mode.

This release supports enterprise **personal Teams chat** and seven bounded PR
review operations. It does not yet ship public Store distribution or a sandbox
suitable for arbitrary third-party plugins.

The [legacy PAT prototype](LEGACY-PAT.md) is retained for explicit local migration
experiments. It requires `BAHULAM_TEAMS_LEGACY_PAT=true` and is not the hosted path.

```bash
# From codekepler-npm
node test/test-ado-hosted.mjs
node test/test-teams-connector.mjs
```
