import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import WebSocket from "ws";
import {
  TYPR_COMPANION_PROTOCOL_VERSION,
  TYPR_COMPANION_ROUTES,
  TYPR_WORKSPACE_MUTATION_HEADER
} from "../src/companion-protocol/index.ts";
import { createTyprServer, hostHasPdflatex, materializeProjectFiles } from "./server.ts";
import { WorkspaceStore } from "./workspaceStore.ts";
import { AccessStore } from "./accessStore.ts";
import { ActivityBus } from "./activity.ts";

const servers: Server[] = [];
const workspaceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(workspaceRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("typr-server Companion API", () => {
  it("returns the current protocol version and only implemented capabilities", async () => {
    const baseUrl = await startServer(createTyprServer({ isPdflatexAvailable: async () => true }));

    const response = await fetch(`${baseUrl}/api/v1/status`, {
      headers: { Origin: "http://localhost:5173" }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    await expect(response.json()).resolves.toEqual({
      protocolVersion: TYPR_COMPANION_PROTOCOL_VERSION,
      serverVersion: "0.1.3-dev",
      capabilities: {
        compile: { engines: ["pdflatex"] },
        filesystem: { projectStorage: false },
        lsp: { languages: [] },
        git: { enabled: false },
        terminal: { enabled: false }
      }
    });
  });

  it.each(["https://typr.ca", "https://beta.typr.ca", "https://dev.typr.ca"])(
    "allows the official Typr origin %s by default",
    async (origin) => {
      const baseUrl = await startServer(createTyprServer({ isPdflatexAvailable: async () => true }));
      const response = await fetch(`${baseUrl}/api/v1/status`, {
        headers: { Origin: origin }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  );

  it("opts an allowed Typr origin into private-network preflights", async () => {
    const baseUrl = await startServer(createTyprServer({ isPdflatexAvailable: async () => true }));
    const response = await fetch(`${baseUrl}/api/v1/status`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://typr.ca",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://typr.ca");
    expect(response.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("keeps CORS preflights route- and method-scoped", async () => {
    const baseUrl = await startServer(createTyprServer({ workspace: await createWorkspace() }));
    const headers = {
      Origin: "https://typr.ca",
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": `content-type, if-none-match, ${TYPR_WORKSPACE_MUTATION_HEADER}`
    };
    const allowed = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFile}?path=file.txt`, {
      method: "OPTIONS",
      headers
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, PUT, DELETE, OPTIONS");

    const wrongRoute = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.status}`, {
      method: "OPTIONS",
      headers
    });
    expect(wrongRoute.status).toBe(405);

    const wrongHeader = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFile}?path=file.txt`, {
      method: "OPTIONS",
      headers: { ...headers, "Access-Control-Request-Headers": "content-type, x-unknown" }
    });
    expect(wrongHeader.status).toBe(400);

    const wrongOrigin = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFile}?path=file.txt`, {
      method: "OPTIONS",
      headers: { ...headers, Origin: "https://attacker.example" }
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it("advertises a configured mapped workspace and its limits", async () => {
    const workspace = await createWorkspace("primary-workspace");
    const baseUrl = await startServer(createTyprServer({
      isPdflatexAvailable: async () => false,
      workspace
    }));

    const response = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.status}`);
    await expect(response.json()).resolves.toMatchObject({
      capabilities: {
        filesystem: {
          projectStorage: true,
          workspaceApiVersion: 1,
          workspaceId: "primary-workspace",
          writable: true,
          limits: {
            maxFileBytes: 16 * 1024 * 1024,
            maxEntries: 4096,
            maxWorkspaceBytes: 256 * 1024 * 1024
          }
        }
      }
    });
  });

  it("supports conditional create, list, read, update, and delete", async () => {
    const workspace = await createWorkspace();
    const baseUrl = await startServer(createTyprServer({ workspace }));
    const fileUrl = `${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFile}?path=chapters%2Fone.txt`;

    const created = await fetch(fileUrl, {
      method: "PUT",
      headers: workspaceHeaders({ "If-None-Match": "*" }),
      body: JSON.stringify({ encoding: "base64", content: Buffer.from("first").toString("base64") })
    });
    expect(created.status).toBe(201);
    const firstEtag = created.headers.get("etag")!;
    expect(firstEtag).toMatch(/^"sha256-/u);

    const listed = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFiles}`);
    await expect(listed.json()).resolves.toMatchObject({
      files: [{ path: "chapters/one.txt", size: 5, etag: firstEtag }]
    });
    const read = await fetch(fileUrl);
    expect(read.headers.get("etag")).toBe(firstEtag);
    await expect(read.json()).resolves.toMatchObject({
      path: "chapters/one.txt",
      encoding: "base64",
      content: Buffer.from("first").toString("base64")
    });

    const stale = await fetch(fileUrl, {
      method: "PUT",
      headers: workspaceHeaders({ "If-Match": '"stale"' }),
      body: JSON.stringify({ encoding: "base64", content: Buffer.from("bad").toString("base64") })
    });
    expect(stale.status).toBe(412);
    const updated = await fetch(fileUrl, {
      method: "PUT",
      headers: workspaceHeaders({ "If-Match": firstEtag }),
      body: JSON.stringify({ encoding: "base64", content: Buffer.from("second").toString("base64") })
    });
    expect(updated.status).toBe(200);
    const secondEtag = updated.headers.get("etag")!;
    expect(secondEtag).not.toBe(firstEtag);

    const deleted = await fetch(fileUrl, {
      method: "DELETE",
      headers: workspaceHeaders({ "If-Match": secondEtag })
    });
    expect(deleted.status).toBe(204);
    expect((await workspace.list()).files).toEqual([]);
  });

  it("requires a non-simple mutation header and exact write preconditions", async () => {
    const baseUrl = await startServer(createTyprServer({ workspace: await createWorkspace() }));
    const fileUrl = `${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFile}?path=file.txt`;
    const body = JSON.stringify({ encoding: "base64", content: "b2s=" });

    const missingIntent = await fetch(fileUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-None-Match": "*" },
      body
    });
    expect(missingIntent.status).toBe(400);
    const missingPrecondition = await fetch(fileUrl, {
      method: "PUT",
      headers: workspaceHeaders(),
      body
    });
    expect(missingPrecondition.status).toBe(428);
    const both = await fetch(fileUrl, {
      method: "PUT",
      headers: workspaceHeaders({ "If-None-Match": "*", "If-Match": '"sha256-value"' }),
      body
    });
    expect(both.status).toBe(428);
  });

  it("rejects unapproved browser origins before touching the workspace", async () => {
    const workspace = await createWorkspace();
    const baseUrl = await startServer(createTyprServer({ workspace }));
    const response = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFile}?path=blocked.txt`, {
      method: "PUT",
      headers: workspaceHeaders({ Origin: "https://attacker.example", "If-None-Match": "*" }),
      body: JSON.stringify({ encoding: "base64", content: "bm8=" })
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect((await workspace.list()).files).toEqual([]);
  });

  it("keeps workspace routes unavailable when no mapped root is configured", async () => {
    const baseUrl = await startServer(createTyprServer());
    const response = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFiles}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "workspace-disabled" } });
  });

  it("rejects decoded traversal and duplicate path query parameters", async () => {
    const root = await createWorkspaceRoot();
    const baseUrl = await startServer(createTyprServer({ workspace: await WorkspaceStore.open(root) }));
    const traversal = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFile}?path=%2e%2e%2Fsecret`);
    expect(traversal.status).toBe(400);
    const duplicate = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.workspaceFile}?path=a&path=b`);
    expect(duplicate.status).toBe(400);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("rejects malformed compile payloads", async () => {
    const baseUrl = await startServer(createTyprServer());
    const response = await postJson(baseUrl, { protocolVersion: 1 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid-request", message: expect.stringContaining("engine") }
    });
  });

  it("optionally enforces managed API keys and attributes activity to their users", async () => {
    const access = await AccessStore.open();
    const user = await access.createUser("Typr desktop");
    const { secret } = await access.createApiKey(user.id, "Primary browser");
    await access.setRequireApiKeys(true);
    const activity = new ActivityBus();
    const baseUrl = await startServer(createTyprServer({ access, activity, isPdflatexAvailable: async () => true }));

    const rejected = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.status}`);
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("www-authenticate")).toContain("Bearer");
    const accepted = await fetch(`${baseUrl}${TYPR_COMPANION_ROUTES.status}`, {
      headers: { Authorization: `Bearer ${secret}` }
    });
    expect(accepted.status).toBe(200);
    expect(activity.snapshot().some((event) => event.userId === user.id && event.type === "request-completed")).toBe(true);
  });

  it("authenticates browser WebSockets without echoing the key-bearing subprotocol", async () => {
    const access = await AccessStore.open();
    const user = await access.createUser("Live preview");
    const { secret } = await access.createApiKey(user.id, "Browser socket");
    await access.setRequireApiKeys(true);
    const baseUrl = await startServer(createTyprServer({ access }));
    const socketUrl = `${baseUrl.replace("http:", "ws:")}/ws/texpresso`;

    await expect(openSocket(socketUrl)).rejects.toThrow(/401/u);
    const encoded = Buffer.from(secret, "utf8").toString("base64url");
    const socket = await openSocket(socketUrl, ["typr-companion-v1", `typr-api-key.${encoded}`]);
    expect(socket.protocol).toBe("typr-companion-v1");
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("rejects unsupported protocol versions and engines", async () => {
    const baseUrl = await startServer(createTyprServer());
    const request = validRequest();

    const protocolResponse = await postJson(baseUrl, { ...request, protocolVersion: 99 });
    expect(protocolResponse.status).toBe(400);
    await expect(protocolResponse.json()).resolves.toMatchObject({
      error: { code: "unsupported-protocol-version" }
    });

    const engineResponse = await postJson(baseUrl, { ...request, engine: "xelatex" });
    expect(engineResponse.status).toBe(422);
    await expect(engineResponse.json()).resolves.toMatchObject({
      error: { code: "unsupported-engine" }
    });
  });

  it("rejects project paths that traverse out of the temporary root", async () => {
    const baseUrl = await startServer(createTyprServer());
    const response = await postJson(baseUrl, {
      ...validRequest(),
      files: [{ path: "../outside.tex", kind: "text", content: "not allowed" }]
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("traversal") }
    });
  });

  it("materializes nested text and binary project files below the request workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "typr-server-test-"));
    try {
      await materializeProjectFiles(workspace, [
        { path: "main.tex", kind: "text", content: "\\input{chapters/intro}" },
        { path: "chapters/intro.tex", kind: "text", content: "Hello from a chapter." },
        { path: "images/pixel.bin", kind: "binary", encoding: "base64", content: "AAEC" }
      ]);

      await expect(readFile(join(workspace, "chapters/intro.tex"), "utf8")).resolves.toBe(
        "Hello from a chapter."
      );
      await expect(readFile(join(workspace, "images/pixel.bin"))).resolves.toEqual(
        Buffer.from([0, 1, 2])
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("compiles a multi-file native LaTeX project when pdflatex is available", async () => {
    if (!(await hostHasPdflatex())) {
      return;
    }
    const baseUrl = await startServer(createTyprServer());
    const response = await postJson(baseUrl, {
      protocolVersion: 1,
      engine: "pdflatex",
      mainFilePath: "main.tex",
      files: [
        {
          path: "main.tex",
          kind: "text",
          content: "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n"
        },
        { path: "chapters/intro.tex", kind: "text", content: "Hello from Typr Companion.\n" }
      ]
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, engine: "pdflatex", output: { path: "main.pdf" } });
    expect(Buffer.from(result.output.content, "base64").subarray(0, 4).toString()).toBe("%PDF");
  });

  it("returns a typed compile failure for invalid LaTeX source", async () => {
    if (!(await hostHasPdflatex())) {
      return;
    }
    const baseUrl = await startServer(createTyprServer());
    const response = await postJson(baseUrl, {
      ...validRequest(),
      files: [
        {
          path: "main.tex",
          kind: "text",
          content: "\\documentclass{article}\n\\begin{document}\n\\definitelyNotALatexCommand\n\\end{document}\n"
        }
      ]
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      engine: "pdflatex",
      errors: [{ code: "latex-compile-failed", path: "main.tex" }]
    });
  });
});

function validRequest() {
  return {
    protocolVersion: TYPR_COMPANION_PROTOCOL_VERSION,
    engine: "pdflatex",
    mainFilePath: "main.tex",
    files: [{ path: "main.tex", kind: "text", content: "\\documentclass{article}" }]
  };
}

async function startServer(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function postJson(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function createWorkspace(workspaceId = "test-workspace"): Promise<WorkspaceStore> {
  return WorkspaceStore.open(await createWorkspaceRoot(), { workspaceId });
}

async function createWorkspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "typr-server-workspace-api-test-"));
  workspaceRoots.push(root);
  return root;
}

function workspaceHeaders(additional: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [TYPR_WORKSPACE_MUTATION_HEADER]: "1",
    ...additional
  };
}

function openSocket(url: string, protocols?: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}
