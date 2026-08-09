import { describe, expect, it } from "vitest";
import {
  TYPR_COMPANION_PROTOCOL_VERSION,
  TYPR_COMPANION_ROUTES,
  type CompanionStatusResponse,
  type CompileFailure,
  type CompileRequest,
  type CompileResult,
  type CompileSuccess
} from "./index";

describe("Typr Companion protocol", () => {
  it("defines the initial version and versioned routes", () => {
    expect(TYPR_COMPANION_PROTOCOL_VERSION).toBe(1);
    expect(TYPR_COMPANION_ROUTES).toEqual({
      status: "/api/v1/status",
      compile: "/api/v1/compile"
    });
  });

  it("models capability discovery with extensible capability groups", () => {
    const status: CompanionStatusResponse = {
      protocolVersion: 1,
      serverVersion: "0.1.0",
      capabilities: {
        compile: { engines: ["pdflatex", "typst"] },
        filesystem: { projectStorage: false },
        lsp: { languages: [] },
        git: { enabled: false },
        terminal: { enabled: false }
      }
    };

    expect(status.capabilities.compile.engines).toContain("typst");
    expect(status.capabilities.filesystem.projectStorage).toBe(false);
  });

  it("models a complete multi-file text project compile request", () => {
    const request: CompileRequest = {
      protocolVersion: TYPR_COMPANION_PROTOCOL_VERSION,
      engine: "pdflatex",
      mainFilePath: "main.tex",
      files: [
        { path: "main.tex", kind: "text", content: "\\input{chapters/intro}" },
        { path: "chapters/intro.tex", kind: "text", content: "Introduction" },
        { path: "references.bib", kind: "text", content: "@book{example}" }
      ]
    };

    expect(request.files.map((file) => file.path)).toEqual([
      "main.tex",
      "chapters/intro.tex",
      "references.bib"
    ]);
  });

  it("distinguishes successful compilation results from failures", () => {
    const success: CompileSuccess = {
      ok: true,
      engine: "typst",
      output: {
        path: "out/document.pdf",
        mediaType: "application/pdf",
        encoding: "base64",
        content: "JVBERi0="
      },
      log: "Compilation completed.",
      durationMs: 42
    };
    const failure: CompileFailure = {
      ok: false,
      engine: "pdflatex",
      errors: [
        {
          code: "undefined-control-sequence",
          message: "Undefined control sequence.",
          path: "main.tex",
          line: 12
        }
      ],
      log: "! Undefined control sequence.",
      durationMs: 28
    };

    const results: CompileResult[] = [success, failure];
    const resultSummaries = results.map((result) => {
      if (result.ok) {
        return result.output.mediaType;
      }

      return result.errors[0]?.code;
    });

    expect(resultSummaries).toEqual([
      "application/pdf",
      "undefined-control-sequence"
    ]);
  });
});
