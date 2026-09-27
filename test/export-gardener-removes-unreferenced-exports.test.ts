import assert from "node:assert/strict";
import { test } from "node:test";

test("acceptedWakeCount is not exported from github-event-wake", async () => {
  const module = await import("../src/lib/github-event-wake.js");
  assert.equal(Object.hasOwn(module, "acceptedWakeCount"), false);
});

test("MODEL_UPSTREAM_BASE_URL_DEFAULT is not exported from secret-boundary", async () => {
  const module = await import("../src/lib/secret-boundary.js");
  assert.equal(Object.hasOwn(module, "MODEL_UPSTREAM_BASE_URL_DEFAULT"), false);
});

test("serviceTokensFileExists is not exported from serve", async () => {
  const module = await import("../src/lib/serve.js");
  assert.equal(Object.hasOwn(module, "serviceTokensFileExists"), false);
});
