import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { probeNativeSandbox } from "./sandboxProbe.ts";

export interface NativeSandboxPolicyOptions {
  allowUnsandboxedStateless: boolean;
  sandboxExecutable?: string;
  workspaceRoot?: string;
  onFallback?: (message: string) => void;
  accessExecutable?: (path: string, mode: number) => Promise<void>;
  probeSandbox?: (path: string) => Promise<void>;
  assertVolumeFree?: () => Promise<void>;
}

/**
 * Resolves the launcher used by native compiler children.
 *
 * A workspace is never allowed beside unsandboxed compiler processes. The
 * explicit fallback exists only for volume-free, trusted-document container
 * deployments on kernels such as stock Unraid that do not provide Landlock.
 */
export async function resolveNativeSandbox(options: NativeSandboxPolicyOptions): Promise<string | undefined> {
  const sandboxExecutable = options.sandboxExecutable?.trim() || undefined;
  const workspaceRoot = options.workspaceRoot?.trim() || undefined;
  if (!sandboxExecutable) {
    if (workspaceRoot) {
      throw new Error("A mapped workspace requires TYPR_COMPANION_SANDBOX_EXECUTABLE; refusing to expose it beside unsandboxed native compilers.");
    }
    if (options.allowUnsandboxedStateless) {
      await (options.assertVolumeFree ?? assertStatelessFallbackVolumeFree)();
      options.onFallback?.(
        `WARNING: native filesystem sandbox is not configured; continuing only because ` +
        `TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS=1 and no workspace is mapped. ` +
        `Use trusted documents only.`
      );
    }
    return undefined;
  }

  try {
    await (options.accessExecutable ?? access)(sandboxExecutable, constants.X_OK);
    await (options.probeSandbox ?? probeNativeSandbox)(sandboxExecutable);
    return sandboxExecutable;
  } catch (error) {
    if (workspaceRoot || !options.allowUnsandboxedStateless) throw error;
    await (options.assertVolumeFree ?? assertStatelessFallbackVolumeFree)();
    const detail = error instanceof Error ? error.message : String(error);
    options.onFallback?.(
      `WARNING: native filesystem sandbox unavailable; continuing only because ` +
      `TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS=1 and no workspace is mapped. ` +
      `Use trusted documents only. ${detail}`
    );
    return undefined;
  }
}

/** Rejects host/data mounts before entering the weaker stateless fallback. */
export async function assertStatelessFallbackVolumeFree(): Promise<void> {
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  validateStatelessFallbackMountInfo(mountInfo);
}

export function validateStatelessFallbackMountInfo(mountInfo: string): void {
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    if (fields.length < 7) throw new Error("Could not validate container mounts for stateless fallback.");
    const separator = fields.indexOf("-");
    if (separator < 0 || !fields[separator + 1]) {
      throw new Error("Could not validate container mount types for stateless fallback.");
    }
    const mountPoint = decodeMountInfoPath(fields[4]);
    const filesystemType = fields[separator + 1];
    if (isStandardContainerMount(mountPoint, filesystemType)) continue;
    throw new Error(
      `Stateless fallback refuses unexpected mount ${JSON.stringify(mountPoint)}; ` +
      `remove every host/data mount or enable a working native sandbox.`
    );
  }
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

function isStandardContainerMount(mountPoint: string, filesystemType: string): boolean {
  return mountPoint === "/" || (mountPoint === "/tmp" && filesystemType === "tmpfs") ||
    mountPoint === "/etc/hosts" || mountPoint === "/etc/hostname" || mountPoint === "/etc/resolv.conf" ||
    ((mountPoint === "/proc" || mountPoint.startsWith("/proc/")) && ["proc", "tmpfs"].includes(filesystemType)) ||
    ((mountPoint === "/sys" || mountPoint.startsWith("/sys/")) && ["sysfs", "cgroup", "cgroup2", "tmpfs"].includes(filesystemType)) ||
    ((mountPoint === "/dev" || mountPoint === "/dev/pts" ||
      mountPoint === "/dev/mqueue" || mountPoint === "/dev/shm") &&
      ["tmpfs", "devpts", "mqueue"].includes(filesystemType));
}

export function parseUnsandboxedStatelessOptIn(value: string | undefined): boolean {
  const normalized = value?.trim();
  if (!normalized) return false;
  if (normalized === "1") return true;
  throw new Error("TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS must be unset or exactly 1.");
}
