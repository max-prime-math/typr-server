import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, delimiter, extname, join } from "node:path";
import { nativeTool } from "./nativeTools.ts";

const SUPPORTED_MISSING_EXTENSIONS = new Set([
  ".bbx", ".bst", ".cbx", ".cfg", ".clo", ".cls", ".def", ".enc", ".fd",
  ".map", ".otf", ".pfb", ".sty", ".tfm", ".ttf", ".vf"
]);
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/u;
const SAFE_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/u;
const MAX_FILES_PER_ROUND = 4;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface TexPackageResolution {
  files: string[];
  packages: string[];
  installed: boolean;
  diagnostic?: string;
}

export interface TexPackageUpdateResult {
  updated: boolean;
  diagnostic: string;
}

export interface TexPackageManagerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type TexPackageManagerCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number
) => Promise<TexPackageManagerCommandResult>;

export interface TexPackageManagerOptions {
  command?: string;
  enabled?: boolean;
  runCommand?: TexPackageManagerCommandRunner;
}

/**
 * Resolves missing TeX support files through the active TeX Live package
 * database. Installs are serialized because tlmgr mutates one shared tree.
 */
export class TexPackageManager {
  private readonly command: string;
  private readonly enabled: boolean;
  private readonly runCommand: TexPackageManagerCommandRunner;
  private installQueue: Promise<void> = Promise.resolve();

  constructor(options: TexPackageManagerOptions = {}) {
    this.command = options.command ?? nativeTool("tlmgr");
    this.enabled = options.enabled ?? texPackageAutoInstallEnabled(process.env.TYPR_COMPANION_TEX_AUTO_INSTALL);
    this.runCommand = options.runCommand ?? runTexPackageManagerCommand;
  }

  async resolveCompilerFailure(output: string, signal: AbortSignal): Promise<TexPackageResolution> {
    const files = extractMissingTexFiles(output).slice(0, MAX_FILES_PER_ROUND);
    if (files.length === 0) return { files: [], packages: [], installed: false };
    if (!this.enabled) {
      return {
        files,
        packages: [],
        installed: false,
        diagnostic: "automatic TeX package installation is disabled"
      };
    }

    let releaseQueue!: () => void;
    const previous = this.installQueue;
    this.installQueue = new Promise<void>((resolveQueue) => { releaseQueue = resolveQueue; });
    await previous;
    try {
      const packages = new Set<string>();
      for (const file of files) {
        if (signal.aborted) return { files, packages: [...packages], installed: false, diagnostic: "compilation was cancelled" };
        const search = await this.runCommand(
          this.command,
          ["search", "--global", "--file", `/${file}`],
          signal,
          SEARCH_TIMEOUT_MS
        );
        if (search.exitCode !== 0) {
          return {
            files,
            packages: [...packages],
            installed: false,
            diagnostic: conciseCommandFailure("tlmgr search", search)
          };
        }
        const packageName = packageForExactFile(search.stdout, file);
        if (packageName) packages.add(packageName);
      }

      if (packages.size === 0) {
        return { files, packages: [], installed: false, diagnostic: "no exact package match was found in the TeX Live repository" };
      }
      let install = await this.runCommand(
        this.command,
        ["install", ...packages],
        signal,
        INSTALL_TIMEOUT_MS
      );
      if (install.exitCode !== 0 && requiresTlmgrSelfUpdate(`${install.stdout}\n${install.stderr}`)) {
        const selfUpdate = await this.runCommand(
          this.command,
          ["update", "--self"],
          signal,
          INSTALL_TIMEOUT_MS
        );
        if (selfUpdate.exitCode !== 0) {
          return {
            files,
            packages: [...packages],
            installed: false,
            diagnostic: conciseCommandFailure("tlmgr self-update", selfUpdate)
          };
        }
        install = await this.runCommand(
          this.command,
          ["install", ...packages],
          signal,
          INSTALL_TIMEOUT_MS
        );
      }
      if (install.exitCode !== 0) {
        return {
          files,
          packages: [...packages],
          installed: false,
          diagnostic: conciseCommandFailure("tlmgr install", install)
        };
      }
      return { files, packages: [...packages], installed: true };
    } catch (error) {
      return {
        files,
        packages: [],
        installed: false,
        diagnostic: error instanceof Error ? error.message : String(error)
      };
    } finally {
      releaseQueue();
    }
  }

  /** Applies all updates available within the active TeX Live release. */
  async updateAll(signal: AbortSignal): Promise<TexPackageUpdateResult> {
    if (!this.enabled) return { updated: false, diagnostic: "automatic TeX package management is disabled" };
    let releaseQueue!: () => void;
    const previous = this.installQueue;
    this.installQueue = new Promise<void>((resolveQueue) => { releaseQueue = resolveQueue; });
    await previous;
    try {
      const update = await this.runCommand(
        this.command,
        ["update", "--self", "--all"],
        signal,
        15 * 60_000
      );
      if (update.exitCode !== 0) return { updated: false, diagnostic: conciseCommandFailure("tlmgr update", update) };
      return {
        updated: true,
        diagnostic: `${update.stdout}\n${update.stderr}`.trim().split(/\r?\n/u).filter(Boolean).slice(-5).join(" ") || "TeX Live is current."
      };
    } catch (error) {
      return { updated: false, diagnostic: error instanceof Error ? error.message : String(error) };
    } finally {
      releaseQueue();
    }
  }
}

let sharedManager: TexPackageManager | undefined;
let sharedManagerCommand: string | undefined;

/** Follows provider activation while keeping installs serialized per active tree. */
export function activeTexPackageManager(): TexPackageManager {
  const command = nativeTool("tlmgr");
  if (!sharedManager || sharedManagerCommand !== command) {
    sharedManager = new TexPackageManager({ command });
    sharedManagerCommand = command;
  }
  return sharedManager;
}

/** Extracts only safe, package-manageable filenames from canonical TeX errors. */
export function extractMissingTexFiles(output: string): string[] {
  const files = new Set<string>();
  const patterns = [
    /(?:LaTeX|Package\s+\S+)\s+Error:\s+File\s+[`']([^`'\r\n]+)[`']\s+not\s+found\.?/giu,
    /I couldn't open style file\s+([^\s.]+\.(?:bst|bbx|cbx))/giu,
    /Font\s+[^\r\n=]+?=([A-Za-z0-9._+-]+)(?:\s+at\s+[^\r\n]+?)?\s+not\s+loadable:\s+Metric\s+\(TFM\)\s+file\s+not\s+found/giu
  ];
  for (const [patternIndex, pattern] of patterns.entries()) {
    for (const match of output.matchAll(pattern)) {
      const raw = patternIndex === 2 && !extname(match[1]) ? `${match[1]}.tfm` : match[1];
      const candidate = safeMissingFile(raw);
      if (candidate) files.add(candidate);
    }
  }
  return [...files];
}

/** Parses tlmgr's stable package-header/path output and requires an exact basename match. */
export function packageForExactFile(output: string, requestedFile: string): string | undefined {
  let packageName: string | undefined;
  let bestMatch: { packageName: string; score: number } | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const header = /^([A-Za-z0-9][A-Za-z0-9._+-]{0,159}):\s*$/u.exec(line.trim());
    if (header) {
      packageName = SAFE_PACKAGE_NAME.test(header[1]) ? header[1] : undefined;
      continue;
    }
    if (!packageName) continue;
    const path = line.trim().replace(/^RELOCATED\//u, "");
    if (basename(path.replaceAll("\\", "/")) === requestedFile) {
      const score = /(?:^|\/)texmf-dist\/(?:tex|fonts)\//u.test(path) ? 2 : /(?:^|\/)(?:doc|source)\//u.test(path) ? 0 : 1;
      if (!bestMatch || score > bestMatch.score) bestMatch = { packageName, score };
    }
  }
  return bestMatch?.packageName;
}

export function texPackageAutoInstallEnabled(value: string | undefined): boolean {
  const normalized = value?.trim();
  if (!normalized || normalized === "1") return true;
  if (normalized === "0") return false;
  throw new Error("TYPR_COMPANION_TEX_AUTO_INSTALL must be unset, 0, or 1.");
}

export function requiresTlmgrSelfUpdate(output: string): boolean {
  return /tlmgr itself needs to be updated/iu.test(output);
}

function safeMissingFile(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/");
  const file = basename(normalized);
  if (file !== normalized && !normalized.endsWith(`/${file}`)) return undefined;
  if (!SAFE_FILE_NAME.test(file) || !SUPPORTED_MISSING_EXTENSIONS.has(extname(file).toLowerCase())) return undefined;
  return file;
}

function conciseCommandFailure(label: string, result: TexPackageManagerCommandResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/u).filter(Boolean).slice(-3).join(" ");
  return `${label} exited with code ${result.exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`;
}

async function packageManagerEnvironment(): Promise<NodeJS.ProcessEnv> {
  const configuredRoot = process.env.TYPR_COMPANION_DATA_ROOT?.trim();
  const home = configuredRoot
    ? join(configuredRoot, "tex-package-manager")
    : process.platform === "win32" ? process.env.USERPROFILE : "/tmp/typr-tex-package-manager";
  if (home) await mkdir(home, { recursive: true, mode: 0o700 });
  const configuredPath = process.env.TYPR_COMPANION_NATIVE_PATH?.trim();
  const path = configuredPath || (process.platform === "win32"
    ? process.env.PATH ?? process.env.Path ?? ""
    : "/usr/local/bin:/usr/bin:/bin");
  return {
    PATH: path.split(delimiter).filter(Boolean).join(delimiter),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...(home ? { HOME: home } : {}),
    ...(process.platform === "win32" ? {
      USERPROFILE: home,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT
    } : {}),
    ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
    ...(process.env.SSL_CERT_DIR ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
    ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {})
  };
}

async function runTexPackageManagerCommand(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number
): Promise<TexPackageManagerCommandResult> {
  const isWindowsScript = process.platform === "win32" && /\.(?:bat|cmd)$/iu.test(command);
  const executable = isWindowsScript ? process.env.ComSpec || "cmd.exe" : command;
  const commandArguments = isWindowsScript ? ["/d", "/s", "/c", command, ...args] : [...args];
  const child = spawn(executable, commandArguments, {
    shell: false,
    windowsHide: true,
    env: await packageManagerEnvironment(),
    stdio: "pipe"
  });
  return new Promise((resolveRun, rejectRun) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const abort = () => child.kill("SIGKILL");
    const capture = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining > 0) target.push(buffer.subarray(0, remaining));
      bytes += buffer.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      rejectRun(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolveRun({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}
