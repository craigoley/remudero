/**
 * W1-T13427: a fix child wrote no row from its launch to its admission grant, a median of 15.6 minutes. Each step it
 * runs before admission now writes a sweep.fix.prepare_timing row, and no decision changes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { disposeSharedPauseRefresh, type SharedPauseGitDeps } from "#src/lib/fleet-control.js";
import { loadPlan } from "#src/lib/plan.js";
import { riskJudgePlanContextDigestFor } from "#src/lib/risk-judge.js";
import { buildFixDispatchEnvelope, runFixDispatchChild, type FixDispatchChildPorts, type OpenPrView } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import type { DetachedWorkSpec } from "#src/lib/run-child.js";
import { runDetachedWork } from "#test/helpers/run-task-test.js";

const TASK = "W1-T13427X";
const HEAD = "1342700000";
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];
const pr: OpenPrView = {
  prNumber: 13427, prUrl: "https://github.com/craigoley/remudero/pull/13427", taskId: TASK, reviewState: "failure", checksState: "green",
  unmetCriteria: UNMET, priorStrikes: 0, lastActivityAt: "2026-11-17T16:00:00Z", headSha: HEAD, headRefName: `run-${TASK}-1794931694000`,
  autoMergeArmed: false,
};
const envelope = buildFixDispatchEnvelope(pr, { unmetCriteria: UNMET }, { fixKey: `${TASK}@${HEAD}`, decidedAtMs: 1, planContextDigest: "digest-1" });
const STAGES = ["child-hold", "child-live-pr", "child-task", "child-admission", "child-effects"];
type Row = { step: string } & Record<string, unknown>;

/** Fake ports on a fake clock: each port moves the clock by a known amount and records its call. */
function child(over: Partial<FixDispatchChildPorts> & { dispatch?: (...args: unknown[]) => unknown } = {}) {
  let clock = 1_000;
  const rows: Row[] = [];
  const calls: unknown[][] = [];
  let held = 0;
  let released = 0;
  const live = { state: "OPEN", merged: false, headSha: HEAD };
  const ports: FixDispatchChildPorts = {
    stageClock: () => clock,
    log: (step, extra) => { rows.push({ step, ...extra }); },
    hold: () => { calls.push(["hold"]); clock += 5; return undefined; },
    readLivePr: async (url) => { calls.push(["readLivePr", url]); clock += 40; return live; },
    readTask: (taskId) => { calls.push(["readTask", taskId]); clock += 300; return { found: true, merged: false, retired: false, contextDigest: "digest-1" }; },
    claimFixAdmission: (p) => { calls.push(["claimFixAdmission", p]); clock += 7; held++; return { admitted: true, release: () => { held--; released++; } }; },
    dispatcher: () => {
      calls.push(["dispatcher"]);
      clock += 11;
      return { dispatchFix: async (p, evidence, onPhase, control) => {
        calls.push(["dispatchFix", p, evidence, control?.admissionSinceMs]);
        if (over.dispatch) return over.dispatch(p, evidence, onPhase, control) as never;
        onPhase?.("admission");
        onPhase?.("worker");
      } };
    },
    ...over,
  };
  const wire = () => ({ envelope: JSON.parse(JSON.stringify(envelope)) as unknown });
  return { ports, rows, calls, wire, held: () => held, released: () => released };
}

const timing = (rows: Row[]) => rows.filter((r) => r.step === "sweep.fix.prepare_timing");

test("W1-T13427 criterion 1: the fix child writes one timing row per step before its admission", async () => {
  const c = child();
  await runFixDispatchChild(c.wire(), c.ports);
  assert.deepEqual(timing(c.rows).map((r) => [r.stage, r.elapsed_ms, r.pr_number, r.head_sha]), [
    ["child-hold", 5, 13427, HEAD], ["child-live-pr", 40, 13427, HEAD], ["child-task", 300, 13427, HEAD],
    ["child-admission", 7, 13427, HEAD], ["child-effects", 11, 13427, HEAD],
  ]);
  const firstPhase = c.rows.findIndex((r) => r.step === "sweep.fix.child_phase");
  assert.ok(firstPhase > 0, "the child reached its phase rows");
  const lastTiming = c.rows.findLastIndex((r) => r.step === "sweep.fix.prepare_timing");
  assert.ok(lastTiming < firstPhase, "all five rows come before the first sweep.fix.child_phase row");
  for (const row of timing(c.rows)) {
    assert.deepEqual(Object.keys(row).sort(), ["elapsed_ms", "head_sha", "pr_number", "stage", "step"], "numbers and the stage name only");
  }
});

/** A fix-dispatch run child in a temporary directory, with a fixture plan, config and ledger. */
function detached() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13427-child-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, JSON.stringify([{ id: TASK, title: "timed fix child", repo: "remudero", type: "implement",
    verify: "auto", depends_on: [], status: "queued", files: ["src/lib/sweep.ts"], design: "a timed child" }]));
  const timedEnvelope = buildFixDispatchEnvelope(pr, { unmetCriteria: UNMET }, {
    fixKey: `${TASK}@${HEAD}`, decidedAtMs: 1, planContextDigest: riskJudgePlanContextDigestFor(loadPlan(planPath))({ taskId: TASK }),
  });
  const work: DetachedWorkSpec = { kind: "fix-dispatch", prNumber: pr.prNumber, headSha: HEAD, inputs: { envelope: timedEnvelope } };
  const rows: Row[] = [];
  let boardUnreadable = false;
  const git: SharedPauseGitDeps = {
    run: () => assert.fail("no synchronous network read"),
    runAsync: async () => ({ status: 0, stdout: "" }),
    mintAnchor: () => assert.fail("a read never writes a PAUSE anchor"),
  };
  const ports = {
    config: { root, claudeBin: "/bin/true" } as Config, planPath, sharedPauseGit: git,
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
    github: fakeGitHub({ findMergedByTrailer: () => null, listMergedHeadBranches: () => [], listOpenHeadBranches: () => [],
      readFailed: () => boardUnreadable }),
    planSnapshot: () => ({ plan: loadPlan(planPath), staleDispatch: false }),
    readPr: async () => ({ state: "OPEN", mergedAt: null, headRefOid: HEAD }),
    claimFixAdmission: () => ({ admitted: true as const }),
    dispatcher: () => ({ dispatchFix: async () => {} }),
  };
  const run = () => runDetachedWork(work, { taskId: TASK, runId: "t13427-child" }, ports);
  return { rows, run, unreadable: () => { boardUnreadable = true; },
    cleanup: () => { disposeSharedPauseRefresh(git); rmSync(root, { recursive: true, force: true }); } };
}

test("W1-T13427 criterion 2: the run child also times the shared pause, the plan sync, the projection and the digest", async () => {
  const d = detached();
  try {
    await d.run();
    const byStage = new Map(timing(d.rows).map((r) => [String(r.stage), r]));
    for (const stage of ["child-shared-pause", "child-plan-sync", "child-plan-projection", "child-context-digest", ...STAGES]) {
      const row = byStage.get(stage);
      assert.ok(row, `${stage} has a timing row`);
      assert.equal(typeof row.elapsed_ms, "number");
      assert.ok((row.elapsed_ms as number) >= 0);
      assert.equal(row.pr_number, pr.prNumber);
      assert.equal(row.head_sha, HEAD);
    }
    assert.equal(timing(d.rows).filter((r) => r.stage === "child-plan-sync").length, 1, "the memoised plan read is not timed again");
    const inner = ["child-plan-sync", "child-plan-projection", "child-context-digest"]
      .reduce((sum, stage) => sum + (byStage.get(stage)!.elapsed_ms as number), 0);
    assert.ok(inner <= (byStage.get("child-task")!.elapsed_ms as number), "the task read holds its three parts");
  } finally {
    d.cleanup();
  }
});

test("W1-T13427 criterion 3: a refused child still writes the rows of the steps it finished", async () => {
  const cases: Array<[string, Partial<FixDispatchChildPorts>, string, string[]]> = [
    ["the head moved", { readLivePr: async () => ({ state: "OPEN", merged: false, headSha: "f00dfacecc" }) },
      `the PR head moved from ${HEAD} to f00dfacecc`, ["child-hold", "child-live-pr"]],
    ["the task is merged", { readTask: () => ({ found: true, merged: true, retired: false }) },
      `task ${TASK} is already merged`, ["child-hold", "child-live-pr", "child-task"]],
    ["the merge projection is unreadable", { readTask: () => { throw new Error(`task ${TASK}'s merge projection is unreadable`); } },
      `the recheck could not read its evidence (task ${TASK}'s merge projection is unreadable)`, ["child-hold", "child-live-pr", "child-task"]],
  ];
  for (const [name, over, reason, stages] of cases) {
    const c = child(over);
    await assert.rejects(runFixDispatchChild(c.wire(), c.ports), { message: `fix dispatch refused: ${reason}` }, name);
    const refusedAt = c.rows.findIndex((r) => r.step === "sweep.fix.child_refused");
    assert.equal(c.rows[refusedAt]!.reason, reason, `${name}: the refusal reason is unchanged`);
    assert.deepEqual(c.rows.slice(0, refusedAt).map((r) => r.stage), stages, `${name}: each finished step is timed before the refusal`);
    assert.equal(timing(c.rows).length, stages.length, `${name}: no later step runs`);
  }
});

test("W1-T13427 criterion 4: timing changes no call, no argument and no release", async () => {
  const c = child();
  await runFixDispatchChild(c.wire(), c.ports);
  assert.deepEqual(c.calls, [
    ["hold"], ["readLivePr", pr.prUrl], ["readTask", TASK], ["hold"], ["claimFixAdmission", envelope.pr], ["dispatcher"], ["hold"],
    ["dispatchFix", envelope.pr, { unmetCriteria: UNMET }, undefined],
  ]);
  assert.equal(c.released(), 1, "the success path releases the grant");

  const afterClaim: Array<[string, Partial<FixDispatchChildPorts> & { dispatch?: (...args: unknown[]) => unknown }, RegExp]> = [
    ["a reconstruction that throws", { dispatcher: () => { throw new Error("no credentials"); } }, /could not be reconstructed \(no credentials\)/],
    ["a dispatch that throws", { dispatch: () => { throw new Error("dispatch failed"); } }, /dispatch failed/],
    ["a declined claim", { dispatch: () => ({ claimDeclined: true, ownerRecoveryReason: "owner_remove_failed" }) }, /declined at the checkout claim/],
  ];
  for (const [name, over, pattern] of afterClaim) {
    const r = child(over);
    await assert.rejects(runFixDispatchChild(r.wire(), r.ports), pattern, name);
    assert.equal(r.held(), 0, `${name}: the grant is released`);
    assert.equal(r.released(), 1, `${name}: released once`);
  }
  let holds = 0;
  const late = child({ hold: () => (++holds === 3 ? "PAUSE: late" : undefined) });
  await assert.rejects(runFixDispatchChild(late.wire(), late.ports), /worker admission is held: PAUSE: late/);
  assert.equal(holds, 3, "the hold is read three times, as before");
  assert.equal(late.released(), 1, "a hold after the claim releases the grant");
});
