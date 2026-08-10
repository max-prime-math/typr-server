import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.TYPR_COMPANION_DOCKER_IMAGE ?? "typr-server:test";
const skipBuild = process.env.TYPR_COMPANION_DOCKER_SKIP_BUILD === "1";
const expectedVersion = process.env.TYPR_COMPANION_EXPECTED_VERSION;
let containerId;
let workspaceRoot;

try {
  if (!skipBuild) {
    await run("docker", [
      "build",
      "--file", "docker/typr-server.Dockerfile",
      "--tag", image,
      "."
    ]);
  }

  workspaceRoot = await mkdtemp(resolve(tmpdir(), "typr-companion-docker-workspace-"));
  const readCanary = "TYPR_WORKSPACE_READ_SECRET_9f7499";
  await writeFile(resolve(workspaceRoot, "read-canary.tex"), `\\typeout{${readCanary}}\n`);
  containerId = (await capture("docker", [
    "run",
    "--detach",
    "--rm",
    "--security-opt", "no-new-privileges:true",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=536870912",
    "--pids-limit", "256",
    "--memory", "2g",
    "--cpus", "2",
    "--publish", "127.0.0.1::8484",
    "--mount", `type=bind,src=${workspaceRoot},dst=/workspace`,
    "--env", "TYPR_COMPANION_WORKSPACE_ROOT=/workspace",
    "--env", "TYPR_COMPANION_WORKSPACE_ID=docker-test",
    image
  ])).trim();

  const portOutput = await capture("docker", ["port", containerId, "8484/tcp"]);
  const port = parsePublishedPort(portOutput);
  const baseUrl = `http://127.0.0.1:${port}`;

  const status = await waitForStatus(baseUrl);
  assert(status.protocolVersion === 1, "Docker Companion must report protocol version 1.");
  if (expectedVersion) {
    assert(status.serverVersion === expectedVersion,
      `Docker Companion must report server version ${expectedVersion}; received ${status.serverVersion}.`);
  }
  assert(status.capabilities?.compile?.engines?.includes("pdflatex"), "Docker Companion must advertise pdflatex.");
  assert(status.capabilities?.filesystem?.projectStorage === true, "Mapped workspace capability must be enabled.");
  assert(status.capabilities?.filesystem?.workspaceId === "docker-test", "Mapped workspace ID must be stable.");

  const officialOriginResponse = await fetch(`${baseUrl}/api/v1/status`, {
    headers: { Origin: "https://typr.ca" }
  });
  assert(officialOriginResponse.ok, "The status endpoint must respond to the official Typr origin.");
  assert(
    officialOriginResponse.headers.get("access-control-allow-origin") === "https://typr.ca",
    "The production image must allow the official Typr origin without wildcard CORS."
  );

  const privateNetworkPreflight = await fetch(`${baseUrl}/api/v1/status`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://typr.ca",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Private-Network": "true"
    }
  });
  assert(privateNetworkPreflight.status === 204, "The private-network preflight must succeed.");
  assert(
    privateNetworkPreflight.headers.get("access-control-allow-private-network") === "true",
    "The production image must opt allowed Typr origins into private-network requests."
  );

  const simpleResult = await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\begin{document}\nHello from Docker.\n\\end{document}\n")
  ]);
  assertPdf(simpleResult, "a simple LaTeX document");

  const multiFileResult = await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n"),
    textFile("chapters/intro.tex", "Hello from a nested file.\n")
  ]);
  assertPdf(multiFileResult, "a multi-file LaTeX document");

  const assetResult = await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\includegraphics{images/example.png}\n\\end{document}\n"),
    {
      path: "images/example.png",
      kind: "binary",
      encoding: "base64",
      // A valid, one-pixel PNG fixture.
      content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAB3YoTpAAAAAd0SU1FB+oICBMKBG0twNAAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDgtMDhUMTk6MTA6MDQrMDA6MDArhK71AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA4LTA4VDE5OjEwOjA0KzAwOjAwWtkWSQAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wOC0wOFQxOToxMDowNCswMDowMA3MN5YAAAAKSURBVAjXY2gAAACCAIHdQ2r0AAAAAElFTkSuQmCC"
    }
  ]);
  assertPdf(assetResult, "a LaTeX document with a binary image asset");

  const brokenResult = await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\begin{document}\n\\definitelyNotALatexCommand\n\\end{document}\n")
  ]);
  assert(
    brokenResult.ok === false && brokenResult.errors?.[0]?.code === "latex-compile-failed",
    "Broken LaTeX must return a typed latex-compile-failed result."
  );

  const traversalResponse = await requestCompile(baseUrl, {
    protocolVersion: 1,
    engine: "pdflatex",
    mainFilePath: "main.tex",
    files: [textFile("../outside.tex", "not allowed")]
  });
  assert(traversalResponse.status === 400, "Traversal paths must be rejected with HTTP 400.");

  const absoluteRead = await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{/workspace/read-canary.tex}\n\\end{document}\n")
  ]);
  assert(absoluteRead.ok === false, "Native compilation must not read the mapped workspace directly.");
  assert(!JSON.stringify(absoluteRead).includes(readCanary), "Mapped-workspace read canary must not leak through compiler output.");

  await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\newwrite\\outside\n\\begin{document}\n\\immediate\\openout\\outside=/workspace/write-canary\\immediate\\write\\outside{bad}\n\\end{document}\n")
  ]);
  assert(!(await readdir(workspaceRoot)).includes("write-canary"), "Native compilation must not write to the mapped workspace.");

  const shellResult = await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\begin{document}\n\\immediate\\write18{touch /workspace/shell-canary}\nShell disabled.\n\\end{document}\n")
  ]);
  assertPdf(shellResult, "a document that attempts shell escape");
  assert(!(await readdir(workspaceRoot)).includes("shell-canary"), "TeX shell escape must stay disabled.");

  const latexmkRcResult = await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\begin{document}\nNo rc execution.\n\\end{document}\n"),
    textFile(".latexmkrc", "system('touch /workspace/latexmkrc-canary');\n")
  ]);
  assertPdf(latexmkRcResult, "a project containing an untrusted .latexmkrc");
  assert(!(await readdir(workspaceRoot)).includes("latexmkrc-canary"), "latexmk must ignore project-supplied rc files.");

  const workspaceListing = await fetch(`${baseUrl}/api/v1/workspace/files`);
  assert(workspaceListing.ok, "Mapped workspace listing must be available in the production image.");
  const listedFiles = await workspaceListing.json();
  assert(listedFiles.files?.some((file) => file.path === "read-canary.tex"), "Mapped workspace listing must include regular files.");
  const apiFileUrl = `${baseUrl}/api/v1/workspace/file?path=nested%2Fapi-created.bin`;
  const apiCreate = await fetch(apiFileUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Typr-Workspace-Mutation": "1",
      "If-None-Match": "*"
    },
    body: JSON.stringify({ encoding: "base64", content: Buffer.from([0, 1, 2, 255]).toString("base64") })
  });
  assert(apiCreate.status === 201, "Mapped workspace API must conditionally create a nested file.");
  const apiEtag = apiCreate.headers.get("etag");
  assert(apiEtag?.startsWith('"sha256-'), "Mapped workspace writes must return a strong ETag.");
  assert((await readFile(resolve(workspaceRoot, "nested/api-created.bin"))).equals(Buffer.from([0, 1, 2, 255])), "Mapped workspace API must preserve binary bytes.");
  const apiDelete = await fetch(apiFileUrl, {
    method: "DELETE",
    headers: { "X-Typr-Workspace-Mutation": "1", "If-Match": apiEtag }
  });
  assert(apiDelete.status === 204, "Mapped workspace API must conditionally delete the file it created.");

  const timeoutSource = "\\documentclass{article}\n\\begin{document}\n\\newcount\\counter\\counter=0\\loop\\advance\\counter by 1\\ifnum\\counter<2000000000\\repeat\\end{document}\n";
  const timeoutOne = requestCompile(baseUrl, compileRequest([textFile("main.tex", timeoutSource)]));
  const timeoutTwo = requestCompile(baseUrl, compileRequest([textFile("main.tex", timeoutSource)]));
  await delay(500);
  const busyStartedAt = Date.now();
  const busy = await requestCompile(baseUrl, compileRequest([textFile("main.tex", timeoutSource)]));
  assert(
    busy.status === 429 && busy.body.error?.code === "server-busy",
    `A third concurrent compile must be rejected with server-busy; received ${busy.status} ${JSON.stringify(busy.body)}.`
  );
  assert(Date.now() - busyStartedAt < 2_000, "A busy rejection must be prompt rather than queued.");
  const timedOut = await Promise.all([timeoutOne, timeoutTwo]);
  assert(timedOut.every((result) => result.body.errors?.[0]?.code === "compile-timeout"), "Timed-out compilers must return the typed timeout code.");

  const outputFlood = await compile(baseUrl, [
    textFile("main.tex", "\\documentclass{article}\n\\begin{document}\n\\newcount\\n\\loop\\typeout{XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX}\\advance\\n by 1\\ifnum\\n<50000\\repeat\\end{document}\n")
  ]);
  assert(outputFlood.ok === false && outputFlood.errors?.[0]?.code === "compiler-output-limit", "Compiler output floods must hit the typed capture limit.");
  assertPdf(await compile(baseUrl, [textFile("main.tex", "\\documentclass{article}\n\\begin{document}\nRecovered after limits.\n\\end{document}\n")]), "a compile after timeout and output-limit recovery");
  const leftovers = await capture("docker", ["exec", containerId, "find", "/tmp", "-maxdepth", "1", "-name", "typr-companion-*", "-print"]);
  assert(leftovers.trim() === "", `Compile workspaces must be removed after every outcome; found: ${leftovers}`);

  console.log("Docker Companion verification passed.");
} finally {
  if (containerId) {
    await run("docker", ["stop", "--timeout", "10", containerId], { allowFailure: true });
  }
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
}

function textFile(path, content) {
  return { path, kind: "text", content };
}

function compileRequest(files) {
  return { protocolVersion: 1, engine: "pdflatex", mainFilePath: "main.tex", files };
}

async function compile(baseUrl, files) {
  const response = await requestCompile(baseUrl, compileRequest(files));
  assert(response.status === 200, `Compile request returned HTTP ${response.status}.`);
  return response.body;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function requestCompile(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/v1/compile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function waitForStatus(baseUrl) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/status`);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`Status endpoint returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Docker Companion did not become ready: ${lastError?.message ?? "unknown error"}`);
}

function parsePublishedPort(output) {
  const match = output.match(/:(\d+)\s*$/m);
  if (!match) {
    throw new Error(`Could not determine the published Docker port from: ${output}`);
  }
  return Number.parseInt(match[1], 10);
}

function assertPdf(result, description) {
  assert(
    result.ok === true,
    `Expected ${description} to compile successfully: ${JSON.stringify(result.errors ?? result)}`
  );
  assert(
    Buffer.from(result.output?.content ?? "", "base64").subarray(0, 4).toString() === "%PDF",
    `Expected ${description} to produce a PDF.`
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0 || allowFailure) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} exited with status ${code}.`));
      }
    });
  });
}

function capture(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) {
        resolveRun(output);
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} exited with status ${code}.`));
      }
    });
  });
}
