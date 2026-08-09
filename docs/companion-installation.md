---
title: Install Typr Companion
---

# Install Typr Companion

Typr Companion supplies native `latexmk`/pdfLaTeX compilation and the experimental TeXpresso live preview to the Typr PWA. It runs separately from the PWA and does not store projects. The official image is:

```text
ghcr.io/max-prime-math/typr-server
```

## Requirements

- Docker Engine on Linux, or Docker Desktop on Windows/macOS.
- A `linux/amd64` or `linux/arm64` Docker host.
- Typr and the Companion should be used on the same trusted machine. The browser connects to host loopback at port 8484.

Windows uses Docker Desktop with its WSL2 backend, macOS uses Docker Desktop, and Linux uses Docker Engine. Native Windows and macOS Companion packages are intentionally not required.

## Install

The direct Docker command is the simplest installation and does not require cloning this repository:

```bash
docker run -d \
  --name typr-server \
  --restart unless-stopped \
  --security-opt no-new-privileges:true \
  -p 127.0.0.1:8484:8484 \
  ghcr.io/max-prime-math/typr-server:latest
```

The image allows the official Stable, Beta, and Development Typr origins plus the standard local Vite origins. A custom Typr deployment must replace that allowlist with its exact origin:

```bash
-e TYPR_COMPANION_ALLOWED_ORIGINS=https://your-typr.example
```

No environment variable or volume is required for the official Typr PWA. The server uses temporary per-request/per-session directories and removes them; there is currently no safe, meaningful cache directory to persist and user projects are never mounted or stored.

Typr uses `http://127.0.0.1:8484` by default. To use a Companion behind another HTTPS URL, open **Settings → Editor → Typr Companion**, enter the URL, and apply it. The selection is stored in that browser. A remote HTTP URL cannot be used from the hosted HTTPS PWA because browsers block mixed content. Chromium browsers may also request Local Network Access permission; allow it for Typr when intentionally connecting to your Companion.

### Docker Compose

The repository's [`compose.yaml`](../compose.yaml) uses the published stable image, loopback binding, restart policy, and `no-new-privileges` hardening. Download that one file or copy it into an otherwise empty directory, then run:

```bash
docker compose up -d
```

The production Compose file never builds from source. Contributors can instead use the separate [`compose.dev.yaml`](../compose.dev.yaml):

```bash
docker compose -f compose.dev.yaml up --build
```

## Verify and diagnose

Check that Docker reports a healthy running container:

```bash
docker ps
curl -sS http://127.0.0.1:8484/api/v1/status
```

The status response reports the packaged Companion `serverVersion` independently of `protocolVersion`. In Typr, the Companion connection indicator should become connected. If it does not, inspect `docker logs typr-server`, confirm port 8484 is not already occupied, and confirm a custom PWA origin is present in `TYPR_COMPANION_ALLOWED_ORIGINS`.

## Update

For Compose, pull and recreate the service:

```bash
docker compose pull
docker compose up -d
```

For direct Docker, pull and recreate it with the same options used at installation:

```bash
docker pull ghcr.io/max-prime-math/typr-server:latest
docker stop typr-server
docker rm typr-server
docker run -d \
  --name typr-server \
  --restart unless-stopped \
  --security-opt no-new-privileges:true \
  -p 127.0.0.1:8484:8484 \
  ghcr.io/max-prime-math/typr-server:latest
```

There is no self-updater inside the Companion and the PWA cannot mutate Docker. Docker/the host remains responsible for container lifecycle.

## Pin or roll back a version

`latest` means the newest stable release, never an arbitrary `dev` build. For reproducible TeX behavior, replace it with a complete release such as:

```text
ghcr.io/max-prime-math/typr-server:0.1.1
```

In Compose:

```yaml
image: ghcr.io/max-prime-math/typr-server:0.1.1
```

Run `docker compose pull && docker compose up -d` after changing the tag. Rollback is the same operation with the previous known-good tag. Direct Docker users pull the chosen tag and recreate the container with it.

Stable releases publish `MAJOR.MINOR.PATCH`, `MAJOR.MINOR`, `MAJOR`, `latest`, and `sha-<short-sha>` tags. Prefer the full three-part version when document output must remain repeatable.

## Uninstall

Direct Docker installation:

```bash
docker stop typr-server
docker rm typr-server
```

Compose installation:

```bash
docker compose down
```

There is no Companion cache volume to remove and uninstalling the container does not remove browser-local Typr projects.

## Security

- Keep `127.0.0.1:8484:8484`; do not publish port 8484 on `0.0.0.0` or a LAN/public interface.
- The container runs as a non-root user, has an origin allowlist, and is compatible with `no-new-privileges`.
- It has no authentication and is intended for trusted, local documents.
- Docker isolation is not a hostile-code sandbox. Native TeX processes user-authored input and the service must not be exposed directly to the internet.
- No extra Linux capabilities or privileged mode are required.

## Platform notes

- **Linux:** use Docker Engine. Native amd64 is the primary current development/runtime environment.
- **Windows:** use Docker Desktop with the WSL2 backend. The image is Linux-based; no native Windows TeX setup is needed.
- **macOS:** use Docker Desktop. Apple Silicon selects the arm64 image; Intel Macs select amd64.
- **Unraid:** use the provided [Typr Companion Unraid template](./companion-unraid.md). No volume is needed. Because the browser and NAS are separate devices, use a trusted HTTPS reverse proxy restricted to your LAN/VPN and configure that URL in Typr. The service is unauthenticated and must not be exposed publicly.

The GitHub workflow is configured to build and run the complete backend Docker suite natively on GitHub-hosted amd64 and arm64 runners. A successful run provides explicit CI evidence; it is not a claim of manual verification on every Docker Desktop, Linux distribution, or Unraid release.

## Local development image

Contributors do not need GHCR:

```bash
docker build \
  -f docker/typr-server.Dockerfile \
  --target runtime \
  -t typr-server:dev \
  .

docker run --rm \
  -p 127.0.0.1:8484:8484 \
  typr-server:dev
```

## Reproducibility boundary

The Node base image is explicitly versioned (`22.23.2-bookworm-slim`), TeXpresso is built from the pinned source commit recorded in the image label, and the runtime `ws` package is exact-versioned with an integrity-bearing lockfile. Debian Bookworm package versions are resolved by `apt` at build time and the base image is not digest-pinned, so rebuilding the same Git revision later is not promised to be byte-for-byte identical. Published release tags and their OCI digest are the durable rollback boundary.
