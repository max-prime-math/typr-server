import { describe, expect, it } from "vitest";
import { hasLatexError, offsetToPosition, pngDimensions, positionToOffset } from "./texpressoSession.ts";

describe("TeXpresso session helpers", () => {
  it("uses LSP-compatible UTF-16 line and column positions", () => {
    const source = "first\nemoji: 😀 target\nlast";
    expect(offsetToPosition(source, source.indexOf("target"))).toEqual({ line: 1, column: 10 });
    expect(offsetToPosition(source, source.length)).toEqual({ line: 2, column: 4 });
    expect(positionToOffset(source, { line: 1, character: 10 })).toBe(source.indexOf("target"));
    expect(() => positionToOffset(source, { line: 1, character: 100 })).toThrow(/outside/);
  });

  it("classifies familiar TeX error messages without changing Companion diagnostics", () => {
    expect(hasLatexError("! Undefined control sequence.")).toBe(true);
    expect(hasLatexError("Output written on main.pdf (1 page)." )).toBe(false);
  });

  it("reads dimensions from a browser-native PNG header without snapshotting image bytes", () => {
    const header = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x03, 0xe1, 0x00, 0x00, 0x05, 0x7c
    ]);
    expect(pngDimensions(header)).toEqual({ width: 993, height: 1404 });
  });
});
