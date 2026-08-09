import { createTyprServer, shutdownTyprServer } from "./server.ts";

const port = parsePort(process.env.TYPR_COMPANION_PORT, 8484);
const host = process.env.TYPR_COMPANION_HOST ?? "127.0.0.1";
const configuredVersion = process.env.TYPR_COMPANION_VERSION?.trim();
const server = createTyprServer(configuredVersion ? { serverVersion: configuredVersion } : {});

server.listen(port, host, () => {
  console.log(`typr-server listening on http://${host}:${port}`);
});

server.once("error", (error) => {
  console.error(`typr-server could not listen on ${host}:${port}: ${error.message}`);
  process.exitCode = 1;
});

let shutdown: Promise<void> | undefined;
function handleShutdown(signal: NodeJS.Signals): void {
  if (shutdown) {
    return;
  }
  console.log(`typr-server received ${signal}; shutting down.`);
  shutdown = shutdownTyprServer(server).catch((error: Error) => {
    console.error(`typr-server shutdown failed: ${error.message}`);
    process.exitCode = 1;
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
