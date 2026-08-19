import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, win32 } from "node:path";
import type { ProjectFile } from "../src/companion-protocol/index.ts";

/** Writes validated request files into an ephemeral Companion workspace. */
export async function materializeProjectFiles(root: string, files: readonly ProjectFile[]): Promise<void> {
  for (const file of files) {
    const pathError = validateProjectPath(file.path, "project file path");
    if (pathError) throw new Error(pathError);
    const destination = resolveProjectPath(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.kind === "text" ? file.content : Buffer.from(file.content, "base64"));
  }
}

export function validateProjectPath(
  value: unknown,
  label: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return `${label} must be a non-empty relative path.`;
  if (value === "." || value.endsWith("/") || value.includes("\0") || value.includes("\\") || isAbsolute(value) || win32.isAbsolute(value)) {
    return `${label} must be a safe relative POSIX path.`;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) return `${label} must not contain parent-directory traversal.`;
  if (platform === "win32" && segments.some(isWindowsUnsafePathSegment)) {
    return `${label} contains a file name that Windows cannot store safely.`;
  }
  return undefined;
}

export function isWindowsUnsafePathSegment(segment: string): boolean {
  const stem = segment.split(".", 1)[0].toUpperCase();
  return /[<>:"|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem);
}

export function resolveProjectPath(root: string, projectPath: string): string {
  const resolvedRoot = resolve(root);
  const destination = resolve(resolvedRoot, normalize(projectPath));
  const pathFromRoot = relative(resolvedRoot, destination);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("Project path resolves outside the temporary project directory.");
  }
  return destination;
}
