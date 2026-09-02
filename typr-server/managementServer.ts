import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AccessStore, AccessStoreError } from "./accessStore.ts";
import { ActivityBus, type ActivityEvent } from "./activity.ts";
import { ManagementAuthenticator, type ManagementSession } from "./managementAuth.ts";
import { MANAGEMENT_LOGIN_HTML, MANAGEMENT_UI_HTML } from "./managementUi.ts";
import { ProviderManager, ProviderManagerError } from "./providerManager.ts";
import { activeTexPackageManager } from "./texPackageManager.ts";

export type ManagedServiceStatus = "ready" | "busy" | "degraded" | "detected" | "unavailable" | "error";

export interface ManagedServiceDescriptor {
  id: string;
  name: string;
  kind: "api" | "compiler" | "live-preview" | "workspace" | "lsp";
  status: ManagedServiceStatus;
  advertised: boolean;
  active: number;
  description: string;
  capabilities: string[];
  provider?: {
    executable?: string;
    version?: string;
    source: "embedded" | "configured" | "path" | "not-found";
  };
}

export interface ManagementServerOptions {
  access: AccessStore;
  activity: ActivityBus;
  providers?: ProviderManager;
  servicePort: number;
  getServices: (forceRefresh?: boolean) => Promise<ManagedServiceDescriptor[]>;
  allowRemote?: boolean;
  authenticator?: ManagementAuthenticator;
  publicOrigin?: string;
}

interface ManagementContext {
  clients: Set<ServerResponse>;
}

const contexts = new WeakMap<Server, ManagementContext>();
const MAX_MANAGEMENT_BODY_BYTES = 64 * 1024;
const MANAGEMENT_HEADER = "x-typr-management";
const CSRF_HEADER = "x-typr-csrf";
const MANAGEMENT_CSP = contentSecurityPolicy([MANAGEMENT_LOGIN_HTML, MANAGEMENT_UI_HTML]);

/** Creates the management GUI/API server. Remote mode requires session authentication. */
export function createManagementServer(options: ManagementServerOptions): Server {
  if (options.allowRemote && !options.authenticator) throw new Error("Remote management requires configured administrator authentication.");
  const publicOrigin = options.publicOrigin ? normalizePublicOrigin(options.publicOrigin) : undefined;
  if (publicOrigin && !options.authenticator?.secureCookies) {
    throw new Error("Public management requires secure session cookies.");
  }
  const context: ManagementContext = { clients: new Set() };
  const server = createServer(async (request, response) => {
    applySecurityHeaders(response, Boolean(publicOrigin));
    try {
      if (!options.allowRemote && !hasLoopbackHost(request)) {
        sendJson(response, 421, { error: { code: "loopback-host-required", message: "Management accepts loopback Host headers only." } });
        return;
      }
      if (publicOrigin && !hasExpectedPublicHost(request, publicOrigin)) {
        sendJson(response, 421, { error: { code: "management-host-mismatch", message: "Management Host does not match its configured public origin." } });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const session = options.authenticator?.session(request.headers.cookie);
      if (request.method === "GET" && url.pathname === "/login") {
        if (session) redirect(response, "/");
        else sendHtml(response, MANAGEMENT_LOGIN_HTML);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        if (!options.authenticator) {
          sendJson(response, 404, { error: { code: "authentication-disabled", message: "Management login is disabled in local mode." } });
          return;
        }
        requireSameOrigin(request, publicOrigin);
        const body = await readManagementBody(request);
        if (!isRecord(body) || typeof body.username !== "string" || typeof body.password !== "string") {
          throw invalidBody("Login body must contain username and password.");
        }
        const login = await options.authenticator.login(
          body.username,
          body.password,
          request.socket.remoteAddress ?? "unknown"
        );
        if (!login.ok) {
          if (login.retryAfterSeconds) response.setHeader("Retry-After", String(login.retryAfterSeconds));
          sendJson(response, login.retryAfterSeconds ? 429 : 401, {
            error: { code: "management-login-failed", message: "The username or password was not accepted." }
          });
          return;
        }
        response.setHeader("Set-Cookie", login.setCookie!);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (options.authenticator && !session) {
        if (request.method === "GET" && url.pathname === "/") redirect(response, "/login");
        else sendJson(response, 401, { error: { code: "management-authentication-required", message: "Management administrator authentication is required." } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        requireManagementIntent(request, options.authenticator, session);
        response.setHeader("Set-Cookie", options.authenticator!.logout(request.headers.cookie));
        sendJson(response, 200, { ok: true });
        return;
      }
      await handleManagementRequest(request, response, server, context, options, session);
    } catch (error) {
      if (error instanceof AccessStoreError || error instanceof ProviderManagerError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      sendJson(response, 500, {
        error: { code: "management-error", message: error instanceof Error ? error.message : "Management request failed." }
      });
    }
  });
  contexts.set(server, context);
  return server;
}

export async function shutdownManagementServer(server: Server): Promise<void> {
  const context = contexts.get(server);
  for (const client of context?.clients ?? []) client.end();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function handleManagementRequest(
  request: IncomingMessage,
  response: ServerResponse,
  server: Server,
  context: ManagementContext,
  options: ManagementServerOptions,
  session: ManagementSession | undefined
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, MANAGEMENT_UI_HTML);
    return;
  }
  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/snapshot") {
    const address = server.address();
    sendJson(response, 200, {
      servicePort: options.servicePort,
      managementPort: address && typeof address !== "string" ? address.port : null,
      management: {
        authenticated: Boolean(session),
        ...(session ? { username: session.username, csrfToken: session.csrfToken, expiresAt: session.expiresAt } : {}),
        publicOrigin: options.publicOrigin ?? null
      },
      providerManagement: options.providers?.snapshot() ?? { enabled: false, providers: [], jobs: [] },
      services: await options.getServices(),
      access: options.access.snapshot(),
      activity: options.activity.snapshot({ limit: 1_000 })
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    openActivityStream(request, response, context, options.activity);
    return;
  }
  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "GET, POST, PATCH, DELETE");
    response.writeHead(204).end();
    return;
  }
  requireManagementIntent(request, options.authenticator, session);

  if (request.method === "POST" && url.pathname === "/api/services/refresh") {
    await options.getServices(true);
    options.activity.publish({
      serviceId: "management",
      level: "info",
      type: "providers-refreshed",
      message: "Provider discovery was refreshed from the management console."
    });
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/texlive/update") {
    const result = await activeTexPackageManager().updateAll(AbortSignal.timeout(15 * 60_000));
    options.activity.publish({
      serviceId: "latex",
      level: result.updated ? "info" : "error",
      type: result.updated ? "texlive-updated" : "texlive-update-failed",
      message: result.diagnostic
    });
    if (!result.updated) throw new ProviderManagerError(502, "texlive-update-failed", result.diagnostic);
    sendJson(response, 200, { result });
    return;
  }
  const providerInstallMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/install$/u);
  if (request.method === "POST" && providerInstallMatch) {
    if (!options.providers) throw new ProviderManagerError(409, "provider-management-disabled", "Provider management is disabled.");
    const job = options.providers.startInstall(decodeURIComponent(providerInstallMatch[1]));
    options.activity.publish({
      serviceId: `provider-${job.providerId}`,
      level: "info",
      type: "provider-install-queued",
      message: `Queued installation for ${job.providerId}.`,
      metadata: { jobId: job.id }
    });
    sendJson(response, 202, { job });
    return;
  }
  const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/u);
  if (request.method === "PATCH" && providerMatch) {
    if (!options.providers) throw new ProviderManagerError(409, "provider-management-disabled", "Provider management is disabled.");
    const body = await readManagementBody(request);
    if (!isRecord(body) || body.active !== true) throw invalidBody("Provider update must set active to true.");
    await options.providers.activateTexProvider(decodeURIComponent(providerMatch[1]));
    options.activity.publish({
      serviceId: "latex",
      level: "info",
      type: "tex-provider-activated",
      message: `Activated TeX provider ${decodeURIComponent(providerMatch[1])}.`
    });
    sendJson(response, 200, { providerManagement: options.providers.snapshot() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/users") {
    const body = await readManagementBody(request);
    if (!isRecord(body) || typeof body.name !== "string") throw invalidBody("User body must contain a name.");
    const user = await options.access.createUser(body.name);
    options.activity.publish({ serviceId: "management", level: "info", type: "user-created", message: `Created user ${user.name}.` });
    sendJson(response, 201, { user });
    return;
  }
  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/u);
  if (request.method === "PATCH" && userMatch) {
    const body = await readManagementBody(request);
    if (!isRecord(body) || typeof body.disabled !== "boolean") throw invalidBody("User update must contain disabled.");
    const user = await options.access.setUserDisabled(decodeURIComponent(userMatch[1]), body.disabled);
    options.activity.publish({
      serviceId: "management",
      level: body.disabled ? "warning" : "info",
      type: body.disabled ? "user-disabled" : "user-enabled",
      message: `${body.disabled ? "Disabled" : "Enabled"} user ${user.name}.`
    });
    sendJson(response, 200, { user });
    return;
  }
  const keyCreateMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/keys$/u);
  if (request.method === "POST" && keyCreateMatch) {
    const body = await readManagementBody(request);
    if (!isRecord(body) || typeof body.label !== "string") throw invalidBody("API key body must contain a label.");
    const created = await options.access.createApiKey(decodeURIComponent(keyCreateMatch[1]), body.label);
    options.activity.publish({ serviceId: "management", level: "info", type: "api-key-created", message: `Created API key ${created.key.label}.` });
    sendJson(response, 201, created);
    return;
  }
  const keyMatch = url.pathname.match(/^\/api\/keys\/([^/]+)$/u);
  if (request.method === "DELETE" && keyMatch) {
    const key = await options.access.revokeApiKey(decodeURIComponent(keyMatch[1]));
    options.activity.publish({ serviceId: "management", level: "warning", type: "api-key-revoked", message: `Revoked API key ${key.label}.` });
    sendJson(response, 200, { key });
    return;
  }
  if (request.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readManagementBody(request);
    if (!isRecord(body) || typeof body.requireApiKeys !== "boolean") throw invalidBody("Settings body must contain requireApiKeys.");
    await options.access.setRequireApiKeys(body.requireApiKeys);
    options.activity.publish({
      serviceId: "management",
      level: body.requireApiKeys ? "warning" : "info",
      type: "api-authentication-changed",
      message: `Service API-key authentication ${body.requireApiKeys ? "enabled" : "disabled"}.`
    });
    sendJson(response, 200, { requireApiKeys: body.requireApiKeys });
    return;
  }
  sendJson(response, 404, { error: { code: "not-found", message: "No management route matches this request." } });
}

function openActivityStream(
  request: IncomingMessage,
  response: ServerResponse,
  context: ManagementContext,
  activity: ActivityBus
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  context.clients.add(response);
  const afterId = Number(request.headers["last-event-id"] ?? 0);
  for (const event of activity.snapshot({ afterId: Number.isSafeInteger(afterId) ? afterId : 0 })) writeEvent(response, event);
  const unsubscribe = activity.subscribe((event) => writeEvent(response, event));
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    context.clients.delete(response);
  });
}

function writeEvent(response: ServerResponse, event: ActivityEvent): void {
  response.write(`id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`);
}

async function readManagementBody(request: IncomingMessage): Promise<unknown> {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new AccessStoreError(415, "content-type-required", "Management mutations require application/json.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_MANAGEMENT_BODY_BYTES) throw new AccessStoreError(413, "body-too-large", "Management request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidBody("Management request body must contain valid JSON.");
  }
}

function requireManagementIntent(
  request: IncomingMessage,
  authenticator: ManagementAuthenticator | undefined,
  session: ManagementSession | undefined
): void {
  if (request.headers[MANAGEMENT_HEADER] !== "1") {
    throw new AccessStoreError(400, "management-header-required", "X-Typr-Management: 1 is required for management mutations.");
  }
  if (authenticator && (!session || !authenticator.validCsrf(session, stringHeader(request.headers[CSRF_HEADER])))) {
    throw new AccessStoreError(403, "management-csrf-required", "A valid management CSRF token is required.");
  }
}

function hasLoopbackHost(request: IncomingMessage): boolean {
  if (!request.headers.host) return false;
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function applySecurityHeaders(response: ServerResponse, publicMode: boolean): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", MANAGEMENT_CSP);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  if (publicMode) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json) });
  response.end(json);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location, "Content-Length": "0" });
  response.end();
}

function normalizePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TYPR_COMPANION_MANAGEMENT_PUBLIC_ORIGIN must be an exact HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TYPR_COMPANION_MANAGEMENT_PUBLIC_ORIGIN must be an exact HTTPS origin.");
  }
  return url.origin;
}

function hasExpectedPublicHost(request: IncomingMessage, publicOrigin: string): boolean {
  return request.headers.host?.toLowerCase() === new URL(publicOrigin).host.toLowerCase();
}

function requireSameOrigin(request: IncomingMessage, publicOrigin: string | undefined): void {
  const origin = stringHeader(request.headers.origin);
  if (publicOrigin) {
    if (origin !== publicOrigin) throw new AccessStoreError(403, "management-origin-forbidden", "Management login requires its configured public origin.");
    return;
  }
  if (!origin) return;
  const host = request.headers.host;
  try {
    if (!host || new URL(origin).host.toLowerCase() !== host.toLowerCase()) throw new Error("mismatch");
  } catch {
    throw new AccessStoreError(403, "management-origin-forbidden", "Management login requires a same-origin request.");
  }
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentSecurityPolicy(documents: string[]): string {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const document of documents) {
    for (const match of document.matchAll(/<script>([\s\S]*?)<\/script>/gu)) scripts.add(cspHash(match[1]));
    for (const match of document.matchAll(/<style>([\s\S]*?)<\/style>/gu)) styles.add(cspHash(match[1]));
  }
  return [
    "default-src 'none'",
    `script-src ${[...scripts].join(" ")}`,
    `style-src ${[...styles].join(" ")}`,
    "connect-src 'self'",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join("; ");
}

function cspHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

function invalidBody(message: string): AccessStoreError {
  return new AccessStoreError(400, "invalid-management-request", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
