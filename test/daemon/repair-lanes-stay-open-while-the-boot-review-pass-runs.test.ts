/**
 * W1-T12703 — REPAIR LANES STAY OPEN WHILE THE BOOT REVIEW PASS RUNS.
 *
 * Over 24 h to 2026-11-14T17:00Z, 13 boot passes stood 69 due fix rounds on 30 PRs down as "review-only boot
 * pass: repair lanes closed until the boot review settles" (9.4 PR-hours of hold). The boot pass exists so
 * reviews come first after a restart and so nothing arms during boot. Neither needs the fix lanes closed: a
 * fix round still takes the per-head claim and the fix-capacity admission.
 *
 * The start-claim sweep: a conflict round on an operator-session head reads its task's refs/rmd-dispatch claims
 * (readSessionOwnershipViaGit). So the boot pass opens its fix lanes only once the boot claim sweep settled.
 *
 * Every hook test drives the real `buildSweepLightHook` through its io ports, never a mirror of its wiring.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  lightPassArmAdmitted, lightPassFixAdmitted, runDaemon, type LightPassScope, type RestartAdmission,
} from "#src/lib/daemon.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import {
  drainDetachedSweepActions, reviewOnlyStandDownReason, runSweep, type LightPassScopeName, type OpenPrView,
  type SweepDeps,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
// The run-task test seam, not a direct `src/run-task.ts` import: the reach ratchet caps direct importers.
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";

const BOOT: LightPassScope = { reviewOnly: true, scope: "boot" };
const CLOSED = /repair lanes closed/;
const FILE = "src/subject.ts";

function openPr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    headSha: `head-${prNumber}`, headRefName: `run-W1-T${prNumber}-1`, lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    mergeState: "clean", changedFiles: [FILE], ...over,
  };
}

function ownRedPr(prNumber: number): OpenPrView {
  return openPr(prNumber, { checksState: "red", reviewState: "pending", redRequiredChecks: ["ci"],
    ciFailures: [{ name: "ci", logTail: "assertion failed in this diff" }] });
}

function conflictedPr(prNumber: number): OpenPrView {
  return openPr(prNumber, {
    mergeState: "dirty",
    mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 0, theirsDeleted: 0 }], oursLog: "a", theirsLog: "b" },
  });
}

/** Green and not yet reviewed at its head: a review-lane PR. */
function unreviewedPr(prNumber: number): OpenPrView {
  return openPr(prNumber, { reviewState: "none" });
}

/** The production light hook over `prs`, with every effect recorded in one ordered event list. */
function fixture(prs: OpenPrView[], opts: { holdFix?: Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12703-`));
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const rows: Array<Record<string, unknown>> = prs.filter((p) => p.reviewState === "success").map((p) => ({
    step: "review.posted", task_id: p.taskId, pr_url: p.prUrl, head_sha: p.headSha,
    state: "success", capped: false, plan_only: false,
  }));
  const events: string[] = [];
  const armed: number[] = [];
  const fixes: number[] = [];
  const reviews: number[] = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T12703", readLedger: () => rows,
    appendLine: (_path, row) => {
      rows.push(row);
      if (row.step === "sweep.review_admitted") events.push(`review_admitted:${String(row.pr_number ?? row.pr_url)}`);
    },
    readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    arm: (p) => { armed.push(p.prNumber); return "armed"; },
    postReview: (p) => { reviews.push(p.prNumber); events.push(`review:${p.prNumber}`); },
    close: () => assert.fail("unexpected close"),
    claimFixAdmission: (p) => { events.push(`fix_admission:${p.prNumber}`); return { admitted: true }; },
    dispatchFix: async (p) => {
      await opts.holdFix;
      fixes.push(p.prNumber);
      events.push(`fix:${p.prNumber}`);
      rows.push({ step: "fix.dispatch", task_id: p.taskId, pr_number: p.prNumber, head_sha: p.headSha, strike: 1 });
    },
    escalate: () => assert.fail("unexpected escalation"),
    requeueCheck: () => true,
    readMainTip: async () => "main-1",
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: p.headSha }),
    rereadPrAtAct: async () => undefined,
    readActionsStatusSummary: async () => ({ components: [], incidents: [] }),
    readBranchProtectionStrict: async () => false,
    updateBranch: () => "updated",
  };
  const io: NonNullable<Parameters<typeof buildSweepLightHook>[12]> = {
    openPrViews: async () => prs,
    effects: () => effects,
    readCompare: async () => ({ ahead_by: 0, files: [] }),
  };
  const hook = buildSweepLightHook("o", "r", { root } as never, effects.ledgerPath, "T12703",
    { tasks: [], byId: new Map() } as never, () => {},
    undefined, undefined, undefined, undefined, undefined, io);
  const disposed = (prNumber: number) => rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === prNumber);
  const count = (step: string) => rows.filter((r) => r.step === step).length;
  return { rows, events, armed, fixes, reviews, effects, hook, disposed, count,
    cleanup: () => {
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(shim.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

const latch = (answer: boolean, asked: string[]): RestartAdmission =>
  (kind, surface) => { asked.push(`${kind}:${surface ?? "probe"}`); return kind === "fix-dispatch" ? answer : true; };

test("W1-T12703 criterion 1: the boot scope opens its fix lanes when the restart latch admits a fix", () => {
  const asked: string[] = [];
  assert.equal(lightPassFixAdmitted(BOOT), true, "a boot pass with no latch opens its fix lanes");
  assert.equal(lightPassFixAdmitted({ ...BOOT, admit: latch(true, asked) }), true, "the latch admits the fix");
  assert.equal(lightPassFixAdmitted({ ...BOOT, admit: latch(false, asked) }), false, "the latch refuses the fix");
  assert.deepEqual(asked, ["fix-dispatch:light", "fix-dispatch:light"], "asked on the light surface");
  for (const scope of ["pause", "drain", "idle", "interphase-review"] as const satisfies readonly LightPassScopeName[]) {
    assert.equal(lightPassFixAdmitted({ reviewOnly: true, scope, admit: latch(true, []) }), false, `${scope} stays closed`);
  }
  assert.equal(lightPassFixAdmitted({ reviewOnly: true }), false, "an unnamed review-only pass stays closed");
  assert.equal(lightPassFixAdmitted(undefined), true, "the ordinary pass is unchanged");
});

test("W1-T12703 criterion 2: a boot pass dispatches a due fix round and a conflict round", async () => {
  const red = ownRedPr(1270301);
  const dirty = conflictedPr(1270302);
  const f = fixture([red, dirty]);
  try {
    await f.hook(BOOT);
    await drainDetachedSweepActions();
    assert.deepEqual([...f.fixes].sort(), [red.prNumber, dirty.prNumber], "one fix round and one conflict round");
    assert.ok(f.events.includes(`fix_admission:${red.prNumber}`), "the fix round took the fix-capacity admission");
    assert.ok(f.events.includes(`fix_admission:${dirty.prNumber}`), "the conflict round took the fix-capacity admission");
    for (const pr of [red, dirty]) {
      const row = f.disposed(pr.prNumber);
      assert.ok(row, `${pr.prNumber} has a disposed row`);
      assert.doesNotMatch(String(row?.stand_down_reason ?? ""), CLOSED);
      assert.equal(row?.light_pass_scope, "boot");
    }
  } finally { f.cleanup(); }
  // Control: the same pass with the latch refusing the fix keeps both lanes closed.
  const held = fixture([ownRedPr(1270303)]);
  try {
    await held.hook({ ...BOOT, admit: latch(false, []) });
    await drainDetachedSweepActions();
    assert.deepEqual(held.fixes, []);
    assert.equal(held.disposed(1270303)?.acted, false);
  } finally { held.cleanup(); }
});

test("W1-T12703 criterion 3: the boot pass and the full pass start one round on one head", async () => {
  let release!: () => void;
  const holdFix = new Promise<void>((resolve) => { release = resolve; });
  const red = ownRedPr(1270311);
  const f = fixture([red], { holdFix });
  try {
    await f.hook(BOOT);
    // The boot pass's round is admitted and still starting; the first full pass reaches the same head.
    const fullPass = runSweep([ownRedPr(1270311)], { ...f.effects, runId: "FULL-T12703" });
    for (let i = 0; i < 400 && !f.rows.some((r) => r.step === "sweep.disposed" && r.run_id === "FULL-T12703"); i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    release();
    await fullPass;
    await drainDetachedSweepActions();
    assert.equal(f.count("fix.dispatch"), 1, "exactly one fix.dispatch on the head");
    assert.deepEqual(f.fixes, [red.prNumber]);
    const full = f.rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === red.prNumber && r.run_id === "FULL-T12703");
    assert.equal(full?.acted, false, "the full pass stands down");
    assert.match(String(full?.stand_down_reason), /duplicate fix-dispatch key/);
  } finally {
    release();
    f.cleanup();
  }
});

test("W1-T12703 criterion 4: the boot review is admitted first and a fix takes no review slot", async () => {
  const run = async (scope: LightPassScope) => {
    const f = fixture([unreviewedPr(1270321), ownRedPr(1270322)]);
    try {
      await f.hook(scope);
      await drainDetachedSweepActions();
      return { events: [...f.events], reviews: [...f.reviews], fixes: [...f.fixes],
        admitted: f.count("sweep.review_admitted") };
    } finally { f.cleanup(); }
  };
  const today = await run({ ...BOOT, admit: latch(false, []) });
  const open = await run(BOOT);
  const firstReview = (events: string[]) => events.findIndex((e) => e.startsWith("review"));
  assert.ok(firstReview(today.events) >= 0, `positive control: the closed boot pass admits the review ${JSON.stringify(today)}`);
  assert.ok(firstReview(open.events) >= 0, "the open boot pass admits the review");
  assert.ok(firstReview(open.events) <= firstReview(today.events), "the review is admitted no later than today");
  assert.deepEqual(today.fixes, [], "control: today the fix waits");
  assert.deepEqual(open.fixes, [1270322], "the open pass also starts the fix round");
  const fixAt = open.events.findIndex((e) => e.startsWith("fix_admission:"));
  assert.ok(fixAt > firstReview(open.events), `the fix is admitted after the review: ${JSON.stringify(open.events)}`);
  assert.deepEqual(open.reviews, today.reviews, "the fix round takes no review slot");
  assert.equal(open.admitted, today.admitted);
});

test("W1-T12703 criterion 5: a boot pass still holds arms, and pause drain and idle keep repair lanes closed", async () => {
  assert.equal(lightPassArmAdmitted(BOOT), false);
  const ready = openPr(1270331);
  const boot = fixture([ready]);
  try {
    await boot.hook(BOOT);
    assert.deepEqual(boot.armed, [], "boot arms nothing");
    const row = boot.disposed(ready.prNumber);
    assert.equal(row?.acted, false);
    assert.equal(row?.stand_down_reason, reviewOnlyStandDownReason("boot"));
    assert.match(String(row?.stand_down_reason), /boot review/);
    assert.doesNotMatch(String(row?.stand_down_reason), CLOSED);
  } finally { boot.cleanup(); }
  for (const scope of ["pause", "drain", "idle"] as const satisfies readonly LightPassScopeName[]) {
    const f = fixture([ownRedPr(1270332), conflictedPr(1270333)]);
    try {
      await f.hook({ reviewOnly: true, scope });
      await drainDetachedSweepActions();
      assert.deepEqual(f.fixes, [], `${scope} dispatches nothing`);
      for (const prNumber of [1270332, 1270333]) {
        assert.match(String(f.disposed(prNumber)?.stand_down_reason), CLOSED, `${scope} keeps its text`);
      }
    } finally { f.cleanup(); }
  }
});

test("W1-T12703: the boot pass opens its fix lanes only after the start-claim sweep settles", async () => {
  let settleClaims!: () => void;
  const claimSweepSettled = new Promise<void>((resolve) => { settleClaims = resolve; });
  const seen: Array<{ before: boolean; after: boolean; scope: LightPassScope | undefined }> = [];
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const merged = new Set<string>();
  await runDaemon(loadPlanFromYaml(`
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`, "t12703"), {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" };
    },
    sweep: async () => {},
    sweepLight: async (scope) => {
      const before = lightPassFixAdmitted(scope);
      settleClaims();
      await tick();
      seen.push({ before, after: lightPassFixAdmitted(scope), scope });
    },
    claimSweepSettled,
    gardens: [() => ({ stop: () => {} })],
    checkStop: () => undefined,
    checkPause: () => undefined,
    sleep: async () => { await tick(); },
    log: () => {},
  }, { max: 1, pollIntervalMs: 5, bootCadenceGateBoundMs: 60_000, sweepWallClockBoundMs: 60_000 });
  const boot = seen.find((s) => s.scope?.scope === "boot");
  assert.ok(boot, "positive control: the boot review ran");
  assert.equal(boot.before, false, "a fix lane that may read a dispatch claim waits for the claim sweep");
  assert.equal(boot.after, true, "the settled claim sweep opens the boot pass's fix lanes");
});
