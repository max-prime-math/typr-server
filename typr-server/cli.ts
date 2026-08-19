import type { Server } from "node:http";
import { join } from "node:path";
import { AccessStore } from "./accessStore.ts";
import { ActivityBus } from "./activity.ts";
import { createManagementServer, shutdownManagementServer, type ManagedServiceDescriptor } from "./managementServer.ts";
import { createTyprServer, getCompanionRuntimeSnapshot, shutdownTyprServer } from "./server.ts";
import { ServiceCatalog } from "./serviceCatalog.ts";
import { WorkspaceStore } from "./workspaceStore.ts";
import { parseUnsandboxedStatelessOptIn, resolveNativeSandbox } from "./sandboxPolicy.ts";
import { prepareWindowsPortableRuntime, windowsCompanionDataRoot } from "./windowsPortable.ts";

await prepareWindowsPortableRuntime();

const port = parsePort(process.env.TYPR_COMPANION_PORT, 8484);
const managementPort = parsePort(process.env.TYPR_COMPANION_MANAGEMENT_PORT, 8485);
if (managementPort === port) throw new Error("The Companion service and management GUI must use different ports.");
const host = process.env.TYPR_COMPANION_HOST ?? "127.0.0.1";
const configuredVersion = process.env.TYPR_COMPANION_VERSION?.trim();
const workspaceRoot = process.env.TYPR_COMPANION_WORKSPACE_ROOT?.trim();
const sandboxExecutable = await resolveNativeSandbox({
  allowUnsandboxedStateless: parseUnsandboxedStatelessOptIn(
    process.env.TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS
  ),
  sandboxExecutable: process.env.TYPR_COMPANION_SANDBOX_EXECUTABLE,
  workspaceRoot,
  onFallback: (message) => console.warn(message)
});
if (sandboxExecutable) process.env.TYPR_COMPANION_SANDBOX_EXECUTABLE = sandboxExecutable;
else delete process.env.TYPR_COMPANION_SANDBOX_EXECUTABLE;
const workspace = workspaceRoot ? await WorkspaceStore.open(workspaceRoot, {
  workspaceId: process.env.TYPR_COMPANION_WORKSPACE_ID?.trim() || "default"
}) : undefined;
const activity = new ActivityBus();
const configuredStatePath = process.env.TYPR_COMPANION_MANAGEMENT_STATE?.trim();
const statePath = configuredStatePath || (process.platform === "win32"
  ? join(windowsCompanionDataRoot(), "management.json")
  : undefined);
const access = await AccessStore.open(statePath);
const server = createTyprServer({
  ...(configuredVersion ? { serverVersion: configuredVersion } : {}),
  ...(workspace ? { workspace } : {}),
  activity,
  access
});
const services = new ServiceCatalog(() => getCompanionRuntimeSnapshot(server));
const managementServer = createManagementServer({
  access,
  activity,
  servicePort: port,
  getServices: async (forceRefresh) => [managementDescriptor(), ...await services.snapshot(forceRefresh)]
});

await listen(server, port, host);
try {
  await listen(managementServer, managementPort, "127.0.0.1");
} catch (error) {
  await shutdownTyprServer(server);
  throw error;
}
console.log(`typr-server listening on http://${host}:${port}`);
console.log(`Typr Companion management GUI: http://127.0.0.1:${managementPort}`);
activity.publish({
  serviceId: "management",
  level: "info",
  type: "server-started",
  message: `Management GUI started on loopback port ${managementPort}.`,
  metadata: { servicePort: port, managementPort, persistentAccessState: Boolean(statePath) }
});

let shutdown: Promise<void> | undefined;
function handleShutdown(signal: NodeJS.Signals): void {
  if (shutdown) {
    return;
  }
  console.log(`typr-server received ${signal}; shutting down.`);
  shutdown = Promise.all([shutdownTyprServer(server), shutdownManagementServer(managementServer)]).then(() => undefined).catch((error: Error) => {
    console.error(`typr-server shutdown failed: ${error.message}`);
    process.exitCode = 1;
  });
}

function managementDescriptor(): ManagedServiceDescriptor {
  return {
    id: "management",
    name: "Management GUI",
    kind: "api",
    status: "ready",
    advertised: false,
    active: 0,
    description: "Loopback-only service visibility, access control, and live activity.",
    capabilities: ["service-catalog", "users", "api-keys", "live-activity"]
  };
}

function listen(serverToListen: Server, listenPort: number, listenHost: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      serverToListen.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      serverToListen.off("error", onError);
      resolve();
    };
    serverToListen.once("error", onError);
    serverToListen.once("listening", onListening);
    serverToListen.listen(listenPort, listenHost);
  });
}

process.once("SIGINT", () => handleShutdown("SIGINT"));
process.once("SIGTERM", () => handleShutdown("SIGTERM"));

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("TYPR_COMPANION_PORT must be a valid TCP port number.");
  }
  return parsed;
}
