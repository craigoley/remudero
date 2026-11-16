import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchOpenPrsRest } from "#src/lib/open-prs-rest.js";
import {
  DEFAULT_SWEEP_POLICY, lastKnownMergeStateFromLedger, runSweep, withInheritedMergeState, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// #18726 on 2026-11-16, read from the core ledger. Head 7481c5d disposed clean at main ef8b749 from 13:20:13Z
// to 13:28:54Z; sweep.merge_probe read it clean against ef8b749 at 13:58:14Z; a pass with no main tip wrote
// merge_state clean with no merge_main_sha at 13:58:41Z; and at 14:23:20Z the sweep escalated it "not positively
// mergeable — checks none, review none — ... read against main (unrecorded), and main is now ef8b749".
const PR = 18726;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const TASK = "W1-T13190";
const HEAD = "7481c5d0a1b2c3d4e5f60718293a4b5c6d7e8f90";
const MAIN = "ef8b7490a1b2c3d4e5f60718293a4b5c6d7e8f91";
const OLD_MAIN = "0be5c1a0a1b2c3d4e5f60718293a4b5c6d7e8f92";

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: PR_URL, taskId: TASK, headRefName: `run-${TASK}-1794841008000`, headSha: HEAD,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: "2026-11-16T13:10:00.000Z", ...over,
  };
}
const unread = (over: Partial<OpenPrView> = {}) => view({ mergeState: undefined, mergeable: undefined, mergeableState: undefined, ...over });

const disposedClean = (ts: string, extra: Record<string, unknown> = {}) => ({
  run_id: "SWEEP-old", task_id: TASK, step: "sweep.disposed", pr_number: PR, pr_url: PR_URL, head_sha: HEAD,
  disposition: "mergeable", merge_state: "clean", merge_main_sha: MAIN, ts, ...extra,
});
const cleanAtMain = ["13:20:13", "13:22:20", "13:24:31", "13:26:42", "13:28:54"].map(t => disposedClean(`2026-11-16T${t}.000Z`));
const probe = (verdict: "clean" | "conflict", mainSha: string, extra: Record<string, unknown> = {}) => ({
  run_id: "SWEEP-probe", task_id: "SWEEP", step: "sweep.merge_probe", pr_number: PR, head_sha: HEAD, main_sha: mainSha,
  verdict, conflict_paths: [], ts: "2026-11-16T13:58:14.000Z", ...extra,
});

function harness(prior: Record<string, unknown>[], mainTip: string | undefined, at: string) {
  const rows: Record<string, unknown>[] = [];
  const calls = { arm: 0, repush: 0, escalate: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/nonexistent/rmd-W1-T13195/rows.ndjson", runId: `SWEEP-${at}`, now: () => Date.parse(at),
    readMainTip: () => mainTip,
    readLedger: () => [...prior, ...rows], appendLine: (_path, row) => { rows.push(row); },
    log: (step, extra = {}) => { rows.push({ run_id: `SWEEP-${at}`, step, ...extra }); },
    arm: () => { calls.arm++; }, close: () => {}, dispatchFix: () => {}, escalate: () => { calls.escalate++; },
    repushAbsent: async () => { calls.repush++; return "f00dfeed"; },
  };
  const disposed = () => rows.findLast(r => r.step === "sweep.disposed");
  return { deps, rows, calls, disposed };
}

test("W1-T13195 criterion 1: a pass with no main tip records the inherited main, so a later pass at that main inherits clean", async () => {
  // The 13:58:41Z pass: mergeability unread and no main tip.
  const noMain = harness(cleanAtMain, undefined, "2026-11-16T13:58:41.000Z");
  await runSweep([unread()], noMain.deps, DEFAULT_SWEEP_POLICY);
  const row = noMain.disposed();
  assert.equal(row?.merge_state, "clean", "positive control: the pass inherited clean");
  assert.equal(row?.merge_main_sha, MAIN, "the inherited record's main is written with its state");

  // The 14:23:20Z pass at main ef8b749 reads the ledger the 13:58:41Z pass left.
  const later = harness([...cleanAtMain, ...noMain.rows], MAIN, "2026-11-16T14:23:20.000Z");
  await runSweep([unread()], later.deps, DEFAULT_SWEEP_POLICY);
  const after = later.disposed();
  assert.equal(after?.merge_state, "clean", "clean at ef8b749 is still inherited at ef8b749");
  assert.equal(after?.merge_main_sha, MAIN);
  assert.doesNotMatch(String(after?.reason), /\(unrecorded\)/);
  assert.doesNotMatch(String(after?.reason), /not inherited \(W1-T11166\)/);

  // A clean observed on a pass with no main tip and no earlier record names no main, so it records no merge_state.
  const fresh = harness([], undefined, "2026-11-16T13:58:41.000Z");
  await runSweep([view({ mergeState: "clean", mergeable: true, mergeableState: "clean" })], fresh.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(fresh.disposed()?.merge_state, undefined, "no clean is recorded without its main");
  assert.equal(fresh.disposed()?.merge_main_sha, undefined);
  for (const r of [...noMain.rows, ...later.rows, ...fresh.rows]) {
    if (r.step === "sweep.disposed" && (r.merge_state === "clean" || r.merge_state === "behind")) {
      assert.equal(typeof r.merge_main_sha, "string", "no clean or behind row without merge_main_sha");
    }
  }
});

test("W1-T13195 criterion 1: a conflict seen with no main tip is never followed by an older clean being inherited", async () => {
  const conflictSeen = (rows: Record<string, unknown>[]) => harness(rows, undefined, "2026-11-16T13:58:41.000Z");
  const dirtyView = view({ mergeState: "dirty", mergeable: false, mergeableState: "dirty" });

  // An older clean at ef8b749 names a main: the conflict row records dirty against that main and hides the clean.
  const named = conflictSeen(cleanAtMain);
  await runSweep([dirtyView], named.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(named.disposed()?.merge_state, "dirty");
  assert.equal(named.disposed()?.merge_main_sha, MAIN, "the dirty row names the newest record's main");
  const afterNamed = [...cleanAtMain, ...named.rows];
  assert.equal(lastKnownMergeStateFromLedger(afterNamed, PR, HEAD)?.state, "dirty");
  const next = withInheritedMergeState(unread(), afterNamed, MAIN);
  assert.equal(next.pr.mergeState, "dirty", "the next pass at ef8b749 inherits the conflict, never the older clean");

  // No record names a main: the conflict is still recorded (W1-T4470 hysteresis), and it hides the older clean.
  const legacy = [disposedClean("2026-11-16T13:28:54.000Z", { merge_main_sha: undefined })];
  assert.equal(withInheritedMergeState(unread(), legacy, MAIN).refused?.state, "clean", "positive control: mergeInheritanceRefused refuses the legacy clean");
  const unnamed = conflictSeen(legacy);
  await runSweep([dirtyView], unnamed.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(unnamed.disposed()?.merge_state, "dirty");
  assert.equal(unnamed.disposed()?.merge_main_sha, undefined, "no main was known");
  for (const mainTip of [MAIN, undefined]) {
    const afterUnnamed = withInheritedMergeState(unread(), [...legacy, ...unnamed.rows], mainTip);
    assert.equal(afterUnnamed.pr.mergeState, "dirty", `the older clean is never inherited (main ${mainTip ?? "unread"})`);
  }
  for (const r of [...named.rows, ...unnamed.rows]) {
    if (r.step === "sweep.disposed" && (r.merge_state === "clean" || r.merge_state === "behind")) assert.equal(typeof r.merge_main_sha, "string");
  }
});

test("W1-T13195 criterion 2: a merge probe row is a read against its main_sha", async () => {
  // The legacy 13:58:41Z row had no main; a later clean probe against ef8b749 is the newest read.
  const legacy = disposedClean("2026-11-16T13:58:41.000Z", { merge_main_sha: undefined });
  const rows = [legacy, probe("clean", MAIN, { ts: "2026-11-16T14:05:00.000Z" })];
  const known = lastKnownMergeStateFromLedger(rows, PR, HEAD);
  assert.deepEqual(known, { state: "clean", observedAt: "2026-11-16T14:05:00.000Z", mainSha: MAIN });
  assert.equal(lastKnownMergeStateFromLedger([legacy], PR, HEAD)?.mainSha, undefined, "positive control: the legacy row alone has no main");
  assert.equal(withInheritedMergeState(unread(), rows, MAIN).pr.mergeState, "clean");

  const conflict = probe("conflict", MAIN, { conflict_paths: ["src/lib/sweep.ts"], conflict_evidence: {
    files: [{ path: "src/lib/sweep.ts", oursDeleted: 3, theirsDeleted: 5 }], oursLog: "", theirsLog: "" } });
  const dirty = lastKnownMergeStateFromLedger([...cleanAtMain, conflict], PR, HEAD);
  assert.equal(dirty?.state, "dirty", "a conflict verdict is a dirty read");
  assert.equal(dirty?.mainSha, MAIN);
  assert.deepEqual(dirty?.conflictFiles, [{ path: "src/lib/sweep.ts", oursDeleted: 3, theirsDeleted: 5 }]);

  assert.equal(lastKnownMergeStateFromLedger([probe("clean", MAIN, { head_sha: OLD_MAIN })], PR, HEAD), undefined, "another head's probe is not this head's read");
  assert.equal(lastKnownMergeStateFromLedger([probe("clean", MAIN, { pr_number: 1 })], PR, HEAD), undefined, "another PR's probe is not this PR's read");
  assert.equal(lastKnownMergeStateFromLedger([{ ...probe("clean", MAIN), verdict: "unreadable" }], PR, HEAD), undefined);

  const sweepAt = harness(rows, MAIN, "2026-11-16T14:23:20.000Z");
  await runSweep([unread()], sweepAt.deps, DEFAULT_SWEEP_POLICY);
  const row = sweepAt.disposed();
  assert.equal(row?.merge_state, "clean", "the probe's clean at the current main is inherited");
  assert.equal(row?.merge_main_sha, MAIN);
  assert.doesNotMatch(String(row?.reason), /read against main \(unrecorded\)/);
});

test("W1-T13195 criterion 3: invariant clean-only-at-its-own-main — clean and behind need their own main, dirty does not", () => {
  for (const state of ["clean", "behind"] as const) {
    const other = withInheritedMergeState(unread(), [disposedClean("2026-11-16T13:20:13.000Z", { merge_state: state, merge_main_sha: OLD_MAIN })], MAIN);
    assert.equal(other.pr.mergeState, undefined, `${state} at another main is not inherited`);
    assert.equal(other.refused?.state, state);
    const absent = withInheritedMergeState(unread(), [disposedClean("2026-11-16T13:20:13.000Z", { merge_state: state, merge_main_sha: undefined })], MAIN);
    assert.equal(absent.pr.mergeState, undefined, `${state} with no recorded main is not inherited`);
    const same = withInheritedMergeState(unread(), [disposedClean("2026-11-16T13:20:13.000Z", { merge_state: state })], MAIN);
    assert.equal(same.pr.mergeState, state, `positive control: ${state} at this main is inherited`);
  }
  const oldProbe = withInheritedMergeState(unread(), [probe("clean", OLD_MAIN)], MAIN);
  assert.equal(oldProbe.pr.mergeState, undefined, "a clean probe at an older main is not inherited");
  assert.equal(oldProbe.refused?.mainSha, OLD_MAIN);

  const dirtyRow = disposedClean("2026-11-16T13:20:13.000Z", { merge_state: "dirty", merge_main_sha: OLD_MAIN });
  assert.equal(withInheritedMergeState(unread(), [dirtyRow], MAIN).pr.mergeState, "dirty", "a dirty record is inherited at any main");
  assert.equal(withInheritedMergeState(unread(), [probe("conflict", OLD_MAIN)], MAIN).pr.mergeState, "dirty", "a conflict probe is inherited at any main");
});

/** The production read: a failed rollup read (W1-T521) through the REST list and the view builder. */
async function viewWithFailedRollupRead(): Promise<OpenPrView> {
  const restFetch = (args: string[]) => {
    const path = args.find(a => a.startsWith("repos/")) ?? "";
    if (path.includes("state=open")) {
      return [{ number: PR, html_url: PR_URL, state: "open", draft: false, title: "plan", body: `Remudero-Task: ${TASK}`,
        updated_at: "2026-11-16T13:10:00Z", created_at: "2026-11-16T13:00:00Z", head: { ref: `run-${TASK}-1794841008000`, sha: HEAD } }];
    }
    throw new Error("HTTP 502: rollup read failed");
  };
  const openPrRows = fetchOpenPrsRest("craigoley", "remudero", restFetch);
  assert.equal(openPrRows[0]?.rollupUnreadable, true, "positive control: the REST read marks the failed rollup");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13195-`));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const built = await buildOpenPrViewsAsync("craigoley", "remudero", ledgerPath, {
      openPrRows,
      fetchAsync: async (args) => (args.some(a => a.includes("/files") || a.includes("/runs")) ? [] : {}),
      requiredContexts: () => ["ci-gate", "remudero-review"],
      readCiGateRequired: () => [],
      readMainPlan: () => ({ tasks: [], byId: new Map() }),
    });
    assert.equal(built.length, 1);
    return built[0]!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T13195 criterion 4: a failed rollup read waits as unread, never 'checks none, review none' and never the absent-checks re-push", async () => {
  const built = await viewWithFailedRollupRead();
  assert.equal(built.rollupUnreadable, true, "the view builder carries the failed read");
  assert.equal(built.checksState, "none", "positive control: without the field the view reads checks none");
  assert.equal(built.reviewState, "none");

  // Old enough that an absent suite would be re-pushed (W1-T9408), as #18847's 923534 ms snapshot was.
  const pr = { ...built, mergeState: "clean" as const, lastActivityAt: "2026-11-16T10:00:00.000Z" };
  const h = harness(cleanAtMain, MAIN, "2026-11-16T14:23:20.000Z");
  const result = await runSweep([pr], h.deps, DEFAULT_SWEEP_POLICY);
  const row = h.disposed();
  assert.equal(row?.disposition, "wait");
  assert.equal(row?.blocker, "awaiting-ci");
  assert.match(String(row?.reason), /^checks and review unread this pass/);
  assert.equal(row?.rollup_unreadable, true);
  assert.doesNotMatch(String(row?.reason), /checks none, review none/);
  assert.equal(result.actions[0]?.disposition, "wait");
  assert.equal(h.calls.repush, 0, "no absent-checks re-push for a PR whose checks were not read");
  assert.equal(h.rows.filter(r => r.step === "sweep.absent_repush").length, 0);
  assert.equal(h.calls.escalate, 0);

  const control = harness(cleanAtMain, MAIN, "2026-11-16T14:23:20.000Z");
  await runSweep([{ ...pr, rollupUnreadable: undefined }], control.deps, DEFAULT_SWEEP_POLICY);
  assert.notEqual(control.disposed()?.disposition, "wait", "positive control: a read empty rollup takes the absent-checks rows");
  assert.equal(control.disposed()?.rollup_unreadable, undefined);
});

test("W1-T13195 criterion 5: invariant unread-is-never-green — an unread rollup is never mergeable, armed or merged", async () => {
  for (const isPlanFiling of [false, true]) {
    // A view that somehow still reads green and success must not be trusted when its rollup read failed.
    const pr = view({ mergeState: "clean", mergeable: true, mergeableState: "clean", rollupUnreadable: true,
      isPlanFiling, ...(isPlanFiling ? { taskId: undefined, planFilingSource: "github-files" as const } : {}) });
    const h = harness(cleanAtMain, MAIN, "2026-11-16T14:23:20.000Z");
    const result = await runSweep([pr], h.deps, DEFAULT_SWEEP_POLICY);
    assert.notEqual(result.actions[0]?.disposition, "mergeable");
    assert.equal(h.disposed()?.disposition, "wait");
    assert.equal(h.calls.arm, 0, "never armed and never merged: a direct merge also goes through arm");
    assert.equal(h.rows.filter(r => r.step === "automerge.armed" || r.arm_outcome === "armed" || r.arm_outcome === "direct-merged").length, 0);

    const control = harness(cleanAtMain, MAIN, "2026-11-16T14:23:20.000Z");
    await runSweep([{ ...pr, rollupUnreadable: undefined }], control.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(control.disposed()?.disposition, "mergeable", "positive control: the same PR with a read rollup is mergeable");
  }
});
