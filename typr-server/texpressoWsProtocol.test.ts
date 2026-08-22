import { describe, expect, it } from "vitest";
import {
  TEXPRESSO_WS_LIMITS,
  TEXPRESSO_WS_PROTOCOL_VERSION,
  TEXPRESSO_WS_ROUTE,
  validateTexpressoClientMessage
} from "./texpressoWsProtocol.ts";

describe("private TeXpresso WebSocket protocol", () => {
  it("keeps its private version and route outside stable Companion API v1", () => {
    expect(TEXPRESSO_WS_PROTOCOL_VERSION).toBe(1);
    expect(TEXPRESSO_WS_ROUTE).toBe("/ws/texpresso");
    expect(TEXPRESSO_WS_ROUTE.startsWith("/api/v1")).toBe(false);
    expect(TEXPRESSO_WS_LIMITS.defaultDpi).toBe(240);
  });

  it("accepts nested text files, binary assets, and native render settings", () => {
    const result = validateTexpressoClientMessage({
      type: "initialize",
      protocolVersion: 1,
      revision: 10,
      mainFilePath: "main.tex",
      render: { dpi: 192, theme: { foreground: 0xcdd6f4, background: 0x1e1e2e } },
      files: [
        { path: "main.tex", kind: "text", content: "\\input{chapters/one}" },
        { path: "chapters/one.tex", kind: "text", content: "hello" },
        { path: "assets/pixel.png", kind: "binary", encoding: "base64", content: "AAEC" }
      ]
    });
    expect(result).toMatchObject({
      ok: true,
      message: {
        type: "initialize",
        revision: 10,
        render: { dpi: 192, theme: { foreground: 0xcdd6f4, background: 0x1e1e2e } }
      }
    });
  });

  it("rejects absurd DPI, traversal, malformed ranges, and invalid revisions", () => {
    const base = {
      type: "initialize",
      protocolVersion: 1,
      revision: 1,
      mainFilePath: "main.tex",
      files: [{ path: "main.tex", kind: "text", content: "x" }]
    };
    expect(validateTexpressoClientMessage({ ...base, render: { dpi: 2000 } })).toMatchObject({ ok: false, code: "invalid-render-settings" });
    expect(validateTexpressoClientMessage({ ...base, render: { theme: { foreground: -1, background: 0xffffff } } })).toMatchObject({ ok: false, code: "invalid-render-settings" });
    expect(validateTexpressoClientMessage({ ...base, mainFilePath: "../main.tex" })).toMatchObject({ ok: false, code: "invalid-project" });
    expect(validateTexpressoClientMessage({ type: "change", revision: 2, path: "main.tex", range: {}, text: "x" })).toMatchObject({ ok: false, code: "invalid-change" });
    expect(validateTexpressoClientMessage({ type: "change", revision: 0, path: "main.tex", range: {}, text: "x" })).toMatchObject({ ok: false, code: "invalid-revision" });
  });

  it("accepts LSP-compatible UTF-16 range changes and revision jumps", () => {
    expect(validateTexpressoClientMessage({
      type: "change",
      revision: 15,
      path: "chapters/one.tex",
      range: { start: { line: 1, character: 3 }, end: { line: 1, character: 5 } },
      text: "😀"
    })).toEqual({
      ok: true,
      message: {
        type: "change",
        revision: 15,
        path: "chapters/one.tex",
        range: { start: { line: 1, character: 3 }, end: { line: 1, character: 5 } },
        text: "😀"
      }
    });
  });
});
