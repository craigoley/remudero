/**
 * W1-T11510 — AN INTERPHASE-REVIEW PASS ARMS A READY PR, AND ITS REPAIR LANES STAY CLOSED.
 *
 * Operator ruling 2026-11-06. #16962's head was green and reviewed at 13:47:47Z; 13 interphase-review
 * passes from 13:35:39Z to 13:56:20Z each stood its arm down as "review-only interphase-review pass: repair
 * lanes closed ...", because the interphase clock makes a pass review-only whenever another pass or a review
 * overlaps it, and the hook passed `!reviewOnly` as `armAllowed`.
 *
 * Every test drives the REAL `buildSweepLightHook` through its io ports (openPrViews, effects, readCompare),
 * never a hand-written `lightPassActionable` mirror: the mirror is how a test stays green while the hook is wrong.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { lightPassArmAdmitted, lightPassFixAdmitted, type LightPassScope } from "#src/lib/daemon.js";
import {
  CODE_SCANNING_FIX_STEP,
  decideSweepArm,
  reviewOnlyStandDownReason,
  type LightPassScopeName,
  type OpenPrView,
  type SweepDeps,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildSweepLightHook } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const INTERPHASE: LightPassScope = { reviewOnly: true, scope: "interphase-review" };
const FILE = "src/subject.ts";

function readyPr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    headSha: `head-${prNumber}`, headRefName: `run-W1-T${prNumber}-1`, lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    mergeState: "clean", changedFiles: [FILE], ...over,
  };
}

/** W1-T9569's shapes: a worker-needing conflict and an own-diff red. */
function conflictedPr(prNumber: number): OpenPrView {
  return readyPr(prNumber, {
    mergeState: "dirty",
    mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 0, theirsDeleted: 0 }], oursLog: "a", theirsLog: "b" },
  });
}

function ownRedPr(prNumber: number): OpenPrView {
  return readyPr(prNumber, { checksState: "red", reviewState: "pending", redRequiredChecks: ["ci"],
    ciFailures: [{ name: "ci", logTail: "assertion failed in this diff" }] });
}

function cancelledOnlyPr(prNumber: number): OpenPrView {
  return readyPr(prNumber, { checksState: "red", reviewState: "pending", redRequiredChecks: ["ci"],
    cancelledRequiredChecks: [{ name: "ci", jobId: "77" }], ciFailures: [{ name: "ci", logTail: "cancelled" }] });
}

type Compare = { ahead_by: number; files: Array<{ filename: string }> } | Error;

function fixture(prs: OpenPrView[], opts: {
  seed?: Array<Record<string, unknown>>;
  compare?: (pr: number) => Compare;
  liveHead?: (pr: OpenPrView) => string;
  arm?: SweepDeps["arm"];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11510-`));
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
  rows.push(...(opts.seed ?? []));
  const armed: Array<{ pr: number; head: string }> = [];
  const updates: number[] = [];
  const fixes: number[] = [];
  const escalations: number[] = [];
  const requeues: number[] = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T11510", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    arm: opts.arm ?? ((p) => { armed.push({ pr: p.prNumber, head: p.headSha }); return "armed"; }),
    postReview: () => {}, close: () => assert.fail("unexpected close"),
    dispatchFix: (p) => { fixes.push(p.prNumber); },
    escalate: (p) => { escalations.push(p.prNumber); },
    requeueCheck: (p) => { requeues.push(p.prNumber); return true; },
    readMainTip: async () => "main-1",
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: opts.liveHead?.(p) ?? p.headSha }),
    rereadPrAtAct: async () => undefined,
    readActionsStatusSummary: async () => ({ components: [], incidents: [] }),
    readBranchProtectionStrict: async () => false,
    updateBranch: (p) => { updates.push(p.prNumber); return "updated"; },
  };
  const io: NonNullable<Parameters<typeof buildSweepLightHook>[12]> = {
    openPrViews: async () => prs,
    effects: () => effects,
    readCompare: async (args: string[]) => {
      const pr = prs.find((p) => args.some((a) => a.includes(`compare/${p.headSha}...`)))!;
      const answer = opts.compare?.(pr.prNumber) ?? { ahead_by: 0, files: [] };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const hook = buildSweepLightHook("o", "r", { root } as never, effects.ledgerPath, "T11510",
    { tasks: [], byId: new Map() } as never, () => {},
    undefined, undefined, undefined, undefined, undefined, io);
  const disposed = (prNumber: number) => rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === prNumber);
  return { rows, armed, updates, fixes, escalations, requeues, effects, hook, disposed,
    cleanup: () => {
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(shim.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

test("the interphase-review pass arms a ready code PR through the guarded path", async () => {
  assert.equal(lightPassArmAdmitted(INTERPHASE), true);
  assert.equal(lightPassFixAdmitted(INTERPHASE), false, "the pass's fix admission stays false");
  const f = fixture([readyPr(1151001)]);
  try {
    await f.hook(INTERPHASE);
    assert.deepEqual(f.armed, [{ pr: 1151001, head: "head-1151001" }], "armed once, at its exact head, through deps.arm");
    const row = f.disposed(1151001);
    assert.equal(row?.disposition, "mergeable");
    assert.equal(row?.acted, true);
    assert.equal(row?.arm_outcome, "armed");
    assert.equal(row?.arm_surface, "light");
    assert.equal(row?.light_pass_scope, "interphase-review");
    assert.deepEqual(f.updates, [], "arming refreshes nothing");
    assert.deepEqual(f.fixes, []);
  } finally { f.cleanup(); }
});

test("pause drain boot and idle passes hold arms while an ordinary pass arms", async () => {
  for (const scope of ["pause", "drain", "boot", "idle"] as const satisfies readonly LightPassScopeName[]) {
    assert.equal(lightPassArmAdmitted({ reviewOnly: true, scope }), false, scope);
    const f = fixture([readyPr(1151011)]);
    try {
      await f.hook({ reviewOnly: true, scope });
      assert.deepEqual(f.armed, [], `${scope} arms nothing`);
      const row = f.disposed(1151011);
      assert.equal(row?.acted, false, scope);
      assert.equal(row?.stand_down_reason, reviewOnlyStandDownReason(scope), `${scope} writes its own stand-down`);
      assert.equal(row?.light_pass_scope, scope);
    } finally { f.cleanup(); }
  }
  const ordinary = fixture([readyPr(1151012)]);
  try {
    await ordinary.hook();
    assert.deepEqual(ordinary.armed, [{ pr: 1151012, head: "head-1151012" }], "the ordinary pass still arms");
    assert.equal(ordinary.disposed(1151012)?.arm_surface, "light");
    assert.equal("light_pass_scope" in (ordinary.disposed(1151012) ?? {}), false);
  } finally { ordinary.cleanup(); }
});

test("interphase arm refusals name head hold risk judge and in-flight reasons", async () => {
  const moved = readyPr(1151021);
  const held = readyPr(1151022);
  const risky = readyPr(1151023);
  const capped = readyPr(1151024);
  const f = fixture([moved, held, risky, capped], {
    liveHead: (p) => p.prNumber === moved.prNumber ? "moved-sha-1151021" : p.headSha,
    seed: [
      { run_id: "R", task_id: held.taskId, step: "automerge.hold_engaged", pr_number: held.prNumber,
        authority: "interactive-cli", by: "operator", reason: "hold for a decision" },
      { run_id: "R", task_id: risky.taskId, step: "risk_judge.escalated", pr_number: risky.prNumber,
        head_sha: risky.headSha, issue_url: "https://github.com/o/r/issues/1" },
      { run_id: "R", task_id: capped.taskId, step: "review.posted", pr_url: capped.prUrl, head_sha: capped.headSha,
        state: "success", capped: true },
    ],
  });
  try {
    const refusal = decideSweepArm(capped, f.rows);
    assert.equal(refusal.arm, false, "control: the capped verdict is a decideSweepArm refusal");
    await f.hook(INTERPHASE);
    assert.deepEqual(f.armed, [], "no refused head reaches deps.arm");
    assert.match(String(f.disposed(moved.prNumber)?.stand_down_reason), /^head moved from head-115/);
    assert.match(String(f.disposed(held.prNumber)?.stand_down_reason), /operator merge hold/);
    assert.match(String(f.disposed(risky.prNumber)?.stand_down_reason), /^risk judge escalated this head/);
    assert.equal(f.disposed(capped.prNumber)?.stand_down_reason, refusal.reason);
    for (const pr of [moved, held, risky, capped]) {
      assert.equal(f.disposed(pr.prNumber)?.light_pass_scope, "interphase-review");
      assert.notEqual(f.disposed(pr.prNumber)?.stand_down_reason, reviewOnlyStandDownReason("interphase-review"));
    }
  } finally { f.cleanup(); }

  // Two overlapping interphase passes on one head: the second names the arm already in flight.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: number[] = [];
  const pr = readyPr(1151025);
  const overlap = fixture([pr], { arm: async (p) => { calls.push(p.prNumber); await gate; return "armed" as const; } });
  try {
    const first = overlap.hook(INTERPHASE);
    for (let i = 0; i < 200 && calls.length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, "precondition: the first pass's arm is in flight");
    await overlap.hook(INTERPHASE);
    assert.equal(calls.length, 1, "the overlapping pass does not call deps.arm");
    assert.match(String(overlap.disposed(pr.prNumber)?.stand_down_reason), /arm for this head is already in flight/);
    release();
    await first;
    assert.equal(overlap.disposed(pr.prNumber)?.arm_outcome, "armed");
  } finally { release(); overlap.cleanup(); }
});

test("interphase pass holds compare and refresh-selected heads without update-branch", async () => {
  const unreadable = readyPr(1151031);
  const overlapping = readyPr(1151032);
  const waiting = readyPr(1151033);
  const clean = readyPr(1151034);
  const f = fixture([unreadable, overlapping, waiting, clean], {
    compare: (n) => n === unreadable.prNumber ? new Error("compare: HTTP 502")
      : n === overlapping.prNumber ? { ahead_by: 2, files: [{ filename: FILE }] }
        : { ahead_by: 0, files: [] },
    seed: [{ run_id: "R", task_id: "SWEEP", step: "sweep.base_red.refresh_admission",
      waiting: [{ pr_number: waiting.prNumber, head_sha: waiting.headSha }] }],
  });
  try {
    await f.hook(INTERPHASE);
    assert.deepEqual(f.updates, [], "no update-branch call");
    assert.equal(f.rows.filter((r) => String(r.step).startsWith("sweep.update_branch")).length, 0);
    assert.deepEqual(f.armed.map((a) => a.pr), [clean.prNumber], "only the unheld ready head arms");
    assert.equal(f.disposed(unreadable.prNumber)?.stand_down_reason,
      "ready PR distance is unreadable — held until its compare succeeds");
    for (const pr of [overlapping, waiting]) {
      const row = f.disposed(pr.prNumber);
      assert.equal(row?.acted, false, `#${pr.prNumber} is held`);
      assert.match(String(row?.stand_down_reason), /held for the ordinary pass's refresh, not armed/);
    }
  } finally { f.cleanup(); }

  // Control: the ordinary pass refreshes the overlapping head the interphase pass held.
  const ordinary = fixture([overlapping], { compare: () => ({ ahead_by: 2, files: [{ filename: FILE }] }) });
  try {
    await ordinary.hook();
    assert.deepEqual(ordinary.updates, [overlapping.prNumber]);
  } finally { ordinary.cleanup(); }
});

test("fix conflict and CodeQL repair lanes stay closed on an interphase pass", async () => {
  const red = ownRedPr(1151041);
  const cancelled = cancelledOnlyPr(1151042);
  const conflict = conflictedPr(1151043);
  const codeql = readyPr(1151044, { codeqlHeadAlerts: { headSha: "head-1151044",
    alerts: [{ alertNumber: 9, ruleId: "js/sql-injection", severity: "high", path: FILE, line: 3, message: "tainted" }] } });
  const ruling = { run_id: "R", task_id: codeql.taskId, step: CODE_SCANNING_FIX_STEP, pr_number: codeql.prNumber,
    pr_url: codeql.prUrl, head_sha: codeql.headSha, alert_numbers: [9], rule_ids: ["js/sql-injection"],
    source: "fix", reason: "a real injection" };
  const closed = reviewOnlyStandDownReason("interphase-review");
  const f = fixture([red, cancelled, conflict, codeql], { seed: [ruling] });
  try {
    await f.hook(INTERPHASE);
    for (const pr of [red, cancelled, conflict, codeql]) {
      const row = f.disposed(pr.prNumber);
      assert.equal(row?.acted, false, `#${pr.prNumber} stands down`);
      assert.equal(row?.stand_down_reason, closed, `#${pr.prNumber} names the review-only scope`);
    }
    assert.deepEqual(f.fixes, [], "no fix starts");
    assert.deepEqual(f.requeues, [], "no requeue starts");
    assert.deepEqual(f.escalations, [], "the CodeQL route reaches no escalation");
    assert.deepEqual(f.armed, [], "a head ruled for a fix is not armed");
    assert.equal(f.rows.filter((r) => r.step === "code_scanning.fix_dispatch").length, 0);
    assert.equal(f.rows.filter((r) => r.step === CODE_SCANNING_FIX_STEP && r.pr_number === codeql.prNumber).length, 1,
      "the ruling row survives for the next ordinary pass");
  } finally { f.cleanup(); }

  // Control: the next ordinary pass reads the surviving ruling and takes the CodeQL fix route.
  const ordinary = fixture([readyPr(1151045, { codeqlHeadAlerts: { headSha: "head-1151045", alerts: codeql.codeqlHeadAlerts!.alerts } })],
    { seed: [{ ...ruling, task_id: "W1-T1151045", pr_number: 1151045, pr_url: "https://github.com/o/r/pull/1151045", head_sha: "head-1151045" }] });
  try {
    await ordinary.hook();
    assert.notEqual(ordinary.disposed(1151045)?.stand_down_reason, closed);
    assert.equal(ordinary.rows.filter((r) => r.step === "code_scanning.fix_dispatch" && r.pr_number === 1151045).length, 1,
      "the ordinary pass prepares the CodeQL fix");
  } finally { ordinary.cleanup(); }
});
