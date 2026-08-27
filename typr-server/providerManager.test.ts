import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderManager, type ManagedProviderDefinition } from "./providerManager.ts";

const roots: string[] = [];
const payload = Buffer.from("verified provider archive");
const definition: ManagedProviderDefinition = {
  id: "test-lsp",
  name: "Test LSP",
  kind: "lsp",
  version: "1.0.0",
  description: "Test provider",
  executableNames: ["texlab"],
  assets: [{
    platform: "linux",
    arch: "x64",
    url: "https://github.com/example/provider/releases/download/v1/provider.tar.gz",
    sha256: createHash("sha256").update(payload).digest("hex"),
    size: payload.byteLength,
    archive: "tar.gz"
  }]
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider manager", () => {
  it("downloads, verifies, installs, and restores a curated provider", async () => {
    const root = await temporaryRoot();
    const events: string[] = [];
    const manager = await ProviderManager.open({
      dataRoot: root,
      platform: "linux",
      arch: "x64",
      catalog: [definition],
      fetch: async () => new Response(payload, {
        status: 200,
        headers: { "Content-Length": String(payload.byteLength) }
      }),
      extract: async (_definition, _asset, archivePath, stagingRoot) => {
        expect(await readFile(archivePath)).toEqual(payload);
        await mkdir(join(stagingRoot, "bin"), { recursive: true });
        await writeFile(join(stagingRoot, "bin", "texlab"), "binary");
      },
      onEvent: (event) => events.push(event.type)
    });

    const job = manager.startInstall("test-lsp");
    await expect(manager.waitForJob(job.id)).resolves.toMatchObject({ status: "completed" });
    expect(manager.snapshot().providers[0]).toMatchObject({ installed: true, active: true });
    expect(events).toEqual(["provider-download-started", "provider-installed"]);

    const restored = await ProviderManager.open({ dataRoot: root, platform: "linux", arch: "x64", catalog: [definition] });
    expect(restored.snapshot().providers[0]).toMatchObject({ installed: true });
  });

  it("fails closed on a checksum mismatch and leaves no installed provider", async () => {
    const root = await temporaryRoot();
    const manager = await ProviderManager.open({
      dataRoot: root,
      platform: "linux",
      arch: "x64",
      catalog: [{ ...definition, assets: [{ ...definition.assets[0], sha256: "0".repeat(64) }] }],
      fetch: async () => new Response(payload, { status: 200, headers: { "Content-Length": String(payload.byteLength) } }),
      extract: async () => { throw new Error("extract must not run"); }
    });
    const job = manager.startInstall("test-lsp");
    await expect(manager.waitForJob(job.id)).resolves.toMatchObject({ status: "failed", error: "Provider download checksum mismatch." });
    expect(manager.snapshot().providers[0].installed).toBe(false);
  });

  it("reports unsupported platforms and disabled persistent storage", async () => {
    const disabled = await ProviderManager.open({ platform: "linux", arch: "x64", catalog: [definition] });
    expect(disabled.snapshot().enabled).toBe(false);
    expect(() => disabled.startInstall("test-lsp")).toThrow(/persistent Companion data root/u);

    const root = await temporaryRoot();
    const unsupported = await ProviderManager.open({ dataRoot: root, platform: "darwin", arch: "arm64", catalog: [definition] });
    expect(unsupported.snapshot().providers[0].supported).toBe(false);
    expect(() => unsupported.startInstall("test-lsp")).toThrow(/not available/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "typr-provider-test-"));
  roots.push(root);
  return root;
}
