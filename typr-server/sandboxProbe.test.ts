import { describe, expect, it } from "vitest";
import { probeNativeSandbox } from "./sandboxProbe.ts";

describe("native sandbox startup probe", () => {
  it("accepts a launcher that successfully executes the probe command", async () => {
    await expect(probeNativeSandbox("/bin/true")).resolves.toBeUndefined();
  });

  it("fails readiness when the configured launcher cannot run the probe", async () => {
    await expect(probeNativeSandbox("/bin/false")).rejects.toThrow(/refusing readiness/u);
  });
});
