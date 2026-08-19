import { nativeTool, nativeToolAvailable } from "./nativeTools.ts";
import { runNativeProcess, type NativeProcessResult } from "./nativeProcess.ts";

/** Runs the same deterministic, shell-escape-disabled final build on every host. */
export async function runLatexProject(
  workspace: string,
  mainFilePath: string,
  signal: AbortSignal
): Promise<NativeProcessResult> {
  if (await nativeToolAvailable("latexmk")) {
    return runNativeProcess(
      nativeTool("latexmk"),
      ["-norc", "-pdf", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", mainFilePath],
      workspace,
      signal
    );
  }

  let result: NativeProcessResult = { exitCode: 0, signal: null, stdout: "", stderr: "" };
  for (let pass = 1; pass <= 3; pass += 1) {
    result = await runNativeProcess(
      nativeTool("pdflatex"),
      ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", mainFilePath],
      workspace,
      signal
    );
    result.stdout = `--- pdflatex pass ${pass} ---\n${result.stdout}`;
    if (result.exitCode !== 0) break;
  }
  return result;
}
