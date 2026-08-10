import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceError,
  WorkspaceStore,
  validateWorkspacePath
} from "./workspaceStore.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceStore", () => {
  it("lists regular files deterministically while excluding .git", async () => {
    const root = await createRoot();
    await mkdir(join(root, "nested"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "z.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "nested/a.txt"), "hello");
    await writeFile(join(root, ".git/config"), "secret");
    const store = await WorkspaceStore.open(root, { workspaceId: "test-workspace" });

    const result = await store.list();

    expect(result.workspaceId).toBe("test-workspace");
    expect(result.files.map((file) => file.path)).toEqual(["nested/a.txt", "z.bin"]);
    expect(result.files[0]).toMatchObject({ size: 5, etag: expect.stringMatching(/^"sha256-/) });
  });

  it("creates, conditionally updates, reads, and deletes nested binary files", async () => {
    const root = await createRoot();
    const store = await WorkspaceStore.open(root);
    const initial = Buffer.from([0, 1, 2, 255]);

    const created = await store.write("assets/nested/image.bin", initial, { kind: "create" });
    expect(created).toMatchObject({ path: "assets/nested/image.bin", size: 4 });
    await expect(store.read("assets/nested/image.bin")).resolves.toMatchObject({
      encoding: "base64",
      content: initial.toString("base64"),
      etag: created.etag
    });
    await expect(store.write("assets/nested/image.bin", Buffer.from("new"), { kind: "create" }))
      .rejects.toMatchObject({ status: 412, code: "workspace-precondition-failed" });

    const updated = await store.write("assets/nested/image.bin", Buffer.from("new"), {
      kind: "update",
      etag: created.etag
    });
    expect(updated.etag).not.toBe(created.etag);
    await expect(store.delete("assets/nested/image.bin", created.etag))
      .rejects.toMatchObject({ status: 412, code: "workspace-precondition-failed" });
    await store.delete("assets/nested/image.bin", updated.etag);
    await expect(store.read("assets/nested/image.bin"))
      .rejects.toMatchObject({ status: 404, code: "workspace-file-not-found" });
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("does not leave internal temporary files after a successful atomic write", async () => {
    const root = await createRoot();
    const store = await WorkspaceStore.open(root);
    await store.write("file.txt", Buffer.from("atomic"), { kind: "create" });

    await expect(readFile(join(root, "file.txt"), "utf8")).resolves.toBe("atomic");
    expect((await readdir(root)).filter((name) => name.startsWith(".typr-companion-write-"))).toEqual([]);
  });

  it("rejects traversal, absolute, encoded-equivalent, reserved, and overlong paths", () => {
    const invalid = [
      "../secret",
      "folder/../secret",
      "/absolute",
      "C:\\absolute",
      "folder//file",
      "./file",
      ".git/config",
      "folder/.typr-companion-write-fake",
      `folder/${"x".repeat(256)}`,
      "folder\u0000/file"
    ];
    for (const path of invalid) {
      expect(() => validateWorkspacePath(path)).toThrow(WorkspaceError);
    }
  });

  it("rejects symlink roots and paths without reading or writing through them", async () => {
    const parent = await createRoot();
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    await symlink(root, join(parent, "root-link"));

    await expect(WorkspaceStore.open(join(parent, "root-link"))).rejects.toThrow(/real directory/u);
    const store = await WorkspaceStore.open(root);
    await expect(store.list()).rejects.toMatchObject({ status: 409, code: "workspace-unsafe-entry" });
    await expect(store.read("escape/secret.txt")).rejects.toMatchObject({ status: 409 });
    await expect(store.write("escape/new.txt", Buffer.from("no"), { kind: "create" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("secret");
  });

  it("enforces per-file, entry-count, and total-workspace limits", async () => {
    const root = await createRoot();
    const store = await WorkspaceStore.open(root, {
      limits: { maxFileBytes: 4, maxEntries: 2, maxWorkspaceBytes: 6 }
    });

    await expect(store.write("large", Buffer.from("12345"), { kind: "create" }))
      .rejects.toMatchObject({ status: 413, code: "workspace-file-too-large" });
    await store.write("one", Buffer.from("123"), { kind: "create" });
    await store.write("two", Buffer.from("45"), { kind: "create" });
    await expect(store.write("three", Buffer.from("x"), { kind: "create" }))
      .rejects.toMatchObject({ status: 413, code: "workspace-entry-limit" });
    await expect(store.write("two", Buffer.from("4567"), { kind: "update", etag: (await store.read("two")).etag }))
      .rejects.toMatchObject({ status: 413, code: "workspace-size-limit" });
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "typr-workspace-test-"));
  roots.push(root);
  return root;
}
