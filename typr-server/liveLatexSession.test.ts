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
});
