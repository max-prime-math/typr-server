import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "./accessStore.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("management access store", () => {
  it("persists only hashed keys and authenticates enabled users", async () => {
    const root = await mkdtemp(join(tmpdir(), "typr-access-store-test-"));
    roots.push(root);
    const path = join(root, "management.json");
    const store = await AccessStore.open(path);
    const user = await store.createUser("Editor");
    const created = await store.createApiKey(user.id, "Desktop Typr");
    await store.setRequireApiKeys(true);

    expect(created.secret).toMatch(/^typr_[A-Za-z0-9_-]+$/u);
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain(created.secret);
    expect(persisted).toContain('"hash"');
    await expect(store.authorize(undefined)).resolves.toMatchObject({ ok: false });
    await expect(store.authorize(`Bearer ${created.secret}`)).resolves.toMatchObject({
      ok: true,
      principal: { userId: user.id, userName: "Editor", keyId: created.key.id }
    });

    const reopened = await AccessStore.open(path);
    await expect(reopened.authorize(`Bearer ${created.secret}`)).resolves.toMatchObject({ ok: true });
  });

  it("revokes keys immediately and rejects enforcement without a usable key", async () => {
    const store = await AccessStore.open();
    await expect(store.setRequireApiKeys(true)).rejects.toThrow(/Create an API key/u);
    const user = await store.createUser("Build agent");
    const created = await store.createApiKey(user.id, "CI");
    await store.revokeApiKey(created.key.id);

    await expect(store.authorize(`Bearer ${created.secret}`)).resolves.toMatchObject({ ok: false });
    await expect(store.setRequireApiKeys(true)).rejects.toThrow(/Create an API key/u);
  });

  it("disables every key owned by a disabled user", async () => {
    const store = await AccessStore.open();
    const user = await store.createUser("Disabled editor");
    const created = await store.createApiKey(user.id, "Laptop");
    await store.setUserDisabled(user.id, true);

    await expect(store.authorize(`Bearer ${created.secret}`)).resolves.toMatchObject({ ok: false });
  });
});
