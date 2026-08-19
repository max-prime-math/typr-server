import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { build } from "esbuild";

if (process.platform !== "win32") {
  throw new Error("build:windows must run on Windows so Node emits a native PE executable.");
}
const root = resolve(import.meta.dirname, "..");
const outputDirectory = join(root, "dist", "windows");
const bundle = join(outputDirectory, "typr-companion.mjs");
const output = join(outputDirectory, "typr-companion-windows-x64.exe");
const configPath = join(outputDirectory, "sea-config.json");
const release = JSON.parse(await readFile(join(root, "companion-release.json"), "utf8"));
const installer = process.env.TYPR_WINDOWS_TINYTEX_INSTALLER?.trim();
if (!installer || !isAbsolute(installer)) {
  throw new Error("TYPR_WINDOWS_TINYTEX_INSTALLER must be the absolute path to the verified TinyTeX installer.");
}

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(root, "typr-server", "cli.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __typrCreateRequire } from "node:module"; ' +
      'const require = __typrCreateRequire(import.meta.url);'
  },
  define: {
    TYPR_WINDOWS_BUILD_VERSION: JSON.stringify(release.version)
  }
});

await writeFile(configPath, JSON.stringify({
  main: bundle,
  mainFormat: "module",
  executable: process.execPath,
  output,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgvExtension: "none",
  assets: {
    "tinytex-installer.exe": installer,
    "mupdf-wasm.wasm": join(root, "node_modules", "mupdf", "dist", "mupdf-wasm.wasm")
  }
}, null, 2));

const result = spawnSync(process.execPath, ["--build-sea", configPath], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Built ${output}`);
