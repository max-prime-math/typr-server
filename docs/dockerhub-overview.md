# Typr Companion

![Typr Companion](https://raw.githubusercontent.com/max-prime-math/typr/main/public/icons/icon-512.png)

Typr Companion is the self-hosted compile and live-preview service for Typr. It provides isolated LaTeX/TeXpresso compilation and a private WebSocket live-preview transport.

## Image

```sh
maxprimemath/typr-server:0.1.4
```

The image supports `linux/amd64` and `linux/arm64`. Use an exact version or digest for reproducible deployments; `latest` is a moving alias.

## Quick start

```sh
docker run --detach --name typr-companion \
  --publish 127.0.0.1:8484:8484 \
  --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=536870912 \
  maxprimemath/typr-server:0.1.4
```

Configure Typr with the browser-reachable Companion URL and an exact allowed origin. CORS is not authentication; the service is designed for mutually trusted users and documents.

## Workspace storage

Companion is stateless by default. Typr browser storage remains the authoritative local copy. An optional, tightly scoped mapped workspace can be enabled for explicit manual sync; map one project directory only, never a broad host path or Docker socket. Back up mapped files before enabling deletes or upgrades.

## Security and Tailscale

Use Companion only on a trusted LAN or private VPN. Never expose it directly to the public Internet. For remote access, keep per-container Tailscale hooks disabled and use host-level Tailscale Serve to proxy HTTPS and WebSockets to `127.0.0.1:8484`. Disable Tailscale Funnel/public sharing. The hardened image is non-root, read-only, and cannot run a root-required per-container Tailscale hook.

## Documentation

- [Installation guide](https://github.com/max-prime-math/typr-server/blob/main/docs/companion-installation.md)
- [Unraid guide](https://github.com/max-prime-math/typr-server/blob/main/docs/companion-unraid.md)
- [Release notes](https://github.com/max-prime-math/typr-server/blob/main/docs/companion-release.md)
- [Typr Companion repository](https://github.com/max-prime-math/typr-server)

Typr Companion is licensed under AGPL-3.0-or-later.
