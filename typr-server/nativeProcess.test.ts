import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeProcessError, prepareCompilerEnvironment, runNativeProcess } from "./nativeProcess.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native compiler process policy", () => {
  it("uses a minimal compiler environment rooted in the ephemeral directory", async () => {
    const root = await createRoot();
    process.env.TEXINPUTS = "/sensitive";
    try {
      const env = await prepareCompilerEnvironment(root);
      expect(env.TEXINPUTS).toBeUndefined();
      expect(env.HOME).toBe(join(root, ".typr-home"));
      expect(env.TMPDIR).toBe(root);
      expect(env.shell_escape).toBe("f");
      expect(env.openout_any).toBe("p");
    } finally {
      delete process.env.TEXINPUTS;
    }
  });

  it("captures normal output from a fixed argv process", async () => {
    const root = await createRoot();
    const result = await runNativeProcess(
      process.execPath,
      ["-e", "process.stdout.write('ok'); process.stderr.write('note')"],
      root,
      new AbortController().signal
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", stderr: "note" });
  });

  it("terminates an aborted process and reports a typed timeout", async () => {
    const root = await createRoot();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await expect(runNativeProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      root,
      controller.signal
    )).rejects.toEqual(expect.objectContaining<Partial<NativeProcessError>>({ code: "compile-timeout" }));
  });

  it("kills compiler output floods at the shared one MiB cap", async () => {
    const root = await createRoot();
    await expect(runNativeProcess(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 'x'))"],
      root,
      new AbortController().signal
    )).rejects.toEqual(expect.objectContaining<Partial<NativeProcessError>>({ code: "compiler-output-limit" }));
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "typr-native-process-test-"));
  roots.push(root);
  return root;
}
