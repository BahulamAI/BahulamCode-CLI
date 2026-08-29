# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Bahulam Code, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to report

Email **security@bahulam.ai** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to expect

- **Acknowledgment** within 48 hours
- **Assessment** within 1 week
- **Fix or mitigation** timeline communicated after assessment
- **Credit** in the release notes (unless you prefer to remain anonymous)

### Scope

The following are in scope:

- Authentication and authorization bypass
- Remote code execution
- Data exposure or leakage
- Dependency vulnerabilities with known exploits
- Path traversal allowing access outside the workspace

The following are out of scope:

- Denial of service against the CLI itself
- Issues requiring physical access to the user's machine
- Social engineering attacks

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Security Best Practices for Users

- Keep `@bahulam/code` updated to the latest version
- Do not share your Bahulam session token (`B0_TOKEN`)
- Use `bahulam login` to authenticate — do not hardcode tokens in scripts
- Review tool approval prompts before allowing writes or shell commands
