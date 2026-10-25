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

test("startCiFrictionGardener is not exported from ci-friction-gardener", async () => {
  const module = await import("../src/lib/ci-friction-gardener.js");
  assert.equal(Object.hasOwn(module, "startCiFrictionGardener"), false);
});

test("selectorShadowFullSuiteSize is not exported from selector-shadow-gardener", async () => {
  const module = await import("../src/lib/selector-shadow-gardener.js");
  assert.equal(Object.hasOwn(module, "selectorShadowFullSuiteSize"), false);
});

test("MAIN_HEALTH_FALLBACK_RUN_LIMIT is not exported from sweep", async () => {
  const module = await import("../src/lib/sweep.js");
  assert.equal(Object.hasOwn(module, "MAIN_HEALTH_FALLBACK_RUN_LIMIT"), false);
});

test("READ_ONLY_INSPECTION_VERBS is not exported from read-only-inspection", async () => {
  const module = await import("../src/lib/read-only-inspection.js");
  assert.equal(Object.hasOwn(module, "READ_ONLY_INSPECTION_VERBS"), false);
});

test("RUN_CHILD_PHASES is not exported from run-child-contract", async () => {
  const module = await import("../src/lib/run-child-contract.js");
  assert.equal(Object.hasOwn(module, "RUN_CHILD_PHASES"), false);
});

test("triageNeedsModel is not exported from escalation-triage", async () => {
  const module = await import("../src/lib/escalation-triage.js");
  assert.equal(Object.hasOwn(module, "triageNeedsModel"), false);
});

test("addLifetimeDispatchTallies is not exported from status", async () => {
  const module = await import("../src/lib/status.js");
  assert.equal(Object.hasOwn(module, "addLifetimeDispatchTallies"), false);
});

test("INBOX_GARDENER_INTERVAL_MS is not exported from inbox-gardener", async () => {
  const module = await import("../src/lib/inbox-gardener.js");
  assert.equal(Object.hasOwn(module, "INBOX_GARDENER_INTERVAL_MS"), false);
});

test("newestLockfileImageInputSha is not exported from deployer", async () => {
  const module = await import("../src/lib/deployer.js");
  assert.equal(Object.hasOwn(module, "newestLockfileImageInputSha"), false);
});

test("releaseAuthorsFromLedger is not exported from drain", async () => {
  const module = await import("../src/lib/drain.js");
  assert.equal(Object.hasOwn(module, "releaseAuthorsFromLedger"), false);
});
