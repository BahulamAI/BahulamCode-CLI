# Contributing to Bahulam Code

Thanks for your interest in contributing to Bahulam Code. This document covers the basics.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a branch for your changes
4. Make your changes
5. Run the test suite
6. Submit a pull request

## Development Setup

```bash
git clone https://github.com/BahulamAI/BahulamCode-CLI.git
cd BahulamCode-CLI
npm install
npm test
```

## Branch Naming

Use the pattern: `{issue_number}_{short-description}`

Examples:
- `223_open_source_prep`
- `45_fix_memory_leak`

## Code Style

- ES modules only (`type: "module"`)
- No external linting dependencies — keep it simple
- Match the style of the file you're editing

## Testing

Run the full test suite before submitting:

```bash
npm test
```

All tests must pass. If you're adding a new feature, add a test for it.

## Pull Requests

- Keep PRs focused on one change
- Write a clear title and description
- Reference any related issues
- Make sure CI passes

## Reporting Issues

Open an issue on [GitHub](https://github.com/BahulamAI/BahulamCode-CLI/issues). Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your OS, Node version, and npm version

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
