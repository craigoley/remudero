import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.parse("2026-09-09T20:00:00.000Z");
const RECENT = "2026-09-09T19:00:00.000Z";

function ledgerPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-redundant-refix-")), "ledger.ndjson");
  writeFileSync(path, "");
  return path;
}

function dirtyPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4832,
    prUrl: "https://github.com/craigoley/remudero/pull/4832",
    taskId: "W1-T3273",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "8eaeb95c0",
    autoMergeArmed: false,
    mergeState: "dirty",
    mergeConflict: {
      files: [{ path: "test/stale-gate-fixture.test.ts", oursDeleted: 1, theirsDeleted: 1 }],
      oursLog: "8eaeb95 fix stale-gate fixture",
      theirsLog: "f15dff6 fix stale-gate fixture",
      redundantRefix: {
        compared: "bytes",
        verdict: "main-byte-identical",
        comparedPaths: ["test/stale-gate-fixture.test.ts"],
      },
    },
    ...over,
  };
}

function deps(path: string, fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr, evidence) => {
      fixed.push({ pr, evidence });
    },
    escalate: () => {},
    ledgerPath: path,
    runId: "SWEEP-W1-T3273",
    now: () => NOW,
  };
}

function disposed(path: string, prNumber: number): Record<string, unknown> {
  const row = readLedgerLines(path).find((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
  assert.ok(row, `missing sweep.disposed row for #${prNumber}`);
  return row;
}

test("a dirty PR whose conflicting hunk resolves byte-identically to main is admitted for automatic resolution", () => {
  const result = deriveDisposition(dirtyPr(), DEFAULT_SWEEP_POLICY, NOW);

  assert.equal(result.disposition, "conflicted");
  assert.match(result.reason, /redundant re-fix byte comparison matched main/);
  assert.match(result.reason, /byte-identical to main/);
  assert.doesNotMatch(result.reason, /pure concurrent addition/);
});

test("a dirty PR whose conflicting hunk resolves to something different from main keeps the ambiguous refusal", () => {
  const result = deriveDisposition(
    dirtyPr({
      prNumber: 4848,
      mergeConflict: {
        files: [{ path: "test/stale-gate-fixture.test.ts", oursDeleted: 1, theirsDeleted: 1 }],
        oursLog: "8eaeb95 fix stale-gate fixture",
        theirsLog: "f15dff6 fix stale-gate fixture",
        redundantRefix: {
          compared: "bytes",
          verdict: "different-from-main",
          comparedPaths: ["test/stale-gate-fixture.test.ts"],
          differingPaths: ["test/stale-gate-fixture.test.ts"],
        },
      },
    }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );

  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /redundant re-fix byte comparison differed from main/);
  assert.match(result.reason, /never auto-resolved/);
});

test("a branch whose non-conflicting files fail to apply is declined despite a redundant hunk", () => {
  const result = deriveDisposition(
    dirtyPr({
      prNumber: 4849,
      mergeConflict: {
        files: [{ path: "test/stale-gate-fixture.test.ts", oursDeleted: 1, theirsDeleted: 1 }],
        oursLog: "8eaeb95 fix stale-gate fixture",
        theirsLog: "f15dff6 fix stale-gate fixture",
        redundantRefix: {
          compared: "bytes",
          verdict: "non-conflicting-files-failed",
          comparedPaths: ["test/stale-gate-fixture.test.ts"],
          failedApplyPaths: ["src/lib/sweep.ts"],
        },
      },
    }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );

  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /non-conflicting files failed to apply: src\/lib\/sweep.ts/);
  assert.match(result.reason, /never auto-resolved/);
});

test("the predicate reads byte evidence, not commit subjects or task ids", () => {
  const sameWordsDifferentBytes = dirtyPr({
    prNumber: 4850,
    taskId: "W1-T3273",
    mergeConflict: {
      files: [{ path: "test/stale-gate-fixture.test.ts", oursDeleted: 1, theirsDeleted: 1 }],
      oursLog: "8eaeb95 fix stale-gate fixture",
      theirsLog: "f15dff6 fix stale-gate fixture",
      redundantRefix: {
        compared: "bytes",
        verdict: "different-from-main",
        comparedPaths: ["test/stale-gate-fixture.test.ts"],
        differingPaths: ["test/stale-gate-fixture.test.ts"],
      },
    },
  });

  const result = deriveDisposition(sameWordsDifferentBytes, DEFAULT_SWEEP_POLICY, NOW);

  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /byte comparison differed from main/);
});

test("both admission and decline write a ledger row naming the byte comparison that decided it", async () => {
  const path = ledgerPath();
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const admitted = dirtyPr({ prNumber: 4832, headSha: "admitted-head" });
  const declined = dirtyPr({
    prNumber: 4848,
    headSha: "declined-head",
    mergeConflict: {
      files: [{ path: "test/stale-gate-fixture.test.ts", oursDeleted: 1, theirsDeleted: 1 }],
      oursLog: "8eaeb95 fix stale-gate fixture",
      theirsLog: "f15dff6 fix stale-gate fixture",
      redundantRefix: {
        compared: "bytes",
        verdict: "different-from-main",
        comparedPaths: ["test/stale-gate-fixture.test.ts"],
        differingPaths: ["test/stale-gate-fixture.test.ts"],
      },
    },
  });

  await runSweep([admitted, declined], deps(path, fixed), DEFAULT_SWEEP_POLICY);

  assert.equal(fixed.length, 1, "only the byte-identical redundant re-fix dispatches");
  assert.equal(fixed[0].evidence.mergeConflict?.redundantRefix?.verdict, "main-byte-identical");

  const admittedRow = disposed(path, 4832);
  assert.equal(admittedRow.disposition, "conflicted");
  assert.equal(admittedRow.acted, true);
  assert.match(String(admittedRow.reason), /redundant re-fix byte comparison matched main/);

  const declinedRow = disposed(path, 4848);
  assert.equal(declinedRow.disposition, "blocked-ambiguous");
  assert.equal(declinedRow.acted, true);
  assert.match(String(declinedRow.reason), /redundant re-fix byte comparison differed from main/);
  assert.match(String(declinedRow.reason), /never auto-resolved/);
});
