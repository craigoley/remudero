import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  createPersistentDeliveryDedupStore,
  isAllowlistedGithubEvent,
  sweepWakeMarkerPath,
} from "../src/lib/github-event-wake.js";
import { createService, type Route } from "../src/lib/service.js";

const SECRET = "test-webhook-secret";
const REPOSITORY = "craigoley/remudero";

function signature(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

async function withRoute<T>(route: Route, run: (url: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${port}${route.path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function webhookHeaders(body: string, deliveryId: string, event = "check_run"): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": event,
    "x-hub-signature-256": signature(body),
  };
}

test("pull-request review changes that alter merge eligibility all wake reconciliation", () => {
  assert.equal(isAllowlistedGithubEvent("pull_request_review", "submitted"), true);
  assert.equal(isAllowlistedGithubEvent("pull_request_review", "edited"), true);
  assert.equal(isAllowlistedGithubEvent("pull_request_review", "dismissed"), true);
});

test("the bounded delivery set survives a serve-process restart", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-dedup-"));
  const path = join(root, "state", "github-webhook-deliveries.json");
  try {
    const first = createPersistentDeliveryDedupStore(path, 2);
    assert.equal(first.has("delivery-a"), false);
    first.record("delivery-a");
    first.record("delivery-b");

    const restarted = createPersistentDeliveryDedupStore(path, 2);
    assert.equal(restarted.has("delivery-a"), true);
    assert.equal(restarted.has("delivery-b"), true);
    restarted.record("delivery-c");

    const bounded = createPersistentDeliveryDedupStore(path, 2);
    assert.equal(bounded.has("delivery-a"), false);
    assert.equal(bounded.has("delivery-b"), true);
    assert.equal(bounded.has("delivery-c"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker-write failure does not poison the delivery id", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-marker-failure-"));
  const markerPath = sweepWakeMarkerPath(root);
  const dedup = createDeliveryDedupStore(10);
  let failWrite = true;
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath,
    dedup,
    writeMarker: (path, marker) => {
      if (failWrite) throw new Error("synthetic marker failure");
      mkdirSync(join(root, "state"), { recursive: true });
      writeFileSync(path, JSON.stringify(marker));
    },
  });
  const body = JSON.stringify({ action: "completed", repository: { full_name: REPOSITORY } });
  try {
    await withRoute(route, async (url) => {
      const failed = await fetch(url, { method: "POST", headers: webhookHeaders(body, "delivery-retry"), body });
      assert.equal(failed.status, 500);
      failWrite = false;
      const retried = await fetch(url, { method: "POST", headers: webhookHeaders(body, "delivery-retry"), body });
      assert.equal(retried.status, 202);
      assert.deepEqual(await retried.json(), { accepted: true });
      assert.equal(JSON.parse(readFileSync(markerPath, "utf8")).deliveryId, "delivery-retry");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized webhook receives 413 without resetting the connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-github-body-bound-"));
  const body = JSON.stringify({ action: "completed", repository: { full_name: REPOSITORY }, padding: "x".repeat(128) });
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath: sweepWakeMarkerPath(root),
    dedup: createDeliveryDedupStore(10),
    maxBodyBytes: 64,
  });
  try {
    await withRoute(route, async (url) => {
      const response = await fetch(url, { method: "POST", headers: webhookHeaders(body, "delivery-large"), body });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "body_too_large" });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
