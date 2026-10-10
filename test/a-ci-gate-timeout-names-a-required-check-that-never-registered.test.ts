// W1-T5979 — W1-T5934's ciTimeoutNotReadyChecks fills a timeout's not-ready list from the fresh
// rollup when the gate's annotation lists none. Two gaps: a required check whose workflow never
// started has NO rollup entry, so the list read "none" for exactly the missing check; and the
// rollup was not filtered to ci-gate's REQUIRED set, so a queued optional check was named as what
// the gate waits for. This suite pins that, given the gate's REQUIRED list, the rollup's queued
// checks are intersected with it, each required name absent from the rollup is named as never
// registered, and an unreadable REQUIRED list is named as unreadable, never treated as empty.
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
// The annotation fallback the sweep usually sees: the error line alone, no `  - <check>` list.
const ANNOTATION_ONLY: CiFailure = { name: "ci-gate", conclusion: "FAILURE", jobId: "901", logTail: TIMEOUT_LINE };

const HEAD = "5979aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ci-gate's REQUIRED list for this fixture: `acceptance-author-gate` never registered at all.
const REQUIRED = ["ci", "rule-checks", "acceptance-author-gate"];

// The fresh rollup: rule-checks (required) and optional-lint (NOT required) both wait for a runner;
// acceptance-author-gate has no entry, because its workflow was never triggered.
const ROLLUP: RollupCheckEntry[] = [
  { name: "ci-gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-06T10:40:00Z" },
  { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-06T10:39:00Z" },
  { name: "rule-checks", status: "QUEUED" },
  { name: "optional-lint", status: "QUEUED" },
  { context: "remudero-review", state: "PENDING" },
];

function subject(): OpenPrView {
  return {
    prNumber: 5979,
    prUrl: "https://github.com/craigoley/remudero/pull/5979",
    taskId: "W1-T5979",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-06T11:30:00Z", // expiring-fixture: exempt -- every runSweep below injects `now` pinned ten minutes later (deps()), so the age comparison never reads the wall clock
    headSha: HEAD,
    headRefName: "run-W1-T5979-1791300000000",
    autoMergeArmed: false,
    redRequiredChecks: [],
    ciFailures: [ANNOTATION_ONLY],
    cancelledRequiredChecks: [],
  };
}

function deps(
  ledgerPath: string,
  rollup: RollupCheckEntry[],
  required: readonly string[],
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
    readCiGateRollup: () => rollup,
    readCiGateRequired: () => required,
    ...(behind !== undefined ? { behindMainByPr: new Map([[5979, behind]]) } : {}),
    readLiveState: (pr) => ({ ok: true, state: "OPEN", headSha: pr.headSha }),
    updateBranch: () => "updated",
    ledgerPath,
    runId: "SWEEP-W1-T5979",
    now: () => Date.parse("2026-10-06T11:40:00Z"),
  };
}

function ledger(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5979-${label}-`)), "ledger.ndjson");
}

function rows(path: string): { reason: string; outcome?: Record<string, unknown> } {
  const lines = readLedgerLines(path);
  const disposed = lines.findLast((line) => line.step === "sweep.disposed" && line.head_sha === HEAD);
  return {
    reason: String(disposed?.stand_down_reason),
    outcome: lines.find((line) => line.step === "sweep.ci_timeout_refresh.outcome"),
  };
}

test("a ci-gate timeout names a required check absent from the rollup as never registered, and never names a queued check outside the required set", async () => {
  assert.deepEqual(ciTimeoutNotReadyChecks([], ROLLUP, REQUIRED), {
    names: ["rule-checks", "acceptance-author-gate"],
    neverRegistered: ["acceptance-author-gate"],
    source: "rollup-required",
  });

  const path = ledger("filtered");
  await runSweep([subject()], deps(path, ROLLUP, REQUIRED), DEFAULT_SWEEP_POLICY);
  const { reason, outcome } = rows(path);
  assert.match(reason, /never-started check\(s\) rule-checks, acceptance-author-gate \(never registered\) \[not-ready list: /);
  assert.doesNotMatch(reason, /optional-lint/);
  assert.deepEqual(outcome?.not_ready_checks, ["rule-checks", "acceptance-author-gate"]);
  assert.deepEqual(outcome?.never_registered_checks, ["acceptance-author-gate"]);
  assert.equal(outcome?.not_ready_source, "rollup-required");
});

test("a timeout whose only missing required check never registered escalates naming it, never 'none'", async () => {
  const path = ledger("escalate");
  const escalated: string[] = [];
  // Nothing is queued on the rollup at all: before W1-T5979 this read "(unnamed) ... shows none queued".
  const settled = ROLLUP.map((c) =>
    c.status === "QUEUED" ? { ...c, status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-06T10:41:00Z" } : c);
  await runSweep([subject()], deps(path, settled, REQUIRED, escalated, 0), DEFAULT_SWEEP_POLICY);
  assert.equal(escalated.length, 1);
  assert.match(escalated[0], /never-started check\(s\) acceptance-author-gate \(never registered\) \[not-ready list: /);
  assert.doesNotMatch(escalated[0], /unnamed|none queued/);
  const row = readLedgerLines(path).find((line) => line.step === "sweep.ci_timeout_refresh.escalated");
  assert.deepEqual(row?.not_ready_checks, ["acceptance-author-gate"]);
  assert.deepEqual(row?.never_registered_checks, ["acceptance-author-gate"]);
});

test("a required check matched by its status context counts as registered, and the gate and review never count as required", () => {
  const rollup: RollupCheckEntry[] = [{ context: "codeql-gate", state: "EXPECTED" }];
  assert.deepEqual(ciTimeoutNotReadyChecks([], rollup, ["codeql-gate", "ci-gate", "remudero-review"]), {
    names: ["codeql-gate"],
    neverRegistered: [],
    source: "rollup-required",
  });
});

test("an unreadable REQUIRED list is named as unreadable, never read as an empty required set", async () => {
  assert.deepEqual(ciTimeoutNotReadyChecks([], ROLLUP, []), {
    names: ["rule-checks", "optional-lint"],
    source: "rollup-required-unreadable",
  });
  const path = ledger("required-unreadable");
  await runSweep([subject()], deps(path, ROLLUP, []), DEFAULT_SWEEP_POLICY);
  const { reason, outcome } = rows(path);
  assert.match(reason, /\[not-ready list: queued on the fresh rollup, unfiltered: the gate's REQUIRED list was unreadable/);
  assert.equal(outcome?.not_ready_source, "rollup-required-unreadable");
});

test("the gate's annotation list is still used as is when the REQUIRED list is read", () => {
  assert.deepEqual(ciTimeoutNotReadyChecks(["rule-checks"], ROLLUP, REQUIRED), {
    names: ["rule-checks"],
    source: "annotation",
  });
});
