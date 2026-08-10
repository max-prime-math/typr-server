import test from "node:test";
import assert from "node:assert/strict";

import { isManifestUnknown } from "./classify-registry-probe-error.mjs";

test("accepts only an explicit manifest-unknown response", () => {
  assert.equal(isManifestUnknown("reading manifest 1.2.3: manifest unknown"), true);
  assert.equal(isManifestUnknown('{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}'), true);
});

test("rejects repository, authentication, and generic transport failures", () => {
  for (const message of [
    "NAME_UNKNOWN: repository name not known to registry",
    "NAME_UNKNOWN: repository missing; manifest unknown",
    "unexpected status from HEAD request: 404 Not Found",
    "requested access to the resource is denied",
    "unauthorized: authentication required",
    "toomanyrequests: rate limit exceeded",
    "dial tcp: lookup registry.example: no such host",
    "TLS handshake timeout",
    "context deadline exceeded",
    "credential helper: executable file not found"
  ]) {
    assert.equal(isManifestUnknown(message), false, message);
  }
});
