import test from "node:test";
import assert from "node:assert/strict";

import { verifyOciImageIndex } from "./verify-oci-image-index.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const image = (architecture, character) => ({
  digest: digest(character),
  platform: { architecture, os: "linux" }
});
const attestation = (subjectDigest, character) => ({
  annotations: {
    "vnd.docker.reference.digest": subjectDigest,
    "vnd.docker.reference.type": "attestation-manifest"
  },
  digest: digest(character),
  platform: { architecture: "unknown", os: "unknown" }
});
const validIndex = () => {
  const amd64 = image("amd64", "a");
  const arm64 = image("arm64", "b");
  return {
    manifests: [
      amd64,
      arm64,
      attestation(amd64.digest, "c"),
      attestation(arm64.digest, "d")
    ]
  };
};

test("accepts exactly two runnable platforms with matching attestations", () => {
  assert.doesNotThrow(() => verifyOciImageIndex(validIndex()));
});

test("rejects a missing architecture", () => {
  const index = validIndex();
  index.manifests.splice(1, 1);
  assert.throws(() => verifyOciImageIndex(index));
});

test("rejects a missing attestation", () => {
  const index = validIndex();
  index.manifests.pop();
  assert.throws(() => verifyOciImageIndex(index));
});

test("rejects duplicate runnable platforms", () => {
  const index = validIndex();
  index.manifests.splice(1, 0, image("amd64", "e"));
  assert.throws(() => verifyOciImageIndex(index));
});

test("rejects an unexpected runnable platform", () => {
  const index = validIndex();
  index.manifests.push(image("ppc64le", "e"));
  assert.throws(() => verifyOciImageIndex(index));
});

test("rejects duplicate attestation references", () => {
  const index = validIndex();
  index.manifests.push(attestation(digest("a"), "e"));
  assert.throws(() => verifyOciImageIndex(index));
});
