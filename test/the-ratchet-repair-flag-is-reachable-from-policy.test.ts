import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { loadPolicy, policyPath } from "../src/lib/policy.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  recordableRatchetRepairFor,
  recordableRatchetScripts,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";

const REPO_ROOT = join(new URL("..", import.meta.url).pathname);
const NOW = Date.parse("2026-09-10T00:00:00.000Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-ratchet-policy-")), "ledger.ndjson");
}

function ratchetPr(over: Partial<OpenPrView> = {}): OpenPrView {
  const checks = over.redRequiredChecks ?? ["comment-load-ratchet"];
  return {
    prNumber: 3289,
    prUrl: "https://github.com/o/r/pull/3289",
    taskId: "W1-T3289",
    reviewState: "failure",
    checksState: "red",
    redRequiredChecks: checks,
    ciFailures: checks.map((name) => ({ name, logTail: `${name}: record it in the baseline` })),
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-10T00:00:00.000Z",
    headSha: "ratchet-policy-head",
    autoMergeArmed: false,
    ...over,
  };
}

function deps(overrides: Partial<SweepDeps> = {}) {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const path = overrides.ledgerPath ?? ledgerPath();
  const runId = overrides.runId ?? "ratchet-policy-test";
  const out: SweepDeps & {
    fixed: typeof fixed;
    steps: typeof steps;
  } = {
    fixed,
    steps,
    ledgerPath: path,
    runId,
    now: () => NOW,
    arm: () => {},
    close: () => {},
    escalate: () => {},
    dispatchFix: (pr, evidence) => {
      fixed.push({ pr, evidence });
      if (pr.taskId) {
        appendLedger(path, {
          run_id: runId,
          task_id: pr.taskId,
          step: "fix.dispatch",
          strike: (pr.priorStrikes ?? 0) + 1,
        });
      }
    },
    log: (step, extra) => {
      steps.push({ step, extra });
    },
    ...overrides,
  };
  return out;
}

test("W1-T3289: DEFAULT_SWEEP_POLICY collects the shipped plan row and keeps the switch off", () => {
  const shipped = loadPolicy(policyPath(REPO_ROOT));
  assert.equal(shipped.values.sweep.recordableRatchetRepairEnabled, false);
  assert.equal(
    DEFAULT_SWEEP_POLICY.recordableRatchetRepairEnabled,
    shipped.values.sweep.recordableRatchetRepairEnabled,
  );
});

test("W1-T3289: an absent or false flag still names the remedy and withholds the repair", async () => {
  for (const policy of [
    { ...DEFAULT_SWEEP_POLICY, recordableRatchetRepairEnabled: false },
    withoutRecordableFlag(DEFAULT_SWEEP_POLICY),
  ]) {
    const repaired: number[] = [];
    const d = deps({
      repairRecordableRatchet: (pr) => {
        repaired.push(pr.prNumber);
        return true;
      },
    });
    await runSweep([ratchetPr()], d, policy);

    assert.deepEqual(repaired, []);
    assert.equal(d.fixed.length, 1, "disabled repair must fall through to the ordinary fix rung");
    const disposed = readLedgerLines(d.ledgerPath).filter((line) => line.step === "sweep.disposed");
    assert.match(String(disposed[0].reason), /RECORDABLE ratchet/);
    assert.match(String(disposed[0].reason), /npm run comment-load-ratchet/);
    assert.match(String(disposed[0].reason), /DISABLED \(recordableRatchetRepairEnabled\)/);
  }
});

test("W1-T3289: a true flag runs the generator scripts and ledgers the repair", async () => {
  const repaired: Array<{ pr: number; scripts: readonly string[] }> = [];
  const d = deps({
    repairRecordableRatchet: (pr, scripts) => {
      repaired.push({ pr: pr.prNumber, scripts });
      return true;
    },
  });
  await runSweep([ratchetPr({ redRequiredChecks: ["comment-load-ratchet", "source-size-baseline:legacy"] })], d, {
    ...DEFAULT_SWEEP_POLICY,
    recordableRatchetRepairEnabled: true,
  });

  assert.deepEqual(repaired, [
    { pr: 3289, scripts: ["comment-load-ratchet", "source-size-baseline:legacy"] },
  ]);
  assert.equal(d.fixed.length, 0, "a repaired ratchet must not also dispatch a worker");
  assert.equal(d.steps.filter((line) => line.step === "sweep.ratchet_repaired").length, 1);
});

test("W1-T3289: add/raise-capable ledgers are admitted, but score floors outside the registry are not", () => {
  const admitted = recordableRatchetScripts();
  assert.equal(admitted.has("comment-load-ratchet"), true);
  assert.equal(admitted.has("source-size-baseline:legacy"), true);
  assert.deepEqual(
    recordableRatchetRepairFor({ redRequiredChecks: ["comment-load-ratchet"] } as never),
    ["comment-load-ratchet"],
  );
  assert.deepEqual(
    recordableRatchetRepairFor({ redRequiredChecks: ["source-size-baseline:legacy"] } as never),
    ["source-size-baseline:legacy"],
  );
  assert.equal(
    recordableRatchetRepairFor({ redRequiredChecks: ["coverage-ratchet"] } as never),
    undefined,
    "a score floor outside REGENERABLE_ARTIFACT_GENERATORS must never be repaired",
  );
});

function withoutRecordableFlag(policy: SweepPolicy): SweepPolicy {
  const copy: SweepPolicy = { ...policy };
  delete copy.recordableRatchetRepairEnabled;
  return copy;
}
