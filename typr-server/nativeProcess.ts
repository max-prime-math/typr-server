import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 1500;

export interface NativeProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export class NativeProcessError extends Error {
  readonly code: "compile-timeout" | "compiler-output-limit";

  constructor(code: "compile-timeout" | "compiler-output-limit", message: string) {
    super(message);
    this.name = "NativeProcessError";
    this.code = code;
  }
}

export async function prepareCompilerEnvironment(
  cwd: string,
  extra: Record<string, string> = {}
): Promise<NodeJS.ProcessEnv> {
  const home = join(cwd, ".typr-home");
  const texmf = join(cwd, ".typr-texmf");
  const cache = join(cwd, ".typr-cache");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(texmf, { recursive: true }), mkdir(cache, { recursive: true })]);
  const configuredNativePath = process.env.TYPR_COMPANION_NATIVE_PATH?.trim();
  const path = configuredNativePath || (process.platform === "win32"
    ? process.env.PATH ?? process.env.Path ?? ""
    : "/usr/local/bin:/usr/bin:/bin");
  return {
    PATH: path.split(delimiter).filter(Boolean).join(delimiter),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: home,
    TMPDIR: cwd,
    ...(process.platform === "win32" ? {
      USERPROFILE: home,
      TEMP: cwd,
      TMP: cwd,
      // Windows cannot start even an absolute .exe without these system values.
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT
    } : {}),
    TEXMFHOME: texmf,
    TEXMFVAR: join(texmf, "var"),
    TEXMFCONFIG: join(texmf, "config"),
    TEXMFCACHE: cache,
    TEXMFOUTPUT: cwd,
    shell_escape: "f",
    openin_any: "p",
    openout_any: "p",
    SDL_VIDEODRIVER: "dummy",
    ...extra
  };
}

export function spawnSandboxed(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcessWithoutNullStreams {
  const launcher = process.env.TYPR_COMPANION_SANDBOX_EXECUTABLE?.trim();
  return spawn(
    launcher || command,
    launcher ? [cwd, "--", command, ...args] : [...args],
    {
      cwd,
      detached: process.platform !== "win32",
      env,
      shell: false,
      stdio: "pipe"
    }
  );
}

export async function runNativeProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal
): Promise<NativeProcessResult> {
  const child = spawnSandboxed(command, args, cwd, await prepareCompilerEnvironment(cwd));
  return new Promise((resolveRun, rejectRun) => {
    const detached = process.platform !== "win32";
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let failure: NativeProcessError | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (childSignal: NodeJS.Signals) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, childSignal);
        else if (process.platform === "win32" && child.pid) {
          // taskkill /T is the only Windows-inbox way to terminate latexmk and
          // every TeX child it owns. It needs no elevation for this user's tree.
          const arguments_ = ["/pid", String(child.pid), "/t"];
          if (childSignal === "SIGKILL") arguments_.push("/f");
          const killer = spawn("taskkill.exe", arguments_, { shell: false, stdio: "ignore" });
          killer.on("error", () => child.kill());
        } else child.kill(childSignal);
      } catch {
        // The process may have exited between deciding to stop it and signalling it.
      }
    };
    const stop = (immediate = false) => {
      if (!failure) failure = new NativeProcessError("compile-timeout", "Native compilation exceeded its deadline.");
      if (immediate) {
        signalGroup("SIGKILL");
        return;
      }
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const abortListener = () => stop();
    const capture = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (remaining > 0) target.push(buffer.subarray(0, remaining));
      capturedBytes += buffer.byteLength;
      if (capturedBytes > MAX_CAPTURE_BYTES && !failure) {
        failure = new NativeProcessError("compiler-output-limit", "Native compiler output exceeded 1 MiB.");
        stop(true);
      }
    };

    if (signal.aborted) stop();
    else signal.addEventListener("abort", abortListener, { once: true });
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => {
      signal.removeEventListener("abort", abortListener);
      if (killTimer) clearTimeout(killTimer);
      rejectRun(error);
    });
    child.once("close", (exitCode, childSignal) => {
      signal.removeEventListener("abort", abortListener);
      if (killTimer) clearTimeout(killTimer);
      if (failure) {
        rejectRun(failure);
        return;
      }
      resolveRun({
        exitCode,
        signal: childSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}
