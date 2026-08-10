# Typr Companion

Typr Companion is the optional native LaTeX, scoped mapped-workspace, and experimental TeXpresso service
for [Typr](https://github.com/max-prime-math/typr). The public container remains
`ghcr.io/max-prime-math/typr-server`.

The service is deliberately unauthenticated. Run it only on a trusted machine,
LAN, or VPN; never expose it to the public Internet. Browser access from another
device normally requires an HTTPS reverse proxy with WebSocket support because
an HTTPS Typr page cannot call a plain HTTP/WS Companion.

Browser-local storage remains Typr's default. The file API is disabled unless
an administrator explicitly maps one trusted directory; native compiler
children are sandboxed away from that mount. This does not create a safe
multi-tenant service—all users and documents must still be mutually trusted.

## Install

See [the installation guide](docs/companion-installation.md) for Docker,
Compose, version pinning, rollback, platform support, and security guidance.
The production [`compose.yaml`](compose.yaml) stays stateless by default; the
separate [`compose.workspace.yaml`](compose.workspace.yaml) override enables one
exact administrator-selected directory. Unraid users should follow the
[separate Companion template guide](docs/companion-unraid.md).
The [protocol guide](docs/companion-protocol.md) documents the versioned API and
the experimental live-preview transport. Maintainers use the
[staged release policy](docs/companion-release.md); a Git tag is never the first
test of an image.

## Develop

Node 22.6 or later is required for built-in TypeScript type stripping.

```sh
npm ci
npm run typecheck
npm test
npm run companion
```

The transport-neutral protocol is exported as
`@max-prime-math/typr-companion-protocol`. Consumers must pin an immutable Git
commit, not a branch, so the browser client and server cannot drift silently.

See [HISTORY.md](HISTORY.md) for the preserved monorepo commit mapping and tag
safeguards used for the split.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
