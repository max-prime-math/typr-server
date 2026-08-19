---
title: Manage Typr Companion
---

# Typr Companion management console

Companion uses two independent HTTP listeners:

- `127.0.0.1:8484` is the document service API used by Typr.
- `127.0.0.1:8485` is the local management GUI and management API.

Change the ports with `TYPR_COMPANION_PORT` and
`TYPR_COMPANION_MANAGEMENT_PORT`. They must be different. The management host is
fixed to IPv4 loopback; it is not affected by `TYPR_COMPANION_HOST` and is not a
LAN administration surface.

## Services and providers

The dashboard distinguishes services that Companion actually advertises from
providers merely detected on the host. It currently shows:

- the Companion protocol API;
- native LaTeX compilation and whether `latexmk` or direct `pdflatex` is used;
- live preview and its active session count;
- configured workspace storage;
- detected TexLab and Tinymist executables; and
- the management console itself.

TexLab and Tinymist detection is informational in this milestone. Companion
does not advertise LSP languages until an LSP routing transport is implemented.
**Refresh providers** reruns bounded `--version` probes without executing a
shell. The console does not yet install distributions, download packages, edit
executable paths, or start LSP processes.

## Users and API keys

Management users are Companion service principals, not Windows or Linux login
accounts. A user may own multiple independently revocable keys. The complete
key is returned once when it is created. Companion stores its SHA-256 hash,
short display prefix, label, owner, creation time, and rate-limited last-used
time; it never stores the raw secret.

API authentication is initially disabled. The safe setup sequence is:

1. Create a user.
2. Create and copy an API key for that user.
3. Configure the Typr client to send the key.
4. Enable **Require API keys**.

When enforcement is enabled, every service HTTP route requires:

```text
Authorization: Bearer typr_<secret>
```

An authenticated browser live-preview WebSocket requests both of these
subprotocol values:

```text
typr-companion-v1
typr-api-key.<base64url-encoded-complete-api-key>
```

Disabling a user disables all their keys immediately. Revocation is permanent.
The management GUI remains available so the local OS user can recover from a
lost or revoked last key.

On portable Windows, state persists with current-user permissions at:

```text
%LOCALAPPDATA%\Typr Companion\management.json
```

Native non-Windows development runs keep management state in memory unless
`TYPR_COMPANION_MANAGEMENT_STATE` names a writable JSON file. Container users
should not expose the management port; the current production container remains
stateless and publishes only the service port.

## Live activity and logs

The process keeps the newest 1,000 structured activity events in memory and
streams new events to the GUI with server-sent events. Service cards and tabs
separate API, compilation, workspace, live-preview, management, and provider
activity. Events include request status and duration, authenticated user ID when
available, active-session transitions, access-control changes, and up to 128 KiB
of compiler log detail. Request bodies and API-key values are never logged, but
native compiler logs can quote document paths or source lines and should be
treated as document data.

Activity history is deliberately process-local: it clears on restart and does
not create an unbounded log database. The GUI reconnects automatically if the
event stream is interrupted.

## Local security boundary

The management server validates loopback Host headers, sends no CORS permission,
requires `X-Typr-Management: 1` for every mutation, denies framing, and applies a
restrictive content-security policy. These controls prevent an ordinary remote
web page from managing Companion through the browser. They do not defend against
malware already running as the same OS user.

API keys authenticate service callers; they do not make native TeX, MuPDF, or
language-server processes safe for hostile multi-tenant use. Keep both ports off
the public Internet and continue to use trusted documents, a trusted LAN/VPN,
and the existing process/filesystem sandbox controls.
