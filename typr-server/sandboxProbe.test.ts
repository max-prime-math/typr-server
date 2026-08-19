import { describe, expect, it } from "vitest";
import { probeNativeSandbox } from "./sandboxProbe.ts";

// The native launcher is Linux-only; Windows portable mode intentionally uses
// its separate per-user policy and never invokes this probe.
describe.skipIf(process.platform === "win32")("native sandbox startup probe", () => {
  it("accepts a launcher that successfully executes the probe command", async () => {
    await expect(probeNativeSandbox("/bin/true")).resolves.toBeUndefined();
  });

  it("fails readiness when the configured launcher cannot run the probe", async () => {
    await expect(probeNativeSandbox("/bin/false")).rejects.toThrow(/refusing readiness/u);
  });
});
