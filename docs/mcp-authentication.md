# MCP authentication

Register a server once, sign in explicitly, then let Bahulam reuse and refresh its credentials. HTTP and legacy SSE use the same MCP SDK authentication path in the Node runtime, including when Rust renders the terminal.

## Browser OAuth

For Postiz's browser-authenticated endpoint:

```sh
bahulam mcp add postiz --url https://mcp.postiz.com/mcp-oauth-dynamic --oauth
bahulam mcp login postiz
bahulam mcp test postiz
```

Login opens your default browser and listens on an ephemeral `127.0.0.1` port. It uses authorization-code flow with PKCE and validates the callback state. The browser and CLI must run on the same machine. Login times out after three minutes; Ctrl+C cancels. No API key belongs in the URL.

Servers that support dynamic client registration need no client ID. For a pre-registered public client, use `--client-id <id>` and, if required by its registration, `--callback-port <port>` (1024–65535). Register `http://127.0.0.1:<port>/callback` with the provider. `--scope '<scopes>'` supplies explicit scopes. Confidential clients requiring a separately provisioned client secret are not supported by these flags.

Startup never launches a browser. Expired access tokens are refreshed automatically when a refresh token is available; rejected refresh tokens require another `mcp login`. OAuth requires HTTPS except for loopback development servers. Authentication redirects are not followed automatically by network requests; register the final endpoint URL.

## API-key servers

Use a masked prompt to avoid putting the key in shell history or configuration:

```sh
bahulam mcp add example --url https://example.com/mcp --api-key
```

The default header is `Authorization: Bearer <key>`. For another scheme:

```sh
bahulam mcp add example --url https://example.com/mcp --api-key --api-key-header X-API-Key --api-key-prefix ''
```

Alternatively, supply an environment reference. Single quotes preserve the reference when running from a shell:

```sh
bahulam mcp add example --url https://example.com/mcp \
  --header 'Authorization: Bearer ${EXAMPLE_API_KEY}'
```

The environment variable must be set in the Bahulam process. Missing variables produce an error instead of an empty header. Server `env` values are isolated; they do not modify the parent environment or other servers. Rotate a stored API key with `bahulam mcp login example --api-key`.

## Run commands inside Bahulam

Use the same commands with `!` in the composer:

```text
!bahulam mcp add postiz --url https://mcp.postiz.com/mcp-oauth-dynamic --oauth
!bahulam mcp login postiz
!bahulam mcp test postiz
```

The terminal temporarily hands input and output to the command. Press Enter afterward to return to the previous view. `!bahulam mcp` uses the current CLI installation, not a potentially older global executable. It preserves quoted environment references. Other `!` commands execute through the local shell. These direct commands and their output are not added to agent context or prompt history. During an agent turn they queue until the turn finishes; credentials are never sent as follow-up instructions.

`/mcp login <name>` and `/mcp add … --api-key` use the same terminal handoff. `/mcp list`, `/mcp test` and `/mcp logout` work as regular slash commands. Restart the session to register newly added tools with the agent.

## Storage and diagnostics

The agent can call the read-only `bahulam_cli_info` tool (`mcp`, `input`, `version`, or `all`) for the instructions belonging to the installed package. Both local and remote agent routes advertise it. It never reads credentials; backend account/provider questions still use `bahulam_info`.

- Portable registrations remain in `~/.claude/settings.json` for compatibility with the existing settings loader.
- OAuth tokens, dynamic client registration and prompted API keys are stored separately under `${BAHULAM_HOME:-~/.bahulam}/mcp-credentials/`, keyed by the full resolved server URL.
- These files are **not encrypted**. On POSIX, the directory is mode `0700` and credential files are `0600`; Windows relies on the user's profile ACL. Keep this directory out of shared folders and backups intended for distribution.
- `mcp list --json` and registration output redact configured headers, environment values, arguments and credential-bearing URL paths/query values. Environment references remain visible. Remote error bodies and server stderr are withheld because they may echo credentials.
- `mcp test` initializes the connection and lists tools; it never executes a tool.
- `mcp logout <name>` deletes local credentials. It does not revoke the provider-side grant or invalidate another process's already-running connection. Reconnect active sessions; use the provider's account controls to revoke access remotely.
- `mcp remove <name>` removes registration only. Run `logout` before removal if you also want to delete credentials; registrations using the same URL share the credential record.

## Validation

```sh
node test/test-mcp-auth.mjs
node test/test-mcp.mjs
node scripts/test-mcp-terminal.mjs
```

The authentication suite uses local HTTP/OAuth fixtures, not a real account. The terminal suite exercises the actual composer and credential prompt with a pseudo-terminal on POSIX. Real browser/provider and Windows acceptance must be checked separately.
