/**
 * test/sweep/a-fix-child-keeps-its-merge-conflict-evidence-across-head-moves.test.ts — W1-T12545.
 *
 * LIVE (PR #18305, 2026-11-11 to 2026-11-13): one fix child was refused because the PR head moved between the
 * sweep's decision and the child's recheck, and one adopted child ran outside merge-conflict mode and stood down
 * on CONFLICT_REPAIR_HANDOFF_REASON. A conflicted PR registers no new check runs, so only a merge-conflict round
 * can move it. A round that reads CONFLICTING now re-enters merge-conflict mode from a trial merge's unmerged
 * index, and a conflicted child takes a moved head that still reads CONFLICTING.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { originWithClone, type GitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";
import {
  CONFLICT_REPAIR_HANDOFF_REASON, buildFixDispatchEnvelope, runFixDispatchChild,
  type FixDispatchChildPorts, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";
import type { Config } from "#src/lib/config.js";
import type { FixProgressInput } from "#src/lib/fix-progress-judge.js";
import type { MergeConflictEvidence } from "#src/lib/merge-state.js";
import type { WorkerResult } from "#src/lib/worker.js";

type Run = Parameters<typeof runFixRung>[0];
type Row = { step: string } & Record<string, unknown>;
const MOUNT = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const RED = ["ci-shard"];
const CI_FAILURES = RED.map((name) => ({ name, logTail: `${name}: failed` }));
const CONFLICT: MergeConflictEvidence = { files: [{ path: "src/shared.ts", oursDeleted: 1, theirsDeleted: 1 }],
  oursLog: "ours", theirsLog: "theirs" };

/** A clone on a branch whose `shared.ts` edit conflicts with origin/main when `conflicting`, else main edits another file. */
function conflictFixture(conflicting: boolean): { clone: GitRepo; head: string } {
  const { clone } = originWithClone(join(mkdtempSync(join(tmpdir(), "rmd-t12545-")), "branch"),
    { seed: { "shared.ts": "export const value = 0;\n" } });
  clone.git("checkout", "-q", "-b", "run-W1-T12545X-1");
  writeFileSync(join(clone.dir, "shared.ts"), "export const value = 1;\n");
  clone.git("commit", "-q", "-am", "ours");
  clone.git("checkout", "-q", "main");
  if (conflicting) writeFileSync(join(clone.dir, "shared.ts"), "export const value = 2;\n");
  else writeFileSync(join(clone.dir, "other.ts"), "export const other = 2;\n");
  clone.git("add", "-A", ".");
  clone.git("commit", "-q", "-m", "theirs");
  clone.git("push", "-q", "origin", "main");
  clone.git("checkout", "-q", "run-W1-T12545X-1");
  return { clone, head: clone.git("rev-parse", "HEAD") };
}

function review(headSha: string): Run["initialReview"] {
  return {
    state: "failure", criteria: [], summary: "sweep-reconstructed: required checks red - ci-log dispatch", headSha,
    testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    reviewerOutcome: "sweep-reconstructed-ci-log",
  };
}

function worker(n: number): WorkerResult {
  return {
    sessionId: `fix-${n}`, costUsd: 0, numTurns: 1, text: "REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(x): repair the round",
    blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false, provider: "claude",
  };
}

/** A shell-less fix rung on a real branch checkout; `mergeable` answers each pre-strike merge-facts read in turn. */
function rung(checkout: ReturnType<typeof conflictFixture>, mergeable: string[], over: Partial<Run> = {}) {
  const state = mkdtempSync(join(tmpdir(), "rmd-t12545-state-"));
  const rows: Row[] = [];
  const judged: FixProgressInput[] = [];
  const counts = { starts: 0, spawns: 0, mergeFacts: 0 };
  const run: Run = {
    taskId: "W1-T12545X", runId: "W1-T12545X-run",
    task: { id: "W1-T12545X", title: "repair the shared value", files: ["shared.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/18305", branch: "run-W1-T12545X-1",
    worktreePath: checkout.clone.dir, initialSessionId: "initial", mount: MOUNT,
    settingsFile: join(state, "settings.json"),
    config: { root: state, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 5, initialReview: review(checkout.head),
    progressDecision: { verdict: "continue", reason: "the sweep admitted this round" },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: checkout.clone.dir, reviewerMount: MOUNT },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      fixProgressJudge: async (input) => {
        judged.push(input);
        return judged.length < 2
          ? { verdict: "continue", reason: "the next round has new evidence" }
          : { verdict: "escalate", loop: "fixture stop", reason: "the fixture ends the rung" };
      },
      spawn: async () => worker(++counts.spawns),
      startShellLessMergeConflictMerge: () => { counts.starts++; return { started: true }; },
      harnessCommitForShellLessWorker: (input) => { input.onCommit?.(checkout.head); return 1; },
      worktreeHasUncommittedChanges: () => false,
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => CI_FAILURES,
      readMergeFacts: () => ({ mergeable: mergeable[counts.mergeFacts++] ?? "MERGEABLE" }),
      runReview: async () => review(checkout.head), fetchPrBody: async () => "REPORT",
      push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(state, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "W1-T12545X", ...extra }),
      say: () => {}, account: (result) => result,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
    ...over,
  };
  return { run, rows, judged, counts };
}

const steps = (rows: Row[], step: string) => rows.filter((row) => row.step === step);
const conflictStandDowns = (rows: Row[]) => steps(rows, "fix.stood_down").filter((row) => row.reason === CONFLICT_REPAIR_HANDOFF_REASON);

describe("a fix round re-enters merge-conflict mode from a trial merge's unmerged index", () => {
  test("W1-T12545 criterion 1: a ci-log round that reads CONFLICTING repairs the conflict instead of standing down", async () => {
    const checkout = conflictFixture(true);
    const f = rung(checkout, ["CONFLICTING"], { ciFailures: CI_FAILURES });
    const outcome = await runFixRung(f.run);
    assert.equal(outcome.outcome, "escalated", outcome.reason);
    assert.equal(conflictStandDowns(f.rows).length, 0);
    const reentered = steps(f.rows, "fix.merge_mode_reentered");
    assert.equal(reentered.length, 1);
    assert.deepEqual(reentered[0]!.conflicted_files, ["shared.ts"]);
    assert.equal(reentered[0]!.head_sha, checkout.head);
    assert.equal(reentered[0]!.site, "rung.strike");
    assert.deepEqual(steps(f.rows, "fix.dispatch").map((row) => row.mode), ["merge-conflict", "ci-log"]);
    assert.equal(f.counts.starts, 1, "the conflict round starts its own merge of main");
    assert.equal(checkout.clone.git("rev-parse", "HEAD"), checkout.head, "the trial merge is aborted");
    assert.equal(checkout.clone.git("status", "--porcelain", "--untracked-files=all"), "");
  });

  test("W1-T12545 criterion 2: a round that left merge-conflict mode re-enters it when main brings the conflict back", async () => {
    const checkout = conflictFixture(true);
    const f = rung(checkout, ["CONFLICTING"], { mergeConflict: CONFLICT });
    const outcome = await runFixRung(f.run);
    assert.equal(outcome.outcome, "escalated", outcome.reason);
    assert.equal(conflictStandDowns(f.rows).length, 0, "a conflict that comes back never ends the rung");
    const order = f.rows.filter((row) => row.step === "fix.merge_mode_cleared" || row.step === "fix.merge_mode_reentered")
      .map((row) => row.step);
    assert.deepEqual(order.slice(0, 2), ["fix.merge_mode_cleared", "fix.merge_mode_reentered"]);
    assert.deepEqual(steps(f.rows, "fix.merge_mode_reentered")[0]!.conflicted_files, ["shared.ts"]);
    assert.deepEqual(steps(f.rows, "fix.dispatch").map((row) => row.mode).slice(0, 2), ["merge-conflict", "merge-conflict"]);
    assert.equal(f.counts.starts, 2);
  });
});

describe("invariant:conflict-round-needs-captured-evidence", () => {
  test("W1-T12545 criterion 3: no unmerged paths, a dirty tree or an unreadable merge stands down exactly as today", async () => {
    const clean = conflictFixture(false);
    const merged = rung(clean, ["CONFLICTING"], { ciFailures: CI_FAILURES });
    const first = await runFixRung(merged.run);
    assert.equal(first.outcome, "stood_down");
    assert.equal(first.reason, CONFLICT_REPAIR_HANDOFF_REASON);
    assert.equal(conflictStandDowns(merged.rows).length, 1);
    assert.equal(steps(merged.rows, "fix.merge_mode_reentered").length, 0);
    assert.equal(merged.counts.spawns, 0);
    assert.equal(clean.clone.git("rev-parse", "HEAD"), clean.head, "a clean trial merge is aborted, never committed");
    assert.equal(clean.clone.git("status", "--porcelain", "--untracked-files=all"), "");

    const dirtyCheckout = conflictFixture(true);
    writeFileSync(join(dirtyCheckout.clone.dir, "stray.txt"), "not the rung's\n");
    const dirty = rung(dirtyCheckout, ["CONFLICTING"], { ciFailures: CI_FAILURES });
    const second = await runFixRung(dirty.run);
    assert.equal(second.reason, CONFLICT_REPAIR_HANDOFF_REASON);
    assert.equal(steps(dirty.rows, "fix.merge_mode_reentered").length, 0, "nothing is inferred from a dirty tree");
    assert.equal(dirtyCheckout.clone.git("rev-parse", "HEAD"), dirtyCheckout.head);

    const unreadable = conflictFixture(true);
    const broken = rung(unreadable, ["CONFLICTING"], { ciFailures: CI_FAILURES });
    broken.run.deps.scopeAmendmentGit = async (_cwd, args) => {
      if (args[0] === "fetch") throw new Error("origin unreachable");
      return unreadable.clone.git(...args);
    };
    const third = await runFixRung(broken.run);
    assert.equal(third.reason, CONFLICT_REPAIR_HANDOFF_REASON);
    assert.equal(steps(broken.rows, "fix.merge_mode_reentered").length, 0);
    assert.match(String(steps(broken.rows, "fix.gate_read_error").find((row) => row.read === "scope_merge_conflict")?.error),
      /origin unreachable/);

    const older = conflictFixture(true);
    const stale = rung(older, ["CONFLICTING"], { ciFailures: CI_FAILURES, initialReview: review("0".repeat(40)) });
    stale.run.deps.runReview = async () => review("0".repeat(40));
    const fourth = await runFixRung(stale.run);
    assert.equal(fourth.reason, CONFLICT_REPAIR_HANDOFF_REASON, "a worktree at another head is never evidence");
    assert.equal(steps(stale.rows, "fix.merge_mode_reentered").length, 0);
  });
});

const FIX_HEAD = "9c0fa1b0aa";
const LIVE_HEAD = "7e57ab1e00";
const fixPr = (): OpenPrView => ({
  prNumber: 18305, prUrl: "https://github.com/acme/remudero/pull/18305", taskId: "W1-T12545X", reviewState: "failure",
  checksState: "none", unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-13T00:00:00Z", headSha: FIX_HEAD,
  headRefName: "run-W1-T12545X-1", autoMergeArmed: false,
});

function child(evidence: Parameters<typeof buildFixDispatchEnvelope>[1], over: Partial<FixDispatchChildPorts> = {}) {
  const envelope = buildFixDispatchEnvelope(fixPr(), evidence, { fixKey: `W1-T12545X@${FIX_HEAD}`, decidedAtMs: 1, planContextDigest: "digest-1" });
  const calls: Array<{ pr: OpenPrView; evidence: Parameters<SweepDeps["dispatchFix"]>[1] }> = [];
  const rows: Row[] = [];
  const reads = { live: 0, mergeFacts: 0, task: 0 };
  const deps: FixDispatchChildPorts = {
    hold: () => undefined,
    readLivePr: async () => { reads.live++; return { state: "OPEN", merged: false, headSha: LIVE_HEAD }; },
    readTask: () => { reads.task++; return { found: true, merged: false, retired: false, contextDigest: "digest-1" }; },
    readMergeFacts: async () => { reads.mergeFacts++; return { mergeable: "CONFLICTING" }; },
    log: (step, extra) => { rows.push({ step, ...extra }); },
    claimFixAdmission: () => ({ admitted: true }),
    dispatcher: () => ({ dispatchFix: async (pr, ev) => { calls.push({ pr, evidence: ev }); } }),
    ...over,
  };
  return { run: () => runFixDispatchChild({ envelope: JSON.parse(JSON.stringify(envelope)) }, deps), calls, rows, reads };
}

describe("a conflicted fix child adopts a moved head that still reads CONFLICTING", () => {
  test("W1-T12545 criterion 4: a conflicted child dispatches at the live head; not conflicting or unreadable refuses", async () => {
    const adopted = child({ unmetCriteria: [], mergeConflict: CONFLICT });
    await adopted.run();
    assert.equal(adopted.calls.length, 1);
    assert.equal(adopted.calls[0]!.pr.headSha, LIVE_HEAD, "the dispatch runs at the live head");
    assert.deepEqual(adopted.calls[0]!.evidence.mergeConflict, CONFLICT, "in merge-conflict mode, with the same evidence");
    assert.deepEqual(steps(adopted.rows, "sweep.fix.child_head_adopted").map(({ step: _s, ...rest }) => rest),
      [{ pr_number: 18305, from_head: FIX_HEAD, to_head: LIVE_HEAD }]);
    assert.equal(adopted.reads.mergeFacts, 1);
    assert.equal(adopted.reads.live, 2, "the live head is read again after the merge facts");

    for (const [name, readMergeFacts] of [
      ["a mergeable head", async () => ({ mergeable: "MERGEABLE" })],
      ["an unknown merge state", async () => ({})],
      ["an unreadable merge-facts read", async () => { throw new Error("gh down"); }],
    ] as const) {
      const h = child({ unmetCriteria: [], mergeConflict: CONFLICT }, { readMergeFacts });
      await assert.rejects(h.run(), /head moved from 9c0fa1b0aa to 7e57ab1e00/, name);
      assert.equal(h.calls.length, 0, name);
      assert.equal(steps(h.rows, "sweep.fix.child_head_adopted").length, 0, name);
      assert.equal(steps(h.rows, "sweep.fix.child_refused").length, 1, name);
    }

    let liveReads = 0;
    const movedAgain = child({ unmetCriteria: [], mergeConflict: CONFLICT }, {
      readLivePr: async () => ({ state: "OPEN", headSha: ++liveReads === 1 ? LIVE_HEAD : "a9a1n00000" }),
    });
    await assert.rejects(movedAgain.run(), /head moved/, "a head that moves again under the read is refused");
    assert.equal(movedAgain.calls.length, 0);
  });

  test("W1-T12545 criterion 5: a child without conflict evidence refuses a moved head; the other checks run at the live head", async () => {
    const plain = child({ unmetCriteria: [], ciFailures: CI_FAILURES });
    await assert.rejects(plain.run(), /head moved from 9c0fa1b0aa to 7e57ab1e00/);
    assert.equal(plain.calls.length, 0);
    assert.equal(plain.reads.mergeFacts, 0, "no merge-facts read for a child without conflict evidence");

    const cases: Array<[string, Partial<FixDispatchChildPorts>, RegExp]> = [
      ["a closed PR", { readLivePr: async () => ({ state: "CLOSED", headSha: LIVE_HEAD }) }, /no longer open \(CLOSED\)/],
      ["a merged PR", { readLivePr: async () => ({ state: "OPEN", merged: true, headSha: LIVE_HEAD }) }, /no longer open \(merged\)/],
      ["a merged task", { readTask: () => ({ found: true, merged: true, retired: false, contextDigest: "digest-1" }) }, /already merged/],
      ["a retired task", { readTask: () => ({ found: true, merged: false, retired: true, contextDigest: "digest-1" }) }, /is retired/],
      ["a changed context", { readTask: () => ({ found: true, merged: false, retired: false, contextDigest: "digest-2" }) },
        /canonical context changed/],
    ];
    for (const [name, over, pattern] of cases) {
      const h = child({ unmetCriteria: [], mergeConflict: CONFLICT }, over);
      await assert.rejects(h.run(), pattern, name);
      assert.equal(h.calls.length, 0, name);
      assert.equal(steps(h.rows, "sweep.fix.child_head_adopted").length, 0, name);
    }

    const unmoved = child({ unmetCriteria: [], mergeConflict: CONFLICT },
      { readLivePr: async () => ({ state: "OPEN", headSha: FIX_HEAD }) });
    await unmoved.run();
    assert.equal(unmoved.calls[0]!.pr.headSha, FIX_HEAD);
    assert.equal(unmoved.reads.mergeFacts, 0, "an unmoved head needs no merge-facts read");
  });
});
