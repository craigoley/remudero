// test/sweep-stale-body.test.ts — W1-T9124: a PR body edited WITHOUT a push leaves the head-keyed
// `remudero-review` status on the old verdict. The sweep must see that the input changed and queue one re-review.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STALE_BODY_REREVIEW_STEP,
  detectStaleBody,
  queueStaleBodyReReview,
  runSweep,
  type StaleBodyPrView,
} from "#test/helpers/sweep-test.js";
import { runDaemon, staleBodyFindingsForTick } from "#src/lib/daemon.js";
import type { OpenPrView } from "#src/lib/sweep.js";

const URL = "https://github.com/o/r/pull/9124";
const HEAD = "aaaa111";
const OLD = "v2:old";
const NEW = "v2:new";

function view(over: Partial<StaleBodyPrView> = {}): StaleBodyPrView {
  return { prNumber: 9124, prUrl: URL, headSha: HEAD, taskId: "W1-T9124", reviewState: "success", reviewInputDigest: NEW, ...over };
}
const posted = (digest: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  step: "review.posted", pr_url: URL, head_sha: HEAD, state: "success", review_input_digest: digest, ...over,
});

test("sweep detects stale body and queues re-review", () => {
  const found = detectStaleBody([view()], [posted(OLD)]);
  assert.equal(found.length, 1);
  assert.deepEqual(
    { reviewed: found[0].reviewedDigest, current: found[0].currentDigest, queued: found[0].queued },
    { reviewed: OLD, current: NEW, queued: false },
  );
  const rows: Array<Record<string, unknown>> = [];
  const queued = queueStaleBodyReReview(found, { ledgerPath: "L", runId: "R", appendLine: (_p, line) => { rows.push(line); } });
  assert.equal(queued.length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, STALE_BODY_REREVIEW_STEP);
  assert.equal(rows[0].review_input_digest, NEW);
  assert.equal(rows[0].reviewed_input_digest, OLD);
  assert.equal(rows[0].task_id, "W1-T9124");
  // One-shot: the queued row marks the finding, and a second queue writes nothing.
  const again = detectStaleBody([view()], [posted(OLD), rows[0]]);
  assert.equal(again[0].queued, true);
  assert.equal(queueStaleBodyReReview(again, { ledgerPath: "L", runId: "R", appendLine: (_p, line) => { rows.push(line); } }).length, 0);
  assert.equal(rows.length, 1);
});

test("sweep stale body: an unchanged body, a pending or judged current input, and missing evidence are not stale", () => {
  assert.deepEqual(detectStaleBody([view({ reviewInputDigest: OLD })], [posted(OLD)]), []);
  assert.deepEqual(detectStaleBody([view()], [posted(OLD), posted(NEW)]), [], "current input already judged");
  assert.deepEqual(detectStaleBody([view()], [posted(OLD), { step: "review.pending_posted", pr_url: URL, head_sha: HEAD, review_input_digest: NEW }]), [], "current input in flight");
  assert.deepEqual(detectStaleBody([view()], [posted(OLD, { head_sha: "bbbb222" })]), [], "verdict on another head");
  assert.deepEqual(detectStaleBody([view()], [posted(OLD, { state: "pending" })]), [], "pending is not a delivered verdict");
  assert.deepEqual(detectStaleBody([view()], [posted(undefined)]), [], "legacy row without a digest");
  assert.deepEqual(detectStaleBody([view()], []), [], "no verdict to compare");
  assert.deepEqual(detectStaleBody([view({ reviewState: "none" })], [posted(OLD)]), [], "no verdict showing");
  assert.deepEqual(detectStaleBody([view({ reviewInputDigest: undefined })], [posted(OLD)]), [], "no digest");
  assert.equal(detectStaleBody([view({ taskId: undefined })], [posted(OLD)])[0].taskId, undefined);
});

test("sweep stale body: the daemon tick helper reads the ledger and skips torn lines", () => {
  const lines = [JSON.stringify(posted(OLD)), "{torn"];
  assert.equal(staleBodyFindingsForTick([view()], () => lines).length, 1);
  assert.deepEqual(staleBodyFindingsForTick(undefined, () => lines), []);
  assert.deepEqual(staleBodyFindingsForTick([view()], undefined), []);
  assert.deepEqual(staleBodyFindingsForTick([], () => lines), []);
});

test("sweep stale body: daemon reports pending input once per pr, head and digest", async () => {
  const otherHead = "bbbb222";
  const otherUrl = "https://github.com/o/r/pull/9125";
  const nextDigest = "v2:newer";
  const passes = [
    [view({ reviewInputDigest: OLD })],
    [view()],
    [view()],
    [view({ reviewInputDigest: nextDigest })],
    [view({ headSha: otherHead, reviewInputDigest: nextDigest })],
    [view({ prNumber: 9125, prUrl: otherUrl, headSha: otherHead, reviewInputDigest: nextDigest })],
  ];
  const ledger = [
    posted(OLD),
    posted(OLD, { head_sha: otherHead }),
    posted(OLD, { pr_url: otherUrl, head_sha: otherHead }),
    { step: STALE_BODY_REREVIEW_STEP, pr_url: URL, head_sha: HEAD, review_input_digest: NEW },
  ].map((row) => JSON.stringify(row));
  let tick = 0;
  let sweeps = 0;
  const reported: Array<{ tick: number; extra: Record<string, unknown> }> = [];
  const summary = await runDaemon({ tasks: [], byId: new Map() }, {
    refreshMerged: () => () => false,
    runOne: async () => assert.fail("quiet hours must prevent dispatch"),
    readLedgerLines: () => ledger,
    sweep: async () => {
      sweeps++;
      return { reviewInputViews: passes[tick] };
    },
    checkQuietHours: () => ({ deferred: true, detail: "fixture dispatch hold" }),
    checkStop: () => tick >= passes.length ? "all fixture passes consumed" : undefined,
    sleep: async () => { tick++; },
    log: (step, extra = {}) => {
      if (step === "review.stale_body_pending") reported.push({ tick, extra });
    },
  });
  assert.equal(summary.stopReason, "stopped");
  assert.equal(sweeps, passes.length, "each tick consumed a completed sweep");
  const expected = (tick: number, prNumber: number, headSha: string, digest: string, queued: boolean) => ({
    tick,
    extra: {
      pr_number: prNumber, head_sha: headSha, review_input_digest: digest,
      reviewed_input_digest: OLD, queued,
    },
  });
  assert.deepEqual(reported, [
    expected(1, 9124, HEAD, NEW, true),
    expected(3, 9124, HEAD, nextDigest, false),
    expected(4, 9124, otherHead, nextDigest, false),
    expected(5, 9125, otherHead, nextDigest, false),
  ], "unchanged input stays silent, repeated input is deduped, and each changed identity reports");
});

test("sweep stale body: runSweep ledgers one re-review request for an edited body", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const prior = [posted(OLD)];
  const pr = {
    prNumber: 9124, prUrl: URL, taskId: "W1-T9124", reviewState: "success", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: "2026-10-16T00:00:00Z", headSha: HEAD, autoMergeArmed: false, reviewInputDigest: NEW,
  } as OpenPrView;
  const deps = {
    ledgerPath: "/nonexistent/ledger.ndjson", runId: "SWEEP-W1-T9124", dryRun: false, now: () => Date.parse("2026-10-16T01:00:00Z"),
    readLedger: () => [...prior, ...rows], appendLine: (_p: string, line: Record<string, unknown>) => { rows.push(line); },
    log: () => {},
  };
  await runSweep([pr], deps as never).catch((e: unknown) => { void e; /* downstream rungs need real deps; the ledgered request precedes them */ });
  assert.equal(rows.filter((r) => r.step === STALE_BODY_REREVIEW_STEP).length, 1);
  await runSweep([pr], deps as never).catch((e: unknown) => { void e; });
  assert.equal(rows.filter((r) => r.step === STALE_BODY_REREVIEW_STEP).length, 1, "second pass is deduped by the ledger");
});
