import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeAtomicAsync } from "../src/lib/fs-race-safe.js";
import { createPersistentDeliveryDedupStore, readSweepWakeMarker, sweepWakeMarkerPath, writeSweepWakeMarkerAtomicAsync } from "../src/lib/github-event-wake.js";

const marker = { deliveryId: "d-1", event: "check_suite", action: "completed", repository: "o/r", receivedAtIso: "2026-09-24T12:00:00.000Z" };

test("the sweep wake marker is written without holding the event loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-async-marker-"));
  try {
    const path = sweepWakeMarkerPath(root);
    let done = false;
    let loopRanDuringWrite = false;
    const write = writeSweepWakeMarkerAtomicAsync(path, marker).then(() => void (done = true));
    setImmediate(() => void (loopRanDuringWrite = !done));
    await write;
    assert.equal(loopRanDuringWrite, true, "a queued callback ran while the write (and its fsync) was in flight");
    assert.deepEqual(readSweepWakeMarker(path), marker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery ids recorded concurrently are all kept on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-async-dedup-"));
  try {
    const path = join(root, "state", "github-webhook-deliveries.json");
    const store = createPersistentDeliveryDedupStore(path, 10);
    await Promise.all([store.record("delivery-a"), store.record("delivery-b"), store.record("delivery-a")]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).deliveryIds, ["delivery-a", "delivery-b"]);
    const restarted = createPersistentDeliveryDedupStore(path, 10);
    assert.equal(restarted.has("delivery-a"), true);
    assert.equal(restarted.has("delivery-b"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an async atomic write lands its mode on the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-async-mode-"));
  try {
    const path = join(root, "nested", "secret.json");
    await writeAtomicAsync(path, Buffer.from("{}"), { mode: 0o600, tmpTag: "stage" });
    assert.equal(readFileSync(path, "utf8"), "{}");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
