import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeProjectFiles } from "./projectFiles.ts";
import { startLiveLatexSession } from "./liveLatexSession.ts";
import { nativeToolAvailable } from "./nativeTools.ts";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.TYPR_COMPANION_LIVE_BACKEND;
  delete process.env.TYPR_COMPANION_TEXPRESSO_EXECUTABLE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable full-build live preview", () => {
  it("renders and updates PNG pages without TeXpresso when pdfLaTeX is installed", async () => {
    if (!(await nativeToolAvailable("pdflatex"))) return;
    process.env.TYPR_COMPANION_LIVE_BACKEND = "full";
    const root = await mkdtemp(join(tmpdir(), "typr-full-live-test-"));
    roots.push(root);
    const content = "\\documentclass{article}\n\\begin{document}\nOriginal\n\\end{document}\n";
    await materializeProjectFiles(root, [{ path: "main.tex", kind: "text", content }]);
    const session = await startLiveLatexSession({
      projectRoot: root,
      mainFilePath: "main.tex",
      files: [{ path: "main.tex", content }],
      timeoutMs: 30_000
    });
    try {
      expect(session.snapshot().result).toBe("success");
      expect(await session.getPageCount()).toBe(1);
      const first = await session.renderPage(0, 96);
      expect(first.data.subarray(0, 8)).toEqual(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(first.width).toBeGreaterThan(0);
      expect(first.height).toBeGreaterThan(0);
      const updated = await session.applyRangeChange("main.tex", {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 8 }
      }, "Updated");
      expect(updated.result).toBe("success");
      expect(session.getBuffer("main.tex")).toContain("Updated");
    } finally {
      await session.close();
    }
  });

  it("falls back to full builds when the configured TeXpresso executable is missing", async () => {
    if (!(await nativeToolAvailable("pdflatex"))) return;
    process.env.TYPR_COMPANION_TEXPRESSO_EXECUTABLE = "/missing/typr-texpresso";
    const root = await mkdtemp(join(tmpdir(), "typr-missing-texpresso-test-"));
    roots.push(root);
    const content = "\\documentclass{article}\n\\begin{document}\nFallback\n\\end{document}\n";
    await materializeProjectFiles(root, [{ path: "main.tex", kind: "text", content }]);
    const session = await startLiveLatexSession({
      projectRoot: root,
      mainFilePath: "main.tex",
      files: [{ path: "main.tex", content }],
      timeoutMs: 30_000
    });
    try {
      expect(session.pid).toBe(process.pid);
      expect(session.snapshot().result).toBe("success");
      expect(await session.getPageCount()).toBe(1);
    } finally {
      await session.close();
    }
  });
});
