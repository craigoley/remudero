import assert from "node:assert/strict";
import { test } from "node:test";

import {
  stillBlockedByPushedRunBranch,
  type OrphanRunBranchEvidence,
  type PushedRunRef,
} from "../src/lib/drain.js";
import {
  lazyClosedUnmerged,
  requeueTimesFromLedger,
  runBranchDispatchOpts,
  runBranchStateFrom,
  withRequeueReceipts,
} from "../src/lib/daemon.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-14T15:05:00Z");
const TASK = "W1-T7898";
const SHA = "e54bc66f4e54bc66f4e54bc66f4e54bc66f4e54b";

const refAt = (epochMs: number): PushedRunRef => ({ taskId: TASK, ref: `run-${TASK}-${epochMs}`, sha: SHA });
const evidence = (ref: PushedRunRef, over: Partial<OrphanRunBranchEvidence> = {}): OrphanRunBranchEvidence => ({
  noPrHeadShas: { [ref.ref]: SHA },
  nowMs: NOW,
  liveTaskIds: new Set(),
  ...over,
});
const requeuedAgo = (hours: number) => (id: string) => (id === TASK ? NOW - hours * HOUR : undefined);

test("W1-T9482: a requeued task is not held by its own spent checkpoint branch", () => {
  const ref = refAt(NOW - 6 * HOUR);
  const ids = new Set([TASK]);
  assert.equal(stillBlockedByPushedRunBranch(TASK, ids, undefined, [ref], [], evidence(ref)), true, "no requeue: the 24 h grace holds");
  assert.equal(
    stillBlockedByPushedRunBranch(TASK, ids, undefined, [ref], [], evidence(ref, { requeuedAtMs: requeuedAgo(1) })),
    false,
    "requeued 1 h ago: the 6 h old spent ref stops blocking",
  );
  const logged: Array<Record<string, unknown>> = [];
  const state = runBranchStateFrom(`${SHA}\trefs/heads/${ref.ref}\n`, evidence(ref, { requeuedAtMs: requeuedAgo(1) }));
  const opts = runBranchDispatchOpts(state, [], (step, extra) => logged.push({ step, ...extra }));
  assert.equal(opts.hasPushedRunBranch?.(TASK), false);
  assert.deepEqual(
    logged.map((l) => [l.step, l.reason, l.ref]),
    [["dispatch.run_branch_exception", "requeue-released", ref.ref]],
  );
  assert.equal(stillBlockedByPushedRunBranch(TASK, ids, undefined, [ref], [], evidence(ref, { requeuedAtMs: requeuedAgo(1), liveTaskIds: new Set([TASK]) })), true, "a live lock still blocks");
  assert.equal(stillBlockedByPushedRunBranch(TASK, ids, undefined, [ref], [], evidence(ref, { requeuedAtMs: requeuedAgo(1), noPrHeadShas: {} })), true, "an unproven no-PR tip still blocks");
});

test("W1-T9482: a run branch pushed after the requeue still blocks dispatch", () => {
  const ref = refAt(NOW - 30 * 60_000);
  const ids = new Set([TASK]);
  assert.equal(
    stillBlockedByPushedRunBranch(TASK, ids, undefined, [ref], [], evidence(ref, { requeuedAtMs: requeuedAgo(1) })),
    true,
  );
  assert.equal(
    stillBlockedByPushedRunBranch(TASK, ids, undefined, [ref], [], evidence(ref, { requeuedAtMs: () => undefined })),
    true,
    "a task never requeued keeps blocking",
  );
});

test("W1-T9482: the daemon arm releases a closed-unmerged run branch", () => {
  const ref = refAt(NOW - 2 * HOUR);
  const raw = `${SHA}\trefs/heads/${ref.ref}\n`;
  const closedRows = `${ref.ref}\ttrue\n`;
  const blocked = runBranchDispatchOpts(runBranchStateFrom(raw, undefined), [], () => undefined);
  assert.equal(blocked.hasPushedRunBranch?.(TASK), true, "no closed-PR reader: the ref blocks");
  const released = runBranchDispatchOpts(
    runBranchStateFrom(raw, undefined, new Map(), lazyClosedUnmerged(() => closedRows)),
    [],
    () => undefined,
  );
  assert.equal(released.hasPushedRunBranch?.(TASK), false);
  const merged = runBranchDispatchOpts(
    runBranchStateFrom(raw, undefined, new Map(), lazyClosedUnmerged(() => `${ref.ref}\tfalse\n`)),
    [],
    () => undefined,
  );
  assert.equal(merged.hasPushedRunBranch?.(TASK), true, "a merged or open PR's ref still blocks");
  const failing = runBranchDispatchOpts(
    runBranchStateFrom(raw, undefined, new Map(), lazyClosedUnmerged(() => { throw new Error("rate limited"); })),
    [],
    () => undefined,
  );
  assert.equal(failing.hasPushedRunBranch?.(TASK), true, "a failed closed-PR read excludes nothing");
});

test("W1-T9482: requeue receipts come from the ledger's latest requeued row per task", () => {
  const lines = [
    JSON.stringify({ ts: "2026-10-14T10:00:00.000Z", step: "sweep.strike_ladder.requeued", task_id: TASK }),
    JSON.stringify({ ts: "2026-10-14T13:04:00.000Z", step: "sweep.strike_ladder.requeued", task_id: TASK }),
    JSON.stringify({ ts: "2026-10-14T13:05:00.000Z", step: "sweep.strike_ladder.refreshed", task_id: "W1-T1" }),
    "{torn sweep.strike_ladder.requeued",
  ];
  const times = requeueTimesFromLedger(lines);
  assert.equal(times.get(TASK), Date.parse("2026-10-14T13:04:00.000Z"));
  assert.equal(times.has("W1-T1"), false);
  const ref = refAt(Date.parse("2026-10-14T07:34:13Z"));
  const wired = withRequeueReceipts(evidence(ref), () => lines);
  assert.equal(wired?.requeuedAtMs?.(TASK), Date.parse("2026-10-14T13:04:00.000Z"));
  const unreadable = withRequeueReceipts(evidence(ref), () => { throw new Error("ledger gone"); });
  assert.equal(unreadable?.requeuedAtMs?.(TASK), undefined);
  assert.equal(withRequeueReceipts(undefined, () => lines), undefined);
  assert.equal(
    stillBlockedByPushedRunBranch(TASK, new Set([TASK]), undefined, [ref], [], evidence(ref, { ...wired })),
    false,
  );
});
