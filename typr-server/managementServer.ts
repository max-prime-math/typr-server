import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AccessStore, AccessStoreError } from "./accessStore.ts";
import { ActivityBus, type ActivityEvent } from "./activity.ts";
import { MANAGEMENT_UI_HTML } from "./managementUi.ts";

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
  servicePort: number;
  getServices: (forceRefresh?: boolean) => Promise<ManagedServiceDescriptor[]>;
  allowRemote?: boolean;
  administratorPassword?: string;
}

interface ManagementContext {
  clients: Set<ServerResponse>;
}

const contexts = new WeakMap<Server, ManagementContext>();
const MAX_MANAGEMENT_BODY_BYTES = 64 * 1024;
const MANAGEMENT_HEADER = "x-typr-management";

/** Creates the management GUI/API server. Remote mode requires HTTP Basic authentication. */
export function createManagementServer(options: ManagementServerOptions): Server {
  if (options.allowRemote && !validAdministratorPassword(options.administratorPassword)) {
    throw new Error("Remote management requires a TYPR_COMPANION_MANAGEMENT_PASSWORD of at least 24 characters.");
  }
  const context: ManagementContext = { clients: new Set() };
  const server = createServer(async (request, response) => {
    applySecurityHeaders(response);
    if (!options.allowRemote && !hasLoopbackHost(request)) {
      sendJson(response, 421, { error: { code: "loopback-host-required", message: "Management accepts loopback Host headers only." } });
      return;
    }
    if (options.administratorPassword && !hasAdministratorAuthorization(request, options.administratorPassword)) {
      response.setHeader("WWW-Authenticate", 'Basic realm="Typr Companion Management", charset="UTF-8"');
      sendJson(response, 401, { error: { code: "management-authentication-required", message: "Management administrator authentication is required." } });
      return;
    }
    try {
      await handleManagementRequest(request, response, server, context, options);
    } catch (error) {
      if (error instanceof AccessStoreError) {
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
  options: ManagementServerOptions
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
  requireManagementIntent(request);

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

function requireManagementIntent(request: IncomingMessage): void {
  if (request.headers[MANAGEMENT_HEADER] !== "1") {
    throw new AccessStoreError(400, "management-header-required", "X-Typr-Management: 1 is required for management mutations.");
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

function hasAdministratorAuthorization(request: IncomingMessage, password: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0 || decoded.slice(0, separator) !== "typr") return false;
  const supplied = Buffer.from(decoded.slice(separator + 1), "utf8");
  const expected = Buffer.from(password, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function validAdministratorPassword(password: string | undefined): password is string {
  return Boolean(password && password.length >= 24);
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
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

function invalidBody(message: string): AccessStoreError {
  return new AccessStoreError(400, "invalid-management-request", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
