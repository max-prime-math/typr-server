import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.TYPR_COMPANION_DOCKER_IMAGE ?? "typr-server:texpresso-ws-test";
const outputRoot = resolve(repositoryRoot, process.env.TYPR_TEXPRESSO_WS_OUTPUT ?? "qa-ui-artifacts/texpresso-ws");
let containerId;
let createdContainerId;
let workspaceRoot;

async function main() {
 try {
  if (process.env.TYPR_COMPANION_DOCKER_SKIP_BUILD !== "1" && process.env.TYPR_TEXPRESSO_WS_SKIP_BUILD !== "1") {
    await run("docker", ["build", "--file", "docker/typr-server.Dockerfile", "--tag", image, "."]);
  }
  const imageBytes = Number((await capture("docker", ["image", "inspect", image, "--format", "{{.Size}}"])) .trim());
  workspaceRoot = await mkdtemp(join(tmpdir(), "typr-texpresso-workspace-canary-"));
  await chmod(workspaceRoot, 0o777);
  const workspaceSecret = "TYPR_TEXPRESSO_WORKSPACE_SECRET_f2d092";
  await writeFile(join(workspaceRoot, "read-canary.tex"), `\\typeout{${workspaceSecret}}\n`);
  containerId = (await capture("docker", [
    "run", "--detach",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=536870912",
    "--pids-limit", "256",
    "--memory", "2g",
    "--cpus", "2",
    "--mount", `type=bind,src=${workspaceRoot},dst=/workspace`,
    "--env", "TYPR_COMPANION_WORKSPACE_ROOT=/workspace",
    "--env", "TYPR_COMPANION_WORKSPACE_ID=texpresso-canary",
    "--publish", "127.0.0.1::8484",
    image
  ])).trim();
  createdContainerId = containerId;
  const port = parsePublishedPort(await capture("docker", ["port", containerId, "8484/tcp"]));
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/texpresso`;
  await waitForStatus(baseUrl);
  await mkdir(outputRoot, { recursive: true });

  await assertRejectedOrigin(wsUrl);
  await testSandboxReadDenial(wsUrl, workspaceSecret);
  const results = [];
  results.push(await runPreviewScenario(wsUrl, 144, false));
  results.push(await runPreviewScenario(wsUrl, 192, true));
  results.push(await runPreviewScenario(wsUrl, 240, false, 3));

  await testUnexpectedExit(wsUrl, containerId);
  await testBinaryClientFrame(wsUrl);
  await assertNoTexpressoProcess(containerId);

  // Leave one initialized session alive while Docker delivers SIGTERM to PID 1.
  // A clean WebSocket close proves the CLI/server shutdown path closed the
  // native session before the container exited.
  const shutdownClient = await PreviewClient.connect(wsUrl);
  shutdownClient.initialize(900, 192, fixtureFiles());
  await shutdownClient.waitForControl((message) => message.type === "session-ready" && message.revision === 900, 45_000);
  const shutdownClosed = shutdownClient.waitForClose(20_000);
  await run("docker", ["stop", "--timeout", "15", containerId]);
  containerId = undefined;
  await shutdownClosed;

  const report = { imageBytes, imageMiB: imageBytes / 1024 / 1024, outputRoot, results };
  await writeFile(join(outputRoot, "benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  } catch (error) {
    if (containerId) await run("docker", ["logs", containerId], { allowFailure: true });
    throw error;
  } finally {
    if (containerId) await run("docker", ["stop", "--timeout", "15", containerId], { allowFailure: true });
    if (createdContainerId) await run("docker", ["rm", "--force", createdContainerId], { allowFailure: true });
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testSandboxReadDenial(wsUrl, workspaceSecret) {
  const client = await PreviewClient.connect(wsUrl, { Origin: "http://localhost:5173" });
  client.initialize(700, 192, [
    textFile("main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{/workspace/read-canary.tex}\n\\end{document}\n")
  ]);
  const terminal = await client.waitForControl((message) =>
    message.type === "compile-error" || message.type === "session-error" || message.type === "revision-complete",
  45_000);
  assert.notEqual(terminal.message.type, "revision-complete", "TeXpresso must not read the mapped workspace.");
  assert.equal(JSON.stringify(client.controls).includes(workspaceSecret), false, "TeXpresso diagnostics must not leak mapped-workspace contents.");
  if (!client.closed) client.socket.close();
  await client.waitForClose();
}

async function runPreviewScenario(wsUrl, dpi, fullBehavior, editCount = 5) {
  const client = await PreviewClient.connect(wsUrl, { Origin: "http://localhost:5173" });
  const files = fixtureFiles();
  const sources = new Map(files.filter((file) => file.kind === "text").map((file) => [file.path, file.content]));
  const initializeAt = performance.now();

  // A malformed message is recoverable and must not crash or poison this connection.
  client.sendRaw("{");
  const malformed = await client.waitForControl((message) => message.type === "protocol-error" && message.code === "malformed-json");
  assert.equal(malformed.message.fatal, false);

  client.initialize(1, dpi, files);
  const ready = await client.waitForControl((message) => message.type === "session-ready" && message.revision === 1, 45_000);
  assert.equal(ready.message.render.dpi, dpi);
  const initial = await client.waitForRevision(1, 45_000);
  assert.equal(initial.complete.message.pageCount, 3);
  assert.equal(initial.pages.length, 3);
  assert.equal(await processExists(containerId, ready.message.processId), true, "TeXpresso PID must remain alive after initialization.");
  await savePages(dpi, "initial", initial.pages);

  const updateMs = [];
  const renderMs = [];
  const overheadMs = [];
  const totalMs = [];
  const payloadBytes = [];
  let token = "BENCHTOKEN";
  let rapid;
  for (let index = 0; index < editCount; index += 1) {
    const replacement = `BENCH${String(index + 1).padStart(5, "0")}`;
    const revision = index + 2;
    const sentAt = performance.now();
    sendReplacement(client, sources, "sections/body.tex", token, replacement, revision);
    token = replacement;
    const result = await client.waitForRevision(revision, 30_000);
    const total = result.complete.receivedAt - sentAt;
    const server = result.complete.message.timings;
    updateMs.push(server.updateMs);
    renderMs.push(server.renderMs);
    totalMs.push(total);
    overheadMs.push(Math.max(0, total - server.updateMs - server.renderMs));
    payloadBytes.push(sum(result.pages.map((page) => page.data.length)));
  }

  if (fullBehavior) {
    // Changes 7-9 arrive faster than a conservative full-document raster. All
    // edits must apply, but only the latest needs a complete preview state.
    const rapidRevisions = [editCount + 2, editCount + 3, editCount + 4];
    const rapidStartedAt = performance.now();
    for (let index = 0; index < rapidRevisions.length; index += 1) {
      const replacement = `RAPID${String(index + 1).padStart(5, "0")}`;
      sendReplacement(client, sources, "sections/body.tex", token, replacement, rapidRevisions[index]);
      token = replacement;
      if (index < rapidRevisions.length - 1) await delay(30);
    }
    const finalRapidRevision = rapidRevisions.at(-1);
    const rapidResult = await client.waitForRevision(finalRapidRevision, 30_000);
    assert.equal(rapidResult.complete.message.lastGoodRevision, finalRapidRevision);
    assert.equal(client.currentPreviewRevision, finalRapidRevision, "A stale revision became the active preview.");
    const applied = client.controls.filter((event) => event.message.type === "revision-applied" && rapidRevisions.includes(event.message.revision));
    assert.equal(applied.length, rapidRevisions.length, "Every rapid source transition must be applied.");
    assert.ok(applied.some((event) => event.message.render === "coalesced") ||
      client.controls.filter((event) => event.message.type === "revision-complete" && rapidRevisions.includes(event.message.revision)).length < rapidRevisions.length,
    "At least one rapid intermediate render should be superseded.");
    const completedRapid = client.controls.filter((event) => event.message.type === "revision-complete" && rapidRevisions.includes(event.message.revision));
    const rapidStates = client.controls.filter((event) =>
      (event.message.type === "revision-started" || event.message.type === "revision-applied") && rapidRevisions.includes(event.message.revision));
    rapid = {
      intervalMs: 30,
      sent: rapidRevisions.length,
      applied: applied.length,
      rendered: completedRapid.length,
      maxQueueDepth: Math.max(0, ...rapidStates.map((event) => event.message.queueDepth)),
      settleMs: rapidResult.complete.receivedAt - rapidStartedAt
    };

    const invalidRevision = finalRapidRevision + 1;
    sendReplacement(client, sources, "sections/body.tex", token, "\\undefinedTyprWsCommand", invalidRevision);
    token = "\\undefinedTyprWsCommand";
    const compileError = await client.waitForControl((message) => message.type === "compile-error" && message.revision === invalidRevision, 30_000);
    assert.equal(compileError.message.lastGoodRevision, finalRapidRevision);
    assert.ok(compileError.message.diagnostics[0]?.message);
    assert.equal(client.pagesForRevision(invalidRevision).length, 0, "Invalid output must not replace last-good PNGs.");

    const recoveryRevision = invalidRevision + 1;
    sendReplacement(client, sources, "sections/body.tex", token, "RECOVEREDTOKEN", recoveryRevision);
    token = "RECOVEREDTOKEN";
    const recovered = await client.waitForRevision(recoveryRevision, 30_000);
    assert.equal(recovered.complete.message.lastGoodRevision, recoveryRevision);

    const layoutRevision = recoveryRevision + 1;
    sendReplacement(client, sources, "sections/body.tex", "LAYOUTTOKEN", layoutShiftText(), layoutRevision);
    const layout = await client.waitForRevision(layoutRevision, 45_000);
    assert.ok(layout.complete.message.pageCount > 3, "Layout edit must increase page count.");
    assert.equal(layout.document.message.pages.length, layout.complete.message.pageCount);
    await savePages(dpi, "layout", layout.pages);

    const crossRevision = layoutRevision + 1;
    sendReplacement(client, sources, "main.tex", "Cross-reference: \\pageref{page:three}.", "Updated cross-reference: \\pageref{page:three}.", crossRevision);
    const cross = await client.waitForRevision(crossRevision, 45_000);
    assert.equal(cross.complete.message.pageCount, layout.complete.message.pageCount);
    assert.ok(cross.pages.some((page, index) => !page.data.equals(layout.pages[index]?.data)), "Cross-reference revision did not change any rendered page.");

    client.change(crossRevision, "main.tex", zeroRange(), "x");
    const stale = await client.waitForControl((message) => message.type === "protocol-error" && message.code === "stale-revision");
    assert.equal(stale.message.revision, crossRevision);

    const jumpRevision = crossRevision + 3;
    sendReplacement(client, sources, "main.tex", "Updated cross-reference", "Jumped cross-reference", jumpRevision);
    await client.waitForRevision(jumpRevision, 45_000);
  }

  const pid = ready.message.processId;
  await client.shutdown();
  await waitForProcessExit(containerId, pid);

  const first = initial.pages[0].metadata;
  return {
    dpi,
    dimensions: `${first.width}x${first.height}`,
    initialCompileMs: ready.message.initialCompileMs,
    initialClientMs: initial.complete.receivedAt - initializeAt,
    initialPayloadBytes: sum(initial.pages.map((page) => page.data.length)),
    initialAveragePageBytes: average(initial.pages.map((page) => page.data.length)),
    initialLargestPageBytes: Math.max(...initial.pages.map((page) => page.data.length)),
    ordinaryEditCount: editCount,
    medianUpdateMs: median(updateMs),
    medianRenderMs: median(renderMs),
    medianWebSocketOverheadMs: median(overheadMs),
    medianClientMs: median(totalMs),
    medianOrdinaryPayloadBytes: median(payloadBytes),
    ...(rapid ? { rapid } : {})
  };
}

async function testUnexpectedExit(wsUrl, currentContainerId) {
  const client = await PreviewClient.connect(wsUrl);
  client.initialize(500, 192, fixtureFiles());
  const ready = await client.waitForControl((message) => message.type === "session-ready" && message.revision === 500, 45_000);
  await run("docker", ["exec", currentContainerId, "node", "-e", `process.kill(${ready.message.processId}, 'SIGTERM')`]);
  const failure = await client.waitForControl((message) => message.type === "session-error" && message.code === "texpresso-exited", 15_000);
  assert.match(failure.message.message, /exited unexpectedly/i);
  await client.waitForClose(15_000);
}

async function testBinaryClientFrame(wsUrl) {
  const client = await PreviewClient.connect(wsUrl);
  client.socket.send(Buffer.from([1, 2, 3]));
  const error = await client.waitForControl((message) => message.type === "protocol-error" && message.code === "unexpected-binary-frame");
  assert.equal(error.message.fatal, true);
  await client.waitForClose();
}

class PreviewClient {
  controls = [];
  pages = [];
  currentPreviewRevision = 0;
  pendingPageMetadata;
  waiters = new Set();
  closeWaiters = new Set();
  closed = false;

  constructor(socket) {
    this.socket = socket;
    socket.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    // Error details are reflected by close/session control assertions below;
    // keep transport resets from becoming uncaught EventEmitter errors.
    socket.on("error", () => {});
    socket.once("close", () => {
      this.closed = true;
      for (const waiter of this.closeWaiters) waiter();
      this.closeWaiters.clear();
    });
  }

  static connect(url, headers) {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(url, headers ? { headers } : undefined);
      const onError = (error) => rejectConnect(error);
      socket.once("error", onError);
      socket.once("open", () => {
        socket.off("error", onError);
        resolveConnect(new PreviewClient(socket));
      });
    });
  }

  initialize(revision, dpi, files) {
    this.send({ type: "initialize", protocolVersion: 1, revision, mainFilePath: "main.tex", render: { dpi }, files });
  }

  change(revision, path, range, text) {
    this.send({ type: "change", revision, path, range, text });
  }

  send(value) { this.socket.send(JSON.stringify(value)); }
  sendRaw(value) { this.socket.send(value); }

  async shutdown() {
    this.send({ type: "shutdown" });
    await this.waitForControl((message) => message.type === "session-closed" && message.reason === "client-shutdown");
    await this.waitForClose();
  }

  onMessage(data, isBinary) {
    const receivedAt = performance.now();
    if (isBinary) {
      assert.ok(this.pendingPageMetadata, "Binary PNG frame arrived without adjacent page metadata.");
      const bytes = Buffer.from(data);
      assert.equal(bytes.length, this.pendingPageMetadata.byteLength);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.deepEqual(pngDimensions(bytes), { width: this.pendingPageMetadata.width, height: this.pendingPageMetadata.height });
      this.pages.push({ metadata: this.pendingPageMetadata, data: bytes, receivedAt });
      this.pendingPageMetadata = undefined;
    } else {
      assert.equal(this.pendingPageMetadata, undefined, "A control frame interleaved page metadata and its binary PNG.");
      const message = JSON.parse(Buffer.from(data).toString("utf8"));
      if (message.type === "page") this.pendingPageMetadata = message;
      else {
        this.controls.push({ message, receivedAt });
        if (message.type === "revision-complete" && message.revision >= this.currentPreviewRevision) {
          this.currentPreviewRevision = message.revision;
        }
      }
    }
    for (const waiter of [...this.waiters]) waiter();
  }

  waitForControl(predicate, timeoutMs = 10_000) {
    return this.waitFor(() => this.controls.find((event) => predicate(event.message)), timeoutMs);
  }

  async waitForRevision(revision, timeoutMs) {
    const complete = await this.waitForControl((message) => message.type === "revision-complete" && message.revision === revision, timeoutMs);
    const document = this.controls.find((event) => event.message.type === "document" && event.message.revision === revision);
    assert.ok(document, `Revision ${revision} did not include document metadata.`);
    const pages = this.pagesForRevision(revision);
    assert.equal(pages.length, complete.message.pageCount, `Revision ${revision} did not transfer every page.`);
    return { complete, document, pages };
  }

  pagesForRevision(revision) { return this.pages.filter((page) => page.metadata.revision === revision); }

  waitFor(find, timeoutMs) {
    const current = find();
    if (current) return Promise.resolve(current);
    return new Promise((resolveWait, rejectWait) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        rejectWait(new Error(`Timed out after ${timeoutMs} ms. Recent controls: ${JSON.stringify(this.controls.slice(-5).map((event) => event.message))}`));
      }, timeoutMs);
      const check = () => {
        const found = find();
        if (!found) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolveWait(found);
      };
      this.waiters.add(check);
    });
  }

  waitForClose(timeoutMs = 10_000) {
    if (this.closed) return Promise.resolve();
    return new Promise((resolveWait, rejectWait) => {
      const timeout = setTimeout(() => {
        this.closeWaiters.delete(done);
        rejectWait(new Error(`WebSocket did not close within ${timeoutMs} ms.`));
      }, timeoutMs);
      const done = () => { clearTimeout(timeout); resolveWait(); };
      this.closeWaiters.add(done);
    });
  }
}

function fixtureFiles() {
  return [
    textFile("main.tex", String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Typr WebSocket transport fixture}
\begin{document}
\maketitle
\input{sections/body.tex}
Cross-reference: \pageref{page:three}.
\end{document}
`),
    textFile("sections/body.tex", String.raw`\section{First page}
BENCHTOKEN

This multi-file document exercises UTF-16 incremental range edits.
LAYOUTTOKEN
\newpage
\section{Second page}
The second page verifies stable independent page ordering.
\newpage
\section{Third page}\label{page:three}
The third page supplies a cross-reference and pagination target.
`),
    {
      path: "assets/pixel.png",
      kind: "binary",
      encoding: "base64",
      content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    }
  ];
}

function textFile(path, content) { return { path, kind: "text", content }; }

function sendReplacement(client, sources, path, expected, replacement, revision) {
  const source = sources.get(path);
  const offset = source.indexOf(expected);
  assert.notEqual(offset, -1, `Expected client fixture text not found in ${path}: ${expected}`);
  const range = { start: offsetToPosition(source, offset), end: offsetToPosition(source, offset + expected.length) };
  sources.set(path, `${source.slice(0, offset)}${replacement}${source.slice(offset + expected.length)}`);
  client.change(revision, path, range, replacement);
}

function offsetToPosition(source, offset) {
  const lines = source.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length };
}

function zeroRange() { return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }; }

function layoutShiftText() {
  return Array.from({ length: 90 }, (_, index) => `Inserted layout line ${index + 1}: conservative invalidation must update later pages.\n`).join("");
}

async function savePages(dpi, prefix, pages) {
  const directory = join(outputRoot, `${dpi}-dpi`);
  await mkdir(directory, { recursive: true });
  await Promise.all(pages.map((page) => writeFile(join(directory, `${prefix}-page-${page.metadata.page + 1}.png`), page.data)));
}

async function assertRejectedOrigin(wsUrl) {
  await new Promise((resolveTest, rejectTest) => {
    const socket = new WebSocket(wsUrl, { headers: { Origin: "https://example.invalid" } });
    socket.once("unexpected-response", (_request, response) => {
      try { assert.equal(response.statusCode, 403); resolveTest(); } catch (error) { rejectTest(error); }
      response.resume();
    });
    socket.once("open", () => rejectTest(new Error("Disallowed WebSocket origin was accepted.")));
    socket.once("error", () => {});
  });
}

async function waitForStatus(baseUrl) {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/status`);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`Docker Companion did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function processExists(currentContainerId, pid) {
  const output = await capture("docker", ["exec", currentContainerId, "node", "-e", `process.stdout.write(require('node:fs').existsSync('/proc/${pid}') ? 'yes' : 'no')`]);
  return output === "yes";
}

async function waitForProcessExit(currentContainerId, pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await processExists(currentContainerId, pid))) return;
    await delay(100);
  }
  throw new Error(`TeXpresso process ${pid} survived WebSocket teardown.`);
}

async function assertNoTexpressoProcess(currentContainerId) {
  const output = await capture("docker", ["exec", currentContainerId, "node", "-e", "const fs=require('node:fs');for(const p of fs.readdirSync('/proc')){if(/^\\d+$/.test(p)){try{const a=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')[0];if(/(?:^|\\/)texpresso(?:-xetex)?$/.test(a))process.stdout.write(p+' '+a+'\\n')}catch{}}}"]);
  assert.equal(output.trim(), "", `Orphan TeXpresso process found:\n${output}`);
}

function pngDimensions(bytes) { return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; }
function parsePublishedPort(output) { const match = output.match(/:(\d+)\s*$/m); if (!match) throw new Error(`Cannot parse Docker port: ${output}`); return Number(match[1]); }
function median(values) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.floor(ordered.length / 2)]; }
function average(values) { return sum(values) / values.length; }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function printReport(report) {
  console.log("TeXpresso private WebSocket verification passed.");
  console.log(`Docker image: ${(report.imageBytes / 1_000_000).toFixed(1)} MB (${report.imageMiB.toFixed(1)} MiB)`);
  for (const result of report.results) {
    console.log(`${result.dpi} DPI: ${result.dimensions}; initial ${formatBytes(result.initialPayloadBytes)}; average/largest page ${formatBytes(result.initialAveragePageBytes)}/${formatBytes(result.initialLargestPageBytes)}; ordinary payload median ${formatBytes(result.medianOrdinaryPayloadBytes)}`);
    console.log(`${result.dpi} DPI ordinary edit median: update ${result.medianUpdateMs.toFixed(1)} ms; render ${result.medianRenderMs.toFixed(1)} ms; WS/server overhead ${result.medianWebSocketOverheadMs.toFixed(1)} ms; client total ${result.medianClientMs.toFixed(1)} ms`);
    if (result.rapid) console.log(`rapid edits @ ${result.rapid.intervalMs} ms: ${result.rapid.applied}/${result.rapid.sent} applied, ${result.rapid.rendered} rendered, max queue ${result.rapid.maxQueueDepth}, settled ${result.rapid.settleMs.toFixed(1)} ms`);
  }
  console.log(`Sample PNGs and machine-readable report: ${report.outputRoot}`);
}

function formatBytes(value) { return `${(value / 1024).toFixed(1)} KiB`; }

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 || allowFailure ? resolveRun() : rejectRun(new Error(`${command} ${args.join(" ")} exited with status ${code}.`)));
  });
}

function capture(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun(output) : rejectRun(new Error(`${command} ${args.join(" ")} exited with status ${code}.`)));
  });
}

await main();
