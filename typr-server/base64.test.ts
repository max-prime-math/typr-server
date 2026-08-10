import { describe, expect, it } from "vitest";
import { isBase64 } from "./base64.ts";

describe("base64 validation", () => {
  it.each(["", "AA", "AAA", "AAAA", "AA==", "AAA="])("accepts %j", (value) => {
    expect(isBase64(value)).toBe(true);
  });

  it.each(["A", "A===", "AA=A", "AA-_", "AAAA="])("rejects %j", (value) => {
    expect(isBase64(value)).toBe(false);
  });

  it("validates file-limit-sized payloads without recursive regular-expression failure", () => {
    expect(isBase64(Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64"))).toBe(true);
  });
});
