import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { AccessStore } from "./accessStore.ts";
import { ActivityBus } from "./activity.ts";
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
    await expect(response.text()).resolves.toContain("Typr Companion Console");
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
  activity = new ActivityBus()
): Promise<string> {
  const resolvedAccess = await access;
  const server = createManagementServer({ access: resolvedAccess, activity, servicePort: 8484, getServices: async () => services });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Management test server did not listen.");
  return `http://127.0.0.1:${address.port}`;
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
