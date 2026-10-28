// test/a-deterministic-shard-timeout-is-not-re-queued.test.ts — W1-T8040.
//
// 2026-10-11, PR #10852 at 28a3134: ci-shard (7/8) and (8/8) were each re-run (12:55Z, 13:47Z) although
// their first attempts' logs already named a pooled failure before the 35-minute cancel — and ci.yml's
// SHARD HANG text says re-running the same sha will hang again. W1-T1223's one bounded requeue now reads
// the cancelled check's own log first.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deterministicTimeoutSignature,
  runSweep,
  type CancelledRequiredCheck,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-10-11T13:40:00Z");
const HEAD = "28a3134dab0e";
const SHARDS = ["ci-shard (7/8)", "ci-shard (8/8)"];
const POOLED_LOG = [
  "2026-10-11T12:10:00.1Z not ok 41 - a worker thread makes no setup dirs",
  "2026-10-11T12:10:00.2Z pure-test-pool: the pool of 120 file(s) failed",
  "2026-10-11T12:12:00.3Z pure-test-pool: every pooled file passes isolated",
  "2026-10-11T12:12:01.4Z locating the leak ...",
  "2026-10-11T12:45:00.5Z ##[error]The operation was canceled.",
].join("\n");
const PASSING_THEN_HUNG_LOG = [
  "2026-10-11T12:10:00.1Z # tests 900",
  "2026-10-11T12:10:00.2Z # pass 900",
  "2026-10-11T12:10:00.3Z # fail 0",
  "2026-10-11T12:45:00.5Z ##[error]The operation was canceled.",
].join("\n");

const tmpLedger = (): string => join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t8040-`)), "ledger.ndjson");

function view(logs: Record<string, string>, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10852,
    prUrl: "https://github.com/craigoley/remudero/pull/10852",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: HEAD,
    headRefName: "run-unfiled-1791718425961",
    autoMergeArmed: false,
    ciFailures: Object.entries(logs).map(([name, logTail]) => ({ name, logTail, conclusion: "CANCELLED" })),
    cancelledRequiredChecks: Object.keys(logs).map((name, i) => ({ name, jobId: String(114465855726 + i) })),
    ...over,
  };
}

function fakeDeps(over: Partial<SweepDeps> = {}) {
  const requeued: string[] = [];
  const fixed: FixDispatchEvidence[] = [];
  const cancelledEscalated: Array<{ check: CancelledRequiredCheck; reason: string }> = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (_pr, evidence) => {
      fixed.push(evidence);
    },
    escalate: () => {},
    requeueCheck: async (_pr, check) => {
      requeued.push(check.name);
    },
    escalateCancelledCheck: async (_pr, check, reason) => {
      cancelledEscalated.push({ check, reason });
    },
    ledgerPath: tmpLedger(),
    runId: "SWEEP-W1-T8040",
    now: () => NOW,
    ...over,
  };
  return { deps, requeued, fixed, cancelledEscalated };
}

test("W1-T8040: a shard cancelled at its ceiling after a failing test is not re-queued", async () => {
  const { deps, requeued, fixed } = fakeDeps();
  await runSweep([view({ [SHARDS[0]!]: POOLED_LOG, [SHARDS[1]!]: POOLED_LOG })], deps);

  assert.deepEqual(requeued, [], "neither deterministic shard is re-run");
  const skipped = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.check_requeue.skipped");
  assert.deepEqual(skipped.map((l) => l.check_name), SHARDS);
  for (const row of skipped) {
    assert.equal(row.reason, "deterministic-timeout");
    assert.equal(row.head_sha, HEAD);
    assert.match(String(row.signature), /^pool failure: a worker thread makes no setup dirs fails pooled, passes isolated$/);
  }
  assert.equal(readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.check_requeued").length, 0);
  assert.equal(fixed.length, 1, "the ci-log fix path receives the failure instead of a stand-down");
  assert.deepEqual(fixed[0]!.ciFailures?.map((f) => f.name), SHARDS);
});

test("W1-T8040: a cancellation with no failure in its log is still re-queued once", async () => {
  const { deps, requeued, fixed } = fakeDeps();
  await runSweep([view({
    [SHARDS[0]!]: PASSING_THEN_HUNG_LOG, // every test passed: a hang after the summary may be environmental
    [SHARDS[1]!]: "", // no readable log
  })], deps);

  assert.deepEqual(requeued, SHARDS, "both keep today's one bounded requeue");
  assert.equal(fixed.length, 0, "no fix strike is spent on a cancellation with no failure");
  const rows = readLedgerLines(deps.ledgerPath);
  assert.equal(rows.filter((l) => l.step === "sweep.check_requeued").length, 2);
  assert.equal(rows.filter((l) => l.step === "sweep.check_requeue.skipped").length, 0);
});

test("W1-T8040: a superseded run and a bare runner-loss cancellation keep their requeue", () => {
  const superseded = POOLED_LOG + "\n2026-10-11T12:46:00Z ci: SUPERSEDED — this run measured aaa, the PR head is now bbb.";
  assert.equal(deterministicTimeoutSignature(superseded), undefined);
  assert.equal(deterministicTimeoutSignature(undefined), undefined);
  assert.equal(deterministicTimeoutSignature("2026-10-11T12:45:00Z ##[error]The runner has received a shutdown signal."), undefined);
});

test("W1-T8040: the signature names a pool defect and a runner failure before the ceiling", () => {
  assert.match(
    deterministicTimeoutSignature("pure-test-pool: POOL DEFECT — leaking file: test/leaky.test.ts (first failing alongside it: test/victim.test.ts)") ?? "",
    /^pool defect: test\/leaky\.test\.ts leaks$/,
  );
  assert.equal(
    deterministicTimeoutSignature("not ok 3 - the thing\nThe job running on runner X has exceeded the maximum execution time of 35 minutes."),
    "timed out after a failing test: the thing",
  );
});

test("W1-T8040: a second cancellation of a deterministic shard escalates naming its signature", async () => {
  const { deps, requeued, cancelledEscalated } = fakeDeps({
    readLedger: () => [{ step: "sweep.check_requeued", head_sha: HEAD, check_name: SHARDS[0] }],
  });
  await runSweep([view({ [SHARDS[0]!]: POOLED_LOG })], deps);
  assert.deepEqual(requeued, []);
  assert.equal(cancelledEscalated.length, 1);
  assert.match(cancelledEscalated[0]!.reason, /cancelled again/);
  assert.match(cancelledEscalated[0]!.reason, /its log names: pool failure: a worker thread makes no setup dirs/);
});
