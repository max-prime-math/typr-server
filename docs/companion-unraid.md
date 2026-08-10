---
title: Install Typr Companion on Unraid
---

# Install Typr Companion on Unraid

Typr Companion can run on Unraid from the official
`ghcr.io/max-prime-math/typr-server` image. It is stateless by default. One
dedicated host directory can optionally be mapped for explicit manual project
sync; browser-local Typr remains authoritative.

The service has no authentication. Use it only on a trusted LAN or private VPN,
with mutually trusted users and documents. **Never expose it to the public
Internet**, through router port forwarding, a public tunnel, or a public reverse
proxy. TLS improves transport and browser compatibility; it does not add
application authentication.

## Install the template

Until the template is listed in Community Applications, install it as a user
template:

1. Open an Unraid terminal.
2. Download [`unraid/typr-companion.xml`](../unraid/typr-companion.xml):

   ```bash
   curl -fsSL \
     https://raw.githubusercontent.com/max-prime-math/typr-server/main/unraid/typr-companion.xml \
     -o /boot/config/plugins/dockerMan/templates-user/typr-companion.xml
   ```

3. Open **Docker → Add Container** and select **Typr-Companion**.
4. Keep bridge networking and container port `8484`.
5. Add the exact self-hosted Typr origin to **Allowed Typr origins** if needed.
6. Leave **Workspace directory** and **Workspace API root** blank for the
   default stateless deployment. The prefilled Workspace ID is ignored while
   the root is blank.
7. Apply the template and wait for a healthy container.

The template enforces UID 1000, non-privileged operation, dropped capabilities,
no-new-privileges, a read-only root, 512 MiB no-exec tmpfs, 256 PIDs, 2 GiB
memory/swap, and two CPUs. The image probes its Landlock launcher before
listening and fails closed if the Unraid kernel cannot enforce the compiler
filesystem boundary. Actual kernel compatibility remains part of real-host
validation.

## Optional mapped workspace

Configure all three advanced workspace fields together:

- **Workspace directory:** one newly created dedicated directory, mounted RW to
  `/workspace`.
- **Workspace API root:** exactly `/workspace`.
- **Workspace ID:** a stable opaque identifier such as `home-workspace`.

The host directory must be readable and writable by UID 1000. Do not map `/`,
`/mnt`, `/mnt/user`, an entire share, an appdata root, a symlinked directory, or
the Docker socket. Create a narrowly named subdirectory and grant UID 1000 only
the access it needs.

The API exposes regular files below that exact root; it does not expose the host
path or arbitrary browsing. Browser storage remains the primary copy and sync is
manual. Unlinking or removing the container does not delete mapped files, but an
explicit file-API deletion does delete that selected host file. Keep independent
backups.

## Verify the container

From Unraid:

```bash
curl -fsS http://127.0.0.1:8484/api/v1/status
```

The response reports protocol version 1, native compile capabilities, and
`projectStorage: false` unless all mapped-workspace fields are valid. The WebUI
link opens the same status response. Startup failures are visible in the
container log.

## Add trusted HTTPS

In a browser on another device, `127.0.0.1` means that browser device, not the
Unraid server. An HTTPS Typr page also cannot call a plain HTTP/WS Companion
because the browser blocks mixed content. Create a dedicated client-trusted HTTPS
hostname restricted by firewall or VPN to trusted clients. Forward it to
`http://UNRAID-IP:8484`, enable WebSocket upgrades, use a long read timeout, and
allow request bodies of at least 25 MiB. For example:

```nginx
location / {
    proxy_pass http://UNRAID-IP:8484;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    client_max_body_size 25m;
}
```

Keep the hostname unreachable from the public Internet. Plain HTTP on a
non-loopback LAN address is not a secure context and a self-hosted Typr page will
lose service-worker/PWA and filesystem-related features. A self-signed
certificate must be trusted by every client before it is useful.

## Connect Typr

1. Open Typr in the browser that will use Companion.
2. Open **Settings → Editor → Typr Companion**.
3. Enter the browser-reachable HTTPS URL and select **Apply**.
4. If a workspace is configured, open **Settings → Sync** and explicitly link
   the selected project.

The URL is saved only in that browser. Allowed origins contain exact scheme,
host, and port values with no path or trailing slash. CORS is not authentication.
Chrome or Edge may also request Local Network Access permission.

If the status remains unavailable, inspect the browser console, Companion logs,
reverse-proxy WebSocket settings, firewall/VPN rules, certificate trust, and
`TYPR_COMPANION_ALLOWED_ORIGINS`.

## Update, pin, roll back, or remove

Use Unraid's normal container update action for `latest`. For reproducible
native TeX behavior, change Repository to a complete version after it is
published, for example:

```text
ghcr.io/max-prime-math/typr-server:0.1.2
```

Rollback uses the same field with the prior known-good version. Removing the
container removes no browser-local projects and no mapped host directory.

The template remains a direct user template until both public image tags exist,
it passes install/update/rollback/removal and HTTPS/WebSocket tests on a real
Unraid host, a maintained Unraid forum support topic exists, and the maintainer
puts that identical URL in the template's `Support` and profile's `Forum`
fields. Then run `npm run test:unraid -- --submission-ready` and the portal's
Validate and Scan actions before the maintainer explicitly approves Community
Applications submission.
