import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import WebSocket from "ws";

const executable = resolve(process.argv[2] ?? "");
assert(isAbsolute(executable), "Pass the Windows Companion executable path.");
const localData = await mkdtemp(join(tmpdir(), "typr-windows-portable-test-"));
const port = 18_484;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(executable, [], {
  env: { ...process.env, LOCALAPPDATA: localData, TYPR_COMPANION_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

try {
  const status = await waitForStatus();
  assert(status.capabilities.compile.engines.includes("pdflatex"), "Embedded pdflatex was not advertised.");
  assert.equal(status.capabilities.filesystem.projectStorage, true);
  assert.equal(status.capabilities.filesystem.workspaceId, "windows-local");

  const source = "\\documentclass{article}\n\\begin{document}\nHello from portable Windows.\n\\end{document}\n";
  const compileResponse = await fetch(`${baseUrl}/api/v1/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocolVersion: 1,
      engine: "pdflatex",
      mainFilePath: "main.tex",
      files: [{ path: "main.tex", kind: "text", content: source }]
    })
  });
  const compiled = await compileResponse.json();
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  assert.equal(Buffer.from(compiled.output.content, "base64").subarray(0, 4).toString(), "%PDF");

  const workspaceResponse = await fetch(`${baseUrl}/api/v1/workspace/file?path=portable.txt`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Typr-Workspace-Mutation": "1",
      "If-None-Match": "*"
    },
    body: JSON.stringify({ encoding: "base64", content: Buffer.from("portable").toString("base64") })
  });
  assert.equal(workspaceResponse.status, 201);

  await testLivePreview(source);
} finally {
  child.kill();
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(10_000)]);
  await rm(localData, { recursive: true, force: true });
}

async function waitForStatus() {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Companion exited during startup with ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/status`);
      if (response.ok) return response.json();
    } catch {}
    await delay(500);
  }
  throw new Error("Timed out waiting for the portable Windows Companion.");
}

async function testLivePreview(source) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/texpresso`);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  let pngFrames = 0;
  const controls = [];
  socket.on("message", (data, binary) => {
    if (binary) pngFrames += 1;
    else controls.push(JSON.parse(Buffer.from(data).toString("utf8")));
  });
  socket.send(JSON.stringify({
    type: "initialize",
    protocolVersion: 1,
    revision: 1,
    mainFilePath: "main.tex",
    render: { dpi: 96 },
    files: [{ path: "main.tex", kind: "text", content: source }]
  }));
  await waitUntil(() => controls.some((message) => message.type === "revision-complete" && message.revision === 1));
  assert(pngFrames > 0, "Windows full-build live preview produced no PNG pages.");
  socket.send(JSON.stringify({
    type: "change",
    revision: 2,
    path: "main.tex",
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
    text: "Updated. "
  }));
  await waitUntil(() => controls.some((message) => message.type === "revision-complete" && message.revision === 2));
  socket.send(JSON.stringify({ type: "shutdown" }));
  await new Promise((resolveClose) => socket.once("close", resolveClose));
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 90_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for live-preview fallback.");
    await delay(100);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
