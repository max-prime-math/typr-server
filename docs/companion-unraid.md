---
title: Install Typr Companion on Unraid
---

# Install Typr Companion on Unraid

Typr Companion can run on an Unraid server from the official GHCR image. It stores no projects and needs no appdata volume.

There is one important network difference from desktop Docker: the Typr PWA runs in your browser, so `127.0.0.1` means the browser device, not the Unraid server. Because Typr is served over HTTPS, browsers also block a plain HTTP Companion on a LAN address as mixed content. A remote Unraid installation therefore needs an HTTPS reverse proxy with a trusted certificate.

## Install the template

Until the template is listed in Community Applications, install it as a user template:

1. Open an Unraid terminal.
2. Download [`unraid/typr-companion.xml`](../unraid/typr-companion.xml) to the user-template directory:

   ```bash
   curl -fsSL \
     https://raw.githubusercontent.com/max-prime-math/typr/main/unraid/typr-companion.xml \
     -o /boot/config/plugins/dockerMan/templates-user/typr-companion.xml
   ```

3. Open **Docker → Add Container**.
4. Select **Typr-Companion** from the template list.
5. Keep bridge networking, container port `8484`, and the default allowed origins.
6. Apply the template and wait for the image to download.

The template uses `ghcr.io/max-prime-math/typr-server:latest`, runs without privileged mode or persistent volumes, enables `no-new-privileges`, and restarts unless stopped.

## Verify the container

From Unraid, request the status endpoint:

```bash
curl -fsS http://127.0.0.1:8484/api/v1/status
```

The response should report protocol version `1` and advertise `pdflatex`. The template's WebUI link opens this same status response.

## Add HTTPS

Create a dedicated hostname such as `typr-companion.example.com` in your existing reverse proxy. Forward it to `http://UNRAID-IP:8484`, issue a publicly trusted or locally trusted certificate, and enable WebSocket upgrades. A representative Nginx location is:

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

Do not send this hostname through a public tunnel or expose it to the internet. The Companion has an origin allowlist, but it does not have user authentication and native TeX compilation is not a hostile-input sandbox. Limit access at the reverse proxy and firewall to trusted LAN/VPN clients.

## Connect Typr

1. Open Typr in the browser that will use the Companion.
2. Open **Settings → Editor → Typr Companion**.
3. Enter the HTTPS URL, for example `https://typr-companion.example.com`.
4. Select **Apply**.

Chrome or Edge may ask whether Typr can access devices on the local network; allow it for this connection. The Companion answers private-network preflights only for origins in its CORS allowlist. Other browsers may expose an equivalent site permission.

The connection status should change to **Connected**. The URL is saved only in that browser. Use **Reset** to return to desktop Docker at `http://127.0.0.1:8484`.

If the status remains unavailable, check the browser developer console, the reverse-proxy WebSocket settings, `docker logs Typr-Companion`, and the `TYPR_COMPANION_ALLOWED_ORIGINS` value in the Unraid template.

## Update or remove

Use Unraid's normal container update action to pull a newer `latest` image. To pin a reproducible release, edit the Repository field to a complete version such as:

```text
ghcr.io/max-prime-math/typr-server:0.1.1
```

Removing the container removes the entire Companion installation. There is no appdata directory or project volume to delete.
