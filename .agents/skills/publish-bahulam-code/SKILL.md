---
name: publish-bahulam-code
description: Prepare, publish and verify an @bahulam/code npm release from codekepler-npm. Use for version selection, beta dist-tags, native Rust runtime packaging and npm publish failures.
---

# Publish Bahulam Code

Run commands from the repository root. For a stable release, follow the branch and tag procedure in [RELEASE.md](../../../RELEASE.md). For a public testing beta, use the procedure below. Anyone can install a public beta by version or tag.

## Select the version

Query the registry before editing files. Record the current stable version so you can verify it after publishing.

```sh
registry=https://registry.npmjs.org
npm view @bahulam/code versions dist-tags --json --registry="$registry"
npm whoami --registry="$registry"
```

Start from the intended release line. This package has older experimental 2.x versions alongside its 0.x stable line. For the next iteration of an existing beta, increment the prerelease number until the exact version is unused. For example, a published `0.2.2-beta.0` is followed by `0.2.2-beta.1`. If stable `0.2.2` has already shipped, choose the next intended stable line first.

Set the shell variable `version` to the chosen value. Run `npm version "$version" --no-git-tag-version --ignore-scripts`. Set the same version in `rust/bahulam-tui/Cargo.toml` and the `bahulam-tui` package entry in `rust/Cargo.lock`. Inspect the diff for both npm manifests and both Rust files.

## Build and pack

Run `npm run sync-catalog` and review the resulting catalog before building the candidate. Publishing a prebuilt tarball bypasses the source package's normal catalog refresh. Run `npm test`, `npm run test:protocol`, `npm run test:tui` and the terminal checks relevant to the release.

Use [Package Rust terminal](../../../.github/workflows/tui-runtime.yml) on the versioned source revision. Its five native jobs run `npm run tui:build:runtime` and assemble the `bahulam-code` tarball artifact. A workflow run sees committed source at its selected ref. For a local candidate, build the same source for all five targets and stage the outputs under `native/`. A single host build stages only one target. Rebuild after every version bump because the executable embeds its Cargo version.

Check for `bahulam-tui` in `darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64`, and `bahulam-tui.exe` in `win32-x64`. Include any required redistributable DLL and license alongside the Windows executable. Keep track of which builds ran on a native OS, under emulation, or were only cross-compiled.

For local staging:

```sh
mkdir -p rust/target/npm-preview
npm pack --ignore-scripts --pack-destination rust/target/npm-preview
tarball="rust/target/npm-preview/bahulam-code-${version}.tgz"
tar -tzf "$tarball" | grep '^package/native/'
tar -xOzf "$tarball" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).version'
```

Verify the CLI and runtime report the chosen version from an extracted package. Launch interactively without renderer overrides to check Rust inline startup. Test from outside the checkout so a development binary cannot satisfy the check.

## Publish and verify

When the user authorizes public beta publication, publish the **exact verified tarball**. If using the CI artifact, set `tarball` to the downloaded .tgz path first.

```sh
npm publish "$tarball" --tag beta --access public --registry="$registry"
npm view "@bahulam/code@$version" version dist.integrity --json --registry="$registry"
npm view @bahulam/code dist-tags --json --registry="$registry"
printf 'sha512-'
openssl dgst -sha512 -binary "$tarball" | openssl base64 -A
printf '\n'
```

Confirm the registry integrity matches the local hash, `beta` resolves to the chosen version, and `latest` still resolves to the recorded stable release. Testers launch with `npx --yes @bahulam/code@beta`.

- **EOTP:** Have the publisher complete npm's authentication prompt in their own terminal using the same tarball and tag. Keep OTPs and tokens out of chat and logs.
- **E403 with “cannot publish over” or an uncertain publish outcome:** Query the exact version, integrity and tags again. If they already match, publication succeeded. If that version contains different bytes, npm requires a new version. Repeat versioning, builds and packing. For other E403 responses check package access and registry authentication before changing versions.
