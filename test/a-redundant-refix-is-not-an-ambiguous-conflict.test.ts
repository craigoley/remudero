import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  conflictRefusalCause,
  deriveDisposition,
  isRedundantRefixConflict,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { MergeConflictEvidence } from "../src/lib/merge-state.js";

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

test("a redundant re-fix claim not backed by byte evidence keeps the ambiguous refusal", () => {
  const result = deriveDisposition(
    dirtyPr({
      prNumber: 4850,
      mergeConflict: {
        files: [{ path: "test/stale-gate-fixture.test.ts", oursDeleted: 1, theirsDeleted: 1 }],
        oursLog: "8eaeb95 fix stale-gate fixture",
        theirsLog: "f15dff6 fix stale-gate fixture",
        redundantRefix: {
          compared: "semantic" as "bytes",
          verdict: "main-byte-identical",
          comparedPaths: ["test/stale-gate-fixture.test.ts"],
        },
      },
    }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );

  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /redundant re-fix evidence was not a byte comparison/);
  assert.match(result.reason, /never auto-resolved/);
});

test("a redundant re-fix byte comparison must cover every conflicting path", () => {
  const result = deriveDisposition(
    dirtyPr({
      prNumber: 4851,
      mergeConflict: {
        files: [
          { path: "test/stale-gate-fixture.test.ts", oursDeleted: 1, theirsDeleted: 1 },
          { path: "src/lib/sweep.ts", oursDeleted: 1, theirsDeleted: 1 },
        ],
        oursLog: "8eaeb95 fix stale-gate fixture",
        theirsLog: "f15dff6 fix stale-gate fixture",
        redundantRefix: {
          compared: "bytes",
          verdict: "main-byte-identical",
          comparedPaths: ["test/stale-gate-fixture.test.ts"],
        },
      },
    }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );

  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /redundant re-fix byte comparison did not cover every conflicting path/);
  assert.match(result.reason, /never auto-resolved/);
});

test("the predicate reads byte evidence, not commit subjects or task ids", () => {
  const sameWordsDifferentBytes = dirtyPr({
    prNumber: 4852,
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

// -- The DECLINE causes: why a redundant-refix claim was NOT honoured --------------------------
//
// diff-coverage named sweep.ts:335 and :338 -- two arms of redundantRefixConflictDeclineCause that
// nothing reached. They matter more than their two lines suggest: each turns a silent
// "not classifiable as a pure concurrent addition" into a sentence naming what was wrong with the
// evidence, and a refusal that cannot say why is the shape this whole task exists to remove.
//
// Driven through `conflictRefusalCause`, the exported caller, rather than the private helper --
// the cause has to survive the caller's precedence to be worth anything.

test("W1-T3273: evidence that is not a BYTE comparison declines by name, not as 'not classifiable'", () => {
  const files = [{ path: "src/a.ts", oursDeleted: 0, theirsDeleted: 0 }];
  // `compared` is a literal type because typed callers only ever write "bytes". This evidence
  // arrives from the ledger as JSON, which is exactly why a RUNTIME guard exists for a value the
  // type system says cannot occur -- so the fixture has to cast to reach it.
  const evidence = {
    files,
    oursLog: "",
    theirsLog: "",
    redundantRefix: { compared: "prose", verdict: "main-byte-identical", comparedPaths: ["src/a.ts"] },
  } as unknown as MergeConflictEvidence;

  const cause = conflictRefusalCause(files, { mergeConflictAdmissionEnabled: true }, undefined, evidence);
  assert.match(cause, /not a byte comparison/);
  assert.doesNotMatch(cause, /not classifiable/, "the specific cause must win over the generic fallback");
  assert.equal(isRedundantRefixConflict(evidence), false, "and the admission predicate refuses the same evidence");
});

test("W1-T3273: a byte comparison that misses a conflicting path declines by name -- a partial proof is not a proof", () => {
  const files = [
    { path: "src/a.ts", oursDeleted: 0, theirsDeleted: 0 },
    { path: "src/b.ts", oursDeleted: 0, theirsDeleted: 0 },
  ];
  const evidence: MergeConflictEvidence = {
    files,
    oursLog: "",
    theirsLog: "",
    // src/b.ts conflicts and was never compared. Honouring this would admit a merge on evidence
    // that covered half of it.
    redundantRefix: { compared: "bytes", verdict: "main-byte-identical", comparedPaths: ["src/a.ts"] },
  };

  const cause = conflictRefusalCause(files, { mergeConflictAdmissionEnabled: true }, undefined, evidence);
  assert.match(cause, /did not cover every conflicting path/);
  assert.equal(isRedundantRefixConflict(evidence), false, "and the admission predicate refuses it too");

  // POSITIVE CONTROL: the SAME evidence with every path covered is admitted, so this test fails
  // for the coverage gap it names and not because the fixture is malformed.
  const complete: MergeConflictEvidence = {
    ...evidence,
    redundantRefix: { compared: "bytes", verdict: "main-byte-identical", comparedPaths: ["src/a.ts", "src/b.ts"] },
  };
  assert.equal(isRedundantRefixConflict(complete), true, "covering every path is what makes the claim honourable");
});
