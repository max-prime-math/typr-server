#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isManifestUnknown(message) {
  if (/\b(?:NAME_UNKNOWN|UNAUTHORIZED|DENIED|TOOMANYREQUESTS)\b/i.test(message)) return false;
  return /(?:\bMANIFEST_UNKNOWN\b|\bmanifest unknown\b)/i.test(message);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const errorPath = process.argv[2];
  if (!errorPath) throw new Error("Usage: classify-registry-probe-error.mjs <stderr-file>");
  const message = await readFile(errorPath, "utf8");
  process.exitCode = isManifestUnknown(message) ? 0 : 1;
}
