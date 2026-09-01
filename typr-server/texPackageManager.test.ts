import { describe, expect, it, vi } from "vitest";
import {
  extractMissingTexFiles,
  packageForExactFile,
  requiresTlmgrSelfUpdate,
  TexPackageManager,
  texPackageAutoInstallEnabled,
  type TexPackageManagerCommandRunner
} from "./texPackageManager.ts";

describe("TeX package resolver", () => {
  it("extracts supported missing files and ignores unsafe or unrelated diagnostics", () => {
    const output = [
      "! LaTeX Error: File `thmbox.sty' not found.",
      "! LaTeX Error: File `memoir.cls' not found.",
      "! LaTeX Error: File `../../secret.txt' not found.",
      "! LaTeX Error: File `evil;touch.sty' not found.",
      "I couldn't open style file alpha.bst",
      "! Font U/rsfs/m/n/10=rsfs10 at 10.0pt not loadable: Metric (TFM) file not found."
    ].join("\n");

    expect(extractMissingTexFiles(output)).toEqual(["thmbox.sty", "memoir.cls", "alpha.bst", "rsfs10.tfm"]);
  });

  it("requires an exact filename under a validated tlmgr package header", () => {
    const output = [
      "tlmgr: package repository https://mirror.example/tlnet",
      "other-package:",
      "  texmf-dist/tex/latex/other/not-thmbox.sty",
      "thmbox:",
      "  texmf-dist/tex/latex/thmbox/thmbox.sty"
    ].join("\n");

    expect(packageForExactFile(output, "thmbox.sty")).toBe("thmbox");
    expect(packageForExactFile(output, "missing.sty")).toBeUndefined();
  });

  it("searches, installs, and reports the selected package", async () => {
    const runCommand = vi.fn<TexPackageManagerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "thmbox:\n  texmf-dist/tex/latex/thmbox/thmbox.sty\n",
        stderr: ""
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "installed: thmbox", stderr: "" });
    const manager = new TexPackageManager({ command: "/opt/TinyTeX/bin/tlmgr", runCommand });
    const result = await manager.resolveCompilerFailure(
      "! LaTeX Error: File `thmbox.sty' not found.",
      new AbortController().signal
    );

    expect(result).toEqual({ files: ["thmbox.sty"], packages: ["thmbox"], installed: true });
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "/opt/TinyTeX/bin/tlmgr",
      ["search", "--global", "--file", "/thmbox.sty"],
      expect.any(AbortSignal),
      30_000
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "/opt/TinyTeX/bin/tlmgr",
      ["install", "thmbox"],
      expect.any(AbortSignal),
      300_000
    );
  });

  it("does not run tlmgr when automatic installation is disabled", async () => {
    const runCommand = vi.fn<TexPackageManagerCommandRunner>();
    const manager = new TexPackageManager({ enabled: false, runCommand });
    const result = await manager.resolveCompilerFailure(
      "! LaTeX Error: File `thmbox.sty' not found.",
      new AbortController().signal
    );

    expect(result.installed).toBe(false);
    expect(result.diagnostic).toContain("disabled");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("self-updates an older tlmgr and retries the package transaction", async () => {
    const runCommand = vi.fn<TexPackageManagerCommandRunner>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "thmbox:\n texmf-dist/tex/latex/thmbox/thmbox.sty\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 255, stdout: "", stderr: "tlmgr itself needs to be updated." })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "tlmgr updated", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "installed", stderr: "" });
    const manager = new TexPackageManager({ runCommand });

    await expect(manager.resolveCompilerFailure(
      "! LaTeX Error: File `thmbox.sty' not found.",
      new AbortController().signal
    )).resolves.toMatchObject({ installed: true, packages: ["thmbox"] });
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual([
      ["search", "--global", "--file", "/thmbox.sty"],
      ["install", "thmbox"],
      ["update", "--self"],
      ["install", "thmbox"]
    ]);
    expect(requiresTlmgrSelfUpdate("TLMGR ITSELF NEEDS TO BE UPDATED")).toBe(true);
  });

  it("accepts an explicit opt-out and rejects ambiguous values", () => {
    expect(texPackageAutoInstallEnabled(undefined)).toBe(true);
    expect(texPackageAutoInstallEnabled("1")).toBe(true);
    expect(texPackageAutoInstallEnabled("0")).toBe(false);
    expect(() => texPackageAutoInstallEnabled("yes")).toThrow(/must be unset, 0, or 1/u);
  });

  it("updates the active TeX Live release and installed packages together", async () => {
    const runCommand = vi.fn<TexPackageManagerCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: "tlmgr: package repository current",
      stderr: ""
    });
    const manager = new TexPackageManager({ runCommand });
    await expect(manager.updateAll(new AbortController().signal)).resolves.toMatchObject({ updated: true });
    expect(runCommand).toHaveBeenCalledWith("tlmgr", ["update", "--self", "--all"], expect.any(AbortSignal), 900_000);
  });
});
