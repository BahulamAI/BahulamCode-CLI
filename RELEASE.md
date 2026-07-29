# Release Checklist

This repo publishes the npm package `@bahulamai/b0`.

## Branch Flow

1. Finish changes on the feature branch.
2. Run tests on the feature branch:

   ```bash
   npm test
   ```

3. Bump the npm version. For the next minor:

   ```bash
   npm version minor --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "chore: bump b0 to <version>"
   ```

4. Push the feature branch:

   ```bash
   git push origin <feature-branch>
   ```

5. Merge into `development`:

   ```bash
   git checkout development
   git fetch origin
   git merge --ff-only origin/development
   git merge --no-ff <feature-branch> -m "merge: <release summary>"
   npm test
   git push origin development
   ```

6. Open a PR from `development` to `main`.

## Npm Package Validation

Use a temporary npm cache if the local `~/.npm` cache has permission issues:

```bash
env NPM_CONFIG_CACHE=/private/tmp/b0-npm-cache npm pack --dry-run
```

Check registry state:

```bash
env NPM_CONFIG_CACHE=/private/tmp/b0-npm-cache npm view @bahulamai/b0 version versions --json
env NPM_CONFIG_CACHE=/private/tmp/b0-npm-cache npm whoami
```

`npm whoami` must succeed before publishing.

## Publish Latest

Only publish after the release PR is reviewed and the intended commit is the
release candidate.

```bash
env NPM_CONFIG_CACHE=/private/tmp/b0-npm-cache npm publish --tag latest --access public
```

Verify:

```bash
npm view @bahulamai/b0 version
npx @bahulamai/b0@latest --version
```

## Notes

- `package.json` points npm at `B0-README.md`; update that file for npm
  package documentation.
- `README.md` is the shorter GitHub/local landing page.
- Do not commit local `.bahulam/` runtime state.
- Do not publish with missing npm auth or a failed test run.
