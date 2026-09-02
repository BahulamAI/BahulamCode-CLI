# Release Checklist

This repo publishes the npm package `@bahulam/code`.

## Branch Flow

1. Finish changes on a feature branch.
2. Run tests:

   ```bash
   npm test
   ```

3. Bump version:

   ```bash
   npm version patch --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "chore: bump @bahulam/code to <version>"
   ```

4. Push and open a PR to `main`.

5. After merge, pull main and tag:

   ```bash
   git checkout main
   git pull origin main
   git tag v<version>
   git push origin v<version>
   ```

## Npm Publish

Ensure you're logged in:

```bash
npm whoami
```

Publish:

```bash
npm publish --tag latest --access public
```

Verify:

```bash
npm view @bahulam/code version
npx @bahulam/code@latest --version
```

## Notes

- `package.json` ships `README.md` as the canonical npm-facing docs.
- Do not commit local `.bahulam/` runtime state.
- Do not publish with missing npm auth or a failed test run.
