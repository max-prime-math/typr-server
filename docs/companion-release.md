---
title: Release Typr Companion
---

# Release Typr Companion

This is the maintainer policy for `ghcr.io/max-prime-math/typr-server`, its
optional Docker Hub mirror, and the signed portable Windows executable.
Companion and Typr frontend releases have independent
repositories, tag namespaces, versions, workflows, packages, and templates.

## Independent versions

- `companion-release.json` declares the next stable Companion image version.
- An annotated `vMAJOR.MINOR.PATCH` Git tag selects that version.
- `TYPR_COMPANION_PROTOCOL_VERSION` is an API compatibility version and changes
  only for a protocol break.
- The TeXpresso source revision remains a separately pinned Docker build argument
  and OCI label.

Do not increment the protocol merely to publish a container update. The first
standalone release continues the existing image stream as `v0.1.2`; historical
`v0.1.0` and `v0.1.1` tags remain only in the original Typr repository and must
never be copied or moved.

## CI and staged publication

Pull requests, `main` pushes, and manual dispatches run source and native image
tests but never log into a registry. Native amd64 and arm64 jobs run production
Compose plus the REST sandbox, TeXpresso persistence, raster, and private
WebSocket harnesses.

Only a pushed annotated version tag in the official repository may publish. The
workflow requires its version to match `companion-release.json`, its peeled
commit to equal the workflow SHA, and that commit to remain reachable from current
`origin/main`.
Release tags share one non-cancelling concurrency group, so two versions cannot
race moving aliases.

After all prepublication tests pass, the workflow:

1. builds one multi-platform run-unique `candidate-*` image with BuildKit max
   provenance and SPDX SBOM attestations;
2. verifies the candidate OCI index contains runnable amd64 and arm64 images and
   an attestation manifest for each;
3. pulls that exact digest on native amd64 and arm64 runners and repeats all five
   production harnesses;
4. creates immutable exact-version and 12-character SHA tags from the verified
   digest without rebuilding;
5. anonymously pulls those exact tags on both native architectures and verifies
   version, revision, and non-root user;
6. only then promotes the minor, major, and `latest` aliases.

Candidate objects are registry staging artifacts, not releases. Exact Git tags
and exact image tags are immutable. If a run fails after an exact tag exists,
inspect it and rerun only when it resolves to the same candidate digest; never
rebuild over that version.

The separate Windows workflow builds on `windows-2025` with Node's native SEA
builder, embeds the SHA-256-pinned TinyTeX runtime and MuPDF WebAssembly, runs
the Windows unit suite, and exercises first-run offline extraction, REST
compilation, the workspace API, and the live-preview fallback. A tagged build
must have an annotated tag matching `companion-release.json` and must be
Authenticode-signed; missing signing secrets fail publication. The verified
`typr-companion-windows-x64.exe` is attached to the exact GitHub Release without
overwriting an existing asset. Pull-request artifacts remain unsigned test
artifacts.

## Stable tags

Tag `v0.1.4` publishes the Windows executable plus:

```text
ghcr.io/max-prime-math/typr-server:0.1.4
ghcr.io/max-prime-math/typr-server:0.1
ghcr.io/max-prime-math/typr-server:0
ghcr.io/max-prime-math/typr-server:latest
ghcr.io/max-prime-math/typr-server:sha-<12-character-sha>
```

The existing `0` compatibility alias is retained for the `0.1.x` stream. Review
and remove the major-zero alias before a future `0.2.0` if minor releases may
break compatibility. `latest` is written last and never published by a branch,
pull request, or manual run. Promotion rejects a semantic-version downgrade.

## Mandatory GHCR package gate

The existing public `typr-server` package was linked historically to
`max-prime-math/typr`. Before publishing from the standalone repository, verify
that package's settings:

1. add `max-prime-math/typr-server` under **Manage Actions access** with
   **Write** access;
2. connect the package to the standalone repository separately;
3. confirm visibility remains **Public** and anonymous pulls still work.

Do not delete or recreate the package and do not change its namespace. Configure
the GitHub `container-release` environment with required reviewers and restrict
it to protected `v*` tags. Package linkage, Actions access, visibility, and the
release environment are distinct settings.

## Create `v0.1.4`

Only after the complete local and GitHub validation matrix is green, from a
clean exact `main` checkout:

```bash
git tag -a v0.1.4 -m "Typr Companion v0.1.4"
git push origin v0.1.4
```

Pushing the tag intentionally starts publication. If a prepublication step
fails, fix it before any new tag. If an immutable release has already been
published, use a new patch version rather than moving or force-pushing the tag.

After alias promotion, use a clean Docker configuration and verify anonymous
platform pulls by exact version and digest before announcing the release.

## Optional Docker Hub mirror

GHCR is canonical and sufficient for Docker, Compose, and Unraid. The downstream
mirror is enabled only when all three GitHub settings exist:

- variable `DOCKERHUB_NAMESPACE`: destination user or organization;
- variable `DOCKERHUB_USERNAME`: service account used for login;
- secret `DOCKERHUB_TOKEN`: scoped token that can write the intended
  `typr-server` repository.

The mirror uses a digest-pinned Skopeo image to copy the verified multi-platform
index, blobs, and attestations recursively while preserving its digest. It does
not rebuild or attempt a cross-registry retag. Cross-
registry operations cannot be transactional: a Docker Hub failure does not roll
back or invalidate GHCR, and a failed job may leave partial mirror tags that must
be inspected before retry. Never put a placeholder Docker Hub namespace in the
Unraid template.

## Permissions, pins, and attestations

The workflow defaults to `contents: read`. Only candidate publication and tag
promotion receive `packages: write`; candidate verification receives
`packages: read`. All third-party actions are pinned to full immutable commit
SHAs. Registry credentials are supplied only to the jobs that need them.

Release images carry OCI source, documentation, version, full Git revision,
commit timestamp, and AGPL license labels plus Companion protocol and TeXpresso
revision labels. BuildKit publishes max provenance and an SPDX SBOM, and the
candidate gate verifies that attestation manifests exist for both runnable
platforms before any exact tag is created.

The Node base image is pinned by multi-platform digest, as are the TeXpresso Git
revision and the runtime `ws` package integrity. Debian packages are resolved
from the pinned Bookworm base's configured repositories at build time, so the
tested registry candidate digest—not a later source rebuild—is the rollback and
promotion boundary.

## Community Applications readiness

The Unraid template remains independent from release automation. Submission is
blocked until the stable public alias exists, a real Unraid install and trusted
HTTPS/WebSocket path pass, a maintained forum support topic exists, profile XML
is complete, portal Validate/Scan pass, and the maintainer explicitly approves
submission. Public Internet exposure remains prohibited.
