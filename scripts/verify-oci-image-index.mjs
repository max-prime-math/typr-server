#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PLATFORMS = ["linux/amd64", "linux/arm64"];

export function verifyOciImageIndex(index) {
  assert.ok(Array.isArray(index?.manifests), "OCI image index has no manifests");

  const attestations = index.manifests.filter(
    (manifest) => manifest.annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
  );
  const images = index.manifests.filter(
    (manifest) => manifest.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest"
  );

  const platforms = images.map((manifest) =>
    `${manifest.platform?.os ?? ""}/${manifest.platform?.architecture ?? ""}`
  );
  assert.deepEqual(
    [...platforms].sort(),
    EXPECTED_PLATFORMS,
    "OCI image index must contain exactly one runnable linux/amd64 and linux/arm64 manifest"
  );

  const imageDigests = images.map((manifest) => manifest.digest);
  assert.equal(new Set(imageDigests).size, imageDigests.length, "Runnable manifest digests must be unique");
  for (const digest of imageDigests) {
    assert.match(digest ?? "", /^sha256:[0-9a-f]{64}$/, "Runnable manifest has an invalid digest");
  }

  const attestedDigests = attestations.map(
    (manifest) => manifest.annotations?.["vnd.docker.reference.digest"]
  );
  assert.equal(
    new Set(attestedDigests).size,
    attestedDigests.length,
    "Attestation references must be unique"
  );
  assert.deepEqual(
    [...attestedDigests].sort(),
    [...imageDigests].sort(),
    "Every runnable manifest must have exactly one attestation manifest"
  );
  for (const manifest of attestations) {
    assert.equal(manifest.platform?.os, "unknown", "Attestation OS must be unknown");
    assert.equal(manifest.platform?.architecture, "unknown", "Attestation architecture must be unknown");
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Usage: verify-oci-image-index.mjs <raw-index.json>");
  verifyOciImageIndex(JSON.parse(await readFile(inputPath, "utf8")));
  console.log("OCI index contains exactly amd64/arm64 images with matching attestations.");
}

