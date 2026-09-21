import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBehindMainByPr,
  classifyUpdateBranchFailure,
  DISTANCE_REFRESH_ROTATION_MS,
  ghUpdateBranchArgv,
} from "../src/run-task.js";
import {
  DEFAULT_SWEEP_POLICY,
  openPrsBehindMain,
  runSweep,
  selectUpdateBranchTarget,
  type ArmedStalledPr,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";

// EVERY threshold comparison in this suite reads THIS constant, never the wall clock: `deps()`
// below injects `now: () => NOW`, `selectUpdateBranchTarget` takes it as an explicit argument, and
// `buildBehindMainByPr` has no clock at all. So the `lastActivityAt` stamps below are aged against
// a frozen NOW and their age is fixed forever -- which is why each carries an expiring-fixture
// exemption. MEASURED, not asserted: with the REAL clock forced to 2026-10-01 (past the census's
// predicted 2026-09-23 red date) this file still runs 8/8, and a probe asserting the unforced date
// FAILS under the same harness, so the forcing provably reaches the test child process.
const NOW = Date.parse("2026-09-09T12:00:00Z");
const RECENT = "2026-09-09T11:00:00Z";
const POLICY: SweepPolicy = {
  ...DEFAULT_SWEEP_POLICY,
  reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10,
};

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4800,
    prUrl: "https://github.com/craigoley/remudero/pull/4800",
    taskId: "W1-T4800",
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "head4800",
    autoMergeArmed: false,
    mergeState: "behind",
    ...over,
  };
}

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/tmp/rmd-w1-t3277-ledger.ndjson",
    runId: "SWEEP-W1-T3277",
    now: () => NOW,
    readLedger: () => [],
    appendLine: () => {},
    ...over,
  };
}

test("an unarmed review-waiting PR behind main beyond the threshold is refreshed", async () => {
  const target = pr({ prNumber: 4801, headSha: "head4801", autoMergeArmed: false });
  const behindMainByPr = new Map([[4801, 11]]);

  assert.deepEqual(openPrsBehindMain([target], behindMainByPr, POLICY), [
    {
      prNumber: 4801,
      prUrl: "https://github.com/craigoley/remudero/pull/4800",
      taskId: "W1-T4800",
      headSha: "head4801",
      behindBy: 11,
      updateReason: "distance",
    },
  ]);
  assert.equal(selectUpdateBranchTarget([target], NOW, new Set(), new Map(), new Set(), behindMainByPr, POLICY)?.prNumber, 4801);

  const calls: ArmedStalledPr[] = [];
  await runSweep(
    [target],
    deps({
      behindMainByPr,
      updateBranch: (candidate) => {
        calls.push(candidate);
        return "updated";
      },
    }),
    POLICY,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prNumber, 4801);
  assert.equal(calls[0].behindBy, 11);
  assert.equal(calls[0].updateReason, "distance");
});

test("a conflicting distance refresh leaves the PR view byte-for-byte unchanged", async () => {
  const target = pr({ prNumber: 4802, headSha: "head4802" });
  const before = JSON.stringify(target);
  const rows: Array<Record<string, unknown>> = [];

  await runSweep(
    [target],
    deps({
      behindMainByPr: new Map([[4802, 51]]),
      appendLine: (_path, row) => rows.push(row),
      updateBranch: () => "conflict",
    }),
    POLICY,
  );

  assert.equal(JSON.stringify(target), before, "runSweep never mutates or partially rewrites the PR state it was handed");
  assert.equal(rows.filter((row) => row.step === "sweep.update_branch.conflict").length, 1);
  assert.equal(rows.filter((row) => row.step === "sweep.update_branch.updated").length, 0);
});

test("a PR at or inside the threshold is not selected", async () => {
  const target = pr({ prNumber: 4803 });
  const behindMainByPr = new Map([[4803, 10]]);
  const calls: ArmedStalledPr[] = [];

  assert.deepEqual(openPrsBehindMain([target], behindMainByPr, POLICY), []);
  assert.equal(selectUpdateBranchTarget([target], NOW, new Set(), new Map(), new Set(), behindMainByPr, POLICY), undefined);

  await runSweep(
    [target],
    deps({
      behindMainByPr,
      updateBranch: (candidate) => {
        calls.push(candidate);
        return "updated";
      },
    }),
    POLICY,
  );

  assert.deepEqual(calls, []);
});

test("distance refresh is still bounded to one oldest PR per pass", async () => {
  // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
  const older = pr({ prNumber: 4804, headSha: "older", lastActivityAt: "2026-09-09T08:00:00Z" });
  // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
  const younger = pr({ prNumber: 4805, headSha: "younger", lastActivityAt: "2026-09-09T10:00:00Z" });
  const behindMainByPr = new Map([
    [4804, 12],
    [4805, 50],
  ]);
  const calls: ArmedStalledPr[] = [];

  assert.equal(selectUpdateBranchTarget([younger, older], NOW, new Set(), new Map(), new Set(), behindMainByPr, POLICY)?.prNumber, 4804);

  await runSweep(
    [younger, older],
    deps({
      behindMainByPr,
      updateBranch: (candidate) => {
        calls.push(candidate);
        return "updated";
      },
    }),
    POLICY,
  );

  assert.deepEqual(calls.map((candidate) => candidate.prNumber), [4804]);
});

test("W1-T3920 criterion 1: stale-blocked green auto-merge PR refreshes below the ordinary threshold", async () => {
  const target = pr({
    prNumber: 4830,
    prUrl: "https://github.com/craigoley/remudero/pull/4830",
    headSha: "stale-blocked-head",
    autoMergeArmed: true,
    mergeState: "clean", // the REST hydrator normalizes raw `blocked` to non-conflict `clean`
    mergeableState: "blocked",
    checksState: "green",
    reviewState: "success",
  });
  const behindMainByPr = new Map([[4830, 1]]);
  const candidates = openPrsBehindMain([target], behindMainByPr, POLICY);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.updateReason, "stale-blocked");
  assert.equal(selectUpdateBranchTarget([target], NOW, new Set(), new Map(), new Set(), behindMainByPr, POLICY)?.prNumber, 4830);

  const calls: ArmedStalledPr[] = [];
  await runSweep(
    [target],
    deps({
      behindMainByPr,
      updateBranch: (candidate) => {
        calls.push(candidate);
        return "updated";
      },
    }),
    POLICY,
  );
  assert.equal(calls[0]?.prNumber, 4830);
});

test("W1-T3920 criterion 2: stale-blocked PR with non-green checks stays untouched", () => {
  const pending = pr({
    prNumber: 4831,
    autoMergeArmed: true,
    mergeState: "clean",
    mergeableState: "blocked",
    checksState: "pending",
    reviewState: "success",
  });
  const red = pr({
    prNumber: 4832,
    autoMergeArmed: true,
    mergeState: "clean",
    mergeableState: "blocked",
    checksState: "red",
    reviewState: "success",
  });
  const behind = new Map([[4831, 1], [4832, 1]]);
  assert.deepEqual(openPrsBehindMain([pending, red], behind, POLICY), []);
});

test("W1-T3920 criterion 3: stale-blocked refresh requires an armed non-conflicting PR", () => {
  const unarmed = pr({
    prNumber: 4833,
    autoMergeArmed: false,
    mergeState: "clean",
    mergeableState: "blocked",
    checksState: "green",
    reviewState: "success",
  });
  const conflicting = pr({
    prNumber: 4834,
    autoMergeArmed: true,
    mergeState: "dirty",
    mergeable: false,
    mergeableState: "blocked",
    checksState: "green",
    reviewState: "success",
  });
  const behind = new Map([[4833, 1], [4834, 1]]);
  assert.deepEqual(openPrsBehindMain([unarmed, conflicting], behind, POLICY), []);
});

test("W1-T3920 criterion 4: ordinary distance refresh retains its threshold and bound", () => {
  const inside = pr({ prNumber: 4835, headSha: "inside" });
  const older = pr({ prNumber: 4836, headSha: "older", lastActivityAt: "2026-09-09T08:00:00Z" });
  const younger = pr({ prNumber: 4837, headSha: "younger", lastActivityAt: "2026-09-09T10:00:00Z" });
  const distances = new Map([[4835, 10], [4836, 11], [4837, 12]]);
  assert.deepEqual(openPrsBehindMain([inside], distances, POLICY), []);
  assert.equal(selectUpdateBranchTarget([younger, older], NOW, new Set(), new Map(), new Set(), distances, POLICY)?.prNumber, 4836);
});

test("W1-T3920 criterion 5: stale-blocked selection carries an explicit update reason", async () => {
  const target = pr({
    prNumber: 4838,
    autoMergeArmed: true,
    mergeState: "clean",
    mergeableState: "blocked",
    checksState: "green",
    reviewState: "success",
  });
  const rows: Array<Record<string, unknown>> = [];
  await runSweep(
    [target],
    deps({
      behindMainByPr: new Map([[4838, 2]]),
      appendLine: (_path, row) => rows.push(row),
      updateBranch: () => "updated",
    }),
    POLICY,
  );
  assert.equal(rows.find((row) => row.step === "sweep.update_branch.attempted")?.update_reason, "stale-blocked");
  assert.equal(rows.find((row) => row.step === "sweep.update_branch.updated")?.update_reason, "stale-blocked");
});

test("the update-branch REST call carries an expected head sha lease", () => {
  const argv = ghUpdateBranchArgv("craigoley", "remudero", 4806, "head-before-refresh");

  assert.deepEqual(argv.slice(-2), ["-f", "expected_head_sha=head-before-refresh"]);
  assert.equal(
    classifyUpdateBranchFailure("HTTP 422: expected_head_sha does not match the pull request head"),
    "conflict",
  );
});

test("distance refresh ledger rows name the commit distance for updated and declined outcomes", async () => {
  const updated = pr({ prNumber: 4807, headSha: "updated-head" });
  const conflicted = pr({ prNumber: 4808, headSha: "conflicted-head" });
  const errored = pr({ prNumber: 4811, headSha: "errored-head" });
  const updatedRows: Array<Record<string, unknown>> = [];
  const conflictedRows: Array<Record<string, unknown>> = [];
  const erroredRows: Array<Record<string, unknown>> = [];

  await runSweep(
    [updated],
    deps({
      behindMainByPr: new Map([[4807, 12]]),
      appendLine: (_path, row) => updatedRows.push(row),
      updateBranch: () => "updated",
    }),
    POLICY,
  );
  await runSweep(
    [conflicted],
    deps({
      behindMainByPr: new Map([[4808, 51]]),
      appendLine: (_path, row) => conflictedRows.push(row),
      updateBranch: () => "conflict",
    }),
    POLICY,
  );
  await runSweep(
    [errored],
    deps({
      behindMainByPr: new Map([[4811, 52]]),
      appendLine: (_path, row) => erroredRows.push(row),
      updateBranch: () => {
        throw new Error("branch update unavailable");
      },
    }),
    POLICY,
  );

  const updatedOutcome = updatedRows.find((row) => row.step === "sweep.update_branch.updated");
  const declinedOutcome = conflictedRows.find((row) => row.step === "sweep.update_branch.conflict");
  const errorOutcome = erroredRows.find((row) => row.step === "sweep.update_branch.error");
  assert.equal(updatedOutcome?.behind_by, 12);
  assert.equal(updatedOutcome?.update_reason, "distance");
  assert.equal(declinedOutcome?.behind_by, 51);
  assert.equal(declinedOutcome?.update_reason, "distance");
  assert.equal(errorOutcome?.behind_by, 52);
  assert.equal(errorOutcome?.update_reason, "distance");
  assert.equal(errorOutcome?.error, "branch update unavailable");
});

test("the production distance reader compares a normalized-clean PR, rather than mistaking mergeability for graph freshness", () => {
  const subject = pr({ prNumber: 4809, headSha: "head4809", mergeState: "clean" });
  const rawBehind = pr({ prNumber: 4810, headSha: "head4810", mergeState: "behind" });
  const dirty = pr({ prNumber: 4811, headSha: "head4811", mergeState: "dirty" });
  const draft = pr({ prNumber: 4812, headSha: "head4812", isDraft: true });
  const calls: string[] = [];
  const distances = buildBehindMainByPr("craigoley", "remudero", [subject, rawBehind, dirty, draft], (args) => {
    calls.push(args[1]);
    return { ahead_by: 14 };
  }, 0);

  assert.deepEqual([...distances], [[4809, 14], [4810, 14]]);
  assert.deepEqual(calls, [
    "repos/craigoley/remudero/compare/head4809...main",
    "repos/craigoley/remudero/compare/head4810...main",
  ]);
});

test("the production distance reader rotates its bounded direct-compare budget instead of starving later clean PRs", () => {
  const candidates = [
    // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
    pr({ prNumber: 4820, headSha: "head4820", lastActivityAt: "2026-09-09T08:00:00Z" }),
    // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
    pr({ prNumber: 4821, headSha: "head4821", lastActivityAt: "2026-09-09T09:00:00Z" }),
    // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
    pr({ prNumber: 4822, headSha: "head4822", lastActivityAt: "2026-09-09T10:00:00Z" }),
    // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
    pr({ prNumber: 4823, headSha: "head4823", lastActivityAt: "2026-09-09T11:00:00Z" }),
  ];
  const firstCalls: string[] = [];
  const secondCalls: string[] = [];
  buildBehindMainByPr("craigoley", "remudero", candidates, (args) => {
    firstCalls.push(args[1]);
    return { ahead_by: 14 };
  }, 0);
  buildBehindMainByPr("craigoley", "remudero", candidates, (args) => {
    secondCalls.push(args[1]);
    return { ahead_by: 14 };
  }, DISTANCE_REFRESH_ROTATION_MS);

  assert.deepEqual(firstCalls, [
    "repos/craigoley/remudero/compare/head4820...main",
    "repos/craigoley/remudero/compare/head4821...main",
    "repos/craigoley/remudero/compare/head4822...main",
  ]);
  assert.deepEqual(secondCalls, [
    "repos/craigoley/remudero/compare/head4823...main",
    "repos/craigoley/remudero/compare/head4820...main",
    "repos/craigoley/remudero/compare/head4821...main",
  ]);
});
