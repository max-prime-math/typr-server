import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { AccessStore } from "./accessStore.ts";
import { ActivityBus } from "./activity.ts";
import { ManagementAuthenticator } from "./managementAuth.ts";
import { createManagementServer, shutdownManagementServer, type ManagedServiceDescriptor } from "./managementServer.ts";

const servers: Server[] = [];
const services: ManagedServiceDescriptor[] = [{
  id: "companion-api",
  name: "Companion API",
  kind: "api",
  status: "ready",
  advertised: true,
  active: 0,
  description: "Test API",
  capabilities: ["status"]
}];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => shutdownManagementServer(server)));
});

describe("management GUI server", () => {
  it("serves the console on a separate port with restrictive browser headers", async () => {
    const baseUrl = await startManagementServer();
    const response = await fetch(baseUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    const html = await response.text();
    expect(html).toContain("Typr Companion Console");
    expect(html).toContain('id="showApiRequests"');
    expect(html).toContain("event.type === 'request-started' || event.type === 'request-completed'");
  });

  it("requires administrator authentication before allowing remote management", async () => {
    const password = "correct-horse-battery-staple";
    expect(() => createManagementServer({
      access: {} as AccessStore,
      activity: new ActivityBus(),
      servicePort: 8484,
      getServices: async () => services,
      allowRemote: true
    })).toThrow(/requires configured administrator authentication/u);

    const authenticator = await testAuthenticator(password);
    const baseUrl = await startManagementServer(undefined, new ActivityBus(), {
      allowRemote: true,
      authenticator
    });
    const unauthorized = await fetch(`${baseUrl}/api/snapshot`);
    expect(unauthorized.status).toBe(401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { Origin: new URL(baseUrl).origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "typr", password })
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");

    const authorized = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Cookie: cookie! }
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({ management: { authenticated: true, username: "typr" } });
  });

  it("requires an exact HTTPS public origin and CSRF token for authenticated mutations", async () => {
    const authenticator = await testAuthenticator("correct-horse-battery-staple", true);
    const baseUrl = await startManagementServer(undefined, new ActivityBus(), {
      allowRemote: true,
      authenticator,
      publicOrigin: "https://companion.example.test"
    });
    await expect(statusWithHost(`${baseUrl}/login`, "wrong.example.test")).resolves.toBe(421);

    const login = await requestWithHost(`${baseUrl}/api/auth/login`, "POST", {
        Host: "companion.example.test",
        Origin: "https://companion.example.test",
        "Content-Type": "application/json"
      },
      { username: "typr", password: "correct-horse-battery-staple" });
    expect(login.status).toBe(200);
    const cookie = String(login.headers["set-cookie"]?.[0] ?? login.headers["set-cookie"] ?? "");
    expect(cookie).toContain("; Secure");
    const snapshotResponse = await requestWithHost(`${baseUrl}/api/snapshot`, "GET", {
      Host: "companion.example.test", Cookie: cookie
    });
    const snapshot = snapshotResponse.body;

    const missingCsrf = await requestWithHost(`${baseUrl}/api/services/refresh`, "POST", {
        Host: "companion.example.test",
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Typr-Management": "1"
      },
      {});
    expect(missingCsrf.status).toBe(403);
    const accepted = await requestWithHost(`${baseUrl}/api/services/refresh`, "POST", {
        Host: "companion.example.test",
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Typr-Management": "1",
        "X-Typr-CSRF": snapshot.management.csrfToken
      },
      {});
    expect(accepted.status).toBe(200);
  });

  it("retains the loopback Host boundary in local mode", async () => {
    const baseUrl = await startManagementServer();
    await expect(statusWithHost(baseUrl, "unraid.example")).resolves.toBe(421);
  });

  it("manages users, one-time keys, and API-key enforcement", async () => {
    const access = await AccessStore.open();
    const baseUrl = await startManagementServer(access);
    const missingIntent = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Editor" })
    });
    expect(missingIntent.status).toBe(400);

    const createdUser = await mutate(baseUrl, "/api/users", "POST", { name: "Editor" });
    const createdKey = await mutate(baseUrl, `/api/users/${createdUser.user.id}/keys`, "POST", { label: "Browser" });
    expect(createdKey.secret).toMatch(/^typr_/u);
    await mutate(baseUrl, "/api/settings", "PATCH", { requireApiKeys: true });

    const snapshot = await (await fetch(`${baseUrl}/api/snapshot`)).json();
    expect(snapshot).toMatchObject({
      servicePort: 8484,
      access: {
        requireApiKeys: true,
        users: [{ name: "Editor" }],
        keys: [{ label: "Browser", prefix: createdKey.key.prefix }]
      }
    });
    expect(JSON.stringify(snapshot)).not.toContain(createdKey.secret);
    expect(JSON.stringify(snapshot)).not.toContain('"hash"');
  });

  it("streams the bounded activity history as server-sent events", async () => {
    const activity = new ActivityBus();
    activity.publish({ serviceId: "latex", level: "info", type: "compile", message: "Compiled." });
    const baseUrl = await startManagementServer(undefined, activity);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    controller.abort();

    expect(Buffer.from(chunk.value!).toString("utf8")).toContain("event: activity");
    expect(Buffer.from(chunk.value!).toString("utf8")).toContain("Compiled.");
  });
});

async function startManagementServer(
  access: AccessStore | Promise<AccessStore> = newAccessStore(),
  activity = new ActivityBus(),
  options: Pick<Parameters<typeof createManagementServer>[0], "allowRemote" | "authenticator" | "publicOrigin"> = {}
): Promise<string> {
  const resolvedAccess = await access;
  const server = createManagementServer({
    access: resolvedAccess,
    activity,
    servicePort: 8484,
    getServices: async () => services,
    ...options
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Management test server did not listen.");
  return `http://127.0.0.1:${address.port}`;
}

function testAuthenticator(password: string, secureCookies = false): Promise<ManagementAuthenticator> {
  return ManagementAuthenticator.create({
    username: "typr",
    password,
    secureCookies,
    scryptOptions: { N: 1_024, r: 8, p: 1, maxmem: 16 * 1024 * 1024 }
  });
}

function statusWithHost(baseUrl: string, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(baseUrl, { headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

function requestWithHost(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<{ status: number | undefined; headers: import("node:http").IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.once("error", reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

function newAccessStore(): Promise<AccessStore> {
  return AccessStore.open();
}

async function mutate(baseUrl: string, path: string, method: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Typr-Management": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  expect(response.ok).toBe(true);
  return response.json();
}
