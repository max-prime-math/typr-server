import { basename, dirname, resolve } from "node:path";
import { nativeTool, nativeToolAvailable } from "./nativeTools.ts";
import { runNativeProcess, type NativeProcessResult } from "./nativeProcess.ts";

/** Runs the same deterministic, shell-escape-disabled final build on every host. */
export async function runLatexProject(
  workspace: string,
  mainFilePath: string,
  signal: AbortSignal
): Promise<NativeProcessResult> {
  const location = latexProjectExecutionLocation(workspace, mainFilePath);
  if (await nativeToolAvailable("latexmk")) {
    return runNativeProcess(
      nativeTool("latexmk"),
      ["-norc", "-pdf", "-synctex=1", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", location.outputDirectoryArgument, location.mainFileArgument],
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
