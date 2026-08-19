import { spawn } from "node:child_process";

export type NativeTool = "latexmk" | "pdflatex" | "texpresso";

const ENVIRONMENT_KEYS: Readonly<Record<NativeTool, string>> = {
  latexmk: "TYPR_COMPANION_LATEXMK_EXECUTABLE",
  pdflatex: "TYPR_COMPANION_PDFLATEX_EXECUTABLE",
  texpresso: "TYPR_COMPANION_TEXPRESSO_EXECUTABLE"
};

export function nativeTool(tool: NativeTool): string {
  return process.env[ENVIRONMENT_KEYS[tool]]?.trim() || tool;
}

export function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const child = spawn(command, ["--version"], { shell: false, stdio: "ignore" });
    child.once("error", () => resolveAvailability(false));
    child.once("close", (code) => resolveAvailability(code === 0));
  });
}

export async function nativeToolAvailable(tool: NativeTool): Promise<boolean> {
  return commandAvailable(nativeTool(tool));
}
