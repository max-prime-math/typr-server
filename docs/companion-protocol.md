---
title: Typr Companion Protocol
---

The Typr Companion protocol is the small, versioned HTTP contract that will let the Typr PWA communicate with `typr-server`. It is defined in [`src/companion-protocol`](../src/companion-protocol/index.ts) and is intentionally transport-neutral TypeScript: it contains no browser, Node, BusyTeX, or Docker code.

The standalone local `typr-server` implementation is in [`typr-server`](../typr-server). Typr's LaTeX compile flow can use it as an optional native provider while retaining browser-based BusyTeX as its fallback.

## Current v1 contract

- `GET /api/v1/status` returns `protocolVersion`, `serverVersion`, and capability groups for compilation, filesystem/project storage, LSP languages, Git, and terminal support. Compilation advertises supported engine names; an empty list means it is unavailable.
- `POST /api/v1/compile` accepts a `CompileRequest`: protocol version, selected engine, root document path, and all project files. Text and base64-encoded binary files are materialized into the temporary native-TeX project directory.
- Compile responses are a discriminated `CompileResult`: `{ ok: true }` includes a base64 PDF, log, engine, and duration; `{ ok: false }` includes the engine, compiler log, a small list of useful errors, and duration when available.
- When an administrator explicitly maps one fixed workspace, `GET /api/v1/workspace/files` lists regular files and `GET`, `PUT`, and `DELETE /api/v1/workspace/file?path=...` read or conditionally mutate one file. Binary content uses base64; writes require `X-Typr-Workspace-Mutation: 1` plus `If-None-Match: *` for creation or an exact strong `If-Match` ETag for update/deletion.

Workspace storage is disabled when `TYPR_COMPANION_WORKSPACE_ROOT` is unset. When enabled, status advertises `projectStorage: true`, workspace API version 1, an opaque `workspaceId`, writability, and enforced limits. Paths are relative POSIX paths; absolute paths, traversal, `.git`, symlinks, special files, and internal temporary names are rejected. Writes use same-directory atomic replacement. The API intentionally has no arbitrary directory selection, command execution, Git access, recursive deletion, move, watch, or public-network security model.

## Versioning and negotiation

`TYPR_COMPANION_PROTOCOL_VERSION` is `1`. It is a protocol compatibility version, not a Typr app or server release version. A client first reads the status response and only uses a matching supported protocol contract. Future servers can retain `/api/v1` while adding a newer versioned route, allowing older Typr releases to continue using the v1 contract during upgrades.

Types do not validate JSON received over HTTP. Typr has no established runtime schema library, so this first step deliberately adds no dependency. The future HTTP client and server must validate the status, request, and result payloads at their boundary before using them.

## Local `typr-server`

`typr-server` is deliberately a small Node HTTP server rather than a second web framework. It requires Node 22.6 or later (for Node's built-in TypeScript type stripping) and a host TeX installation that provides `pdflatex`. It prefers `latexmk` when available, using this command without a shell:

```text
latexmk -norc -pdf -no-shell-escape -interaction=nonstopmode -halt-on-error -file-line-error main.tex
```

When `latexmk` is absent, it invokes `pdflatex` directly, up to three times, with `-no-shell-escape -interaction=nonstopmode -halt-on-error -file-line-error`. Native work is limited to two concurrent conventional compiles, a 30-second whole-request deadline, 1 MiB combined process output/log capture, a 32 MiB PDF, 512 input files, and 25 MiB decoded project input. The production image launches native TeX and TeXpresso through a fail-closed Landlock filesystem policy with a scrubbed environment and process/file limits. Compiler children can read their ephemeral project and required system toolchain but cannot read the application tree, mapped workspace, or unrelated temporary data.

Start it from the repository root:

```bash
npm run companion
```

It listens on `http://127.0.0.1:8484` by default. Set `TYPR_COMPANION_PORT` to select a different port and `TYPR_COMPANION_HOST` only when a different local bind address is required. The default status response on a machine with `pdflatex` is:

```json
{
  "protocolVersion": 1,
  "serverVersion": "0.1.2-dev",
  "capabilities": {
    "compile": { "engines": ["pdflatex"] },
    "filesystem": { "projectStorage": false },
    "lsp": { "languages": [] },
    "git": { "enabled": false },
    "terminal": { "enabled": false }
  }
}
```

If `pdflatex` is missing, `compile.engines` is `[]`, and a valid `pdflatex` compile request receives a typed `native-compiler-unavailable` failure rather than terminating the server.

By default, CORS allows the official Stable, Beta, and Development Typr origins plus Vite's `localhost`, `127.0.0.1`, and IPv6 loopback origins on port 5173. A deployment using another origin can set the comma-separated `TYPR_COMPANION_ALLOWED_ORIGINS` environment variable. The override replaces the default allowlist. No wildcard CORS, authentication, or remote-server security model is provided.

**Security warning:** this server has no authentication and must never be exposed to the public internet. Self-hosted use is limited to a trusted LAN or private VPN, with exact allowed origins and network controls. Treat every document and workspace user as trusted; native parsers still are not a complete hostile-document security boundary.

## Official Docker Companion runtime

The supported reproducible deployment/runtime for the Companion is the Docker image defined by [`docker/typr-server.Dockerfile`](../docker/typr-server.Dockerfile). It packages the existing `typr-server`; it does not serve the Typr PWA, change the HTTP protocol, or alter Typr's BusyTeX fallback.

### Build and run

Normal users run the published multi-platform image. Installation, updates, version pinning, rollback, uninstall, security, and platform notes are in [Install Typr Companion](./companion-installation.md). The shortest installation is:

```bash
docker run -d --name typr-server --restart unless-stopped \
  --security-opt no-new-privileges:true \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m \
  --pids-limit 256 --memory 2g --cpus 2 \
  -p 127.0.0.1:8484:8484 \
  ghcr.io/max-prime-math/typr-server:latest
```

The server listens on `0.0.0.0:8484` **inside** its container so Docker port publishing can reach it. The `127.0.0.1:8484:8484` mapping keeps the unauthenticated service reachable only from the host. Do not replace `127.0.0.1` with a public interface unless a future security model explicitly supports that use case.

[`compose.yaml`](../compose.yaml) is the equivalent production setup:

```bash
docker compose up -d
```

It pulls the published image and exposes only `127.0.0.1:8484`. [`compose.dev.yaml`](../compose.dev.yaml) retains the build-based contributor workflow. Compilation remains stateless: every compile request and TeXpresso session gets a temporary project directory that is removed after use. An administrator may separately map one project workspace to `/workspace`; it remains disabled by default and is exposed only through the scoped file API above.

Verify the running service with its normal status endpoint:

```bash
curl -sS http://127.0.0.1:8484/api/v1/status
```

The image's Docker health check calls that same endpoint every 30 seconds (after a short startup period). It verifies HTTP responsiveness; it intentionally does not add a Docker-specific API or run a TeX compile each time.

Typr reaches the Dockerized Companion exactly as it reaches the directly-run server: its default URL is already `http://127.0.0.1:8484`. Start Typr normally and it will detect the container through its existing status lifecycle. A user can change the URL at runtime under **Settings → Editor → Typr Companion**; the value is stored in that browser. `VITE_TYPR_COMPANION_URL` changes the build's default URL for a custom deployment.

### Environment and process behavior

The image sets these generic server settings:

| Variable | Image default | Purpose |
| --- | --- | --- |
| `TYPR_COMPANION_VERSION` | injected by the image build | Packaged server version reported by `/api/v1/status`; independent of protocol version. |
| `TYPR_COMPANION_HOST` | `0.0.0.0` | Container listen interface. Native development retains its `127.0.0.1` default. |
| `TYPR_COMPANION_PORT` | `8484` | Companion TCP port. |
| `TYPR_COMPANION_ALLOWED_ORIGINS` | official Typr and local Vite origins | Optional comma-separated exact-origin override, shared with the native server. |
| `TYPR_COMPANION_WORKSPACE_ROOT` | unset | Enables the scoped workspace API for one absolute directory, normally `/workspace`. |
| `TYPR_COMPANION_WORKSPACE_ID` | `default` | Opaque stable identity used by browser bindings; it is not a host path. |
| `TYPR_COMPANION_SANDBOX_EXECUTABLE` | `/usr/local/bin/typr-native-sandbox` | Fail-closed native compiler launcher. A mapped workspace is refused if this is unavailable. |

Node is the container's main process; no shell wrapper is used. It handles normal `SIGTERM`/`SIGINT` shutdown by stopping new HTTP work and terminating active LaTeX compiler process groups before the listener closes. The image runs as the non-root `node` user. `/tmp` remains writable for request-local compiler directories.

### TeX environment and portability

The image uses the multi-architecture `node:22.23.2-bookworm-slim` base, matching the Node 22.6+ requirement for the server's built-in TypeScript type stripping. It installs Debian Bookworm's TeX Live packages:

- `latexmk`
- `texlive-latex-base`, `texlive-latex-recommended`, and `texlive-latex-extra`
- `texlive-fonts-recommended` and `texlive-pictures`
- `texlive-bibtex-extra` and `biber`
- `texlive-xetex` (required by the experimental TeXpresso build)

This supplies the advertised `pdflatex` engine and the common document classes, packages, fonts, graphics/TikZ, and bibliography workflows expected by ordinary LaTeX documents. It intentionally does **not** install the complete TeX Live collection or unrelated future tools such as Typst, LSP servers, or Git tooling. `latexmk` is present, so the existing compiler invocation works without modification.

The Dockerfile has a small TeXpresso build stage and a separate runtime stage. The build stage contains the C/C++ compiler and development headers needed by TeXpresso; the final runtime receives `texpresso`, `texpresso-xetex`, their shared runtime libraries, Node, the existing TeX toolchain, and the small `ws` transport dependency. `typr-server` still has no emitted JavaScript artifact: Node runs its small TypeScript source with the same type-stripping mode used by `npm run companion`. The explicit [`.dockerignore`](../.dockerignore) sends only those runtime files to Docker.

The selected Node base image and Debian packages have `linux/amd64` and `linux/arm64` builds, and TeXpresso is compiled from pinned source inside each target architecture rather than copied as an architecture-specific binary. The Docker workflow runs the REST, persistent TeXpresso, raster, and WebSocket suites natively on GitHub's amd64 and arm64 runners before publishing `ghcr.io/max-prime-math/typr-server`. Historical local amd64 measurements were approximately 396 MiB compressed; release manifests should be inspected for current per-architecture sizes rather than treating that number as fixed.

### Toolchain boundary and security

Node, TeX Live, `latexmk`, and their system dependencies are Companion **container toolchain** components: they are versioned by the Dockerfile and supplied by the image. Future document-specific package caches, fonts, and persistent caches are separate project-dependency concerns. No package-management or persistence API is provided here, so adding such a capability later does not need to depend on a host package manager such as apt, Homebrew, winget, or pacman.

The Companion executes user-authored LaTeX with native tools. Non-root execution, request-local directories, fixed arguments, disabled shell escape/latexmk rc files, bounded work, and Landlock materially confine compiler descendants. They do not make native TeX, MuPDF, or TeXpresso safe for mutually untrusted users. Operate only on a trusted LAN/VPN, never expose the port to the public internet, and add container-level read-only root, bounded tmpfs, PID, memory, and CPU limits. Authentication and package-installation APIs are deliberately not implemented. The private experimental WebSocket does not change this security model.

Future images may add optional capabilities such as Typst, LSP servers, or Git tooling. TeXpresso is present only as the internal experiment documented below; it is not part of the public Companion protocol or capability advertisement.

### Docker-specific verification

The normal frontend test suite does not require Docker. A focused Docker integration command builds a clean image, starts it on a dynamically selected loopback port, verifies `/status`, then checks simple, multi-file, binary-image, and broken-LaTeX requests as well as traversal rejection:

```bash
npm run test:companion:docker
```

## Experimental TeXpresso POC

TeXpresso is included only to evaluate a fast, persistent editing loop. It does **not** change `/api/v1/compile`, the advertised `pdflatex` capability, Typr's frontend behavior, or BusyTeX. The existing `latexmk` path remains the authoritative compatibility/final-build compiler.

The image builds the upstream [TeXpresso](https://github.com/let-def/texpresso) source at commit [`e8df7709077b2f86f6e16e6c86ceefb86de06f8d`](https://github.com/let-def/texpresso/commit/e8df7709077b2f86f6e16e6c86ceefb86de06f8d). Its build stage installs the documented Debian build dependencies (GCC/Make, SDL2, MuPDF, font/text libraries, and headers) and runs `make all`. The final image keeps the resulting `texpresso` frontend and its custom `texpresso-xetex` engine plus the required shared libraries. It deliberately selects TeX Live with TeXpresso's `-texlive` flag; Tectonic is not installed or used.

TeXpresso is a native Linux process that uses a custom incremental XeTeX engine, MuPDF, SDL, and process forking. The POC sets `SDL_VIDEODRIVER=dummy` so the native renderer can run headlessly in Docker. It is therefore suitable for this local Linux container experiment, not a browser compiler or a Windows-native executable.

### Run the POC

Build and run the Docker-only harness:

```bash
npm run test:texpresso:poc
```

Or, after building `typr-server:dev`, run the harness directly in the image:

```bash
docker run --rm --entrypoint node typr-server:dev \
  --experimental-strip-types typr-server/texpresso-poc.ts
```

The harness uses the repository fixtures under [`typr-server/fixtures/texpresso`](../typr-server/fixtures/texpresso): a simple two-file project and a realistic multi-file project with equations, cross references, `booktabs`, `hyperref`, and TikZ. For each fixture it:

1. measures a clean and warm conventional `latexmk` compile;
2. launches TeXpresso once using `-json -lines -texlive -stream`;
3. pre-registers and opens all project files in TeXpresso's virtual filesystem, then sends `resume`;
4. changes an included file three times using TeXpresso's native `change-range` command;
5. changes `main.tex` without restarting TeXpresso;
6. introduces an undefined command, observes the diagnostic, fixes it, and confirms recovery in the same PID; and
7. verifies that the changed editor buffer never overwrote the saved source file.

`change-range` uses TeXpresso's LSP-style UTF-16 line/column positions. The adapter deliberately bounds captured logs and stderr, treats the upstream `flush` event as the point at which a current log/output snapshot can be inspected, and terminates the child process group during normal close. It also handles an unexpected child exit by rejecting pending waits. The POC CLI closes active sessions on `SIGINT`/`SIGTERM`; no HTTP session API is exposed.

### Results and preview-output finding

On the current local `linux/amd64` Docker run, measured values were:

| Fixture | `latexmk` cold | `latexmk` warm median | TeXpresso initial | TeXpresso incremental edits | TeXpresso median | Warm-path speedup |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| simple | 238 ms | 148 ms | 2,220 ms | 36, 9, 24 ms | 24 ms | 6.1× |
| realistic | 631 ms | 326 ms | 244 ms | 24, 19, 20 ms | 20 ms | 16.5× |

The first TeXpresso session paid a format/cache initialization cost; the next session was warm. Timings are intentionally printed by every POC run rather than treated as a portability guarantee. In both fixtures the same TeXpresso PID survived all source edits, the invalid LaTeX change yielded an `Undefined control sequence` diagnostic, and the repaired source recovered successfully without a restart.

The important preview result is negative for immediate frontend integration: TeXpresso's documented editor stdout protocol provides virtual-file events and truncatable output/log events (`append-lines`, `truncate-lines`, and `flush`). Its current rendering path is an internal MuPDF display list presented through SDL. In this POC no PDF, image, or display-list payload was emitted on stdout, and the TeXpresso-only session left no PDF in the project directory.

Therefore a Typr browser live-preview transport would need a new server-side rendering export that supplies each changed page as a transportable raster image (or a browser-compatible vector/display-list representation). The current upstream editor protocol exposes neither, so it cannot simply be connected to Typr's existing PDF viewer or sent through a future WebSocket unchanged. This is why TeXpresso remains experimental and internal.

The POC does not impose a hostile-document sandbox or hard per-session resource limit. It does ensure explicit cleanup, bounded captured output, timeouted waits, and non-root execution. Future work should add session ownership/lifetime limits, stronger CPU/memory/process isolation, and a deliberate page-render transport before exposing it beyond trusted local use.

## Experimental TeXpresso page-render export POC

The next internal-only experiment proves the missing render boundary without changing any Companion HTTP endpoint, capability, or frontend component:

```bash
npm run test:texpresso:render
```

The pinned TeXpresso implementation keeps incremental document state in its TeX engine's `incdvi` representation. `engine_tex.c` turns each page into an `fz_display_list`; `renderer.c` already rasterizes that list with `fz_new_draw_device` and uploads the resulting BGR pixels to an SDL texture. The page count comes from `incdvi_page_count`, and page dimensions are available to the engine while building the display list. This POC reuses the same display-list boundary and renders it to an RGB MuPDF pixmap, then encodes it with MuPDF's native PNG writer. SDL is not involved in the exported pixels.

The upstream editor protocol has no PDF/image/display-list export, no page dimensions/page-count message, and no changed-page notification. It also discovers pages lazily as the native viewer reaches them. The narrow maintained patch, [`docker/patches/texpresso-page-export.patch`](../docker/patches/texpresso-page-export.patch), adds two internal JSON commands (`page-count` and `render-page`) plus `page-image`/`page-image-error` responses. A request for a not-yet-discovered page drives TeXpresso's existing viewer state to that page; a request past EOF reports an error. The patch changes 211 added lines across `src/frontend/editor.[ch]` and `src/frontend/main.c`, with no engine, DVI, SDL, or Docker-source fork. It is plausibly upstreamable as an optional headless/editor-protocol export, although it would need upstream API design review. Updating TeXpresso requires `git apply` to continue applying cleanly and revalidating the protocol response and MuPDF API.

PDF extraction/regeneration is not a low-cost alternative: the incremental TeX path generates DVI/display lists and does not retain or emit a complete PDF. A browser display-list protocol would require serializing MuPDF internals or inventing a graphics protocol. PNG is therefore the smallest browser-native export. The pinned MuPDF build exposes PNG encoding directly; it does not expose a comparably simple WebP writer, so this POC deliberately adds no image-processing dependency. Future transport can negotiate WebP/AVIF only after it has a measured reason to do so.

`TexpressoSession` now has an internal page abstraction (`page`, pixel dimensions, DPI, MIME type, and `Uint8Array` PNG data), bounded to 16 MiB per image. It caches a raster only for the same unedited revision. On every successful edit it conservatively invalidates all cached pages: TeXpresso provides neither an exact changed-page set nor a safe affected-page range. This is required for layout shifts and cross references. Future messages must include page number, width, height, total page count, and a revision so the browser can replace individual pages and decide whether its scroll anchor remains valid; page order remains zero-based and source order in this POC.

### Measured amd64 result

The focused Docker run uses an explicit three-page fixture, five ordinary first-page edits, a layout shift, a cross-reference edit, invalid TeX/recovery, repeated rendering, and clean session shutdown. On the current local `linux/amd64` Docker run:

| Measurement | Result |
| --- | ---: |
| initial TeXpresso state / full three-page discovery | 2,300 ms / 2,352 ms |
| page at 120 DPI | 1,020 × 1,320 px; 16–29 KB; 17–18 ms |
| page at 144 DPI | 1,224 × 1,584 px; 20–35 KB; 24–25 ms |
| ordinary edit: TeXpresso update median | 7 ms |
| ordinary edit: PNG raster/export median | 26 ms |
| ordinary edit to browser-ready PNG median | **33 ms** |
| layout shift: 3 → 5 pages, all-page export | 15 ms update + 152 ms raster |
| cross-reference edit, all-page export | 45 ms update + 150 ms raster |
| initial three-page 144-DPI payload | 76 KB (25 KB average; 35 KB largest) |
| session RSS, initial / after edits and renders | 26 MB / 32 MB |

That POC originally used 144 DPI. The private transport milestone below changes the preferred default to 192 DPI and measures 144, 192, and 240 DPI directly. The harness reports end-to-end process-to-PNG latency; MuPDF's PNG writer is part of that raster/export number, rather than a separate measurable stage. It writes temporary sample PNGs during the run and removes them unless `TYPR_TEXPRESSO_RENDER_OUTPUT` is explicitly set.

For rough one-way transfer estimates, the 25 KB average 144-DPI page costs about 0.2 ms at 1 Gbps LAN, 2 ms at 100 Mbps, and 10 ms at 20 Mbps; the initial 76 KB document costs about 0.6 ms, 6 ms, and 30 ms respectively, before protocol overhead. Raster preview is consequently practical on localhost and a typical LAN for single-page updates. A full five-page invalidation is materially slower and reinforces the value of future page-dirty information.

After an invalid edit, TeXpresso reported diagnostics; the session's retained cached page remains available as the last successful preview. A fresh render from TeXpresso's current error state completed but differed from that retained image, so a future frontend should keep serving the last-good revision while presenting diagnostics rather than replace pages during errors. The same process recovered after the error was fixed.

This run was amd64 only. The Dockerfile remains architecture-neutral because it builds pinned C/C++ source in the target image; Debian/Node/TeX Live packages are available for arm64, but timing, MuPDF output, and memory need a separate arm64 run. The export patch changes source code only and did not add runtime packages; image size should therefore remain effectively at the prior approximately 395 MiB measurement (the current image reports 395 MiB decimal).

**Recommendation: proceed with raster live preview.** The normal edit path retains TeXpresso's advantage by a wide margin (33 ms median edit-to-browser-ready PNG, below the 100 ms target), uses a narrow isolated adaptation, and has modest page payloads. The next milestone should design a private binary transport/revision contract and page-replacement semantics, not a public endpoint or frontend integration yet.

## Private experimental TeXpresso WebSocket

The next milestone implements that transport at:

```text
ws://127.0.0.1:8484/ws/texpresso
```

This route and the browser-neutral private types in [`src/companion-protocol/texpresso.ts`](../src/companion-protocol/texpresso.ts) are **private and experimental**. They are not advertised by `/api/v1/status`, are not part of Companion protocol v1, and may change incompatibly. `POST /api/v1/compile` still runs `latexmk`/pdfLaTeX and returns the authoritative PDF. Typr can use the WebSocket only when the user explicitly selects the experimental live-preview mode; the existing PDF preview remains separate.

The implementation uses [`ws`](https://github.com/websockets/ws), a small, focused Node WebSocket library with no required transitive runtime dependencies. It attaches in `noServer` mode to the existing Node HTTP listener, so no framework was introduced. Per-message compression is disabled because PNG is already compressed. The Docker image installs only `ws`; compared with the same local pre-transport image, compressed image size increased from 414,625,417 to 415,191,961 bytes (566,544 bytes, about 0.54 MiB). Its uncompressed Docker layer is 2.86 MB.

### Lifecycle and initialization

One WebSocket owns one session and one persistent TeXpresso process:

```text
open → initialize → session-ready → initial document/pages → changes → shutdown/close
```

There is no reconnect persistence, shared session, or authentication. Initialization supplies the complete source state, an initial revision, and session render DPI:

```json
{
  "type": "initialize",
  "protocolVersion": 1,
  "revision": 1,
  "mainFilePath": "main.tex",
  "render": { "dpi": 192 },
  "files": [
    { "path": "main.tex", "kind": "text", "content": "..." },
    { "path": "sections/one.tex", "kind": "text", "content": "..." },
    { "path": "assets/plot.png", "kind": "binary", "encoding": "base64", "content": "..." }
  ]
}
```

Text files are opened in TeXpresso's VFS. Binary assets are decoded into the session's private temporary project directory because the upstream VFS command accepts text buffers, not arbitrary bytes. The directory is container-local, exists only for that connection, and is recursively removed at teardown; clients do not need a persistent host project.

After TeXpresso reaches its initial flush, the server sends `session-ready` with `sessionId`, revision, negotiated DPI, private native `processId` (currently useful to the test harness), and initial compile time. A valid initial state is followed by a `document`, all page pairs, and `revision-complete`. An invalid initial state instead receives `compile-error` with `lastGoodRevision: null`.

### Revisions and edits

Every initialization and change revision is a positive safe integer. A new revision must be strictly greater than the latest accepted revision. Duplicates and lower revisions receive non-fatal `protocol-error`/`stale-revision`; gaps such as 10 → 15 are allowed. The client is responsible for constructing a skipped revision as an incremental change from the last accepted source state, not from an unsubmitted state.

Changes use zero-based LSP-compatible UTF-16 positions and TeXpresso's native `change-range` command:

```json
{
  "type": "change",
  "revision": 42,
  "path": "sections/one.tex",
  "range": {
    "start": { "line": 8, "character": 4 },
    "end": { "line": 8, "character": 12 }
  },
  "text": "replacement"
}
```

Only files opened as text during initialization can be changed. A range that cannot be applied is fatal because continuing would make the client and server source states diverge; the client must reconnect with a complete current source state. The same TeXpresso PID remains alive across valid, invalid, recovered, pagination-changing, and cross-reference revisions.

`revision-started` and `revision-applied` expose queue depth, update time, and whether raster work is pending, coalesced, or intentionally omitted for a compile error. `revision-complete` is the only commit point for a new preview state:

```json
{
  "type": "revision-complete",
  "sessionId": "...",
  "revision": 42,
  "lastGoodRevision": 42,
  "pageCount": 3,
  "renderedPages": 3,
  "timings": { "updateMs": 8.1, "renderMs": 139.0, "serverMs": 148.0 }
}
```

A frontend must track its latest submitted revision and never activate page output from an older revision merely because it arrives later. Message ordering is not the stale-output defense; revision identity and the `revision-complete` commit point are.

### Page metadata and binary framing

Before page bytes, the server sends one JSON metadata frame:

```json
{
  "type": "page",
  "sessionId": "...",
  "revision": 42,
  "page": 0,
  "width": 1632,
  "height": 2112,
  "dpi": 192,
  "mimeType": "image/png",
  "byteLength": 48778
}
```

The immediately following WebSocket frame is binary and contains exactly that PNG. A single serialized outbound queue makes the pair adjacent: no control frame or another page can interleave them. The client must reject a binary frame without pending metadata and verify `byteLength`. Page numbers are zero-based. The preceding `document` message contains the revision, `pageCount`, and the ordered descriptor for every page, allowing a client to add pages, remove obsolete pages, and establish dimensions before committing the revision.

Pages are independent replaceable units, and every page descriptor carries its DPI. This leaves room for a future per-page or changed-resolution request without changing page replacement semantics. This version sets one DPI at initialization and has no mid-session quality-change message.

### Errors, last-good output, and coalescing

TeXpresso output and log buffers are classified after every flush. On invalid LaTeX the server sends bounded diagnostics and does not rasterize or publish the broken state:

```json
{
  "type": "compile-error",
  "sessionId": "...",
  "revision": 43,
  "lastGoodRevision": 42,
  "diagnostics": [{ "severity": "error", "message": "Undefined control sequence." }],
  "log": "...",
  "updateMs": 7.4
}
```

The client continues displaying revision 42. When revision 44 repairs the source, it receives normal pages and `lastGoodRevision` advances to 44. Captured TeXpresso logs are bounded in the process adapter, and an individual transmitted diagnostic log is truncated to its most recent 32 KiB.

Changes are always dequeued and applied in order, so coalescing never loses source edits. If newer changes are waiting before rasterization, the applied intermediate revision is marked `coalesced` and is not rendered. If a change arrives during rasterization, the current render stops between pages and is never sent as a complete document. Work already inside TeXpresso/MuPDF cannot be cancelled. The queue is bounded; exceeding it closes the session and requires reinitialization with complete current source.

TeXpresso still provides no dirty-page set. For correctness, every successful revision that reaches the publish stage invalidates the raster cache and renders every page. No source-file-to-page guess is made: included files, layout changes, floats, and cross-references can affect later or earlier pages. Transport pages are already independently replaceable, so a future reliable dirty-page signal can reduce this to affected pages without changing framing.

The cross-reference harness changes a `\pageref`, waits for TeXpresso's revision flush, conservatively rerenders the updated page set, and verifies revision/page metadata. This is preview convergence, not an assertion that TeXpresso has replaced `latexmk` multipass behavior; explicit/final compilation remains authoritative.

### Limits, origins, and teardown

Current trusted-local-use bounds are:

| Resource | Limit |
| --- | ---: |
| inbound WebSocket message | 25 MiB |
| decoded project | 25 MiB / 512 files |
| queued revisions | 64 |
| page count | 64 |
| one PNG | 16 MiB |
| one document's PNGs | 128 MiB |
| transmitted diagnostic log | 32 KiB |
| render DPI | 72–300 (default 192) |

Browser WebSocket upgrades reuse `TYPR_COMPANION_ALLOWED_ORIGINS`; a supplied origin outside the allowlist receives HTTP 403. Origin-less clients are permitted for local Node/CLI tooling. Unknown upgrade routes receive 404, client binary frames are fatal, malformed JSON and stale revisions are non-fatal, and an oversized WebSocket message is closed by `ws`. This is still an unauthenticated trusted-local endpoint. Keep Docker bound to loopback:

```bash
docker run --rm -p 127.0.0.1:8484:8484 typr-server:dev
```

Client `shutdown`, socket disconnect/error, unexpected TeXpresso exit, and server `SIGINT`/`SIGTERM` all close the owned TeXpresso process group and delete its temporary project. The Docker harness verifies disconnect cleanup, deliberate native-process termination, and a live session during container shutdown; no TeXpresso process remains orphaned.

### Docker test and measured result

Run the actual loopback-published container and non-UI Node client with:

```bash
npm run test:texpresso:ws
```

The harness tests multi-file text, a nested binary asset, initial transfer, five ordinary edits, a 30 ms rapid-edit burst, stale revision rejection, invalid LaTeX/last-good retention, recovery, 3 → 5 page layout change, cross-reference change, revision jump, malformed JSON, disallowed origin, client binary-frame error, client disconnect, unexpected TeXpresso exit, and container shutdown. It writes manual quality samples and a machine-readable report under `qa-ui-artifacts/texpresso-ws/`.

On the current local `linux/amd64` Docker run, using the same three-page fixture at each resolution:

| DPI | Pixels | avg / largest PNG | initial payload | ordinary payload | update median | all-page render median | WS/server overhead | client total median |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 144 | 1224×1584 | 24.8 / 34.4 KiB | 74.3 KiB | 73.9 KiB | 6.8 ms | 79.5 ms | 0.9 ms | **87.5 ms** |
| 192 | 1632×2112 | 35.0 / 47.6 KiB | 105.0 KiB | 104.9 KiB | 6.7 ms | 130.8 ms | 0.8 ms | **138.7 ms** |
| 240 | 2040×2640 | 47.8 / 63.3 KiB | 143.4 KiB | 143.4 KiB | 6.0 ms | 196.8 ms | 0.8 ms | **203.4 ms** |

The first 144-DPI session paid a 2.30 s TeXpresso cold start; warm 192/240 sessions initialized in about 88–90 ms before page discovery. The transport itself is negligible compared with rasterization. The prior 33 ms number was a single-page render; these WebSocket totals deliberately measure the correctness-preserving full three-page payload. In the 30 ms rapid-edit burst, all 3 revisions were applied, only the final revision was rendered, maximum observed queue depth was 1, and the final full preview settled in 210.6 ms.

**Recommended private default: 192 DPI.** It increases each axis by one third over 144 DPI, producing the visibly denser sample requested for manual comparison, while payload grows about 41% and a three-page localhost refresh remains about 139 ms. It misses the aspirational 100 ms complete-document target, but 240 DPI is clearly too costly as a default and 144 DPI retains the reported pixelation. The next performance step should be trustworthy dirty-page information or an explicit client page-priority request, not an unsafe file-to-page guess.

### Frontend live-preview lifecycle

The frontend protocol client is isolated in [`src/preview/texpressoClient.ts`](../src/preview/texpressoClient.ts); React lifecycle wiring is in [`src/preview/useTexpressoLivePreview.ts`](../src/preview/useTexpressoLivePreview.ts), and raster display is in [`src/preview/TexpressoPreview.tsx`](../src/preview/TexpressoPreview.tsx). The client does not infer WebSocket support from `/api/v1/status`: REST availability only permits an attempt, while the actual upgrade/session result is the live-preview availability signal.

Selecting **Live Preview (Experimental)** for a supported LaTeX project creates one connection and initializes revision 1 with the same complete-project collection semantics used by conventional Companion compilation. The detected root document, every nested project file, generated diagram assets, binary files, and the active unsaved text are included. CodeMirror change transactions are forwarded promptly as zero-based UTF-16 ranges and receive increasing integer revisions. Existing non-active text changes are reconciled as incremental replacements; root, path-set, rename, create/delete, or binary changes conservatively restart and reinitialize because this protocol has no file-operation message.

Page metadata must be immediately followed by an ArrayBuffer PNG with the declared length and PNG signature. The client stages Blob URLs per revision and publishes only a complete, contiguous page set after the matching `revision-complete`. A completion older than the latest submitted revision is discarded. Replaced and stale Blob URLs are revoked after the new revision commits to the DOM; session/project cleanup revokes all remaining URLs.

The raster viewer displays pixel dimensions at `96 / dpi` logical CSS scale. At the private 192-DPI default, a 1632×2112 raster therefore occupies an ordinary US Letter-sized 816×1056 CSS-pixel page while retaining 2× pixel density. Fit-width, fit-height, fit-page, and manual zoom reuse the existing preview controls and are clamped at native raster resolution. Scroll anchoring records the current page and relative offset, then restores the closest page/offset after an atomic revision replacement or page-count change.

`compile-error` updates the compact live error state but leaves the last good page set mounted. A repaired revision clears the diagnostic only when its complete page set becomes visible. On socket loss, the last good URLs remain active, edits continue locally, and the client stops sending. Companion status recovery or the bounded WebSocket retry starts a new session at revision 1 from the complete current project; old pages remain until that new session publishes successfully. Turning live mode off closes the owned session. Explicit Compile is unchanged: compatible Companion builds still use `/api/v1/compile` and `latexmk`, and transport loss still falls back to BusyTeX.

Development builds add Performance Timeline marks for editor event, WebSocket send, `revision-complete`, and DOM commit. They do not print per-edit production logs. Because TeXpresso still lacks a dirty-page signal, each publishable revision rerenders the full document. Partial page identity is retained in the frontend model for a future measured optimization, but this milestone adds no dirty-page inference, adaptive DPI, Typst live transport, or LSP behavior.

The pinned upstream TeXpresso build does not reliably associate later VFS
edits with an include resolved from an extensionless path such as
`\input{chapter}`. The experimental frontend therefore treats that project
shape as unsupported and keeps the PDF preview active; use the explicit
`\input{chapter.tex}` form for live preview. Operational native-session
timeouts are reconnectable: the frontend retains last-good pages and
reinitializes from the complete current project.

### Manual compile fixture

[`examples/companion-server`](../examples/companion-server) contains a tiny `main.tex` plus `chapter.tex` project. With the server running, this sends the same two-file project and receives a typed success with `output.content` containing a base64 PDF:

```bash
curl -sS http://127.0.0.1:8484/api/v1/compile \
  -H 'content-type: application/json' \
  --data '{
    "protocolVersion": 1,
    "engine": "pdflatex",
    "mainFilePath": "main.tex",
    "files": [
      {"path":"main.tex","kind":"text","content":"\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n"},
      {"path":"chapter.tex","kind":"text","content":"Hello from Typr Companion.\n"}
    ]
  }'
```

Check availability first with:

```bash
curl -sS http://127.0.0.1:8484/api/v1/status
```

Each request validates JSON and file discriminators at the HTTP boundary; rejects unsupported protocol versions/engines; rejects absolute, backslash, NUL, duplicate, and parent-traversal project paths; creates an isolated temporary directory; and removes it after compilation. The compiler is spawned using an executable plus argument array, never a client-provided shell command.

## Typr PWA integration (development stage)

Start the server in one terminal:

```bash
npm run companion
```

Then start Typr normally in another:

```bash
npm run dev
```

Typr checks `GET /api/v1/status` at startup and about every 15 seconds. The default Companion URL is `http://127.0.0.1:8484`, matching the server's default bind address. Change it at runtime under **Settings → Editor → Typr Companion**, or set `VITE_TYPR_COMPANION_URL` before building to choose a different default. A compatible server which advertises `pdflatex` is selected automatically for Typr's `pdftex_bibtex8` LaTeX mode. The Editor settings panel shows the current Companion connection state and advertised engines.

Every native compile sends the complete project: all normal project files, the current unsaved editor source, and binary assets such as generated diagram PDFs. A successful base64 PDF is decoded into the same `CompileResult` byte artifact used by the existing Typr PDF preview; no separate preview is introduced. The build log identifies the engine as `companion` and includes the native compiler log.

If the server is absent, protocol-incompatible, lacks the requested engine, or the selected LaTeX driver is not `pdftex_bibtex8`, Typr uses BusyTeX. If a connected server disappears during a compile, Typr marks it unavailable and retries that compile with BusyTeX. A typed LaTeX error from Companion remains a compiler error in Typr's usual error/build-log flow. HTTP and malformed-protocol failures are surfaced as Companion-specific errors without disabling BusyTeX for future compiles.

This remains a trusted self-host integration. Docker packages the native server, optional scoped workspace, and its private experimental TeXpresso WebSocket. It does not add server discovery, authentication, arbitrary remote-server management, LSP, Git, terminal, package-management UI, or a self-hosted Typr PWA.
