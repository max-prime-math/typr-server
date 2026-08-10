import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
  unlink
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type {
  WorkspaceFileListResponse,
  WorkspaceFileMetadata,
  WorkspaceFileResponse,
  WorkspaceLimits
} from "../src/companion-protocol/index.ts";

const INTERNAL_WRITE_PREFIX = ".typr-companion-write-";

export const DEFAULT_WORKSPACE_LIMITS: Readonly<WorkspaceLimits> = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxEntries: 4096,
  maxWorkspaceBytes: 256 * 1024 * 1024
});

const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_DEPTH = 64;

export class WorkspaceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceError";
    this.status = status;
    this.code = code;
  }
}

export interface WorkspaceStoreOptions {
  workspaceId?: string;
  limits?: WorkspaceLimits;
  /** Test seam for proving cleanup at each fallible atomic-write stage. */
  atomicWriteHook?: (step: "write" | "sync" | "rename") => void | Promise<void>;
}

export type WorkspaceWritePrecondition =
  | { kind: "create" }
  | { kind: "update"; etag: string };

/** A single, fixed host directory exposed through the deliberately small workspace API. */
export class WorkspaceStore {
  readonly limits: Readonly<WorkspaceLimits>;
  readonly workspaceId: string;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    root: string,
    options: WorkspaceStoreOptions
  ) {
    this.root = root;
    this.workspaceId = validateWorkspaceId(options.workspaceId ?? "default");
    this.limits = Object.freeze({ ...(options.limits ?? DEFAULT_WORKSPACE_LIMITS) });
    this.atomicWriteHook = options.atomicWriteHook;
  }

  private readonly root: string;
  private readonly atomicWriteHook: WorkspaceStoreOptions["atomicWriteHook"];

  static async open(root: string, options: WorkspaceStoreOptions = {}): Promise<WorkspaceStore> {
    if (!isAbsolute(root) || root.includes("\\") || resolve(root) === resolve("/")) {
      throw new Error("TYPR_COMPANION_WORKSPACE_ROOT must be an absolute POSIX directory other than root.");
    }
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error("TYPR_COMPANION_WORKSPACE_ROOT must name a real directory, not a link or special file.");
    }
    await access(root, constants.R_OK | constants.W_OK);
    const canonicalRoot = await realpath(root);
    if (canonicalRoot === "/") {
      throw new Error("TYPR_COMPANION_WORKSPACE_ROOT must not resolve to the filesystem root.");
    }
    validateLimits(options.limits ?? DEFAULT_WORKSPACE_LIMITS);
    return new WorkspaceStore(canonicalRoot, options);
  }

  async list(): Promise<WorkspaceFileListResponse> {
    const files = await this.scan();
    return { workspaceId: this.workspaceId, files };
  }

  async read(path: string): Promise<WorkspaceFileResponse> {
    const normalized = validateWorkspacePath(path);
    const filePath = await this.resolveExistingFile(normalized);
    const handle = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fileInfo = await handle.stat();
      this.assertRegularFile(fileInfo, normalized);
      const content = await handle.readFile();
      if (content.byteLength > this.limits.maxFileBytes) {
        throw new WorkspaceError(413, "workspace-file-too-large", "Workspace file exceeds the configured size limit.");
      }
      return {
        path: normalized,
        size: content.byteLength,
        modifiedAt: Math.trunc(fileInfo.mtimeMs),
        etag: createEtag(content),
        encoding: "base64",
        content: content.toString("base64")
      };
    } finally {
      await handle.close();
    }
  }

  async write(
    path: string,
    content: Buffer,
    precondition: WorkspaceWritePrecondition
  ): Promise<WorkspaceFileMetadata> {
    const normalized = validateWorkspacePath(path);
    if (content.byteLength > this.limits.maxFileBytes) {
      throw new WorkspaceError(413, "workspace-file-too-large", "Workspace file exceeds the configured size limit.");
    }

    return this.withMutationLock(async () => {
      const existing = await this.readIfExists(normalized);
      if (precondition.kind === "create" && existing) {
        throw new WorkspaceError(412, "workspace-precondition-failed", "The workspace file already exists.");
      }
      if (precondition.kind === "update" && (!existing || existing.etag !== precondition.etag)) {
        throw new WorkspaceError(412, "workspace-precondition-failed", "The workspace file changed since it was read.");
      }

      const files = await this.scan();
      const currentBytes = files.reduce((total, file) => total + file.size, 0);
      if (!existing && files.length >= this.limits.maxEntries) {
        throw new WorkspaceError(413, "workspace-entry-limit", "Workspace contains too many files.");
      }
      if (currentBytes - (existing?.size ?? 0) + content.byteLength > this.limits.maxWorkspaceBytes) {
        throw new WorkspaceError(413, "workspace-size-limit", "Workspace exceeds the configured total size limit.");
      }

      const destination = await this.resolveForWrite(normalized);
      const temporary = join(destination.parent, `${INTERNAL_WRITE_PREFIX}${randomUUID()}`);
      let handle: FileHandle | undefined;
      let replaced = false;
      try {
        handle = await openFile(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          existing?.mode ?? 0o600
        );
        await this.atomicWriteHook?.("write");
        await handle.writeFile(content);
        await this.atomicWriteHook?.("sync");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await this.atomicWriteHook?.("rename");
        await rename(temporary, destination.path);
        replaced = true;
      } finally {
        await handle?.close().catch(() => undefined);
        if (!replaced) await rm(temporary, { force: true }).catch(() => undefined);
      }
      const result = await this.read(normalized);
      return metadataOnly(result);
    });
  }

  async delete(path: string, expectedEtag: string): Promise<void> {
    const normalized = validateWorkspacePath(path);
    await this.withMutationLock(async () => {
      const existing = await this.readIfExists(normalized);
      if (!existing || existing.etag !== expectedEtag) {
        throw new WorkspaceError(412, "workspace-precondition-failed", "The workspace file changed since it was read.");
      }
      const filePath = await this.resolveExistingFile(normalized);
      await unlink(filePath);
    });
  }

  private async scan(): Promise<WorkspaceFileMetadata[]> {
    const files: WorkspaceFileMetadata[] = [];
    let totalBytes = 0;
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name.startsWith(INTERNAL_WRITE_PREFIX)) continue;
        const childPath = join(directory, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        validateWorkspacePath(relativePath);
        const info = await lstat(childPath);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
          throw new WorkspaceError(409, "workspace-unsafe-entry", "Workspace contains a link or special file.");
        }
        if (info.isDirectory()) {
          await visit(childPath, relativePath);
          continue;
        }
        if (files.length >= this.limits.maxEntries) {
          throw new WorkspaceError(413, "workspace-entry-limit", "Workspace contains too many files.");
        }
        const handle = await openFile(childPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let content: Buffer;
        let openedInfo;
        try {
          openedInfo = await handle.stat();
          this.assertRegularFile(openedInfo, relativePath);
          content = await handle.readFile();
        } finally {
          await handle.close();
        }
        if (content.byteLength > this.limits.maxFileBytes) {
          throw new WorkspaceError(413, "workspace-file-too-large", "Workspace contains an oversized file.");
        }
        totalBytes += content.byteLength;
        if (totalBytes > this.limits.maxWorkspaceBytes) {
          throw new WorkspaceError(413, "workspace-size-limit", "Workspace exceeds the configured total size limit.");
        }
        files.push({
          path: relativePath,
          size: content.byteLength,
          modifiedAt: Math.trunc(openedInfo.mtimeMs),
          etag: createEtag(content)
        });
      }
    };
    await visit(this.root, "");
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async resolveExistingFile(normalized: string): Promise<string> {
    const segments = normalized.split("/");
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (isNotFound(error)) throw new WorkspaceError(404, "workspace-file-not-found", "Workspace file was not found.");
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new WorkspaceError(409, "workspace-unsafe-entry", "Workspace path crosses a symbolic link.");
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new WorkspaceError(409, "workspace-path-conflict", "Workspace path crosses a non-directory entry.");
      }
      if (index === segments.length - 1 && !info.isFile()) {
        throw new WorkspaceError(409, "workspace-path-conflict", "Workspace path does not name a regular file.");
      }
    }
    return current;
  }

  private async resolveForWrite(normalized: string): Promise<{ parent: string; path: string }> {
    const segments = normalized.split("/");
    const fileName = segments.pop()!;
    let parent = this.root;
    for (const segment of segments) {
      parent = join(parent, segment);
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new WorkspaceError(409, "workspace-path-conflict", "Workspace path crosses an unsafe entry.");
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await mkdir(parent, { mode: 0o700 });
      }
    }
    return { parent, path: join(parent, fileName) };
  }

  private async readIfExists(normalized: string): Promise<(WorkspaceFileResponse & { mode: number }) | undefined> {
    try {
      const response = await this.read(normalized);
      const fileInfo = await lstat(join(this.root, ...normalized.split("/")));
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        throw new WorkspaceError(409, "workspace-unsafe-entry", "Workspace path changed to an unsafe entry.");
      }
      return { ...response, mode: fileInfo.mode & 0o777 };
    } catch (error) {
      if (error instanceof WorkspaceError && error.status === 404) return undefined;
      throw error;
    }
  }

  private assertRegularFile(info: { isFile(): boolean }, path: string): void {
    if (!info.isFile()) {
      throw new WorkspaceError(409, "workspace-unsafe-entry", `Workspace path is not a regular file: ${path}`);
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function validateWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    throw new WorkspaceError(400, "invalid-workspace-path", "Workspace path must be a non-empty relative POSIX path.");
  }
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) {
    throw new WorkspaceError(400, "invalid-workspace-path", "Workspace path is too long.");
  }
  const segments = value.split("/");
  if (segments.length > MAX_PATH_DEPTH || segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".." || segment === ".git" ||
    segment.startsWith(INTERNAL_WRITE_PREFIX) || Buffer.byteLength(segment) > MAX_SEGMENT_BYTES || /[\u0000-\u001f\u007f]/u.test(segment)
  )) {
    throw new WorkspaceError(400, "invalid-workspace-path", "Workspace path contains a prohibited segment.");
  }
  return segments.join("/");
}

function createEtag(content: Buffer): string {
  return `"sha256-${createHash("sha256").update(content).digest("base64url")}"`;
}

function metadataOnly(file: WorkspaceFileResponse): WorkspaceFileMetadata {
  return { path: file.path, size: file.size, modifiedAt: file.modifiedAt, etag: file.etag };
}

function validateWorkspaceId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error("TYPR_COMPANION_WORKSPACE_ID must contain only letters, numbers, dots, underscores, and hyphens.");
  }
  return normalized;
}

function validateLimits(limits: WorkspaceLimits): void {
  if (![limits.maxFileBytes, limits.maxEntries, limits.maxWorkspaceBytes].every((value) => Number.isSafeInteger(value) && value > 0) ||
      limits.maxFileBytes > limits.maxWorkspaceBytes) {
    throw new Error("Workspace limits must be positive safe integers and maxFileBytes cannot exceed maxWorkspaceBytes.");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
