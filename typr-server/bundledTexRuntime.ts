import { constants } from "node:fs";
import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Seeds the writable container cache from the image's pinned TeX tree once. */
export async function prepareBundledTexRuntime(): Promise<void> {
  const seedValue = process.env.TYPR_COMPANION_BUNDLED_TEX_SEED?.trim();
  const cacheValue = process.env.TYPR_COMPANION_BUNDLED_TEX_CACHE?.trim();
  const version = process.env.TYPR_COMPANION_BUNDLED_TEX_VERSION?.trim();
  if (!seedValue && !cacheValue && !version) return;
  if (!seedValue || !cacheValue || !version) {
    throw new Error("Bundled TeX requires TYPR_COMPANION_BUNDLED_TEX_SEED, _CACHE, and _VERSION together.");
  }
  if (!isAbsolute(seedValue) || !isAbsolute(cacheValue) || !/^[0-9]{4}\.[0-9]{2}$/u.test(version)) {
    throw new Error("Bundled TeX seed/cache paths must be absolute and its version must use YYYY.MM.");
  }

  const seed = resolve(seedValue);
  const cache = resolve(cacheValue);
  const root = join(cache, version);
  const bin = join(root, "bin", "typr");
  const pdflatex = join(bin, "pdflatex");
  if (!(await exists(pdflatex))) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const staging = join(cache, `.install-${version}-${process.pid}`);
    await rm(staging, { recursive: true, force: true });
    console.log(`Preparing Typr Companion's TeX Live ${version} package cache. This runs once per version.`);
    try {
      await cp(seed, staging, { recursive: true, dereference: false, verbatimSymlinks: true });
      await rm(root, { recursive: true, force: true });
      await rename(staging, root);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (!(await exists(pdflatex))) throw new Error("The bundled TeX Live cache does not contain pdflatex.");

  process.env.TYPR_COMPANION_TEX_ROOT = root;
  process.env.TYPR_COMPANION_NATIVE_PATH = [bin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
  process.env.TYPR_COMPANION_PDFLATEX_EXECUTABLE = pdflatex;
  const latexmk = join(bin, "latexmk");
  if (await exists(latexmk)) process.env.TYPR_COMPANION_LATEXMK_EXECUTABLE = latexmk;
  const tlmgr = join(bin, "tlmgr");
  if (await exists(tlmgr)) process.env.TYPR_COMPANION_TLMGR_EXECUTABLE = tlmgr;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
