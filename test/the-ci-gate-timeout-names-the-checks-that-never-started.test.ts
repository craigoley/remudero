// W1-T5934 — ci-gate's ::error:: annotation carries only W1-T312's TIMED OUT line; the `  - <check>`
// not-ready list follows it in the job log alone. So W1-T5921's stand-down and escalation usually
// read "(unnamed in the gate's annotation)". This suite pins that a classified timeout with no
// annotated list names the checks still queued on the FRESH rollup the sweep already reads, says
// which source answered, uses an annotated list as is, and names an unreadable rollup as unreadable
// rather than reading its empty list as "none never started".
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY,
  ciTimeoutNotReadyChecks,
  runSweep,
  type CiFailure,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
} from "./helpers/sweep-test.js";

const TIMEOUT_LINE =
  "ci-gate: TIMED OUT waiting for required check(s) to complete (this is NOT a check failure -- a NEW sha " +
  "is the only remedy, re-running this same sha will not help):";
// What the sweep usually sees: the annotation fallback, which carries the error line alone.
const ANNOTATION_ONLY: CiFailure = { name: "ci-gate", conclusion: "FAILURE", jobId: "900", logTail: TIMEOUT_LINE };
// What it sees when the job log answered: the error line, then the gate's own not-ready list.
const WITH_LIST: CiFailure = { ...ANNOTATION_ONLY, logTail: `${TIMEOUT_LINE}\n  - acceptance-author-gate` };

const HEAD = "9388aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// The #9388 rollup at that head: the gate failed, rule-checks never got a runner, the rest finished.
const ROLLUP: RollupCheckEntry[] = [
  { name: "ci-gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-05T20:40:00Z" },
  { name: "rule-checks", status: "QUEUED" },
  { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-05T20:39:00Z" },
  { name: "typecheck", status: "IN_PROGRESS", startedAt: "2026-10-05T21:20:00Z" },
  { context: "remudero-review", state: "PENDING" },
];

function subject(failure: CiFailure): OpenPrView {
  return {
    prNumber: 9388,
    prUrl: "https://github.com/craigoley/remudero/pull/9388",
    taskId: "W1-T5885",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-05T21:30:00Z", // expiring-fixture: exempt -- every runSweep below injects `now` pinned ten minutes later (deps()), so the age comparison never reads the wall clock
    headSha: HEAD,
    headRefName: "run-W1-T5885-1791230000000",
    autoMergeArmed: false,
    redRequiredChecks: [],
    ciFailures: [failure],
    cancelledRequiredChecks: [],
  };
}

function deps(
  ledgerPath: string,
  rollup: "unwired" | (() => RollupCheckEntry[] | undefined),
  escalated: string[] = [],
  behind?: number,
): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {
      throw new Error("a timeout is never a fix strike");
    },
    escalate: (_pr, reason) => {
      escalated.push(reason);
    },
    requeueCheck: () => true,
    ...(rollup === "unwired" ? {} : { readCiGateRollup: rollup }),
    ...(behind !== undefined ? { behindMainByPr: new Map([[9388, behind]]) } : {}),
    readLiveState: (pr) => ({ ok: true, state: "OPEN", headSha: pr.headSha }),
    updateBranch: () => "updated",
    ledgerPath,
    runId: "SWEEP-W1-T5934",
    now: () => Date.parse("2026-10-05T21:40:00Z"),
  };
}

function ledger(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5934-${label}-`)), "ledger.ndjson");
}

function rows(path: string): { reason: string; outcome?: Record<string, unknown> } {
  const lines = readLedgerLines(path);
  const disposed = lines.findLast((line) => line.step === "sweep.disposed" && line.head_sha === HEAD);
  return {
    reason: String(disposed?.stand_down_reason),
    outcome: lines.find((line) => line.step === "sweep.ci_timeout_refresh.outcome"),
  };
}

test("ciTimeoutNotReadyChecks: the annotation's list is used as is; without one, the fresh rollup's queued checks", () => {
  assert.deepEqual(ciTimeoutNotReadyChecks(["acceptance-author-gate"], ROLLUP), {
    names: ["acceptance-author-gate"],
    source: "annotation",
  });
  // Only a check still waiting for a runner is named — never the gate itself, a finished or running
  // check, or the review status context.
  assert.deepEqual(ciTimeoutNotReadyChecks([], ROLLUP), { names: ["rule-checks"], source: "rollup" });
  // The LATEST attempt decides: a check queued again after an earlier finished attempt is named.
  assert.deepEqual(
    ciTimeoutNotReadyChecks([], [
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-05T20:00:00Z" },
      { name: "lint", status: "WAITING", startedAt: "2026-10-05T21:00:00Z" },
      { context: "codeql-gate", state: "EXPECTED" },
    ]),
    { names: ["lint", "codeql-gate"], source: "rollup" },
  );
  assert.deepEqual(ciTimeoutNotReadyChecks([], []), { names: [], source: "rollup" }, "a readable rollup with none queued");
  assert.deepEqual(ciTimeoutNotReadyChecks([], "unreadable"), { names: [], source: "rollup-unreadable" });
  assert.deepEqual(ciTimeoutNotReadyChecks([], "unread"), { names: [], source: "rollup-unread" });
});

test("an annotation without the list names rule-checks from the fresh rollup and says so", async () => {
  const path = ledger("rollup");
  await runSweep([subject(ANNOTATION_ONLY)], deps(path, () => ROLLUP), DEFAULT_SWEEP_POLICY);
  const { reason, outcome } = rows(path);
  assert.match(reason, /never-started check\(s\) rule-checks \[not-ready list: queued on the fresh rollup\]/);
  assert.doesNotMatch(reason, /unnamed/);
  assert.match(reason, /base refresh requested/);
  assert.deepEqual(outcome?.not_ready_checks, ["rule-checks"]);
  assert.equal(outcome?.not_ready_source, "rollup");
});

test("an annotation that carries the list is used as is, even when the rollup shows another check queued", async () => {
  const path = ledger("annotation");
  await runSweep([subject(WITH_LIST)], deps(path, () => ROLLUP), DEFAULT_SWEEP_POLICY);
  const { reason, outcome } = rows(path);
  assert.match(reason, /never-started check\(s\) acceptance-author-gate \[not-ready list: the gate's annotation\]/);
  assert.doesNotMatch(reason, /rule-checks/);
  assert.deepEqual(outcome?.not_ready_checks, ["acceptance-author-gate"]);
  assert.equal(outcome?.not_ready_source, "annotation");
});

test("the escalation names the rollup's checks and their source too", async () => {
  const path = ledger("escalate");
  const escalated: string[] = [];
  await runSweep([subject(ANNOTATION_ONLY)], deps(path, () => ROLLUP, escalated, 0), DEFAULT_SWEEP_POLICY);
  assert.equal(escalated.length, 1);
  assert.match(escalated[0], /rule-checks \[not-ready list: queued on the fresh rollup\]; no new head is possible/);
  const row = readLedgerLines(path).find((line) => line.step === "sweep.ci_timeout_refresh.escalated");
  assert.equal(row?.not_ready_source, "rollup");
});

test("an unreadable rollup is named as unreadable, never read as an empty list of never-started checks", async () => {
  const path = ledger("unreadable");
  await runSweep([subject(ANNOTATION_ONLY)], deps(path, () => undefined), DEFAULT_SWEEP_POLICY);
  const { reason, outcome } = rows(path);
  assert.match(reason, /\(unnamed\) \[not-ready list: the gate's annotation lists none and the fresh rollup was unreadable\]/);
  assert.equal(outcome?.not_ready_source, "rollup-unreadable");
  assert.deepEqual(outcome?.not_ready_checks, []);
});

test("a pass that reads no fresh rollup says so, distinct from an unreadable one", async () => {
  const path = ledger("unread");
  await runSweep([subject(ANNOTATION_ONLY)], deps(path, "unwired"), DEFAULT_SWEEP_POLICY);
  const { reason, outcome } = rows(path);
  assert.match(reason, /\[not-ready list: the gate's annotation lists none and this pass reads no fresh rollup\]/);
  assert.equal(outcome?.not_ready_source, "rollup-unread");
});

test("a readable rollup with nothing queued is reported as such, not as unnamed or unreadable", async () => {
  const path = ledger("none-queued");
  const finished = ROLLUP.filter((c) => c.name !== "rule-checks");
  await runSweep([subject(ANNOTATION_ONLY)], deps(path, () => finished), DEFAULT_SWEEP_POLICY);
  const { reason, outcome } = rows(path);
  assert.match(reason, /\(unnamed\) \[not-ready list: the gate's annotation lists none and the fresh rollup shows none queued\]/);
  assert.equal(outcome?.not_ready_source, "rollup");
  assert.deepEqual(outcome?.not_ready_checks, []);
});
