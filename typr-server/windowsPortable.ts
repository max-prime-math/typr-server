import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { getAsset, isSea } from "node:sea";

declare const TYPR_WINDOWS_BUILD_VERSION: string | undefined;

const execFileAsync = promisify(execFile);
const TINYTEX_ASSET = "tinytex-installer.exe";

/** Prepares the embedded, per-user TeX runtime without installation or network access. */
export async function prepareWindowsPortableRuntime(): Promise<void> {
  if (process.platform !== "win32") return;

  const dataRoot = windowsCompanionDataRoot();
  const version = typeof TYPR_WINDOWS_BUILD_VERSION === "string" && TYPR_WINDOWS_BUILD_VERSION
    ? TYPR_WINDOWS_BUILD_VERSION
    : "development";
  if (isSea() && !process.env.TYPR_COMPANION_VERSION?.trim()) {
    process.env.TYPR_COMPANION_VERSION = version;
  }
  const runtimeRoot = join(dataRoot, "runtime", version);
  const tinyTexRoot = join(runtimeRoot, "TinyTeX");
  const bin = join(tinyTexRoot, "bin", "windows");
  const pdflatex = join(bin, "pdflatex.exe");

  if (isSea() && !(await executableExists(pdflatex))) {
    await mkdir(runtimeRoot, { recursive: true });
    const installer = join(runtimeRoot, ".tinytex-installer.exe");
    console.log("Preparing Typr Companion's offline LaTeX runtime for this Windows user. This runs once per version.");
    await writeFile(installer, new Uint8Array(getAsset(TINYTEX_ASSET)));
    try {
      await execFileAsync(installer, ["-y", `-o${runtimeRoot}`], {
        windowsHide: true,
        timeout: 5 * 60_000,
        maxBuffer: 1024 * 1024
      });
    } finally {
      await rm(installer, { force: true }).catch(() => undefined);
    }
    if (!(await executableExists(pdflatex))) {
      throw new Error("The embedded TinyTeX runtime did not produce pdflatex.exe.");
    }
  }

  if (await executableExists(pdflatex)) {
    process.env.TYPR_COMPANION_NATIVE_PATH = [bin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
    process.env.TYPR_COMPANION_PDFLATEX_EXECUTABLE = pdflatex;
    const latexmk = join(bin, "latexmk.exe");
    if (await executableExists(latexmk)) process.env.TYPR_COMPANION_LATEXMK_EXECUTABLE = latexmk;
  }

  // A dedicated per-user directory exposes the workspace feature without an
  // installer, broad filesystem share, or administrator-controlled location.
  if (!process.env.TYPR_COMPANION_WORKSPACE_ROOT?.trim()) {
    const workspace = join(dataRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    process.env.TYPR_COMPANION_WORKSPACE_ROOT = workspace;
    process.env.TYPR_COMPANION_WORKSPACE_ID = "windows-local";
  }
}

export function windowsCompanionDataRoot(): string {
  const localData = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
  return join(localData, "Typr Companion");
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
