import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { stackPrerequisiteFromRest, type StackPrerequisiteCheck } from "../src/lib/arm-auto-merge.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  stackParentHoldReason,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";

const CONFLICT_POLICY = { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: true };
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const REPO_URL = "https://github.com/craigoley/remudero/pull";

type PullRow = { body?: string; state?: string; merged_at?: string | null };

function redChild(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `${REPO_URL}/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 15 * 60 * 1000).toISOString(),
    headSha: `head-${prNumber}`,
    autoMergeArmed: false,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    ...over,
  };
}

function conflictedChild(prNumber: number): OpenPrView {
  return redChild(prNumber, {
    reviewState: "success",
    checksState: "green",
    ciFailures: undefined,
    headRefName: `run-W1-T${prNumber}-1790000000000`,
    mergeState: "dirty",
    mergeable: false,
    mergeableState: "dirty",
    mergeConflict: {
      files: [{ path: "src/lib/machine-filing-judge.ts", oursDeleted: 0, theirsDeleted: 0 }],
      oursLog: "abc1234 edit shardRelPath",
      theirsLog: "def5678 edit shardRelPath",
    },
  });
}

function restFor(child: number, parents: Record<number, PullRow>, body = `Stacked on #${Object.keys(parents).join(" → #")}`) {
  return (args: string[]): PullRow => {
    const n = Number(args[1].split("/").pop());
    return n === child ? { body } : parents[n];
  };
}

function harness(overrides: Partial<SweepDeps> = {}) {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr, evidence) => {
      fixed.push({ pr, evidence });
    },
    escalate: () => {},
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-w1-t4903-")), "ledger.ndjson"),
    runId: "SWEEP-W1-T4903",
    now: () => NOW,
    ...overrides,
  };
  const disposed = () => readLedgerLines(deps.ledgerPath).filter((line) => line.step === "sweep.disposed");
  return { deps, fixed, disposed };
}

test("a stacked child fix round is held while a declared parent is open", async () => {
  const child = redChild(4931);
  const fetch = restFor(4931, { 4930: { state: "open", merged_at: null } });
  const { deps, fixed, disposed } = harness({ stackPrerequisite: (p) => stackPrerequisiteFromRest(p.prUrl, fetch) });

  await runSweep([child], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(fixed.length, 0, "no fix worker is dispatched while the parent is open");
  const row = disposed()[0];
  assert.equal(row.acted, false);
  assert.match(String(row.stand_down_reason), /#4930/);
  assert.deepEqual(row.stack_parent_hold, [4930]);
  assert.equal(
    readLedgerLines(deps.ledgerPath).some((line) => line.step === "fix.dispatch"),
    false,
    "no strike is spent",
  );
});

test("a stacked child fix round proceeds once every declared parent is merged", async () => {
  const child = redChild(4932);
  const parents: Record<number, PullRow> = { 4931: { state: "open", merged_at: null } };
  const fetch = restFor(4932, parents);
  const { deps, fixed, disposed } = harness({ stackPrerequisite: (p) => stackPrerequisiteFromRest(p.prUrl, fetch) });

  await runSweep([child], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(fixed.length, 0, "held first, so the claim must not leak into the next pass");

  parents[4931] = { state: "closed", merged_at: "2026-09-30T11:00:00Z" };
  await runSweep([child], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(fixed.length, 1, "the same child dispatches once its parent reads merged");
  assert.equal(disposed()[1].stack_parent_hold, undefined);
});

test("a stacked child is not held by a parent closed without merging", async () => {
  const child = redChild(4933);
  const fetch = restFor(4933, { 4932: { state: "closed", merged_at: null } });
  const check = stackPrerequisiteFromRest(child.prUrl, fetch);
  assert.equal(check.state, "blocked", "the arm gate still treats a closed-unmerged parent as pending");
  assert.deepEqual(check.pendingParentNumbers, [4932]);
  assert.deepEqual(check.openParentNumbers, []);
  assert.equal(stackParentHoldReason(check), undefined);

  const { deps, fixed } = harness({ stackPrerequisite: (p) => stackPrerequisiteFromRest(p.prUrl, fetch) });
  await runSweep([child], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(fixed.length, 1, "an orphaned child is fixed, never stranded");
});

test("an unstacked pull request and an unreadable stack read dispatch as before", async () => {
  const unstacked = redChild(4934);
  const none = harness({ stackPrerequisite: (p) => stackPrerequisiteFromRest(p.prUrl, () => ({ body: "an ordinary PR" })) });
  await runSweep([unstacked], none.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(none.fixed.length, 1);
  assert.equal(none.disposed()[0].stack_parent_hold, undefined);
  assert.equal(none.disposed()[0].stack_parent_read, undefined);

  const threw = harness({
    stackPrerequisite: () => {
      throw new Error("REST unavailable");
    },
  });
  await runSweep([redChild(4935)], threw.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(threw.fixed.length, 1, "a throwing read does not hold and does not take the pass down");
  assert.equal(threw.disposed()[0].stack_parent_read, "unreadable");

  const unreadable = harness({
    stackPrerequisite: (): StackPrerequisiteCheck => ({ state: "unreadable", parentNumbers: [], detail: "no body" }),
  });
  await runSweep([redChild(4936)], unreadable.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(unreadable.fixed.length, 1);
  assert.equal(unreadable.disposed()[0].stack_parent_read, "unreadable");

  assert.equal(stackParentHoldReason({ state: "ready", parentNumbers: [1] }), undefined);
  assert.equal(stackParentHoldReason({ state: "unstacked", parentNumbers: [] }), undefined);
  assert.equal(stackParentHoldReason({ state: "blocked", parentNumbers: [1] }), undefined);
});

test("a stacked child conflict round is held while a declared parent is open", async () => {
  const child = conflictedChild(4937);
  const parents: Record<number, PullRow> = { 4936: { state: "open", merged_at: null } };
  const fetch = restFor(4937, parents);
  const { deps, fixed, disposed } = harness({ stackPrerequisite: (p) => stackPrerequisiteFromRest(p.prUrl, fetch) });

  await runSweep([child], deps, CONFLICT_POLICY);

  assert.equal(disposed()[0].disposition, "conflicted");
  assert.equal(fixed.length, 0, "no merge-conflict worker while the parent is open");
  assert.equal(disposed()[0].acted, false);
  assert.match(String(disposed()[0].stand_down_reason), /#4936/);
  assert.deepEqual(disposed()[0].stack_parent_hold, [4936]);

  parents[4936] = { state: "closed", merged_at: "2026-09-30T11:00:00Z" };
  await runSweep([child], deps, CONFLICT_POLICY);
  assert.equal(fixed.length, 1, "the conflict round proceeds once the parent merged");
});
