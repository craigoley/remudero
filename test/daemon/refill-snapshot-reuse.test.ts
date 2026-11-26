// W1-T14893: a lane refill reuses the tick read published moments ago unless a GitHub wake since says
// something merged or was pushed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRefillReader, decideRefillRead, isMergeOrPushWake, medianReadIntervalMs } from "#src/lib/refill-snapshot-reuse.js";

const AT = 1_000_000;
const INTERVAL = 60_000;

test("W1-T14893 a fresh snapshot with no merge or push wake since is reused", () => {
  const checkWake = { event: "check_run", action: "completed", atMs: AT + 1_000 };
  const earlierMerge = { event: "pull_request", action: "closed", atMs: AT - 1 };
  const decided = decideRefillRead({ snapshotAtMs: AT, nowMs: AT + 10_000, wakesSince: [checkWake, earlierMerge], readIntervalMs: INTERVAL });
  assert.deepEqual(decided, { decision: "reuse", reason: "fresh", snapshotAgeMs: 10_000 });
});

test("W1-T14893 a merge or push wake after the snapshot forces a fresh read", () => {
  for (const wake of [{ event: "pull_request", action: "closed", atMs: AT + 2_000 }, { event: "push", atMs: AT }]) {
    const decided = decideRefillRead({ snapshotAtMs: AT, nowMs: AT + 10_000, wakesSince: [wake], readIntervalMs: INTERVAL });
    assert.deepEqual(decided, { decision: "read", reason: "merge-or-push-wake", snapshotAgeMs: 10_000 }, wake.event);
  }
  assert.equal(isMergeOrPushWake({ event: "pull_request", action: "opened" }), false, "an opened pull request merges nothing");
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
    now: () => nowMs,
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
  assert.equal(rows.at(-1)?.extra?.reason, "merge-or-push-wake");
  assert.equal(reader.readIntervalMs(), INTERVAL, "the refill's own read does not change the tick's interval");
});

test("W1-T14893 the refill reader keeps only its recent history", async () => {
  const reader = createRefillReader<string>({ read: async () => () => false, published: () => undefined, now: () => AT, log: () => {} });
  for (let i = 0; i < 40; i++) reader.observeRead(i * 1_000);
  for (let i = 0; i < 40; i++) reader.observeWake({ deliveryId: `d${i}`, event: "check_run", receivedAtIso: new Date(AT).toISOString() });
  assert.equal(reader.readIntervalMs(), 1_000);
  assert.equal((await reader.refill("plan"))("x"), false, "no snapshot reads afresh");
});
