import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { TYPR_COMPANION_PROTOCOL_VERSION } from "../src/companion-protocol/index.ts";
import { createTyprServer, hostHasPdflatex, materializeProjectFiles } from "./server.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
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
      serverVersion: "0.1.0",
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

  it("rejects malformed compile payloads", async () => {
    const baseUrl = await startServer(createTyprServer());
    const response = await postJson(baseUrl, { protocolVersion: 1 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid-request", message: expect.stringContaining("engine") }
    });
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
