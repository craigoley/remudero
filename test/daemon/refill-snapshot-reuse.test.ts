// W1-T14893: a lane refill reuses the tick read published moments ago unless a GitHub wake since says
// something merged or was pushed.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import {
  createDeliveryDedupStore, createGitHubEventWakeHandler, isPullRequestClosedWake, lastClosedWakePath, readSweepWakeMarker, sweepWakeMarkerPath,
} from "#src/lib/github-event-wake.js";
import { createRefillReader, decideRefillRead, isMergeWake, medianReadIntervalMs } from "#src/lib/refill-snapshot-reuse.js";
import { createService } from "#src/lib/service.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const AT = 1_000_000;
const INTERVAL = 60_000;

test("W1-T14893 a fresh snapshot with no merge or push wake since is reused", () => {
  const checkWake = { event: "check_run", action: "completed", atMs: AT + 1_000 };
  const earlierMerge = { event: "pull_request", action: "closed", atMs: AT - 1 };
  const decided = decideRefillRead({ snapshotAtMs: AT, nowMs: AT + 10_000, wakesSince: [checkWake, earlierMerge], readIntervalMs: INTERVAL });
  assert.deepEqual(decided, { decision: "reuse", reason: "fresh", snapshotAgeMs: 10_000 });
});

test("W1-T14893 a pull request closed wake after the snapshot forces a fresh read even when a later delivery overwrites the wake marker", async (t) => {
  // Serve coalesces every delivery over one wake marker, so a check_run after a merge hides it there.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14893-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = "w1-t14893-secret";
  const markerPath = sweepWakeMarkerPath(root);
  const route = createGitHubEventWakeHandler({ secret, repository: "o/r", markerPath, dedup: createDeliveryDedupStore(10) });
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const post = async (deliveryId: string, event: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify({ repository: { full_name: "o/r" }, ...payload });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route.path}`, { method: "POST", body,
      headers: { "content-type": "application/json", "x-github-delivery": deliveryId, "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}` } });
    assert.equal(response.status, 202, `${event} is accepted`);
  };
  await post("d-merge", "pull_request", { action: "closed", pull_request: { number: 1, merged: true } });
  await post("d-check", "check_run", { action: "completed", check_run: { name: "ci-gate", conclusion: "failure" } });
  assert.equal(readSweepWakeMarker(markerPath)?.event, "check_run", "the later delivery overwrote the coalesced marker");
  assert.equal(readSweepWakeMarker(lastClosedWakePath(markerPath))?.deliveryId, "d-merge", "the closed wake is kept apart");

  // The daemon's refill reader reads both, as src/cli/commands/daemon.ts does, from a snapshot taken before the merge.
  let reads = 0;
  const snapshotAtMs = Date.parse(readSweepWakeMarker(lastClosedWakePath(markerPath))!.receivedAtIso) - 1;
  const reader = createRefillReader<string>({
    read: async () => { reads++; return () => true; },
    published: () => {
      reader.observeWake(readSweepWakeMarker(markerPath));
      reader.observeWake(readSweepWakeMarker(lastClosedWakePath(markerPath)));
      return { atMs: snapshotAtMs, merged: new Set<string>() };
    },
    clock: clockFromMillisFn(() => snapshotAtMs + 1_000), log: () => {},
  });
  reader.observeRead(snapshotAtMs - INTERVAL);
  reader.observeRead(snapshotAtMs);
  assert.equal((await reader.refill("plan"))("W1-T1"), true);
  assert.equal(reads, 1, "THE CLAIM: the merge forces a fresh read though the marker now names a check_run");

  for (const wake of [{ event: "pull_request", action: "closed", atMs: AT + 2_000 }, { event: "pull_request", action: "closed", atMs: AT }]) {
    assert.deepEqual(decideRefillRead({ snapshotAtMs: AT, nowMs: AT + 10_000, wakesSince: [wake], readIntervalMs: INTERVAL }),
      { decision: "read", reason: "merge-wake", snapshotAgeMs: 10_000 });
  }
  assert.equal(isMergeWake({ event: "pull_request", action: "opened" }), false, "an opened pull request merges nothing");
  assert.equal(isPullRequestClosedWake({ event: "check_run", action: "completed" }), false);
});

test("W1-T14893 a snapshot older than the read interval forces a fresh read", () => {
  assert.deepEqual(decideRefillRead({ snapshotAtMs: AT, nowMs: AT + INTERVAL, wakesSince: [], readIntervalMs: INTERVAL }),
    { decision: "read", reason: "stale", snapshotAgeMs: INTERVAL });
  assert.deepEqual(decideRefillRead({ snapshotAtMs: undefined, nowMs: AT, wakesSince: [], readIntervalMs: INTERVAL }),
    { decision: "read", reason: "no-snapshot" });
  assert.deepEqual(decideRefillRead({ snapshotAtMs: AT, nowMs: AT + 5, wakesSince: [], readIntervalMs: undefined }),
    { decision: "read", reason: "no-interval", snapshotAgeMs: 5 });
});

test("W1-T14893 the read interval is the median gap between the tick's own reads", () => {
  assert.equal(medianReadIntervalMs([AT]), undefined, "one read has no gap");
  assert.equal(medianReadIntervalMs([AT, AT]), undefined, "a zero gap is not an interval");
  assert.equal(medianReadIntervalMs([0, 10, 40, 100]), 30, "odd gap count: 10, 30, 60 -> 30");
  assert.equal(medianReadIntervalMs([0, 10, 30, 60, 100]), 25, "even gap count: 10, 20, 30, 40 -> 25");
});

test("W1-T14893 the refill reader reuses the published merged set and reads afresh after a merge wake", async () => {
  let nowMs = AT;
  let reads = 0;
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const reader = createRefillReader<string>({
    read: async () => { reads++; reader.observeRead(nowMs); return (id) => id === "fresh"; },
    published: () => ({ atMs: AT, merged: new Set(["snap"]) }),
    clock: clockFromMillisFn(() => nowMs),
    log: (step, extra) => rows.push({ step, extra }),
  });
  reader.observeRead(AT - 2 * INTERVAL);
  reader.observeRead(AT - INTERVAL);
  reader.observeRead(AT);
  assert.equal(reader.readIntervalMs(), INTERVAL);

  nowMs = AT + 5_000;
  const reused = await reader.refill("plan");
  assert.equal(reused("snap"), true);
  assert.equal(reads, 0, "a fresh snapshot is reused without a read");
  assert.deepEqual(rows.at(-1), { step: "dispatch.refill_read",
    extra: { decision: "reuse", reason: "fresh", snapshot_age_ms: 5_000, read_interval_ms: INTERVAL } });

  reader.observeWake(undefined);
  reader.observeWake({ deliveryId: "d0", event: "push", receivedAtIso: "not a time" });
  reader.observeWake({ deliveryId: "d1", event: "pull_request", action: "closed", receivedAtIso: new Date(AT + 1_000).toISOString() });
  reader.observeWake({ deliveryId: "d1", event: "pull_request", action: "closed", receivedAtIso: new Date(AT + 1_000).toISOString() });
  const fresh = await reader.refill("plan");
  assert.equal(fresh("fresh"), true);
  assert.equal(reads, 1, "a merge wake after the snapshot reads afresh");
  assert.equal(rows.at(-1)?.extra?.reason, "merge-wake");
  assert.equal(reader.readIntervalMs(), INTERVAL, "the refill's own read does not change the tick's interval");
});

test("W1-T14893 the refill reader keeps only its recent history", async () => {
  const reader = createRefillReader<string>({ read: async () => () => false, published: () => undefined, clock: clockFromMillisFn(() => AT), log: () => {} });
  for (let i = 0; i < 40; i++) reader.observeRead(i * 1_000);
  for (let i = 0; i < 40; i++) reader.observeWake({ deliveryId: `d${i}`, event: "check_run", receivedAtIso: new Date(AT).toISOString() });
  assert.equal(reader.readIntervalMs(), 1_000);
  assert.equal((await reader.refill("plan"))("x"), false, "no snapshot reads afresh");
});
