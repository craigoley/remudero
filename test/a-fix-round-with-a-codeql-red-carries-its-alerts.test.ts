import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sweepModule from "./helpers/sweep-test.js";
import type { CiFailure, OpenPrView, SweepDeps } from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T10066 — #12570's ordinary fix rounds were sent a `CodeQL` ci_failure with a null tail while the head's
// alert #429 was already read, so the worker fixed only the members that had text. A fix round whose red
// includes a failed CodeQL check now carries the head's alerts, or says plainly that they were not read.

const NOW = Date.parse("2026-10-17T14:00:00Z");
const N = 12570;
const HEAD = "d898a9592aaaa";
const OLD_HEAD = "a4f26f8c1bbbb";

const ALERT = {
  alertNumber: 429,
  ruleId: "js/file-system-race",
  severity: "high",
  path: "src/lib/test-slot-mutation.ts",
  line: 239,
  message: "The file may have changed since it was checked.",
};

const RATCHET: CiFailure = { name: "coverage-ratchet", logTail: "diff-coverage: 3 uncovered added lines" };
const BLANK_CODEQL = { name: "CodeQL", logTail: "" } as CiFailure;

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: N,
    prUrl: `https://github.com/craigoley/remudero/pull/${N}`,
    taskId: "W1-T9928",
    headRefName: "run-W1-T9928-1791259610820",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-17T13:00:00Z",
    headSha: HEAD,
    autoMergeArmed: false,
    ciFailures: [RATCHET, BLANK_CODEQL],
    redRequiredChecks: ["coverage-ratchet"],
    codeqlHeadAlerts: { headSha: HEAD, alerts: [ALERT] },
    ...over,
  };
}

async function dispatched(view: OpenPrView): Promise<CiFailure[]> {
  const lines: Array<Record<string, unknown>> = [];
  const fixes: CiFailure[][] = [];
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t10066-`));
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (_p, evidence) => {
      fixes.push((evidence as { ciFailures: CiFailure[] }).ciFailures);
    },
    escalate: () => {},
    ledgerPath: join(dir, "ledger.ndjson"),
    runId: "SWEEP-10066",
    now: () => NOW,
    readLedger: () => lines,
    appendLine: (_path, line) => {
      lines.push(line);
    },
    log: (step, extra = {}) => {
      lines.push({ run_id: "SWEEP-10066", step, ...extra });
    },
  };
  try {
    await sweepModule.runSweep([view], deps);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fixes.length, 1, "the fix lane was dispatched once");
  return fixes[0];
}

test("W1-T10066: a mixed red with a failed CodeQL check dispatches the head alerts", async () => {
  const failures = await dispatched(pr());
  assert.deepEqual(failures.map((f) => f.name), ["coverage-ratchet", "CodeQL alert #429 (js/file-system-race)"]);
  const alert = failures[1].logTail;
  assert.match(alert, /UNTRUSTED SCANNER EVIDENCE/);
  assert.match(alert, /rule: js\/file-system-race \(severity high\)/);
  assert.match(alert, /location: src\/lib\/test-slot-mutation\.ts:239/);
  assert.match(alert, /message: The file may have changed since it was checked\./);
  assert.match(alert, /Do not dismiss alerts or add suppression comments/);
  assert.equal(failures[0].logTail, RATCHET.logTail, "the other red keeps its own evidence");
});

test("W1-T10066: unread alerts give a CodeQL entry that says they were not read", async () => {
  const older = await dispatched(pr({ codeqlHeadAlerts: { headSha: OLD_HEAD, alerts: [ALERT] } }));
  assert.deepEqual(older.map((f) => f.name), ["coverage-ratchet", "CodeQL"]);
  assert.match(older[1].logTail, /^CodeQL failed at this head; its alerts were not read: alerts were read at head a4f26f8, not at this head d898a95/);

  const unread = await dispatched(pr({ codeqlHeadAlerts: undefined }));
  assert.deepEqual(unread.map((f) => f.name), ["coverage-ratchet", "CodeQL"]);
  assert.match(unread[1].logTail, /^CodeQL failed at this head; its alerts were not read: no open high-severity alert was read for this head/);
});

test("W1-T10066: a fix round with no CodeQL failure is unchanged", async () => {
  const failures = await dispatched(pr({ ciFailures: [RATCHET] }));
  assert.deepEqual(failures, [RATCHET]);
  assert.deepEqual(sweepModule.withCodeqlAlertEvidence(pr(), [RATCHET]), [RATCHET]);
});
