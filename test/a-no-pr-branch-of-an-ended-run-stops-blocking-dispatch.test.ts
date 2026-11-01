import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stillBlockedByPushedRunBranch, type OrphanRunBranchEvidence } from "#src/lib/drain.js";
import { endedRunBranchEvidence, runDaemon, runBranchDispatchOpts, runBranchStateFrom } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const TASK = "W1-T9047";
const RUN = `${TASK}-${NOW - 2 * HOUR}`;
const BRANCH = `run-${RUN}`;
const SHA = "a".repeat(40);
const ref = { taskId: TASK, ref: BRANCH, sha: SHA };
const evidence = {
  noPrHeadShas: { [BRANCH]: SHA }, nowMs: NOW, liveTaskIds: new Set<string>(),
  endedRunIds: new Set([RUN]),
};
const blocked = (facts: OrphanRunBranchEvidence, refs = [ref]) =>
  stillBlockedByPushedRunBranch(TASK, new Set([TASK]), undefined, refs, [], facts);
const row = (run: string, step: string, at: number, extra = {}) =>
  JSON.stringify({ run_id: run, task_id: TASK, step, ts: new Date(at).toISOString(), ...extra });

test("W1-T9819: a no-PR branch of an ended run stops blocking dispatch", async (t) => {
  assert.equal(blocked(evidence), false, "the exact run ended; no fixed day elapses");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ended-run-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `- id: ${TASK}\n  title: ended run\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`);
  const ran: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let reads = 0;
  await runDaemon(loadPlan(path), {
    now: () => new Date(NOW),
    refreshMerged: () => () => false,
    readLedgerLines: () => { reads++; return [row(RUN, "verdict", NOW - HOUR, { verdict: "failed" })]; },
    readPushedRunBranches: () => `${SHA}\trefs/heads/${BRANCH}`,
    readOrphanRunBranchEvidence: () => ({ noPrHeadShas: evidence.noPrHeadShas, nowMs: NOW, liveTaskIds: new Set() }),
    runOne: async (id) => { ran.push(id); return { taskId: id, runId: "replacement", merged: true, costUsd: 0, verdict: "merged" }; },
    log: (step, fields) => logs.push({ step, ...fields }),
    checkStop: () => logs.some((l) => l.reason === "run-branch-already-pushed") ? "refused" : undefined,
    sleep: async () => {},
  }, { max: 1 });
  assert.deepEqual(ran, [TASK]);
  const releases = logs.filter((l) => l.step === "dispatch.run_branch_exception");
  assert.deepEqual(releases.map((l) => [l.reason, l.ref]), [["run-ended-no-pr", BRANCH]]);
  assert.equal(reads, 3, "boot, settle and existing result processing; no selection scan");
});

test("W1-T9819: an unproven or live run branch still blocks", () => {
  assert.equal(blocked({ ...evidence, liveTaskIds: new Set([TASK]) }), true);
  assert.equal(blocked(evidence, [{ ...ref, sha: "b".repeat(40) }]), true);
  assert.equal(blocked({ ...evidence, noPrHeadShas: {} }), true, "no no-PR proof, including an open PR");
  assert.equal(blocked({ ...evidence, endedRunIds: new Set(), longestSettledRunMs: 3 * HOUR }), true);
  assert.equal(blocked({ ...evidence, endedRunIds: new Set([`${TASK}-${NOW - HOUR}`]) }), true, "another run's verdict is insufficient");
  assert.equal(blocked({ ...evidence, endedRunIds: new Set(), nowMs: NOW + 48 * HOUR }), true, "no observed span, even after days");
});

test("the observed longest settled span releases only older no-PR refs and reports once", () => {
  const facts = { ...evidence, endedRunIds: new Set<string>(), longestSettledRunMs: HOUR };
  assert.equal(blocked(facts), false);
  assert.equal(blocked({ ...facts, nowMs: NOW - HOUR }), true, "equal age is not older");
  for (const longestSettledRunMs of [NaN, Infinity, -1]) {
    assert.equal(blocked({ ...facts, longestSettledRunMs }), true);
  }
  const logs: Array<Record<string, unknown>> = [];
  const opts = runBranchDispatchOpts(runBranchStateFrom(`${SHA}\trefs/heads/${BRANCH}`, facts), [],
    (step, fields) => logs.push({ step, ...fields }));
  assert.equal(opts.hasPushedRunBranch?.(TASK), false);
  assert.equal(opts.hasPushedRunBranch?.(TASK), false);
  assert.deepEqual(logs.map((l) => l.reason), ["older-than-observed-runs"]);
});


test("ended run evidence uses terminal rows and the longest worked span across classes", () => {
  const measured = endedRunBranchEvidence([
    "{torn", "null", "false", "{}",
    row(RUN, "run.start", NOW - 6 * HOUR),
    row(RUN, "verdict", NOW - HOUR),
    row("short", "run.start", NOW - 2 * HOUR, { task_class: "research" }),
    row("short", "verdict", NOW - HOUR),
    row("never-worked", "run.start", NOW - 20 * HOUR),
    row("never-worked", "verdict", NOW, { backfilled: true }),
    row("reversed", "run.start", NOW), row("reversed", "verdict", NOW - HOUR),
    row("running", "run.start", NOW - 40 * HOUR),
    row("verdict-only", "verdict", NOW),
    row("invalid-time", "run.start", NOW).replace(new Date(NOW).toISOString(), "invalid"),
    row("invalid-time", "verdict", NOW),
  ]);
  assert.equal(measured.longestSettledRunMs, 5 * HOUR);
  assert.equal(measured.endedRunIds.has("running"), false);
  assert.equal(measured.endedRunIds.has("verdict-only"), true);
  assert.equal(measured.endedRunIds.has("never-worked"), true, "excluded from spans but still ended");
  assert.deepEqual(endedRunBranchEvidence([]), { endedRunIds: new Set(), longestSettledRunMs: undefined });
});

test("the daemon learns fallback spans from restart history and keeps checkpoint receipts resumable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}run-span-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `- id: ${TASK}\n  title: measured fallback\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`);
  const logs: Array<Record<string, unknown>> = [];
  const ran: string[] = [];
  let historyReads = 0;
  await runDaemon(loadPlan(path), {
    now: () => new Date(NOW),
    refreshMerged: () => () => false,
    readLedgerLines: () => [],
    readRestartHistory: () => { historyReads++; return [row("historical", "run.start", NOW - 5 * HOUR), row("historical", "verdict", NOW - 4 * HOUR)]; },
    readPushedRunBranches: () => `${SHA}\trefs/heads/${BRANCH}`,
    readOrphanRunBranchEvidence: () => ({ noPrHeadShas: evidence.noPrHeadShas, nowMs: NOW, liveTaskIds: new Set() }),
    runOne: async (id) => { ran.push(id); return { taskId: id, runId: "replacement", merged: true, costUsd: 0, verdict: "merged" }; },
    log: (step, fields) => logs.push({ step, ...fields }),
    checkStop: () => logs.some((l) => l.reason === "run-branch-already-pushed") ? "refused" : undefined,
    sleep: async () => {},
  }, { max: 1 });
  assert.deepEqual(ran, [TASK]);
  assert.equal(historyReads, 1);
  assert.deepEqual(logs.filter((l) => l.step === "dispatch.run_branch_exception").map((l) => l.reason), ["older-than-observed-runs"]);
  const checkpoint = new Map([[TASK, { branch: BRANCH, headSha: SHA }]]);
  const state = runBranchStateFrom(`${SHA}\trefs/heads/${BRANCH}`, evidence, checkpoint);
  assert.deepEqual(state.refs, [], "a kept checkpoint resumes before the orphan guard");
});

test("a terminal verdict learned at settle releases the next tick without another ledger scan", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}settled-run-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `- id: ${TASK}\n  title: settled retry\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`);
  const ledger: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let runs = 0;
  let ledgerReads = 0;
  await runDaemon(loadPlan(path), {
    now: () => new Date(NOW),
    refreshMerged: () => () => false,
    readLedgerLines: () => { ledgerReads++; return ledger; },
    readPushedRunBranches: () => runs === 0 ? "" : `${SHA}\trefs/heads/${BRANCH}`,
    readOrphanRunBranchEvidence: () => ({ noPrHeadShas: evidence.noPrHeadShas, nowMs: NOW, liveTaskIds: new Set() }),
    runOne: async (id) => {
      runs++;
      ledger.push(row(RUN, "verdict", NOW - HOUR, { verdict: "blocked_transient" }));
      return { taskId: id, runId: RUN, merged: runs > 1, costUsd: 0, verdict: runs > 1 ? "merged" : "blocked_transient" };
    },
    log: (step, fields) => logs.push({ step, ...fields }),
    checkStop: () => logs.some((l) => l.reason === "run-branch-already-pushed") ? "refused" : undefined,
    sleep: async () => {},
  }, { max: 2 });
  assert.equal(runs, 2, "the first run's terminal verdict releases its newly pushed ref");
  assert.deepEqual(logs.filter((l) => l.step === "dispatch.run_branch_exception").map((l) => l.reason), ["run-ended-no-pr"]);
  assert.equal(ledgerReads, 5, "boot, two settles, and existing result processing");
});

test("a longer settled run raises the learned fallback without shortening earlier observations", async (t) => {
  for (const [priorHours, settledHours] of [[1, 3], [3, 1]] as const) {
    await t.test(`observed ${priorHours}h then settled ${settledHours}h`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}learned-span-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const path = join(root, "tasks.yaml");
      const learner = "W1-T1";
      writeFileSync(path, [learner, TASK].map(id =>
        `- id: ${id}\n  title: observe a run\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`).join(""));
      const ledger = [row("prior", "run.start", NOW - (priorHours + 5) * HOUR), row("prior", "verdict", NOW - 5 * HOUR)];
      const ran: string[] = [];
      let refusedAfterSettle = false;
      await runDaemon(loadPlan(path), {
        now: () => new Date(NOW),
        refreshMerged: () => id => ran.includes(id),
        readLedgerLines: () => ledger,
        readPushedRunBranches: () => `${SHA}\trefs/heads/${BRANCH}`,
        readOrphanRunBranchEvidence: () => ({ noPrHeadShas: evidence.noPrHeadShas, nowMs: NOW, liveTaskIds: new Set() }),
        runOne: async (id) => {
          ran.push(id);
          ledger.push(row("learner", "run.start", NOW - settledHours * HOUR, { task_id: learner }),
            row("learner", "verdict", NOW, { task_id: learner }));
          return { taskId: id, runId: "learner", merged: true, costUsd: 0, verdict: "merged" };
        },
        log: (step, fields) => {
          if (ran.length > 0 && step === "dispatch.skipped" && fields?.reason === "run-branch-already-pushed") refusedAfterSettle = true;
        },
        checkStop: () => refusedAfterSettle ? "observed refusal" : undefined,
        sleep: async () => {},
      }, { max: 2 });
      assert.deepEqual(ran, [learner], "a 2h ref remains inside the longest 3h observation");
      assert.equal(refusedAfterSettle, true);
    });
  }
});
