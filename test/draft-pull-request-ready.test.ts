import assert from "node:assert/strict";
import { test } from "node:test";
import { readyDraftViaGh } from "../src/run-task.js";
import { runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-09-24T01:00:00Z");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 6912,
    prUrl: "https://github.com/craigoley/remudero/pull/6912",
    taskId: "W1-T4415",
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
    lastActivityAt: "2026-09-24T00:31:39Z",
    headSha: "c3297170",
    headRefName: "plan-garden-1790209890119",
    autoMergeArmed: false,
    mergeState: "clean",
    ...over,
  };
}

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/tmp/rmd-w1-t4415-ledger.ndjson",
    runId: "SWEEP-W1-T4415",
    now: () => NOW,
    readLedger: () => [],
    appendLine: () => {},
    ...over,
  };
}

test("the sweep marks an open draft pull request ready for review and ledgers it", async () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const argvs: string[][] = [];
  const readyDraft = readyDraftViaGh("craigoley", "remudero", (step, extra) => rows.push({ step, extra }), ((args: string[]) => {
    argvs.push(args);
    return "";
  }) as never);

  await runSweep([pr({ isDraft: true }), pr({ prNumber: 6913, headSha: "2ac6e2d9", isDraft: false })], deps({ readyDraft }));

  assert.deepEqual(argvs, [["pr", "ready", "6912", "--repo", "craigoley/remudero"]], "only the draft is readied");
  assert.deepEqual(rows, [
    { step: "sweep.draft_readied", extra: { pr_number: 6912, head_sha: "c3297170", head_ref: "plan-garden-1790209890119" } },
  ]);
});

test("a draft whose checks are not green is readied too", async () => {
  const readied: number[] = [];
  await runSweep(
    [pr({ prNumber: 7001, isDraft: true, checksState: "red" }), pr({ prNumber: 7002, isDraft: true, checksState: "pending" })],
    deps({ readyDraft: (p) => void readied.push(p.prNumber) }),
  );
  assert.deepEqual(readied, [7001, 7002]);
});

test("a failed ready write is ledgered with its reason and the sweep goes on", async () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const readyDraft = readyDraftViaGh("craigoley", "remudero", (step, extra) => rows.push({ step, extra }), (() => {
    throw new Error("HTTP 403");
  }) as never);
  const summary = await runSweep([pr({ isDraft: true })], deps({ readyDraft }));
  assert.equal(rows[0]?.step, "sweep.draft_ready_failed");
  assert.equal(rows[0]?.extra?.reason, "HTTP 403");
  assert.ok(summary, "the pass still completes");
});
