/**
 * W1-T4053 — REVIEWS KEEP FLOWING THROUGH A FRESHNESS DRAIN.
 *
 * A freshness restart runs its final bounded sweep, then waits for the detached actions still in
 * flight — measured 42 drains in three days, p50 9.3 minutes each. The review clock used to be
 * stopped for all of it, so no green pull request was reviewed until the next process booted.
 *
 * Each daemon fixture here holds ONE detached fix open on a gate, so "the drain is waiting" is a
 * state the test controls rather than a race it hopes to win. Every wait that falls inside the
 * drain resolves as a GitHub wake, so the drain's clock owes a pass at once and never needs a
 * fake interval to elapse.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonFreshness, type LightPassScope } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { detachSweepAction, detachedSweepActionCount, drainDetachedSweepActions } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildSweepLightHook, type RunResult } from "../src/run-task.js";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(message);
}

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4053-plan-`));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

interface Row { step: string; extra: Record<string, unknown> }
interface Pass { scope: LightPassScope | undefined; drainOpen: boolean; fixPending: boolean; detached: number }

interface HeldFixOpts { holdReviewPass?: Promise<void>; releaseReviewPass?: () => void; failReviewPass?: boolean }

/** One stale exit whose drain waits on a held detached fix. `holdReviewPass`, when given, parks every
 *  review-only pass on that promise so a pass can be caught mid-flight; `failReviewPass` makes it throw. */
function staleExitWithHeldFix({ holdReviewPass, failReviewPass }: HeldFixOpts = {}) {
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const rows: Row[] = [];
  const passes: Pass[] = [];
  let sweeps = 0;
  let fixSettled = false;
  let releaseFix!: () => void;
  const fixGate = new Promise<void>((resolve) => {
    releaseFix = () => {
      fixSettled = true;
      resolve();
    };
  });
  const drainOpen = () =>
    rows.some((r) => r.step === "daemon.freshness_drain.started") &&
    !rows.some((r) => r.step === "daemon.freshness_drain.completed");
  const daemon = runDaemon(fixturePlan(), {
    // Everything merged: the lifetime selects nothing, so its one cycle is sweeps and clocks only.
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: settle,
    log: (step, extra = {}) => rows.push({ step, extra }),
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
    sweep: async () => {
      sweeps += 1;
      rows.push({ step: "fixture.full_sweep", extra: {} });
      // The first full pass admits a fix and detaches its long CI wait — the shape the drain exists for.
      if (sweeps === 1) detachSweepAction(fixGate, { actionKind: "fix-dispatch", taskId: "W1-T4053-FIX" });
    },
    sleepUntilSweepWake: async () => {
      await settle();
      return drainOpen() ? "wake" : "timeout";
    },
    sweepLight: async (scope?: LightPassScope) => {
      passes.push({ scope, drainOpen: drainOpen(), fixPending: !fixSettled, detached: detachedSweepActionCount() });
      if (holdReviewPass && scope?.reviewOnly) await holdReviewPass;
      if (failReviewPass && scope?.reviewOnly) throw new Error("gh: rate limited");
    },
  });
  return { daemon, rows, passes, releaseFix };
}

/** Runs `body` against a held-fix stale exit and ALWAYS releases the fix and settles the daemon after,
 *  so a failing assertion reports its own reason instead of leaking a held action into the next test. */
async function withHeldFix(
  body: (run: ReturnType<typeof staleExitWithHeldFix>) => Promise<void>,
  opts: HeldFixOpts = {},
): Promise<void> {
  const run = staleExitWithHeldFix(opts);
  try {
    await body(run);
  } finally {
    run.releaseFix();
    opts.releaseReviewPass?.();
    await run.daemon;
    await drainDetachedSweepActions();
  }
}

const drainPasses = (passes: readonly Pass[]) => passes.filter((p) => p.drainOpen);
const stepIndex = (rows: readonly Row[], step: string) => rows.findIndex((r) => r.step === step);

test("W1-T4053: the review clock runs through a freshness drain", async () => {
  await withHeldFix(async (run) => {
    await waitFor(() => drainPasses(run.passes).length > 0, "no light pass ran while the drain waited on its detached fix");
    run.releaseFix();
    const summary = await run.daemon;

    assert.equal(summary.stopReason, "stale");
    const during = drainPasses(run.passes);
    assert.ok(during.every((p) => p.fixPending), "each drain pass ran while the detached fix was still unsettled");
    // Each pass the drain ran is a ledger row carrying `during_drain: true`, between the drain's own rows.
    const passRows = run.rows.filter((r) => r.step === "daemon.review_clock.pass");
    assert.ok(passRows.length >= 1, "a pass during the drain is ledgered");
    assert.ok(passRows.every((r) => r.extra.during_drain === true), JSON.stringify(passRows));
    const started = stepIndex(run.rows, "daemon.freshness_drain.started");
    const completed = stepIndex(run.rows, "daemon.freshness_drain.completed");
    assert.ok(started >= 0 && started < run.rows.indexOf(passRows[0]!), "the first pass row follows the drain's start");
    assert.ok(run.rows.indexOf(passRows.at(-1)!) < completed, "the last pass row precedes the drain's completion");
    assert.ok(completed < stepIndex(run.rows, "daemon_selfrestart_for_freshness"));
    // The completion row counts them, so "reviews kept flowing through this restart" is one row's read.
    assert.equal(run.rows[completed]!.extra.review_passes, passRows.length);
    assert.equal(run.rows[completed]!.extra.remaining_detached_sweep_actions, 0);
  });
});

test("W1-T4053: the stale exit awaits an in-flight light pass", async () => {
  let releasePass!: () => void;
  let passSettled = false;
  const passGate = new Promise<void>((resolve) => {
    releasePass = () => {
      passSettled = true;
      resolve();
    };
  });
  await withHeldFix(async (run) => {
    await waitFor(() => drainPasses(run.passes).length === 1, "the drain's clock never started a pass");
    // The drain itself settles while that pass is still mid-post.
    run.releaseFix();
    await waitFor(() => detachedSweepActionCount() === 0, "the detached fix never settled");
    const returnedMidPass = await Promise.race([
      run.daemon.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    const restartLoggedMidPass = stepIndex(run.rows, "daemon_selfrestart_for_freshness") >= 0;

    releasePass();
    const summary = await run.daemon;

    assert.equal(returnedMidPass, false, "the stale exit must not return while a review pass is still posting");
    assert.equal(restartLoggedMidPass, false, "the restart is not ledgered over an unfinished pass");
    assert.equal(passSettled, true);
    assert.equal(summary.stopReason, "stale");
    assert.equal(drainPasses(run.passes).length, 1, "stopping the clock admitted no second pass behind the first");
    assert.equal(run.rows.find((r) => r.step === "daemon.freshness_drain.completed")?.extra.review_passes, 1);
  }, { holdReviewPass: passGate, releaseReviewPass: () => releasePass() });
});

test("W1-T4053: a drain admits nothing but reviews", async () => {
  await withHeldFix(async (run) => {
    await waitFor(() => drainPasses(run.passes).length >= 2, "the drain's clock did not keep ticking");
    run.releaseFix();
    const summary = await run.daemon;

    assert.equal(summary.stopReason, "stale");
    const during = drainPasses(run.passes);
    // Every pass inside the drain is the REVIEW-ONLY pass, never the ordinary light pass, whose fix rung
    // is open whenever nothing is in flight — a fix admitted here would feed the very drain it runs beside.
    assert.ok(during.every((p) => p.scope?.reviewOnly === true), JSON.stringify(during));
    assert.ok(during.every((p) => p.detached === 1), "no pass during the drain detached a new action");
    // And the review-only scope is never used outside a drain.
    const outside = run.passes.filter((p) => !p.drainOpen);
    assert.ok(outside.every((p) => p.scope === undefined), JSON.stringify(outside));
    // No full sweep ran inside the drain: the final bounded sweep ran BEFORE it, and none after.
    const started = stepIndex(run.rows, "daemon.freshness_drain.started");
    const completed = stepIndex(run.rows, "daemon.freshness_drain.completed");
    const sweepRows = run.rows.flatMap((r, i) => (r.step === "fixture.full_sweep" ? [i] : []));
    assert.ok(sweepRows.some((i) => i < started), "the final bounded sweep ran before the drain");
    assert.deepEqual(sweepRows.filter((i) => i > started), [], "no full sweep was admitted during or after the drain");
    assert.ok(completed > started);
  });
});

test("W1-T4053: a failed pass during a drain is ledgered as one and the drain still ends", async () => {
  await withHeldFix(async (run) => {
    await waitFor(() => drainPasses(run.passes).length > 0, "the drain's clock never attempted a pass");
    run.releaseFix();
    const summary = await run.daemon;

    assert.equal(summary.stopReason, "stale", "a throwing review pass never costs the restart");
    const failures = run.rows.filter((r) => r.step === "daemon.sweep_light.failed");
    assert.ok(failures.length >= 1, "the failed pass is ledgered");
    for (const failure of failures) {
      assert.equal(failure.extra.phase, "freshness_drain");
      assert.equal(failure.extra.during_drain, true);
      assert.equal(failure.extra.error, "gh: rate limited");
    }
    assert.equal(run.rows.filter((r) => r.step === "daemon.review_clock.pass").length, 0, "no failed pass reads as a delivered one");
    const completed = run.rows.find((r) => r.step === "daemon.freshness_drain.completed");
    assert.equal(completed?.extra.review_passes, failures.length, "review_passes counts every admitted attempt");
  }, { failReviewPass: true });
});

// ── the production hook honours the scope ─────────────────────────────────────────────────────────

/** One open PR whose whole red verdict is a cancelled required check: the ordinary light pass
 *  re-queues that job (W1-T2430), which makes it a live control for "the hook acted on something". */
function ghStubForCancelledCheck(callsFile: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.join(" ");
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
const head = { ref: "run-W1-T4053-1", sha: "d4053000000000000000000000000000000000d0" };
if (command.includes("required_status_checks")) {
  process.stdout.write(JSON.stringify({ contexts: ["ci-gate", "remudero-review"] }));
} else if (command.includes("pulls?state=open")) {
  process.stdout.write(JSON.stringify([{ number: 4053, html_url: "https://github.com/o/r/pull/4053", state: "open",
    body: "Remudero-Task: W1-T4053\\n", updated_at: "2026-09-22T12:00:00Z", head, auto_merge: null }]));
} else if (command.includes("/pulls/4053/files")) {
  process.stdout.write("[]");
} else if (command.includes("/pulls/4053")) {
  process.stdout.write(JSON.stringify({ number: 4053, html_url: "https://github.com/o/r/pull/4053", state: "open", merged_at: null, head }));
} else if (command.includes("d4053") && command.includes("check-runs")) {
  process.stdout.write(JSON.stringify({ check_runs: [
    { name: "ci-gate", status: "completed", conclusion: "failure" },
    { name: "coverage-ratchet", status: "completed", conclusion: "cancelled", details_url: "https://github.com/o/r/actions/runs/1/job/405300" },
  ] }));
} else if (command.includes("/status")) {
  process.stdout.write(JSON.stringify({ statuses: [{ context: "remudero-review", state: "success" }] }));
} else {
  process.stdout.write("{}");
}
`;
}

async function runLightHook(scope: LightPassScope | undefined) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4053-hook-`));
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4053-gh-`));
  const callsFile = join(root, "gh-calls.ndjson");
  writeFileSync(join(bin, "gh"), ghStubForCancelledCheck(callsFile), { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    const hook = buildSweepLightHook(
      "o", "r", { root } as never, join(root, "ledger.ndjson"), "RUN-T4053",
      { tasks: [] } as never, (step, extra) => { logs.push({ step, extra }); },
      { loadedCodeSha: "boot-loaded-sha", isLoadedCodeAtOrAfter: () => false },
    );
    await (scope === undefined ? hook() : hook(scope));
    const calls = readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return { logs, calls };
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T4053: the review-only light pass leaves the fix and requeue lanes closed", async () => {
  // CONTROL: nothing is in flight, so the ordinary pass's fix rung is open and the cancelled job re-queues.
  const ordinary = await runLightHook(undefined);
  assert.ok(!ordinary.logs.some((l) => l.step === "sweep_light.error"), JSON.stringify(ordinary.logs));
  assert.ok(ordinary.logs.some((l) => l.step === "sweep.check_requeue.dispatched"), "control: the ordinary pass re-queues");
  assert.ok(ordinary.calls.some((args) => args.includes("repos/o/r/actions/jobs/405300/rerun")));

  const reviewOnly = await runLightHook({ reviewOnly: true });
  assert.ok(!reviewOnly.logs.some((l) => l.step === "sweep_light.error"), JSON.stringify(reviewOnly.logs));
  assert.equal(reviewOnly.logs.filter((l) => l.step === "sweep.summary").length, 1, "no second, requeue-only batch forms");
  assert.ok(!reviewOnly.logs.some((l) => l.step === "sweep.check_requeue.dispatched"), JSON.stringify(reviewOnly.logs));
  assert.ok(!reviewOnly.calls.some((args) => args.some((a) => a.endsWith("/rerun"))), "no job was re-run");
  assert.ok(!reviewOnly.logs.some((l) => l.step === "sweep.fix.dispatched"));
});
