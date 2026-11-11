// W1-T11503 — a freshness exit used to await the daemon's BOUNDED sweep wrapper, so a direct merge still inside its
// preflight or write (owned by the abandoned sweep's original promise) was invisible to the restart drain. Each merge now
// registers at admission and stays registered until its own steps settle.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  attemptArmAsync,
  cancelUnsubmittedDirectMerges,
  closeDirectMergeAdmissions,
  directMergeOperationsInFlight,
  drainDirectMergeOperations,
  openDirectMergeAdmissions,
  type ArmAttemptResult,
} from "#src/lib/arm-auto-merge.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import * as sweep from "#src/lib/sweep.js";

type Row = { step: string; extra: Record<string, any> };
type Result = Awaited<ReturnType<DaemonDeps["runOne"]>>;
type ArmDepsArg = Parameters<typeof attemptArmAsync>[1];

const url = (n: number) => `https://github.com/craigoley/remudero/pull/${n}`;
const CLEAN = "GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)";
const HEAD = "a".repeat(40);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await flush(); }
  assert.fail("the expected phase was never observed");
}

/** An arm whose `gh pr merge --auto` GitHub refuses as clean, so it takes the direct-merge fallback. */
function scene(over: Partial<ArmDepsArg> & { mergeDirect: ArmDepsArg["mergeDirect"] }) {
  const said: string[] = [];
  const deps = {
    armAuto: async () => { throw Object.assign(new Error("refused"), { stderr: CLEAN }); },
    isMerged: async () => false,
    say: (message: string) => said.push(message),
    ...over,
  } as ArmDepsArg;
  return { deps, said };
}

function plan(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-direct-merge-drain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/A.ts]\n");
  return loadPlan(file);
}

/** The real daemon with a live lane, latched for a freshness restart on demand (the drain-inventory test's harness). */
function latched(t: TestContext) {
  const source = plan(t), start = Date.now();
  let now = start, stale = false, exiting = false, running = false;
  t.mock.method(Date, "now", () => now);
  const lane = deferred<Result>(), sleeps: Array<ReturnType<typeof deferred<void>>> = [], rows: Row[] = [];
  const material = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40), staleSinceMs: start - 7_200_000,
    changes: [{ sha: "b".repeat(40), subject: "fix: update worker", files: ["src/lib/worker.ts"] }] };
  const daemon = runDaemon(source, {
    now: () => new Date(now), refreshMerged: () => () => exiting,
    checkFreshness: () => stale ? material : { stale: false },
    log: (step, extra = {}) => rows.push({ step, extra }), runOne: () => { running = true; return lane.promise; },
    sleep: () => { const s = deferred<void>(); sleeps.push(s); return s.promise; },
    sleepUntilSweepWake: async () => {
      if (exiting) { await flush(); return "wake"; }
      const s = deferred<void>(); sleeps.push(s); await s.promise; return "timeout";
    },
    sweepLight: async () => {},
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, max: 1, laneCount: 1, sweepWallClockBoundMs: 1000 });
  const row = (step: string) => rows.find(r => r.step === step)?.extra;
  return {
    start, rows, daemon, row,
    async latch(ms: number) {
      await until(() => {
        for (const s of sleeps.splice(0)) s.resolve();
        return running;
      });
      now = start + ms; stale = true;
      for (let n = 0; n < 2; n++) {
        for (const s of sleeps.splice(0)) s.resolve();
        for (let i = 0; i < 50; i++) await flush();
      }
      assert.ok(rows.some(r => r.step === "daemon.freshness_decision" && r.extra.action === "restart"));
    },
    async settle(ms: number) {
      now = start + ms; exiting = true;
      lane.resolve({ taskId: "A", runId: "A-run", verdict: "merged", merged: true, costUsd: 0 });
      for (const s of sleeps.splice(0)) s.resolve();
      for (let i = 0; i < 20; i++) await flush();
    },
    async finish() {
      exiting = true; stale = true;
      lane.resolve({ taskId: "A", runId: "A-run", verdict: "merged", merged: true, costUsd: 0 });
      for (const s of sleeps.splice(0)) s.resolve();
      await daemon;
    },
  };
}

test("W1-T11503 criterion 1: a direct merge outliving its abandoned sweep stays in the restart inventory until it settles", async () => {
  openDirectMergeAdmissions();
  const write = deferred<void>();
  const s = scene({ mergeDirect: () => write.promise });
  // The "sweep" that started the merge is abandoned: nothing awaits this promise, as a bounded wrapper would not.
  const abandonedSweep = attemptArmAsync(url(16944), s.deps, HEAD);
  await until(() => directMergeOperationsInFlight().some(op => op.phase === "write-submitted"));
  try {
    const [operation] = directMergeOperationsInFlight();
    assert.equal(operation.prNumber, 16944);
    assert.equal(operation.headSha, HEAD);
    const entry = sweep.restartDrainInventory().find(item => item.what === "direct-merge");
    assert.ok(entry, "the merge must be listed beside reviews and detached actions");
    assert.equal(entry.pr, 16944); assert.equal(entry.head_sha, HEAD); assert.equal(entry.phase, "write-submitted");

    const stillRunning = await drainDirectMergeOperations({ boundMs: 0 });
    assert.equal(stillRunning.length, 1, "an unsettled merge is reported at the bound, never counted as drained");

    const waiting = drainDirectMergeOperations({ boundMs: 10_000 });
    write.resolve();
    assert.deepEqual(await waiting, []);
    assert.equal(((await abandonedSweep) as ArmAttemptResult).outcome, "direct-merged");
    assert.equal(directMergeOperationsInFlight().length, 0, "registration ends at settlement");
    assert.ok(s.said.some(m => m.includes("automerge.direct_merge_settled (W1-T11503): phase=write-submitted outcome=direct-merged")), JSON.stringify(s.said));
  } finally { write.resolve(); await abandonedSweep; }
});

test("W1-T11503 criterion 1: the real freshness exit waits for the merge's own settlement, not the wrapper's", async t => {
  openDirectMergeAdmissions();
  const h = latched(t), write = deferred<void>();
  const s = scene({ mergeDirect: () => write.promise, say: (m: string) => h.rows.push({ step: "say", extra: { m } }) });
  const merging = attemptArmAsync(url(16944), s.deps, HEAD);
  await until(() => directMergeOperationsInFlight().length === 1);
  try {
    await h.latch(10);
    const started = h.row("daemon.freshness_drain.started");
    const item = started?.waited_on?.find((x: any) => x.what === "direct-merge");
    assert.ok(item, `the drain start must name the merge: ${JSON.stringify(started)}`);
    assert.equal(item.pr, 16944); assert.equal(item.head_sha, HEAD); assert.equal(item.phase, "write-submitted");
    assert.ok(!("settled" in item), "an internal promise must never enter a ledger payload");
    await h.settle(30);
    assert.equal(h.row("daemon.freshness_exit"), undefined, "the exit must not run while the merge is unsettled");
    write.resolve();
    assert.equal((await h.daemon).stopReason, "stale");
    assert.equal((await merging).outcome, "direct-merged");
    const settledAt = h.rows.findIndex(r => r.step === "say" && String(r.extra.m).includes("direct_merge_settled"));
    const exitAt = h.rows.findIndex(r => r.step === "daemon.freshness_exit");
    assert.ok(settledAt >= 0 && settledAt < exitAt, "the merge settled before the exit row");
    const completed = h.row("daemon.freshness_drain.completed")!;
    assert.equal(completed.unresolved_direct_merges, 0);
    assert.ok(completed.waited_on.find((x: any) => x.what === "direct-merge").settled_after_ms !== undefined);
  } finally { write.resolve(); await h.finish(); await merging; }
});

test("W1-T11503 criterion 2: the latch closes new merge admission and leaves an admitted merge to finish", async () => {
  openDirectMergeAdmissions();
  const write = deferred<void>(), writes: string[] = [];
  const admitted = scene({ mergeDirect: () => write.promise });
  const first = attemptArmAsync(url(101), admitted.deps, HEAD);
  await until(() => directMergeOperationsInFlight().length === 1);
  try {
    closeDirectMergeAdmissions("freshness_latch");
    const late = scene({ mergeDirect: (u: string) => { writes.push(u); } });
    const refused = await attemptArmAsync(url(102), late.deps, HEAD);
    assert.equal(refused.outcome, "direct-merge-preflight-refused");
    assert.equal(refused.directMergePreflight?.reason, "freshness_latch");
    assert.equal(refused.directMergePreflight?.remedy, "retry-later");
    assert.deepEqual(writes, [], "a refused admission submits no write");
    assert.equal(directMergeOperationsInFlight().length, 1, "the admitted merge is untouched by the latch");
    write.resolve();
    assert.equal((await first).outcome, "direct-merged");
  } finally { write.resolve(); await first; openDirectMergeAdmissions(); }
});

test("W1-T11503 criterion 2: the real daemon latch refuses a merge admitted after it", async t => {
  openDirectMergeAdmissions();
  const h = latched(t), writes: string[] = [];
  try {
    await h.latch(10);
    const late = await attemptArmAsync(url(103), scene({ mergeDirect: (u: string) => { writes.push(u); } }).deps, HEAD);
    assert.equal(late.outcome, "direct-merge-preflight-refused");
    assert.equal(late.directMergePreflight?.reason, "freshness_latch");
    assert.deepEqual(writes, []);
  } finally { await h.finish(); openDirectMergeAdmissions(); }
});

test("W1-T11503 criterion 2: a refused write settles as direct-merge-failed with its reason and no leftover registration", async () => {
  openDirectMergeAdmissions();
  let writes = 0;
  const s = scene({ mergeDirect: () => { writes++; throw Object.assign(new Error("boom"), { stderr: "HTTP 422 not mergeable" }); } });
  const r = await attemptArmAsync(url(104), s.deps, HEAD);
  assert.equal(r.outcome, "direct-merge-failed");
  assert.match(String(r.error), /422 not mergeable/);
  assert.equal(writes, 1, "one write, never a blind second");
  assert.equal(directMergeOperationsInFlight().length, 0);
  assert.ok(s.said.some(m => m.includes("outcome=direct-merge-failed")), JSON.stringify(s.said));
});

test("W1-T11503 criterion 2: a head that moved during preflight is refused with no write and no leftover registration", async () => {
  openDirectMergeAdmissions();
  let writes = 0, facts = 0;
  const s = scene({
    mergeDirect: () => { writes++; },
    headSha: async () => "b".repeat(40),
    readMergeFacts: async () => (facts++ === 0 ? { mergeable: "UNKNOWN", behindBy: 0 } : { mergeable: "MERGEABLE", behindBy: 0 }),
    updateBranch: async () => ({ ok: true }),
    sleep: async () => {},
  });
  const r = await attemptArmAsync(url(105), s.deps, HEAD);
  assert.equal(r.outcome, "direct-merge-preflight-refused");
  assert.match(String(r.directMergePreflight?.error), /head moved from/);
  assert.equal(writes, 0);
  assert.equal(directMergeOperationsInFlight().length, 0);
});

test("W1-T11503 criterion 2: a merge cancelled before its write is submitted refuses at the write", async () => {
  openDirectMergeAdmissions();
  const gate = deferred<void>();
  let writes = 0, admissions = 0;
  // The first admission read precedes the arm; the second is inside the admitted merge, before its write.
  const s = scene({ mergeDirect: () => { writes++; }, contributorAdmission: () => (admissions++ === 0 ? undefined : gate.promise) } as any);
  const merging = attemptArmAsync(url(106), s.deps, HEAD);
  await until(() => directMergeOperationsInFlight().length === 1);
  assert.equal(directMergeOperationsInFlight()[0].phase, "preflight");
  assert.equal(cancelUnsubmittedDirectMerges(), 1);
  gate.resolve();
  const r = await merging;
  assert.equal(r.outcome, "direct-merge-failed", "an explicit refusal, never a false success");
  assert.match(String(r.error), /cancelled before its write was submitted/);
  assert.equal(writes, 0, "the cancelled merge never reaches GitHub");
  assert.equal(directMergeOperationsInFlight().length, 0);
});

test("W1-T11503 criterion 2: a submitted write cannot be cancelled and a second admission of that PR is refused", async () => {
  openDirectMergeAdmissions();
  const write = deferred<void>();
  let writes = 0;
  const first = scene({ mergeDirect: () => { writes++; return write.promise; } });
  const merging = attemptArmAsync(url(107), first.deps, HEAD);
  await until(() => directMergeOperationsInFlight().some(op => op.phase === "write-submitted"));
  try {
    assert.equal(cancelUnsubmittedDirectMerges(), 0, "a submitted write is not cancellable");
    const again = await attemptArmAsync(url(107), scene({ mergeDirect: () => { writes++; } }).deps, HEAD);
    assert.equal(again.outcome, "direct-merge-preflight-refused");
    assert.equal(again.directMergePreflight?.reason, "direct_merge_in_flight");
    assert.equal(writes, 1, "no duplicate write while the first is unsettled");
  } finally { write.resolve(); await merging; }
});

test("W1-T11503 criterion 2: a write still unresolved at the drain bound is named an unknown write, not a completed drain", async t => {
  openDirectMergeAdmissions();
  const h = latched(t), write = deferred<void>();
  const s = scene({ mergeDirect: () => write.promise });
  const merging = attemptArmAsync(url(108), s.deps, HEAD);
  await until(() => directMergeOperationsInFlight().some(op => op.phase === "write-submitted"));
  try {
    await h.latch(10); await h.settle(1200);
    await until(() => !!h.row("daemon.freshness_drain.completed"));
    const unresolved = h.rows.find(r => r.step === "daemon.direct_merge_unresolved")?.extra;
    assert.ok(unresolved, "the unresolved merge is reported by name");
    assert.equal(unresolved.outcome, "unknown_write"); assert.equal(unresolved.pr, 108);
    assert.equal(unresolved.head_sha, HEAD); assert.equal(unresolved.phase, "write-submitted");
    const completed = h.row("daemon.freshness_drain.completed")!;
    assert.equal(completed.unresolved_direct_merges, 1);
    const item = completed.waited_on.find((x: any) => x.what === "direct-merge");
    assert.equal(item.abandoned, true); assert.equal(item.settled_after_ms, undefined);
  } finally { write.resolve(); await h.finish(); await merging; openDirectMergeAdmissions(); }
});
