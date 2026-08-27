import type { Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { AccessStore } from "./accessStore.ts";
import { ActivityBus } from "./activity.ts";
import { ManagementAuthenticator } from "./managementAuth.ts";
import { createManagementServer, shutdownManagementServer, type ManagedServiceDescriptor } from "./managementServer.ts";
import { createTyprServer, getCompanionRuntimeSnapshot, resetPdflatexAvailability, shutdownTyprServer } from "./server.ts";
import { ProviderManager } from "./providerManager.ts";
import { ServiceCatalog } from "./serviceCatalog.ts";
import { WorkspaceStore, workspaceLimitsFromEnvironment } from "./workspaceStore.ts";
import {
  parseUnsandboxedStatelessOptIn,
  parseUnsandboxedWorkspaceOptIn,
  resolveNativeSandbox
} from "./sandboxPolicy.ts";
import { prepareWindowsPortableRuntime, windowsCompanionDataRoot } from "./windowsPortable.ts";

await prepareWindowsPortableRuntime();

const port = parsePort(process.env.TYPR_COMPANION_PORT, 8484);
const managementPort = parsePort(process.env.TYPR_COMPANION_MANAGEMENT_PORT, 8485);
if (managementPort === port) throw new Error("The Companion service and management GUI must use different ports.");
const host = process.env.TYPR_COMPANION_HOST ?? "127.0.0.1";
const managementHost = process.env.TYPR_COMPANION_MANAGEMENT_HOST?.trim() || "127.0.0.1";
const managementPublicOrigin = process.env.TYPR_COMPANION_MANAGEMENT_PUBLIC_ORIGIN?.trim() || undefined;
const administratorPassword = await readAdministratorPassword();
const managementUsername = process.env.TYPR_COMPANION_MANAGEMENT_USERNAME?.trim() || "typr";
const remoteManagement = !isLoopbackHost(managementHost);
if (remoteManagement && !administratorPassword) {
  throw new Error("Remote management requires a management password or password file.");
}
const managementAuthenticator = administratorPassword
  ? await ManagementAuthenticator.create({
      username: managementUsername,
      password: administratorPassword,
      secureCookies: Boolean(managementPublicOrigin)
    })
  : undefined;
delete process.env.TYPR_COMPANION_MANAGEMENT_PASSWORD;
const configuredVersion = process.env.TYPR_COMPANION_VERSION?.trim();
const dataRoot = process.env.TYPR_COMPANION_DATA_ROOT?.trim() ||
  (process.platform === "win32" ? windowsCompanionDataRoot() : undefined);
if (dataRoot) process.env.TYPR_COMPANION_DATA_ROOT = dataRoot;
if (parseOptionalFlag(process.env.TYPR_COMPANION_MANAGED_WORKSPACE, "TYPR_COMPANION_MANAGED_WORKSPACE")) {
  if (!dataRoot) throw new Error("TYPR_COMPANION_MANAGED_WORKSPACE=1 requires TYPR_COMPANION_DATA_ROOT.");
  if (!process.env.TYPR_COMPANION_WORKSPACE_ROOT?.trim()) {
    const managedWorkspace = join(dataRoot, "workspaces", "default");
    await mkdir(managedWorkspace, { recursive: true, mode: 0o700 });
    process.env.TYPR_COMPANION_WORKSPACE_ROOT = managedWorkspace;
    process.env.TYPR_COMPANION_WORKSPACE_ID = "managed-default";
  }
}
const workspaceRoot = process.env.TYPR_COMPANION_WORKSPACE_ROOT?.trim();
const sandboxExecutable = await resolveNativeSandbox({
  allowUnsandboxedStateless: parseUnsandboxedStatelessOptIn(
    process.env.TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS
  ),
  allowUnsandboxedWorkspace: parseUnsandboxedWorkspaceOptIn(
    process.env.TYPR_COMPANION_ALLOW_UNSANDBOXED_WORKSPACE
  ),
  sandboxExecutable: process.env.TYPR_COMPANION_SANDBOX_EXECUTABLE,
  workspaceRoot,
  onFallback: (message) => console.warn(message)
});
if (sandboxExecutable) process.env.TYPR_COMPANION_SANDBOX_EXECUTABLE = sandboxExecutable;
else delete process.env.TYPR_COMPANION_SANDBOX_EXECUTABLE;
const workspace = workspaceRoot ? await WorkspaceStore.open(workspaceRoot, {
  workspaceId: process.env.TYPR_COMPANION_WORKSPACE_ID?.trim() || "default",
  limits: workspaceLimitsFromEnvironment()
}) : undefined;
const activity = new ActivityBus();
let services: ServiceCatalog | undefined;
const providers = await ProviderManager.open({
  dataRoot,
  onEvent: (event) => activity.publish({
    serviceId: event.providerId === "tinytex" ? "latex" : `lsp-${event.providerId}`,
    level: event.level,
    type: event.type,
    message: event.message,
    ...(event.metadata ? { metadata: event.metadata } : {})
  }),
  onChanged: async () => {
    resetPdflatexAvailability();
    await services?.snapshot(true);
  }
});
const configuredStatePath = process.env.TYPR_COMPANION_MANAGEMENT_STATE?.trim();
const statePath = configuredStatePath || (dataRoot ? join(dataRoot, "management.json") : undefined);
const access = await AccessStore.open(statePath);
const server = createTyprServer({
  ...(configuredVersion ? { serverVersion: configuredVersion } : {}),
  ...(workspace ? { workspace } : {}),
  activity,
  access
});
services = new ServiceCatalog(() => getCompanionRuntimeSnapshot(server));
const managementServer = createManagementServer({
  access,
  activity,
  providers,
  servicePort: port,
  getServices: async (forceRefresh) => [managementDescriptor(), ...await services!.snapshot(forceRefresh)],
  allowRemote: remoteManagement,
  ...(managementAuthenticator ? { authenticator: managementAuthenticator } : {}),
  ...(managementPublicOrigin ? { publicOrigin: managementPublicOrigin } : {})
});

await listen(server, port, host);
try {
  await listen(managementServer, managementPort, managementHost);
} catch (error) {
  await shutdownTyprServer(server);
  throw error;
}
console.log(`typr-server listening on http://${host}:${port}`);
console.log(`Typr Companion management GUI: ${managementPublicOrigin ?? `http://${managementHost}:${managementPort}`}`);
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
    description: "Authenticated service visibility, access control, and live activity.",
    capabilities: ["session-login", "service-catalog", "users", "api-keys", "live-activity"]
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

function isLoopbackHost(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function parseOptionalFlag(value: string | undefined, name: string): boolean {
  const normalized = value?.trim();
  if (!normalized) return false;
  if (normalized === "1") return true;
  throw new Error(`${name} must be unset or exactly 1.`);
}

async function readAdministratorPassword(): Promise<string | undefined> {
  const inline = process.env.TYPR_COMPANION_MANAGEMENT_PASSWORD;
  const file = process.env.TYPR_COMPANION_MANAGEMENT_PASSWORD_FILE?.trim();
  if (inline && file) throw new Error("Set only one of TYPR_COMPANION_MANAGEMENT_PASSWORD or TYPR_COMPANION_MANAGEMENT_PASSWORD_FILE.");
  if (inline) return inline;
  if (!file) return undefined;
  if (!isAbsolute(file)) throw new Error("TYPR_COMPANION_MANAGEMENT_PASSWORD_FILE must be an absolute path.");
  const value = (await readFile(file, "utf8")).replace(/\r?\n$/u, "");
  if (!value) throw new Error("TYPR_COMPANION_MANAGEMENT_PASSWORD_FILE is empty.");
  return value;
}
