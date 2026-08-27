import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DOWNLOAD_OVERHEAD_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 20_000;

export type ManagedProviderKind = "tex-distribution" | "lsp";
export type ProviderArchive = "tar.gz" | "tar.xz" | "zip" | "windows-installer";
export type ProviderJobStatus = "queued" | "downloading" | "installing" | "completed" | "failed";

export interface ProviderAsset {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  url: string;
  sha256: string;
  size: number;
  archive: ProviderArchive;
}

export interface ManagedProviderDefinition {
  id: string;
  name: string;
  kind: ManagedProviderKind;
  version: string;
  description: string;
  executableNames: string[];
  assets: ProviderAsset[];
}

interface InstalledProviderRecord {
  id: string;
  version: string;
  installedAt: string;
  executables: Record<string, string>;
}

interface ProviderState {
  version: 1;
  activeTexProvider?: string;
  installed: InstalledProviderRecord[];
}

export interface ManagedProviderSnapshot {
  id: string;
  name: string;
  kind: ManagedProviderKind;
  version: string;
  description: string;
  supported: boolean;
  installed: boolean;
  active: boolean;
  installedAt?: string;
  executables: Record<string, string>;
  downloadBytes?: number;
}

export interface ProviderInstallJob {
  id: string;
  providerId: string;
  status: ProviderJobStatus;
  downloadedBytes: number;
  totalBytes: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface ProviderManagerSnapshot {
  enabled: boolean;
  dataRoot?: string;
  providers: ManagedProviderSnapshot[];
  jobs: ProviderInstallJob[];
}

export interface ProviderManagerOptions {
  dataRoot?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  catalog?: readonly ManagedProviderDefinition[];
  fetch?: typeof fetch;
  extract?: (definition: ManagedProviderDefinition, asset: ProviderAsset, archivePath: string, stagingRoot: string) => Promise<void>;
  onEvent?: (event: { providerId: string; level: "info" | "warning" | "error"; type: string; message: string; metadata?: Record<string, string | number | boolean | null> }) => void;
  onChanged?: () => void | Promise<void>;
}

export const CURATED_PROVIDER_CATALOG: readonly ManagedProviderDefinition[] = [
  {
    id: "system-tex",
    name: "Bundled/system TeX",
    kind: "tex-distribution",
    version: "host",
    description: "Use the TeX distribution bundled with Companion or already configured on the host.",
    executableNames: [],
    assets: []
  },
  {
    id: "tinytex",
    name: "TinyTeX",
    kind: "tex-distribution",
    version: "2026.08",
    description: "Portable TeX Live distribution with common LaTeX packages; installs without administrator rights.",
    executableNames: ["pdflatex", "latexmk"],
    assets: [
      asset("linux", "x64", "TinyTeX-linux-x86_64-v2026.08.tar.xz", "59685643fb4160f779df5e3d7d78266a86818ebb86ac25c7900723b0fd73a7cd", 152_058_464, "tar.xz"),
      asset("linux", "arm64", "TinyTeX-linux-arm64-v2026.08.tar.xz", "c6713bf6c44048a4902040a08763c611deac3644b844f03d7244ae49a54a2a08", 155_871_496, "tar.xz"),
      asset("win32", "x64", "TinyTeX-windows-v2026.08.exe", "e8d5e44ea9ffaf3b82c2f23ad4c3738c4d9e89bc5af59a7be558a1154c6d0f48", 172_870_810, "windows-installer")
    ]
  },
  {
    id: "texlab",
    name: "TexLab",
    kind: "lsp",
    version: "5.26.0",
    description: "Language Server Protocol provider for LaTeX projects.",
    executableNames: ["texlab"],
    assets: [
      githubAsset("latex-lsp/texlab", "v5.26.0", "linux", "x64", "texlab-x86_64-linux.tar.gz", "8697bd5e479d4584b14b7eed5c320c80ec4e1d91ebefbb6801e6bf38e9971300", 10_439_323, "tar.gz"),
      githubAsset("latex-lsp/texlab", "v5.26.0", "linux", "arm64", "texlab-aarch64-linux.tar.gz", "a85cdfcd22454b8d8550f4b0f0620c45ab51760f302fac7a12bc18a890f70f8c", 10_383_190, "tar.gz"),
      githubAsset("latex-lsp/texlab", "v5.26.0", "win32", "x64", "texlab-x86_64-windows.zip", "cb028d44c3d2b85d36a2ed52d41a0ff43a341b1f04c500c56c4524c4eb72b316", 9_997_967, "zip")
    ]
  },
  {
    id: "tinymist",
    name: "Tinymist",
    kind: "lsp",
    version: "0.15.2",
    description: "Language Server Protocol provider for Typst projects.",
    executableNames: ["tinymist"],
    assets: [
      githubAsset("Myriad-Dreamin/tinymist", "v0.15.2", "linux", "x64", "tinymist-x86_64-unknown-linux-gnu.tar.gz", "9b8a1aea6bb3fc9c39cb70496f0082bd518cfede555757bc3cb5225b05abc99b", 32_171_441, "tar.gz"),
      githubAsset("Myriad-Dreamin/tinymist", "v0.15.2", "linux", "arm64", "tinymist-aarch64-unknown-linux-gnu.tar.gz", "eba8e14338cf211906d77be6b18102736222da6721e98161133fa0d8ff5ab599", 29_549_962, "tar.gz"),
      githubAsset("Myriad-Dreamin/tinymist", "v0.15.2", "win32", "x64", "tinymist-x86_64-pc-windows-msvc.zip", "91edb0d21edca5841b896d702d8086622792d52b71a9b444d8befb0e937969ae", 29_322_850, "zip")
    ]
  }
] as const;

/** Curated, verified, per-user provider installation and activation. */
export class ProviderManager {
  private readonly dataRoot?: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly catalog: readonly ManagedProviderDefinition[];
  private readonly fetchImplementation: typeof fetch;
  private readonly extractImplementation: ProviderManagerOptions["extract"];
  private readonly onEvent?: ProviderManagerOptions["onEvent"];
  private readonly onChanged?: ProviderManagerOptions["onChanged"];
  private readonly baselineEnvironment: Record<string, string | undefined>;
  private state: ProviderState = { version: 1, installed: [] };
  private readonly jobs = new Map<string, ProviderInstallJob>();
  private readonly jobPromises = new Map<string, Promise<void>>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: ProviderManagerOptions) {
    this.dataRoot = options.dataRoot ? validateDataRoot(options.dataRoot) : undefined;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.catalog = options.catalog ?? CURATED_PROVIDER_CATALOG;
    this.fetchImplementation = options.fetch ?? fetch;
    this.extractImplementation = options.extract;
    this.onEvent = options.onEvent;
    this.onChanged = options.onChanged;
    this.baselineEnvironment = Object.fromEntries([
      "TYPR_COMPANION_PDFLATEX_EXECUTABLE",
      "TYPR_COMPANION_LATEXMK_EXECUTABLE",
      "TYPR_COMPANION_TEXLAB_EXECUTABLE",
      "TYPR_COMPANION_TINYMIST_EXECUTABLE",
      "TYPR_COMPANION_NATIVE_PATH"
    ].map((key) => [key, process.env[key]]));
  }

  static async open(options: ProviderManagerOptions = {}): Promise<ProviderManager> {
    const manager = new ProviderManager(options);
    if (!manager.dataRoot) return manager;
    await mkdir(manager.dataRoot, { recursive: true, mode: 0o700 });
    try {
      manager.state = validateProviderState(JSON.parse(await readFile(manager.statePath(), "utf8")), manager.catalog);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    await manager.removeMissingInstallations();
    manager.applyEnvironment();
    return manager;
  }

  snapshot(): ProviderManagerSnapshot {
    return {
      enabled: Boolean(this.dataRoot),
      ...(this.dataRoot ? { dataRoot: this.dataRoot } : {}),
      providers: this.catalog.map((definition) => {
        const systemTex = definition.id === "system-tex";
        const installed = this.state.installed.find((candidate) => candidate.id === definition.id && candidate.version === definition.version);
        const selectedAsset = this.assetFor(definition);
        return {
          id: definition.id,
          name: definition.name,
          kind: definition.kind,
          version: definition.version,
          description: definition.description,
          supported: systemTex || Boolean(selectedAsset),
          installed: systemTex || Boolean(installed),
          active: definition.kind === "tex-distribution"
            ? systemTex ? !this.state.activeTexProvider : this.state.activeTexProvider === definition.id
            : Boolean(installed),
          ...(installed ? { installedAt: installed.installedAt, executables: this.absoluteExecutables(installed) } : { executables: {} }),
          ...(selectedAsset ? { downloadBytes: selectedAsset.size } : {})
        };
      }),
      jobs: [...this.jobs.values()].map((job) => ({ ...job })).sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    };
  }

  startInstall(providerId: string): ProviderInstallJob {
    if (!this.dataRoot) throw new ProviderManagerError(409, "provider-storage-disabled", "Configure a persistent Companion data root before installing providers.");
    const definition = this.requireDefinition(providerId);
    const selectedAsset = this.assetFor(definition);
    if (!selectedAsset) throw new ProviderManagerError(409, "provider-platform-unsupported", `${definition.name} is not available for ${this.platform}/${this.arch}.`);
    if ([...this.jobs.values()].some((job) => job.providerId === providerId && !["completed", "failed"].includes(job.status))) {
      throw new ProviderManagerError(409, "provider-install-running", `${definition.name} is already being installed.`);
    }
    const job: ProviderInstallJob = {
      id: randomUUID(),
      providerId,
      status: "queued",
      downloadedBytes: 0,
      totalBytes: selectedAsset.size,
      startedAt: new Date().toISOString()
    };
    this.jobs.set(job.id, job);
    const promise = this.runInstall(job, definition, selectedAsset).finally(() => this.jobPromises.delete(job.id));
    this.jobPromises.set(job.id, promise);
    return { ...job };
  }

  async waitForJob(jobId: string): Promise<ProviderInstallJob> {
    const promise = this.jobPromises.get(jobId);
    if (promise) await promise;
    const job = this.jobs.get(jobId);
    if (!job) throw new ProviderManagerError(404, "provider-job-not-found", "Provider installation job was not found.");
    return { ...job };
  }

  async activateTexProvider(providerId: string): Promise<void> {
    const definition = this.requireDefinition(providerId);
    if (definition.kind !== "tex-distribution") throw new ProviderManagerError(400, "provider-kind-invalid", "Only a TeX distribution can be selected as the compiler provider.");
    if (providerId === "system-tex") {
      delete this.state.activeTexProvider;
      await this.persist();
      this.applyEnvironment();
      await this.onChanged?.();
      return;
    }
    const installed = this.state.installed.find((candidate) => candidate.id === providerId && candidate.version === definition.version);
    if (!installed) throw new ProviderManagerError(409, "provider-not-installed", `Install ${definition.name} before activating it.`);
    this.state.activeTexProvider = providerId;
    await this.persist();
    this.applyEnvironment();
    await this.onChanged?.();
  }

  private async runInstall(job: ProviderInstallJob, definition: ManagedProviderDefinition, selectedAsset: ProviderAsset): Promise<void> {
    const stagingRoot = join(this.dataRoot!, ".staging", `${definition.id}-${randomBytes(8).toString("hex")}`);
    const archivePath = join(stagingRoot, `download.${archiveExtension(selectedAsset.archive)}`);
    try {
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      job.status = "downloading";
      this.emit(definition.id, "info", "provider-download-started", `Downloading verified ${definition.name} ${definition.version}.`, { bytes: selectedAsset.size });
      await this.download(selectedAsset, archivePath, job);
      job.status = "installing";
      const extractedRoot = join(stagingRoot, "extracted");
      await mkdir(extractedRoot, { recursive: true, mode: 0o700 });
      if (this.extractImplementation) await this.extractImplementation(definition, selectedAsset, archivePath, extractedRoot);
      else await extractProviderAsset(selectedAsset, archivePath, extractedRoot);
      const relativeExecutables: Record<string, string> = {};
      for (const executableName of definition.executableNames) {
        const executable = await findExecutable(extractedRoot, executableName, this.platform);
        if (!executable) throw new Error(`${definition.name} archive did not contain ${executableName}.`);
        if (this.platform !== "win32") await chmod(executable, 0o755);
        relativeExecutables[executableName] = safeRelative(extractedRoot, executable);
      }
      const destination = this.installRoot(definition.id, definition.version);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rm(destination, { recursive: true, force: true });
      await rename(extractedRoot, destination);
      const record: InstalledProviderRecord = {
        id: definition.id,
        version: definition.version,
        installedAt: new Date().toISOString(),
        executables: relativeExecutables
      };
      this.state.installed = this.state.installed.filter((candidate) => candidate.id !== definition.id);
      this.state.installed.push(record);
      if (definition.kind === "tex-distribution") this.state.activeTexProvider = definition.id;
      await this.persist();
      this.applyEnvironment();
      await this.onChanged?.();
      job.status = "completed";
      job.finishedAt = new Date().toISOString();
      this.emit(definition.id, "info", "provider-installed", `Installed ${definition.name} ${definition.version}.`);
    } catch (error) {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
      this.emit(definition.id, "error", "provider-install-failed", `${definition.name} installation failed: ${job.error}`);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async download(asset: ProviderAsset, target: string, job: ProviderInstallJob): Promise<void> {
    if (asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES) throw new Error("Provider archive size is outside the allowed range.");
    const response = await this.fetchImplementation(asset.url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Provider download failed (${response.status}).`);
    const finalUrl = new URL(response.url || asset.url);
    if (finalUrl.protocol !== "https:" || !allowedDownloadHost(finalUrl.hostname)) throw new Error("Provider download redirected to an untrusted host.");
    const declaredLength = Number(response.headers.get("content-length") ?? asset.size);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > asset.size + DOWNLOAD_OVERHEAD_BYTES) throw new Error("Provider download declared an unexpected size.");
    const file = await open(target, "wx", 0o600);
    const digest = createHash("sha256");
    let downloaded = 0;
    try {
      for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.from(value);
        downloaded += chunk.byteLength;
        if (downloaded > asset.size + DOWNLOAD_OVERHEAD_BYTES) throw new Error("Provider download exceeded its pinned size.");
        digest.update(chunk);
        await file.write(chunk);
        job.downloadedBytes = downloaded;
      }
    } finally {
      await file.close();
    }
    if (downloaded !== asset.size) throw new Error(`Provider download size mismatch: expected ${asset.size}, received ${downloaded}.`);
    const actual = digest.digest("hex");
    if (actual !== asset.sha256) throw new Error("Provider download checksum mismatch.");
  }

  private applyEnvironment(): void {
    for (const [key, value] of Object.entries(this.baselineEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const active = this.state.installed.find((candidate) => candidate.id === this.state.activeTexProvider);
    if (active) {
      const executables = this.absoluteExecutables(active);
      if (executables.pdflatex) process.env.TYPR_COMPANION_PDFLATEX_EXECUTABLE = executables.pdflatex;
      if (executables.latexmk) process.env.TYPR_COMPANION_LATEXMK_EXECUTABLE = executables.latexmk;
      const bins = new Set(Object.values(executables).map(dirname));
      process.env.TYPR_COMPANION_NATIVE_PATH = [...bins, process.env.TYPR_COMPANION_NATIVE_PATH ?? process.env.PATH ?? ""].filter(Boolean).join(sep === "\\" ? ";" : ":");
    }
    for (const record of this.state.installed) {
      const executables = this.absoluteExecutables(record);
      if (record.id === "texlab" && executables.texlab) process.env.TYPR_COMPANION_TEXLAB_EXECUTABLE = executables.texlab;
      if (record.id === "tinymist" && executables.tinymist) process.env.TYPR_COMPANION_TINYMIST_EXECUTABLE = executables.tinymist;
    }
  }

  private absoluteExecutables(record: InstalledProviderRecord): Record<string, string> {
    const root = this.installRoot(record.id, record.version);
    return Object.fromEntries(Object.entries(record.executables).map(([name, path]) => [name, resolveInside(root, path)]));
  }

  private assetFor(definition: ManagedProviderDefinition): ProviderAsset | undefined {
    return definition.assets.find((candidate) => candidate.platform === this.platform && candidate.arch === this.arch);
  }

  private requireDefinition(providerId: string): ManagedProviderDefinition {
    const definition = this.catalog.find((candidate) => candidate.id === providerId);
    if (!definition) throw new ProviderManagerError(404, "provider-not-found", "Managed provider was not found in the curated catalog.");
    return definition;
  }

  private installRoot(providerId: string, version: string): string {
    return join(this.dataRoot!, "providers", providerId, version);
  }

  private statePath(): string {
    return join(this.dataRoot!, "providers.json");
  }

  private async persist(): Promise<void> {
    if (!this.dataRoot) return;
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    const temporary = `${this.statePath()}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.statePath());
    });
    await this.writeQueue;
  }

  private async removeMissingInstallations(): Promise<void> {
    const retained: InstalledProviderRecord[] = [];
    for (const record of this.state.installed) {
      try {
        const executable = Object.values(this.absoluteExecutables(record))[0];
        if (!executable) continue;
        const executableStat = await stat(executable);
        if (executableStat.isFile()) retained.push(record);
      } catch {
        // A partial or externally deleted provider is removed from the active state.
      }
    }
    if (retained.length !== this.state.installed.length) {
      this.state.installed = retained;
      if (!retained.some((record) => record.id === this.state.activeTexProvider)) delete this.state.activeTexProvider;
      await this.persist();
    }
  }

  private emit(providerId: string, level: "info" | "warning" | "error", type: string, message: string, metadata?: Record<string, string | number | boolean | null>): void {
    this.onEvent?.({ providerId, level, type, message, ...(metadata ? { metadata } : {}) });
  }
}

export class ProviderManagerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProviderManagerError";
    this.status = status;
    this.code = code;
  }
}

async function extractProviderAsset(asset: ProviderAsset, archivePath: string, destination: string): Promise<void> {
  if (asset.archive === "windows-installer") {
    if (process.platform !== "win32") throw new Error("Windows provider installer cannot run on this platform.");
    await runExtractor(archivePath, ["-y", `-o${destination}`]);
    return;
  }
  const command = process.platform === "win32" ? "tar.exe" : "tar";
  const mode = asset.archive === "tar.gz" ? "-xzf" : asset.archive === "tar.xz" ? "-xJf" : "-xf";
  await runExtractor(command, [mode, archivePath, "-C", destination]);
}

async function runExtractor(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { windowsHide: true, timeout: 15 * 60_000, maxBuffer: 1024 * 1024 });
}

async function findExecutable(root: string, name: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const expected = platform === "win32" ? `${name}.exe`.toLowerCase() : name;
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_DISCOVERY_ENTRIES) throw new Error("Provider archive contains too many entries.");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name.toLowerCase() !== expected) continue;
        const target = await realpath(path);
        resolveInside(root, relative(root, target));
        if ((await stat(target)).isFile()) return path;
        continue;
      }
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.toLowerCase() === expected) return path;
    }
  }
  return undefined;
}

function asset(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  filename: string,
  sha256: string,
  size: number,
  archive: ProviderArchive
): ProviderAsset {
  return {
    platform,
    arch,
    url: `https://github.com/rstudio/tinytex-releases/releases/download/v2026.08/${filename}`,
    sha256,
    size,
    archive
  };
}

function githubAsset(
  repository: string,
  tag: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  filename: string,
  sha256: string,
  size: number,
  archive: ProviderArchive
): ProviderAsset {
  return { platform, arch, url: `https://github.com/${repository}/releases/download/${tag}/${filename}`, sha256, size, archive };
}

function archiveExtension(archive: ProviderArchive): string {
  if (archive === "windows-installer") return "exe";
  return archive;
}

function validateDataRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error("TYPR_COMPANION_DATA_ROOT must be an absolute path.");
  return resolve(value);
}

function validateProviderState(value: unknown, catalog: readonly ManagedProviderDefinition[]): ProviderState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.installed) ||
    (value.activeTexProvider !== undefined && typeof value.activeTexProvider !== "string")) {
    throw new Error("Companion provider state is invalid.");
  }
  const definitions = new Map(catalog.map((definition) => [definition.id, definition]));
  const installed = value.installed.map((record) => {
    if (!isRecord(record) || typeof record.id !== "string" || typeof record.version !== "string" ||
      typeof record.installedAt !== "string" || !isRecord(record.executables)) {
      throw new Error("Companion installed-provider state is invalid.");
    }
    const definition = definitions.get(record.id);
    if (!definition || definition.version !== record.version) throw new Error("Companion provider state references an unknown provider version.");
    const executables: Record<string, string> = {};
    for (const [name, path] of Object.entries(record.executables)) {
      if (!definition.executableNames.includes(name) || typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
        throw new Error("Companion provider executable state is invalid.");
      }
      executables[name] = path;
    }
    return { id: record.id, version: record.version, installedAt: record.installedAt, executables };
  });
  return {
    version: 1,
    installed,
    ...(value.activeTexProvider ? { activeTexProvider: value.activeTexProvider } : {})
  };
}

function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error("Provider executable escapes its install root.");
  return resolved;
}

function safeRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || isAbsolute(value) || value.split(sep).includes("..")) throw new Error("Provider executable path is invalid.");
  return value;
}

function allowedDownloadHost(hostname: string): boolean {
  return hostname === "github.com" || hostname === "objects.githubusercontent.com" || hostname.endsWith(".githubusercontent.com");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
