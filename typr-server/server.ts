import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import {
  TYPR_COMPANION_PROTOCOL_VERSION,
  TYPR_COMPANION_ROUTES,
  type CompanionCapabilities,
  type CompanionStatusResponse,
  type CompileEngine,
  type CompileFailure,
  type CompileRequest,
  type CompileResult,
  type ProjectFile
} from "../src/companion-protocol/index.ts";
import { materializeProjectFiles, resolveProjectPath, validateProjectPath } from "./projectFiles.ts";
import { TexpressoLiveSession } from "./texpressoLiveSession.ts";
import { TEXPRESSO_WS_LIMITS, TEXPRESSO_WS_ROUTE } from "./texpressoWsProtocol.ts";

export { materializeProjectFiles } from "./projectFiles.ts";

const DEFAULT_SERVER_VERSION = "0.1.2-dev";
const MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const IMPLEMENTED_ENGINES = ["pdflatex"] as const;
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://typr.ca",
  "https://beta.typr.ca",
  "https://dev.typr.ca",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173"
]);

export interface TyprServerOptions {
  serverVersion?: string;
  /** Used by tests and by embedders that need to check host tooling differently. */
  isPdflatexAvailable?: () => Promise<boolean>;
  allowedOrigins?: ReadonlySet<string>;
}

interface NativeRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ValidationSuccess {
  ok: true;
  request: CompileRequest;
}

interface ValidationFailure {
  ok: false;
  message: string;
}

type ValidationResult = ValidationSuccess | ValidationFailure;

interface RequestContext {
  isPdflatexAvailable: () => Promise<boolean>;
  allowedOrigins: ReadonlySet<string>;
  serverVersion: string;
  activeCompilations: Set<AbortController>;
  activeLiveSessions: Set<TexpressoLiveSession>;
  webSocketServer: WebSocketServer;
}

let pdflatexAvailability: Promise<boolean> | undefined;
const serverContexts = new WeakMap<Server, RequestContext>();

/** Creates the standalone local HTTP server; it does not listen until the caller asks it to. */
export function createTyprServer(options: TyprServerOptions = {}): Server {
  const isPdflatexAvailable = options.isPdflatexAvailable ?? hostHasPdflatex;
  const allowedOrigins = options.allowedOrigins ?? getAllowedOriginsFromEnvironment();
  const serverVersion = options.serverVersion ?? DEFAULT_SERVER_VERSION;
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: TEXPRESSO_WS_LIMITS.maxMessageBytes,
    perMessageDeflate: false
  });
  const context: RequestContext = {
    isPdflatexAvailable,
    allowedOrigins,
    serverVersion,
    activeCompilations: new Set(),
    activeLiveSessions: new Set(),
    webSocketServer
  };

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, context);
    } catch (error) {
      // Never let malformed network input terminate the local server process.
      sendJson(response, 500, {
        error: {
          code: "internal-server-error",
          message: error instanceof Error ? error.message : "Unexpected server error."
        }
      });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== TEXPRESSO_WS_ROUTE) {
      rejectUpgrade(socket, 404, "No experimental WebSocket route matches this request.");
      return;
    }
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      rejectUpgrade(socket, 403, "WebSocket origin is not allowed.");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      let liveSession: TexpressoLiveSession;
      liveSession = new TexpressoLiveSession(webSocket, () => context.activeLiveSessions.delete(liveSession));
      context.activeLiveSessions.add(liveSession);
    });
  });
  serverContexts.set(server, context);
  return server;
}

/** Stops new work and terminates active compiler and TeXpresso process groups before closing. */
export async function shutdownTyprServer(server: Server): Promise<void> {
  const context = serverContexts.get(server);
  for (const compilation of context?.activeCompilations ?? []) {
    compilation.abort();
  }
  await Promise.allSettled([...(context?.activeLiveSessions ?? [])].map((session) => session.close("server-shutdown")));
  await new Promise<void>((resolveWebSockets) => {
    if (!context) return resolveWebSockets();
    context.webSocketServer.close(() => resolveWebSockets());
  });
  await new Promise<void>((resolveShutdown, rejectShutdown) => {
    server.close((error) => (error ? rejectShutdown(error) : resolveShutdown()));
  });
}

export async function hostHasPdflatex(): Promise<boolean> {
  pdflatexAvailability ??= commandAvailable("pdflatex");
  return pdflatexAvailability;
}

export function validateCompileRequest(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return invalid("Request body must be a JSON object.");
  }

  if (!isInteger(value.protocolVersion)) {
    return invalid("protocolVersion must be an integer.");
  }

  if (typeof value.engine !== "string" || value.engine.trim() === "") {
    return invalid("engine must be a non-empty string.");
  }

  const mainFilePath = value.mainFilePath;
  const mainPathError = validateProjectPath(mainFilePath, "mainFilePath");
  if (mainPathError) {
    return invalid(mainPathError);
  }
  if (typeof mainFilePath !== "string") {
    return invalid("mainFilePath must be a non-empty relative path.");
  }

  if (!Array.isArray(value.files)) {
    return invalid("files must be an array.");
  }

  const files: ProjectFile[] = [];
  const seenPaths = new Set<string>();
  for (let index = 0; index < value.files.length; index += 1) {
    const file = value.files[index];
    if (!isRecord(file)) {
      return invalid(`files[${index}] must be an object.`);
    }

    const filePath = file.path;
    const pathError = validateProjectPath(filePath, `files[${index}].path`);
    if (pathError) {
      return invalid(pathError);
    }
    if (typeof filePath !== "string") {
      return invalid(`files[${index}].path must be a non-empty relative path.`);
    }

    if (seenPaths.has(filePath)) {
      return invalid(`files[${index}].path duplicates another project file.`);
    }
    seenPaths.add(filePath);

    if (file.kind === "text") {
      if (typeof file.content !== "string") {
        return invalid(`files[${index}].content must be a string for a text file.`);
      }
      files.push({ path: filePath, kind: "text", content: file.content });
      continue;
    }

    if (file.kind === "binary") {
      if (file.encoding !== "base64" || typeof file.content !== "string" || !isBase64(file.content)) {
        return invalid(`files[${index}] must contain valid base64 binary content.`);
      }
      files.push({
        path: filePath,
        kind: "binary",
        encoding: "base64",
        content: file.content
      });
      continue;
    }

    return invalid(`files[${index}].kind must be \"text\" or \"binary\".`);
  }

  if (!seenPaths.has(mainFilePath)) {
    return invalid("mainFilePath must identify one of the supplied files.");
  }

  return {
    ok: true,
    request: {
      protocolVersion: value.protocolVersion,
      engine: value.engine as CompileEngine,
      mainFilePath,
      files
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  applyCorsHeaders(request, response, context.allowedOrigins);

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  if (request.method === "GET" && url.pathname === TYPR_COMPANION_ROUTES.status) {
    const engines: CompileEngine[] = (await context.isPdflatexAvailable()) ? [...IMPLEMENTED_ENGINES] : [];
    const capabilities: CompanionCapabilities = {
      compile: { engines },
      filesystem: { projectStorage: false },
      lsp: { languages: [] },
      git: { enabled: false },
      terminal: { enabled: false }
    };
    const status: CompanionStatusResponse = {
      protocolVersion: TYPR_COMPANION_PROTOCOL_VERSION,
      serverVersion: context.serverVersion,
      capabilities
    };
    sendJson(response, 200, status);
    return;
  }

  if (request.method === "POST" && url.pathname === TYPR_COMPANION_ROUTES.compile) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendClientError(response, body.status, body.message);
      return;
    }

    const validation = validateCompileRequest(body.value);
    if (!validation.ok) {
      sendClientError(response, 400, validation.message);
      return;
    }

    if (validation.request.protocolVersion !== TYPR_COMPANION_PROTOCOL_VERSION) {
      sendClientError(
        response,
        400,
        `Unsupported protocolVersion ${validation.request.protocolVersion}; expected ${TYPR_COMPANION_PROTOCOL_VERSION}.`,
        "unsupported-protocol-version"
      );
      return;
    }

    if (validation.request.engine !== "pdflatex") {
      sendClientError(
        response,
        422,
        `Unsupported compile engine: ${validation.request.engine}.`,
        "unsupported-engine"
      );
      return;
    }

    const compilation = new AbortController();
    context.activeCompilations.add(compilation);
    let result: CompileResult;
    try {
      result = await compileProject(validation.request, context.isPdflatexAvailable, compilation.signal);
    } finally {
      context.activeCompilations.delete(compilation);
    }
    sendJson(response, 200, result);
    return;
  }

  sendJson(response, 404, {
    error: { code: "not-found", message: "No Companion route matches this request." }
  });
}

async function compileProject(
  request: CompileRequest,
  isPdflatexAvailable: () => Promise<boolean>,
  signal?: AbortSignal
): Promise<CompileResult> {
  const startedAt = performance.now();
  if (!(await isPdflatexAvailable())) {
    return compileFailure(
      request.engine,
      "native-compiler-unavailable",
      "pdflatex is not available on this host. Install a native TeX distribution and try again.",
      "",
      startedAt
    );
  }

  const workspace = await mkdtemp(join(tmpdir(), "typr-companion-"));
  try {
    await materializeProjectFiles(workspace, request.files);
    const nativeResult = await runPdflatexProject(workspace, request.mainFilePath, signal);
    const log = await collectCompileLog(workspace, request.mainFilePath, nativeResult);
    const pdfPath = await findOutputPdf(workspace, request.mainFilePath);

    if (nativeResult.exitCode === 0 && pdfPath) {
      return {
        ok: true,
        engine: request.engine,
        output: {
          path: relative(workspace, pdfPath).replaceAll("\\", "/"),
          mediaType: "application/pdf",
          encoding: "base64",
          content: (await readFile(pdfPath)).toString("base64")
        },
        log,
        durationMs: elapsedSince(startedAt)
      };
    }

    const latexError = extractLatexError(log);
    return compileFailure(
      request.engine,
      "latex-compile-failed",
      latexError.message,
      log,
      startedAt,
      latexError.path ?? request.mainFilePath,
      latexError.line
    );
  } catch (error) {
    return compileFailure(
      request.engine,
      "native-compiler-error",
      error instanceof Error ? error.message : "Native LaTeX compilation failed.",
      "",
      startedAt
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runPdflatexProject(
  workspace: string,
  mainFilePath: string,
  signal?: AbortSignal
): Promise<NativeRunResult> {
  if (await commandAvailable("latexmk")) {
    return runCommand(
      "latexmk",
      ["-pdf", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", mainFilePath],
      workspace,
      signal
    );
  }

  let result: NativeRunResult = { exitCode: 0, signal: null, stdout: "", stderr: "" };
  for (let pass = 1; pass <= 3; pass += 1) {
    result = await runCommand(
      "pdflatex",
      ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", mainFilePath],
      workspace,
      signal
    );
    result.stdout = `--- pdflatex pass ${pass} ---\n${result.stdout}`;
    if (result.exitCode !== 0) {
      break;
    }
  }
  return result;
}

function runCommand(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<NativeRunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd, detached, shell: false });
    let stdout = "";
    let stderr = "";
    const stopProcess = () => {
      try {
        if (detached && child.pid) {
          // latexmk may have started pdflatex; signal the Unix process group so
          // a container shutdown cannot leave that child compiler behind.
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // The compiler may have completed between the shutdown signal and kill.
      }
    };
    if (signal?.aborted) {
      stopProcess();
    } else {
      signal?.addEventListener("abort", stopProcess, { once: true });
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", stopProcess);
      rejectRun(error);
    });
    child.once("close", (exitCode, childSignal) => {
      signal?.removeEventListener("abort", stopProcess);
      resolveRun({ exitCode, signal: childSignal, stdout, stderr });
    });
  });
}

async function collectCompileLog(
  workspace: string,
  mainFilePath: string,
  nativeResult: NativeRunResult
): Promise<string> {
  const logPath = replaceExtension(resolveProjectPath(workspace, mainFilePath), ".log");
  let compilerLog = "";
  try {
    compilerLog = await readFile(logPath, "utf8");
  } catch {
    // A launch or very early compiler failure may not create a .log file.
  }
  return [nativeResult.stdout, nativeResult.stderr, compilerLog].filter(Boolean).join("\n");
}

async function findOutputPdf(workspace: string, mainFilePath: string): Promise<string | undefined> {
  const expected = replaceExtension(resolveProjectPath(workspace, mainFilePath), ".pdf");
  if (await exists(expected)) {
    return expected;
  }

  const pdfs = await findFilesWithExtension(workspace, ".pdf");
  return pdfs.length === 1 ? pdfs[0] : undefined;
}

async function findFilesWithExtension(directory: string, extension: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findFilesWithExtension(entryPath, extension)));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function replaceExtension(filePath: string, extension: string): string {
  return join(dirname(filePath), `${basename(filePath, extname(filePath))}${extension}`);
}

function extractLatexError(log: string): { message: string; path?: string; line?: number } {
  const fileLineMatch = log.match(/(?:^|\n)(?:\.\/)?([^:\n]+\.tex):(\d+):\s+(.+)/);
  if (fileLineMatch) {
    return {
      path: fileLineMatch[1],
      line: Number.parseInt(fileLineMatch[2], 10),
      message: fileLineMatch[3].trim()
    };
  }

  const bangMatch = log.match(/^!\s*(.+)$/m);
  const lineMatch = log.match(/^l\.(\d+)/m);
  return {
    message: bangMatch?.[1]?.trim() || "Native LaTeX compilation failed; see log for details.",
    ...(lineMatch ? { line: Number.parseInt(lineMatch[1], 10) } : {})
  };
}

function compileFailure(
  engine: CompileEngine,
  code: string,
  message: string,
  log: string,
  startedAt: number,
  path?: string,
  line?: number
): CompileFailure {
  return {
    ok: false,
    engine,
    errors: [{ code, message, ...(path ? { path } : {}), ...(line ? { line } : {}) }],
    log,
    durationMs: elapsedSince(startedAt)
  };
}

function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

async function readJsonBody(request: IncomingMessage): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; message: string }
> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    request.resume();
    return { ok: false, status: 413, message: "Request body is too large." };
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) {
      return { ok: false, status: 413, message: "Request body is too large." };
    }
    chunks.push(buffer);
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, message: "Request body must contain valid JSON." };
  }
}

function applyCorsHeaders(request: IncomingMessage, response: ServerResponse, allowedOrigins: ReadonlySet<string>): void {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    response.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
  }
}

function getAllowedOriginsFromEnvironment(): ReadonlySet<string> {
  const configured = process.env.TYPR_COMPANION_ALLOWED_ORIGINS;
  if (!configured) {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  return new Set(configured.split(",").map((origin) => origin.trim()).filter(Boolean));
}

function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const child = spawn(command, ["--version"], { shell: false, stdio: "ignore" });
    child.once("error", () => resolveAvailability(false));
    child.once("close", (code) => resolveAvailability(code === 0));
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isBase64(value: string): boolean {
  return value.length % 4 !== 1 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}={0,2}|[A-Za-z0-9+/]{3}={0,1})?$/.test(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): ValidationFailure {
  return { ok: false, message };
}

function sendClientError(response: ServerResponse, status: number, message: string, code = "invalid-request"): void {
  sendJson(response, status, { error: { code, message } });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Not Found"}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}
