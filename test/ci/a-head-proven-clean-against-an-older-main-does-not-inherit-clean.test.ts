import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { applyMergeProbeEvidence, MERGE_PROBE_STEP, probeOpenPrMerges } from "#src/lib/merge-probe.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY, lastKnownMergeStateFromLedger, runSweep, withInheritedMergeState, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// #15638 (W1-T9795) as the 2026-11-03 conflict findings read it. GitHub last read head 35fa075 clean at
// 21:14:47.999Z, while main was 116c844. Every pass from 21:22Z to 00:20Z left mergeability unread and
// inherited "clean". `git merge-tree` of that head is clean against 116c844 and conflicts on src/run-task.ts
// against b95cd21 (merged 23:12:24Z) and every later main, such as ab39118, main when the rung read REST dirty
// at 00:02:16Z and stood down for the sweep, which then disposed refused-escalate on its inherited clean.
const HEAD = "35fa0751dd0f3fd661607d5c61461dc569611d64";
const MAIN_AT_CLEAN = "116c844f7230149823baa29a9cf3b5efa5815b21";
const MAIN_AT_STAND_DOWN = "ab391187757c4a93110a7d8438953c7e61740b4d";
const PR_URL = "https://github.com/craigoley/remudero/pull/15638";

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 15638, prUrl: PR_URL, taskId: "W1-T9795", headRefName: "run-W1-T9795-1793321601764", headSha: HEAD,
    reviewState: "none", checksState: "none", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: "2026-11-02T21:14:41.373Z", ...over,
  };
}

const readClean = (extra: Record<string, unknown> = {}) => ({
  step: "sweep.disposed", pr_number: 15638, pr_url: PR_URL, task_id: "W1-T9795", head_sha: HEAD,
  disposition: "post-review", merge_state: "clean", ts: "2026-11-02T21:14:47.999Z", ...extra,
});
const unread = () => pr({ mergeState: undefined, mergeable: undefined, mergeableState: undefined });

test("W1-T11166: a remembered clean is inherited only while main is the main it was read against", () => {
  const rows = [readClean({ merge_main_sha: MAIN_AT_CLEAN })];
  assert.equal(lastKnownMergeStateFromLedger(rows, 15638, HEAD)?.mainSha, MAIN_AT_CLEAN);

  const moved = withInheritedMergeState(unread(), rows, MAIN_AT_STAND_DOWN);
  assert.equal(moved.pr.mergeState, undefined, "main moved to ab39118, which conflicts with this head: clean is not inherited");
  assert.equal(moved.inherited, undefined);
  assert.equal(moved.refused?.state, "clean", "the refused observation is named so the reason can say so");
  assert.equal(moved.refused?.mainSha, MAIN_AT_CLEAN);

  const same = withInheritedMergeState(unread(), rows, MAIN_AT_CLEAN);
  assert.equal(same.pr.mergeState, "clean", "the same main: W1-T4470's inheritance still holds");
  assert.equal(same.refused, undefined);

  const legacy = withInheritedMergeState(unread(), [readClean()], MAIN_AT_STAND_DOWN);
  assert.equal(legacy.pr.mergeState, undefined, "a row with no recorded main proves nothing about the current main (#15602's 10-31 seed row)");
  assert.equal(legacy.refused?.state, "clean");

  const noMainRead = withInheritedMergeState(unread(), [readClean()], undefined);
  assert.equal(noMainRead.pr.mergeState, "clean", "with no main read, W1-T4470's behaviour is unchanged");

  const dirty = [readClean({ merge_state: "dirty", merge_main_sha: MAIN_AT_CLEAN,
    conflict_files: [{ path: "src/run-task.ts", ours_deleted: 4, theirs_deleted: 22 }] })];
  const dirtyMoved = withInheritedMergeState(unread(), dirty, MAIN_AT_STAND_DOWN);
  assert.equal(dirtyMoved.pr.mergeState, "dirty", "main moving forward does not resolve a conflict");
  assert.deepEqual(dirtyMoved.pr.mergeConflict?.files, [{ path: "src/run-task.ts", oursDeleted: 4, theirsDeleted: 22 }]);
  assert.equal(dirtyMoved.refused, undefined);

  const behind = withInheritedMergeState(unread(), [readClean({ merge_state: "behind", merge_main_sha: MAIN_AT_CLEAN })], MAIN_AT_STAND_DOWN);
  assert.equal(behind.pr.mergeState, undefined, "behind is a fact about one main too");
});

function sweepDeps(ledgerPath: string, mainTip: string | undefined, now: number): SweepDeps {
  return {
    ledgerPath, runId: "SWEEP-W1-T11166", now: () => now, readMainTip: () => mainTip,
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, repushAbsent: async () => "repushed",
  };
}

test("W1-T11166: the sweep records the main a mergeability was read against and refuses it once main moves", async (t) => {
  const repo = gitRepo();
  t.after(() => repo.cleanup());
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const first = Date.parse("2026-11-02T21:14:47.999Z");
  await runSweep([pr({ mergeState: "clean", mergeable: true, mergeableState: "clean" })],
    sweepDeps(ledgerPath, MAIN_AT_CLEAN, first), DEFAULT_SWEEP_POLICY);
  const observed = readLedgerLines(ledgerPath).findLast(r => r.step === "sweep.disposed");
  assert.equal(observed?.merge_state, "clean");
  assert.equal(observed?.merge_main_sha, MAIN_AT_CLEAN, "the observation names the main it was read against");

  const later = Date.parse("2026-11-02T23:59:23.156Z");
  await runSweep([unread()], sweepDeps(ledgerPath, MAIN_AT_STAND_DOWN, later), DEFAULT_SWEEP_POLICY);
  const refused = readLedgerLines(ledgerPath).findLast(r => r.step === "sweep.disposed");
  assert.equal(refused?.merge_state, undefined, "no inherited clean is ledgered forward");
  assert.equal(refused?.merge_main_sha, undefined);
  assert.doesNotMatch(String(refused?.reason), /inherited last known "clean"/);
  assert.match(String(refused?.reason), /read against main 116c844/);
  assert.match(String(refused?.reason), /main is now ab39118/);
});

for (const state of ["clean", "behind"] as const) {
  for (const recordedMain of [MAIN_AT_CLEAN, undefined]) {
    test(`W1-T11166: a red plan filing retains its refused ${state} observation from ${recordedMain ?? "unrecorded main"}`, async (t) => {
      const repo = gitRepo();
      t.after(() => repo.cleanup());
      const filing = pr({
        taskId: undefined, isPlanFiling: true, planFilingSource: "github-files",
        reviewState: "success", checksState: "red",
        ciFailures: [{ name: "lint-plan", conclusion: "FAILURE", logTail: "a plan violation needs repair" }],
      });
      for (const mainTip of [MAIN_AT_STAND_DOWN, recordedMain]) {
        const ledgerPath = join(repo.dir, `plan-${mainTip ?? "unread"}.ndjson`);
        writeFileSync(ledgerPath, "");
        appendLedger(ledgerPath, { run_id: "SWEEP-old", ...readClean({
          merge_state: state, ...(recordedMain === undefined ? {} : { merge_main_sha: recordedMain }),
        }) });
        const result = await runSweep([filing],
          sweepDeps(ledgerPath, mainTip, Date.parse("2026-11-02T23:59:23.156Z")), DEFAULT_SWEEP_POLICY);
        const disposed = readLedgerLines(ledgerPath).findLast(row => row.step === "sweep.disposed");
        assert.equal(disposed?.disposition, "refused-escalate");
        assert.match(String(disposed?.reason), /plan-only PR is red on lint-plan/);
        assert.equal(result.actions[0]?.reason, disposed?.reason, "the action and ledger show the same final reason");
        if (mainTip === MAIN_AT_STAND_DOWN) {
          assert.equal(disposed?.merge_state, undefined);
          assert.equal(disposed?.merge_main_sha, undefined);
          assert.match(String(disposed?.reason), new RegExp(`last known "${state}" for head 35fa075`));
          assert.ok(String(disposed?.reason).includes(`read against main ${recordedMain?.slice(0, 7) ?? "(unrecorded)"}`));
          assert.match(String(disposed?.reason), /main is now ab39118, so it is not inherited/);
        } else {
          assert.equal(disposed?.merge_state, state, "same main or no main read preserves inheritance");
          assert.equal(disposed?.merge_main_sha, mainTip);
          assert.doesNotMatch(String(disposed?.reason), /so it is not inherited/);
        }
      }
    });
  }
}

function conflictFixture(t: TestContext) {
  const repo = gitRepo();
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "run-task.ts"), "base\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base file");
  const oldMain = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-qb", "pr-head");
  writeFileSync(join(repo.dir, "run-task.ts"), "head edit\n");
  repo.git("commit", "-qam", "head edit");
  const conflictHead = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  repo.git("checkout", "-qb", "pr-other");
  writeFileSync(join(repo.dir, "other.ts"), "other\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "other edit");
  const otherHead = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  writeFileSync(join(repo.dir, "run-task.ts"), "main edit\n");
  repo.git("commit", "-qam", "main edit");
  repo.addRemote("origin", repo.dir);
  repo.git("update-ref", "refs/pull/15638/head", conflictHead);
  repo.git("update-ref", "refs/pull/2/head", otherHead);
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: "probe-W1-T11166", task_id: "W1-T11166", step, ...extra });
  return { repo, oldMain, conflictHead, otherHead, ledgerPath, log };
}

test("W1-T11166: a head whose remembered clean main has moved is probed first, and its conflict reaches the unread pass", async (t) => {
  const f = conflictFixture(t);
  appendLedger(f.ledgerPath, { run_id: "SWEEP-old", ...readClean({ head_sha: f.conflictHead, merge_main_sha: f.oldMain }) });
  const stale = pr({ headSha: f.conflictHead, mergeState: undefined, mergeable: undefined, mergeableState: undefined,
    lastActivityAt: "2026-11-02T23:00:00.000Z" });
  const other = pr({ prNumber: 2, prUrl: "https://github.com/craigoley/remudero/pull/2", taskId: "W1-T2",
    headRefName: "run-W1-T2-1", headSha: f.otherHead, mergeState: "clean", mergeable: true, mergeableState: "clean",
    lastActivityAt: "2026-11-01T00:00:00.000Z" });

  const summary = await probeOpenPrMerges([other, stale], f.ledgerPath, f.log, f.repo.dir, { limit: 1 });
  assert.equal(summary.probed, 1);
  const probed = readLedgerLines(f.ledgerPath).filter(r => r.step === MERGE_PROBE_STEP);
  assert.deepEqual(probed.map(r => r.pr_number), [15638], "the stale-clean head takes the one slot before an older clean PR");
  assert.equal(probed[0]?.verdict, "conflict");

  const prs = [stale];
  applyMergeProbeEvidence(prs, summary);
  assert.equal(prs[0]!.mergeState, "dirty", "a probe conflict reaches a pass whose mergeability was unread");
  assert.equal(prs[0]!.mergeConflictSource, "merge-probe");
  assert.deepEqual(prs[0]!.mergeConflict?.files.map(file => file.path), ["run-task.ts"]);

  const observedClean = [{ ...other, headSha: f.conflictHead }];
  applyMergeProbeEvidence(observedClean, { probed: 0, conflictsByPr: new Map([[2, summary.conflictsByPr.get(15638)!]]) });
  assert.equal(observedClean[0]!.mergeState, "clean", "a mergeability GitHub read this pass is never overridden");
});
