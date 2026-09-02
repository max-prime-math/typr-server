import { basename, dirname, resolve } from "node:path";
import { nativeTool, nativeToolAvailable } from "./nativeTools.ts";
import { runNativeProcess, type NativeProcessResult } from "./nativeProcess.ts";
import { activeTexPackageManager } from "./texPackageManager.ts";

const MAX_PACKAGE_RESOLUTION_ROUNDS = 3;

/** Runs the same deterministic, shell-escape-disabled final build on every host. */
export async function runLatexProject(
  workspace: string,
  mainFilePath: string,
  signal: AbortSignal
): Promise<NativeProcessResult> {
  let result = await runLatexProjectOnce(workspace, mainFilePath, signal, false);
  const resolutionNotes: string[] = [];
  for (let round = 0; result.exitCode !== 0 && round < MAX_PACKAGE_RESOLUTION_ROUNDS; round += 1) {
    const resolution = await activeTexPackageManager().resolveCompilerFailure(`${result.stdout}\n${result.stderr}`, signal);
    if (!resolution.installed) {
      if (resolution.files.length > 0 && resolution.diagnostic) {
        resolutionNotes.push(`[typr] Could not install package for ${resolution.files.join(", ")}: ${resolution.diagnostic}`);
      }
      break;
    }
    resolutionNotes.push(`[typr] Installed ${resolution.packages.join(", ")} for ${resolution.files.join(", ")}; retrying compilation.`);
    result = await runLatexProjectOnce(workspace, mainFilePath, signal, true);
  }
  if (resolutionNotes.length > 0) result.stderr = `${resolutionNotes.join("\n")}\n${result.stderr}`;
  return result;
}

async function runLatexProjectOnce(
  workspace: string,
  mainFilePath: string,
  signal: AbortSignal,
  forceRebuild: boolean
): Promise<NativeProcessResult> {
  const location = latexProjectExecutionLocation(workspace, mainFilePath);
  if (await nativeToolAvailable("latexmk")) {
    return runNativeProcess(
      nativeTool("latexmk"),
      ["-norc", "-pdf", ...(forceRebuild ? ["-g"] : []), "-synctex=1", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", location.outputDirectoryArgument, location.mainFileArgument],
      location.workingDirectory,
      signal,
      { sandboxRoot: workspace }
    );
  }

  let result: NativeProcessResult = { exitCode: 0, signal: null, stdout: "", stderr: "" };
  for (let pass = 1; pass <= 3; pass += 1) {
    result = await runNativeProcess(
      nativeTool("pdflatex"),
      ["-synctex=1", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", location.outputDirectoryArgument, location.mainFileArgument],
      location.workingDirectory,
      signal,
      { sandboxRoot: workspace }
    );
    result.stdout = `--- pdflatex pass ${pass} ---\n${result.stdout}`;
    if (result.exitCode !== 0) break;
  }
  return result;
}

export function latexProjectExecutionLocation(workspace: string, mainFilePath: string): {
  workingDirectory: string;
  mainFileArgument: string;
  outputDirectoryArgument: string;
} {
  return {
    workingDirectory: resolve(workspace, dirname(mainFilePath)),
    mainFileArgument: basename(mainFilePath),
    outputDirectoryArgument: "-output-directory=."
  };
}
