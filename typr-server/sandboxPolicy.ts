import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { probeNativeSandbox } from "./sandboxProbe.ts";

export interface NativeSandboxPolicyOptions {
  allowUnsandboxedStateless: boolean;
  allowUnsandboxedWorkspace: boolean;
  sandboxExecutable?: string;
  workspaceRoot?: string;
  texCacheRoot?: string;
  onFallback?: (message: string) => void;
  accessExecutable?: (path: string, mode: number) => Promise<void>;
  probeSandbox?: (path: string) => Promise<void>;
  assertVolumeFree?: () => Promise<void>;
  assertWorkspaceScoped?: (workspaceRoot: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

/**
 * Resolves the launcher used by native compiler children.
 *
 * Landlock remains the default boundary between compiler children and a mapped
 * workspace. Trusted single-user deployments may explicitly accept a weaker
 * boundary after the container mount table proves that only the configured
 * workspace is exposed.
 */
export async function resolveNativeSandbox(options: NativeSandboxPolicyOptions): Promise<string | undefined> {
  const sandboxExecutable = options.sandboxExecutable?.trim() || undefined;
  const workspaceRoot = options.workspaceRoot?.trim() || undefined;
  const texCacheRoot = options.texCacheRoot?.trim() || undefined;
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && !sandboxExecutable) {
    options.onFallback?.(
      `WARNING: Windows portable mode uses TeX's paranoid file-open policy, disabled shell escape, ` +
      `per-job temporary directories, and process-tree deadlines. Windows does not provide the ` +
      `Companion Landlock launcher; use only documents trusted by this Windows account.`
    );
    return undefined;
  }
  if (!sandboxExecutable) {
    if (workspaceRoot) {
      if (!options.allowUnsandboxedWorkspace) {
        throw new Error("A mapped workspace requires TYPR_COMPANION_SANDBOX_EXECUTABLE; refusing to expose it beside unsandboxed native compilers.");
      }
      await (options.assertWorkspaceScoped ?? ((root) => assertTrustedWorkspaceFallbackMounts(root, texCacheRoot)))(workspaceRoot);
      options.onFallback?.(trustedWorkspaceWarning("native filesystem sandbox is not configured"));
      return undefined;
    }
    if (options.allowUnsandboxedStateless) {
      await (options.assertVolumeFree ?? (() => assertStatelessFallbackVolumeFree(texCacheRoot)))();
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
    if (workspaceRoot) {
      if (!options.allowUnsandboxedWorkspace) throw error;
      await (options.assertWorkspaceScoped ?? ((root) => assertTrustedWorkspaceFallbackMounts(root, texCacheRoot)))(workspaceRoot);
      const detail = error instanceof Error ? error.message : String(error);
      options.onFallback?.(trustedWorkspaceWarning(`native filesystem sandbox unavailable. ${detail}`));
      return undefined;
    }
    if (!options.allowUnsandboxedStateless) throw error;
    await (options.assertVolumeFree ?? (() => assertStatelessFallbackVolumeFree(texCacheRoot)))();
    const detail = error instanceof Error ? error.message : String(error);
    options.onFallback?.(
      `WARNING: native filesystem sandbox unavailable; continuing only because ` +
      `TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS=1 and no workspace is mapped. ` +
      `Use trusted documents only. ${detail}`
    );
    return undefined;
  }
}

function trustedWorkspaceWarning(detail: string): string {
  return `WARNING: ${detail}; continuing only because ` +
    `TYPR_COMPANION_ALLOW_UNSANDBOXED_WORKSPACE=1. Native compiler processes may access ` +
    `the mapped workspace. Use only mutually trusted documents and users.`;
}

/** Rejects host/data mounts before entering the weaker stateless fallback. */
export async function assertStatelessFallbackVolumeFree(texCacheRoot?: string): Promise<void> {
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  validateStatelessFallbackMountInfo(mountInfo, texCacheRoot);
}

/** Allows one exact workspace mount while rejecting every other host/data mount. */
export async function assertTrustedWorkspaceFallbackMounts(workspaceRoot: string, texCacheRoot?: string): Promise<void> {
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  validateTrustedWorkspaceFallbackMountInfo(mountInfo, workspaceRoot, texCacheRoot);
}

export function validateStatelessFallbackMountInfo(mountInfo: string, texCacheRoot?: string): void {
  validateFallbackMountInfo(mountInfo, undefined, texCacheRoot);
}

export function validateTrustedWorkspaceFallbackMountInfo(
  mountInfo: string,
  workspaceRoot: string,
  texCacheRoot?: string
): void {
  if (!workspaceRoot.startsWith("/")) {
    throw new Error("Trusted workspace fallback requires an absolute workspace root.");
  }
  validateFallbackMountInfo(mountInfo, workspaceRoot, texCacheRoot);
}

function validateFallbackMountInfo(mountInfo: string, allowedWorkspaceRoot?: string, allowedTexCacheRoot?: string): void {
  if (allowedTexCacheRoot && !allowedTexCacheRoot.startsWith("/")) {
    throw new Error("Trusted TeX cache fallback requires an absolute cache root.");
  }
  let workspaceMountFound = false;
  let texCacheMountFound = false;
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    if (fields.length < 7) throw new Error("Could not validate container mounts for fallback.");
    const separator = fields.indexOf("-");
    if (separator < 0 || !fields[separator + 1]) {
      throw new Error("Could not validate container mount types for fallback.");
    }
    const mountPoint = decodeMountInfoPath(fields[4]);
    const filesystemType = fields[separator + 1];
    if (isStandardContainerMount(mountPoint, filesystemType)) continue;
    if (allowedWorkspaceRoot && mountPoint === allowedWorkspaceRoot) {
      workspaceMountFound = true;
      continue;
    }
    if (allowedTexCacheRoot && mountPoint === allowedTexCacheRoot) {
      texCacheMountFound = true;
      continue;
    }
    throw new Error(
      `${allowedWorkspaceRoot ? "Trusted workspace" : "Stateless"} fallback refuses unexpected mount ` +
      `${JSON.stringify(mountPoint)}; remove every other host/data mount or enable a working native sandbox.`
    );
  }
  if (allowedWorkspaceRoot && !workspaceMountFound) {
    throw new Error(`Trusted workspace fallback requires ${JSON.stringify(allowedWorkspaceRoot)} to be a dedicated mount.`);
  }
  if (allowedTexCacheRoot && !texCacheMountFound) {
    throw new Error(`Trusted fallback requires ${JSON.stringify(allowedTexCacheRoot)} to be a dedicated TeX cache mount.`);
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
  return parseExactOptIn(value, "TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS");
}

export function parseUnsandboxedWorkspaceOptIn(value: string | undefined): boolean {
  return parseExactOptIn(value, "TYPR_COMPANION_ALLOW_UNSANDBOXED_WORKSPACE");
}

function parseExactOptIn(value: string | undefined, variableName: string): boolean {
  const normalized = value?.trim();
  if (!normalized) return false;
  if (normalized === "1") return true;
  throw new Error(`${variableName} must be unset or exactly 1.`);
}
