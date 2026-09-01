import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBundledTexRuntime } from "./bundledTexRuntime.ts";

const keys = [
  "TYPR_COMPANION_BUNDLED_TEX_SEED",
  "TYPR_COMPANION_BUNDLED_TEX_CACHE",
  "TYPR_COMPANION_BUNDLED_TEX_VERSION",
  "TYPR_COMPANION_TEX_ROOT",
  "TYPR_COMPANION_NATIVE_PATH",
  "TYPR_COMPANION_PDFLATEX_EXECUTABLE",
  "TYPR_COMPANION_LATEXMK_EXECUTABLE",
  "TYPR_COMPANION_TLMGR_EXECUTABLE"
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(async () => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bundled TeX runtime", () => {
  it("seeds a versioned writable cache and selects all package tools", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typr-bundled-tex-"));
    roots.push(temporary);
    const seed = join(temporary, "seed");
    const bin = join(seed, "bin", "typr");
    const cache = join(temporary, "cache");
    await mkdir(bin, { recursive: true });
    await Promise.all(["pdflatex", "latexmk", "tlmgr"].map((name) => writeFile(join(bin, name), name)));
    process.env.TYPR_COMPANION_BUNDLED_TEX_SEED = seed;
    process.env.TYPR_COMPANION_BUNDLED_TEX_CACHE = cache;
    process.env.TYPR_COMPANION_BUNDLED_TEX_VERSION = "2026.08";

    await prepareBundledTexRuntime();

    const root = join(cache, "2026.08");
    expect(process.env.TYPR_COMPANION_TEX_ROOT).toBe(root);
    expect(process.env.TYPR_COMPANION_PDFLATEX_EXECUTABLE).toBe(join(root, "bin", "typr", "pdflatex"));
    expect(process.env.TYPR_COMPANION_LATEXMK_EXECUTABLE).toBe(join(root, "bin", "typr", "latexmk"));
    expect(process.env.TYPR_COMPANION_TLMGR_EXECUTABLE).toBe(join(root, "bin", "typr", "tlmgr"));
  });
});
