import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, mkdtemp, open as openFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import {
  TYPR_COMPANION_PROTOCOL_VERSION,
  TYPR_COMPANION_ROUTES,
  TYPR_WORKSPACE_MUTATION_HEADER,
  type CompanionCapabilities,
  type CompanionStatusResponse,
  type CompileEngine,
  type CompileFailure,
  type CompileRequest,
  type CompileResult,
  type ProjectFile,
  type WorkspaceFileWriteRequest
} from "../src/companion-protocol/index.ts";
import { materializeProjectFiles, resolveProjectPath, validateProjectPath } from "./projectFiles.ts";
import { TexpressoLiveSession } from "./texpressoLiveSession.ts";
import { TEXPRESSO_WS_LIMITS, TEXPRESSO_WS_ROUTE } from "./texpressoWsProtocol.ts";
import { WorkspaceError, type WorkspaceStore } from "./workspaceStore.ts";
import { NativeProcessError, type NativeProcessResult } from "./nativeProcess.ts";
import { isBase64 } from "./base64.ts";
import { runLatexProject } from "./latexProject.ts";
import { nativeToolAvailable } from "./nativeTools.ts";

export { materializeProjectFiles } from "./projectFiles.ts";

const DEFAULT_SERVER_VERSION = "0.1.3-dev";
const MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const MAX_PROJECT_FILES = 512;
const MAX_PROJECT_BYTES = 25 * 1024 * 1024;
const MAX_ACTIVE_COMPILATIONS = 2;
const MAX_ACTIVE_LIVE_SESSIONS = 2;
const COMPILE_TIMEOUT_MS = 30_000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
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
  workspace?: WorkspaceStore;
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
  workspace?: WorkspaceStore;
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
    webSocketServer,
    workspace: options.workspace
  };

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, context);
    } catch (error) {
      // Never let malformed network input terminate the local server process.
      if (error instanceof WorkspaceError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
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
    if (context.activeLiveSessions.size >= MAX_ACTIVE_LIVE_SESSIONS) {
      rejectUpgrade(socket, 429, "Companion is already running its maximum number of live compiler sessions.");
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
  pdflatexAvailability ??= nativeToolAvailable("pdflatex");
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
  if (value.files.length > MAX_PROJECT_FILES) {
    return invalid(`files must contain at most ${MAX_PROJECT_FILES} entries.`);
  }

  const files: ProjectFile[] = [];
  const seenPaths = new Set<string>();
  let decodedProjectBytes = 0;
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
      decodedProjectBytes += Buffer.byteLength(file.content);
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
      decodedProjectBytes += Buffer.from(file.content, "base64").byteLength;
      continue;
    }

    return invalid(`files[${index}].kind must be \"text\" or \"binary\".`);
  }

  if (!seenPaths.has(mainFilePath)) {
    return invalid("mainFilePath must identify one of the supplied files.");
  }
  if (decodedProjectBytes > MAX_PROJECT_BYTES) {
    return invalid("Decoded project files exceed the 25 MiB compilation limit.");
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
  applyCorsHeaders(request, response, context.allowedOrigins, url.pathname);

  if (isWorkspaceRoute(url.pathname) && request.headers.origin && !context.allowedOrigins.has(request.headers.origin)) {
    sendJson(response, 403, {
      error: { code: "workspace-origin-forbidden", message: "This browser origin may not access the mapped workspace." }
    });
    return;
  }

  if (request.method === "OPTIONS") {
    if (isWorkspaceRoute(url.pathname) && !context.workspace) {
      sendJson(response, 404, {
        error: { code: "workspace-disabled", message: "No mapped workspace is configured." }
      });
      return;
    }
    const preflight = validateCorsPreflight(request, url.pathname, context.allowedOrigins);
    if (!preflight.ok) {
      sendJson(response, preflight.status, {
        error: { code: preflight.code, message: preflight.message }
      });
      return;
    }
    response.writeHead(204).end();
    return;
  }

  if (request.method === "GET" && url.pathname === TYPR_COMPANION_ROUTES.status) {
    const engines: CompileEngine[] = (await context.isPdflatexAvailable()) ? [...IMPLEMENTED_ENGINES] : [];
    const capabilities: CompanionCapabilities = {
      compile: { engines },
      filesystem: context.workspace ? {
        projectStorage: true,
        workspaceApiVersion: 1,
        workspaceId: context.workspace.workspaceId,
        writable: true,
        limits: { ...context.workspace.limits }
      } : { projectStorage: false },
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

  if (isWorkspaceRoute(url.pathname)) {
    await handleWorkspaceRequest(request, response, url, context.workspace);
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

    if (context.activeCompilations.size >= MAX_ACTIVE_COMPILATIONS) {
      sendJson(response, 429, {
        error: { code: "server-busy", message: "Companion is already running its maximum number of native compilations." }
      });
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

async function handleWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  workspace: WorkspaceStore | undefined
): Promise<void> {
  if (!workspace) {
    sendJson(response, 404, {
      error: { code: "workspace-disabled", message: "No mapped workspace is configured." }
    });
    return;
  }

  if (url.pathname === TYPR_COMPANION_ROUTES.workspaceFiles) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET, OPTIONS");
      sendJson(response, 405, { error: { code: "method-not-allowed", message: "Workspace listing only supports GET." } });
      return;
    }
    sendJson(response, 200, await workspace.list());
    return;
  }

  const paths = url.searchParams.getAll("path");
  if (paths.length !== 1) {
    throw new WorkspaceError(400, "invalid-workspace-path", "Exactly one workspace path query parameter is required.");
  }
  const path = paths[0];

  if (request.method === "GET") {
    const file = await workspace.read(path);
    response.setHeader("ETag", file.etag);
    sendJson(response, 200, file);
    return;
  }

  if (request.method === "PUT") {
    requireWorkspaceMutationHeader(request);
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new WorkspaceError(415, "workspace-content-type", "Workspace writes require application/json.");
    }
    const ifNoneMatch = singleHeader(request.headers["if-none-match"]);
    const ifMatch = singleHeader(request.headers["if-match"]);
    if ((!ifNoneMatch && !ifMatch) || (ifNoneMatch && ifMatch)) {
      throw new WorkspaceError(428, "workspace-precondition-required", "Use If-None-Match: * to create or If-Match with the current ETag to update.");
    }
    if (ifNoneMatch && ifNoneMatch !== "*") {
      throw new WorkspaceError(400, "invalid-workspace-precondition", "Workspace create requires If-None-Match: *.");
    }
    if (ifMatch && !isStrongEtag(ifMatch)) {
      throw new WorkspaceError(400, "invalid-workspace-precondition", "Workspace update requires one quoted strong ETag.");
    }
    const body = await readJsonBody(request);
    if (!body.ok) throw new WorkspaceError(body.status, "invalid-workspace-request", body.message);
    if (!isWorkspaceWriteRequest(body.value)) {
      throw new WorkspaceError(400, "invalid-workspace-request", "Workspace write body must contain valid base64 content.");
    }
    const metadata = await workspace.write(
      path,
      Buffer.from(body.value.content, "base64"),
      ifNoneMatch ? { kind: "create" } : { kind: "update", etag: ifMatch! }
    );
    response.setHeader("ETag", metadata.etag);
    sendJson(response, ifNoneMatch ? 201 : 200, metadata);
    return;
  }

  if (request.method === "DELETE") {
    requireWorkspaceMutationHeader(request);
    const ifMatch = singleHeader(request.headers["if-match"]);
    if (!ifMatch) {
      throw new WorkspaceError(428, "workspace-precondition-required", "Workspace deletion requires If-Match with the current ETag.");
    }
    if (!isStrongEtag(ifMatch)) {
      throw new WorkspaceError(400, "invalid-workspace-precondition", "Workspace deletion requires one quoted strong ETag.");
    }
    await workspace.delete(path, ifMatch);
    response.writeHead(204).end();
    return;
  }

  response.setHeader("Allow", "GET, PUT, DELETE, OPTIONS");
  sendJson(response, 405, { error: { code: "method-not-allowed", message: "Unsupported workspace file method." } });
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
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), COMPILE_TIMEOUT_MS);
  const relayAbort = () => deadline.abort();
  signal?.addEventListener("abort", relayAbort, { once: true });
  try {
    await materializeProjectFiles(workspace, request.files);
    const nativeResult = await runLatexProject(workspace, request.mainFilePath, deadline.signal);
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
          content: (await readPdf(pdfPath)).toString("base64")
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
    if (error instanceof NativeProcessError) {
      return compileFailure(request.engine, error.code, error.message, "", startedAt);
    }
    if (error instanceof CompileOutputError) {
      return compileFailure(request.engine, error.code, error.message, "", startedAt);
    }
    return compileFailure(
      request.engine,
      "native-compiler-error",
      error instanceof Error ? error.message : "Native LaTeX compilation failed.",
      "",
      startedAt
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", relayAbort);
    await rm(workspace, { recursive: true, force: true });
  }
}

async function collectCompileLog(
  workspace: string,
  mainFilePath: string,
  nativeResult: NativeProcessResult
): Promise<string> {
  const logPath = replaceExtension(resolveProjectPath(workspace, mainFilePath), ".log");
  let compilerLog = "";
  try {
    compilerLog = await readTextCapped(logPath, MAX_LOG_BYTES);
  } catch {
    // A launch or very early compiler failure may not create a .log file.
  }
  return [nativeResult.stdout, nativeResult.stderr, compilerLog].filter(Boolean).join("\n");
}

async function findOutputPdf(workspace: string, mainFilePath: string): Promise<string | undefined> {
  const expected = replaceExtension(resolveProjectPath(workspace, mainFilePath), ".pdf");
  try {
    const info = await lstat(expected);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new CompileOutputError("compiler-output-invalid", "Compiler output is not a regular PDF file.");
    }
    if (info.size > MAX_PDF_BYTES) {
      throw new CompileOutputError("compiler-output-too-large", "Compiler PDF exceeds 32 MiB.");
    }
    return expected;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readPdf(path: string): Promise<Buffer> {
  const content = await readFile(path);
  if (content.byteLength > MAX_PDF_BYTES) {
    throw new CompileOutputError("compiler-output-too-large", "Compiler PDF exceeds 32 MiB.");
  }
  return content;
}

async function readTextCapped(path: string, maxBytes: number): Promise<string> {
  const handle = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const info = await handle.stat();
    return `${buffer.subarray(0, bytesRead).toString("utf8")}${info.size > maxBytes ? "\n[log truncated at 1 MiB]" : ""}`;
  } finally {
    await handle.close();
  }
}

class CompileOutputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompileOutputError";
    this.code = code;
  }
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

interface CorsRoutePolicy {
  methods: readonly string[];
  headersByMethod: Readonly<Record<string, readonly string[]>>;
}

function applyCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
  pathname: string
): void {
  const origin = request.headers.origin;
  const policy = getCorsRoutePolicy(pathname);
  if (origin && allowedOrigins.has(origin) && policy) {
    const allowedHeaders = [...new Set(Object.values(policy.headersByMethod).flat())];
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", `${policy.methods.join(", ")}, OPTIONS`);
    if (allowedHeaders.length > 0) response.setHeader("Access-Control-Allow-Headers", allowedHeaders.join(", "));
    response.setHeader("Access-Control-Expose-Headers", "ETag");
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    response.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
  }
}

function validateCorsPreflight(
  request: IncomingMessage,
  pathname: string,
  allowedOrigins: ReadonlySet<string>
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const origin = singleHeader(request.headers.origin);
  if (!origin || !allowedOrigins.has(origin)) {
    return { ok: false, status: 403, code: "cors-origin-forbidden", message: "This browser origin is not allowed." };
  }
  const policy = getCorsRoutePolicy(pathname);
  if (!policy) {
    return { ok: false, status: 404, code: "route-not-found", message: "No Companion API route exists at this path." };
  }
  const requestedMethod = singleHeader(request.headers["access-control-request-method"])?.toUpperCase();
  if (!requestedMethod || !policy.methods.includes(requestedMethod)) {
    return { ok: false, status: 405, code: "cors-method-forbidden", message: "The requested CORS method is not supported by this route." };
  }
  const allowedHeaders = new Set((policy.headersByMethod[requestedMethod] ?? []).map((header) => header.toLowerCase()));
  const requestedHeaderValue = request.headers["access-control-request-headers"];
  if (Array.isArray(requestedHeaderValue)) {
    return { ok: false, status: 400, code: "cors-header-forbidden", message: "The requested CORS headers are malformed." };
  }
  const requestedHeaders = requestedHeaderValue
    ? requestedHeaderValue.split(",")
    .map((header) => header.trim().toLowerCase())
    : [];
  if (requestedHeaders.some((header) => !header || !allowedHeaders.has(header))) {
    return { ok: false, status: 400, code: "cors-header-forbidden", message: "The requested CORS headers are not supported by this route." };
  }
  return { ok: true };
}

function getCorsRoutePolicy(pathname: string): CorsRoutePolicy | undefined {
  if (pathname === TYPR_COMPANION_ROUTES.status) {
    return { methods: ["GET"], headersByMethod: { GET: [] } };
  }
  if (pathname === TYPR_COMPANION_ROUTES.compile) {
    return { methods: ["POST"], headersByMethod: { POST: ["Content-Type"] } };
  }
  if (pathname === TYPR_COMPANION_ROUTES.workspaceFiles) {
    return { methods: ["GET"], headersByMethod: { GET: [] } };
  }
  if (pathname === TYPR_COMPANION_ROUTES.workspaceFile) {
    return {
      methods: ["GET", "PUT", "DELETE"],
      headersByMethod: {
        GET: [],
        PUT: ["Content-Type", "If-Match", "If-None-Match", TYPR_WORKSPACE_MUTATION_HEADER],
        DELETE: ["If-Match", TYPR_WORKSPACE_MUTATION_HEADER]
      }
    };
  }
  return undefined;
}

function getAllowedOriginsFromEnvironment(): ReadonlySet<string> {
  const configured = process.env.TYPR_COMPANION_ALLOWED_ORIGINS;
  if (!configured) {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  return new Set(configured.split(",").map((origin) => origin.trim()).filter(Boolean));
}

function isWorkspaceRoute(pathname: string): boolean {
  return pathname === TYPR_COMPANION_ROUTES.workspaceFiles || pathname === TYPR_COMPANION_ROUTES.workspaceFile;
}

function requireWorkspaceMutationHeader(request: IncomingMessage): void {
  if (singleHeader(request.headers[TYPR_WORKSPACE_MUTATION_HEADER.toLowerCase()]) !== "1") {
    throw new WorkspaceError(
      400,
      "workspace-mutation-header-required",
      `${TYPR_WORKSPACE_MUTATION_HEADER}: 1 is required for workspace mutations.`
    );
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || value.includes(",")) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isStrongEtag(value: string): boolean {
  return /^"[^"\r\n]+"$/u.test(value);
}

function isWorkspaceWriteRequest(value: unknown): value is WorkspaceFileWriteRequest {
  return isRecord(value) && value.encoding === "base64" && typeof value.content === "string" && isBase64(value.content);
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
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(payload);
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  const statusText = status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "Not Found";
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}
