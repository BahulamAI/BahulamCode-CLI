# Getting Help

## Bug Reports

Found a bug? [Open an issue](https://github.com/BahulamAI/BahulamCode-CLI/issues/new?template=bug_report.md) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your OS, Node version (`node --version`), and npm version (`npm --version`)
- Relevant logs or terminal output

## Feature Requests

Have an idea? [Open a feature request](https://github.com/BahulamAI/BahulamCode-CLI/issues/new?template=feature_request.md).

## Questions

- **Email:** support@bahulam.ai
- **GitHub Discussions:** [BahulamAI/BahulamCode-CLI/discussions](https://github.com/BahulamAI/BahulamCode-CLI/discussions)

## Security Issues

See [SECURITY.md](./SECURITY.md) for responsible disclosure instructions.

## Quick Diagnostics

Run the built-in health check:

```bash
bahulam-code doctor
```

This reports your Node version, API key status, model configuration, and MCP server count.

## Common Issues

### "Not logged in. Run `bahulam-code login` first."

```bash
bahulam-code login
```

### CLI hangs or becomes unresponsive

Press `Ctrl+C` to cancel the current operation. If the session is stuck:

```bash
bahulam-code resume
```

### Slow responses or rate limits

Check your rate limit status in the REPL:

```
/cost
```

Consider upgrading your plan at [bahulam.ai/pricing](https://bahulam.ai/pricing) or using your own API key (BYOK).
