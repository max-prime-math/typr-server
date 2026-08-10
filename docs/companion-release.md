---
title: Release Typr Companion
---

# Release Typr Companion

This is the maintainer workflow for `ghcr.io/max-prime-math/typr-server` and its optional Docker Hub mirror. It is deliberately independent from Typr frontend releases and deployment-channel promotions.

## Independent versions

Keep these values separate:

- The Typr PWA version is the application/package version.
- The Companion version is injected into the image from a stable Git tag and returned as `serverVersion`.
- `TYPR_COMPANION_PROTOCOL_VERSION` controls API compatibility and does not change for an image-only release.
- The TeXpresso source revision is a separately pinned Docker build argument and OCI label.

Matching numbers are allowed but do not make these values the same version stream. Do not edit `/api/v1` or increment the protocol merely to publish a container update.

## CI and publish boundary

`.github/workflows/docker.yml` runs on pull requests, pushes to the release-channel branches, matching version tags, and manual dispatches. A source job typechecks, runs the complete unit suite, and builds the production frontend. Its architecture matrix then builds and runs the same existing Docker harnesses for:

- `linux/amd64` natively on the GitHub-hosted amd64 runner;
- `linux/arm64` natively on GitHub's `ubuntu-24.04-arm` runner.

Both jobs verify container startup/status, simple and multi-file pdfLaTeX, a binary image asset, typed invalid-LaTeX failure, path rejection, persistent TeXpresso execution, raster page export, and the full WebSocket live-preview lifecycle. The browser frontend E2E suite is not repeated inside each architecture job: the transport harness already exercises the architecture-sensitive container backend, while frontend behavior remains covered by the normal unit/build and focused frontend E2E workflows.

Pull requests, branch pushes, and manual dispatches never log into a registry and never publish. The publish job requires both architecture test jobs and a Git ref beginning with `refs/tags/v`; it then validates the stricter exact form `vMAJOR.MINOR.PATCH`. A malformed tag fails before registry login/push.

## Stable tags

Tag `v0.1.2` publishes:

```text
ghcr.io/max-prime-math/typr-server:0.1.2
ghcr.io/max-prime-math/typr-server:0.1
ghcr.io/max-prime-math/typr-server:0
ghcr.io/max-prime-math/typr-server:latest
ghcr.io/max-prime-math/typr-server:sha-<short-sha>
```

`latest` is created only in the guarded stable tag job. It is never published from `dev`, `development`, `beta`, `main`, pull requests, or manual runs.

If the repository variable `DOCKERHUB_USERNAME` is configured, the same build also publishes every tag above to `<DOCKERHUB_USERNAME>/typr-server`. If the variable is absent, Docker Hub login and tags are omitted while GHCR publication continues normally.

After the manifest is pushed, two clean jobs pull the versioned image by target platform and rerun status/version and conventional compile checks against the published artifact. This checks the registry manifest rather than only the pre-publish BuildKit result.

## Create a release

First ensure the chosen commit has passed the Docker workflow and the normal application tests. From a clean checkout of that exact commit:

```bash
git tag -a v0.1.2 -m "Typr Companion v0.1.2"
git push origin v0.1.2
```

Pushing the tag is the publication trigger. Do not create or push it until a public GHCR release is intended. If the workflow fails before publish, fix the cause and use a new version tag rather than moving a tag that users may already have resolved.

After the first successful publication, open the `typr-server` package settings and confirm its visibility is **Public**. GHCR package visibility is managed separately from the repository; anonymous `docker pull` and the unauthenticated Compose/Unraid install paths work only after the container package is public. Verify from a logged-out shell before announcing the release:

```bash
docker pull ghcr.io/max-prime-math/typr-server:latest
```

## Enable the Docker Hub mirror

Docker Hub is optional; GHCR is sufficient for Docker, Compose, and the Unraid template. To enable the mirror:

1. Create a public Docker Hub repository named `typr-server` under the intended user or organization.
2. Create a Docker Hub personal access token with permission to write that repository. Do not use the account password.
3. In the GitHub repository settings, add an Actions variable named `DOCKERHUB_USERNAME` containing the Docker Hub namespace.
4. Add an Actions secret named `DOCKERHUB_TOKEN` containing the access token.

The next valid `vMAJOR.MINOR.PATCH` tag logs into both registries and pushes the same multi-platform build, semver tags, OCI metadata, provenance, and SBOM. If `DOCKERHUB_USERNAME` is configured but its token is missing or invalid, publication fails instead of silently producing only one registry copy.

## Community Applications readiness

[`unraid/typr-companion.xml`](../unraid/typr-companion.xml) is usable as a direct Unraid user template before store listing. Community Applications submission should happen only after:

- at least one public stable image is available at the template's `latest` tag;
- the template and icon URLs are available from the `main` branch;
- the documented remote HTTPS connection has been tested on an Unraid host;
- a public Unraid support topic or equivalent maintained support destination exists.

The template is not submitted automatically by the release workflow. Store submission is a separate maintainer action because it creates an ongoing support obligation.

## Permissions and metadata

The workflow defaults to `contents: read`. Only the publish job receives `packages: write`; published-image verification uses `packages: read`. GHCR authentication uses GitHub's built-in `GITHUB_TOKEN`. Optional Docker Hub authentication uses the repository's `DOCKERHUB_USERNAME` variable and masked `DOCKERHUB_TOKEN` secret; no registry credential is committed.

Release images contain OCI source, documentation, version, Git revision, commit-date build timestamp, and AGPL license labels. Typr-specific labels record Companion protocol version and the pinned TeXpresso commit. Buildx also publishes standard provenance and SBOM attestations.

## Build cache and reproducibility

BuildKit's GitHub Actions cache uses one scope per architecture. The release build imports both scopes, so unchanged TeX Live, native TeXpresso, and runtime dependency layers can be reused while source-only changes recopy the small server layer. Cache hits never replace Dockerfile inputs or skip tests.

The Node base tag, TeXpresso commit, and exact `ws` package (including registry integrity) are pinned. Debian packages are intentionally resolved from the selected Bookworm image repositories and the multi-architecture base is version-tagged rather than digest-pinned. Therefore release digests, not later source rebuilds, are the reproducible rollback boundary.

## Architecture evidence

Treat these states precisely in release notes:

- A successful Buildx build is **built successfully**.
- The amd64 matrix runtime suite on `ubuntu-latest` is **tested natively**.
- The arm64 matrix runtime suite on `ubuntu-24.04-arm` is **tested natively on arm64**.

Do not describe arm64 as runtime-verified until its matrix suite completes. If an architecture fails, the `needs: test-image` dependency blocks the entire manifest; never remove the failing platform and silently publish a partial release.
