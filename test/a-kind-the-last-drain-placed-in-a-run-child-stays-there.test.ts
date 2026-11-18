import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { runDaemon, type DaemonFreshness } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import {
  createDetachedWorkHost, DETACHED_WORK_KINDS, detachedWorkPlacement, HOSTED_DETACHED_WORK_KINDS, measureDrainCosts, priorChildPlacements,
  spawnRunChild, startRunChildProbe, type DetachedWorkEvidence, type DetachedWorkSpec,
} from "#src/lib/run-child.js";
import type { RunResult } from "#src/lib/run-result.js";
import { adoptChildWork, installDetachedWorkHost, resetChildWork } from "#src/lib/sweep.js";

// The 2026-11-18 16:20Z shape: older drains waited on reviews and light-pass actions, never on a fix dispatch, and the
// newest drain row (16:20:56.221Z) placed the hosted kinds in a run child.
const placement = (child: readonly string[]) =>
  Object.fromEntries(DETACHED_WORK_KINDS.map((kind) => [kind, child.includes(kind) ? "child" : "process"]));
const olderDrain = { step: "daemon.freshness_drain.completed", ts: "2026-11-18T14:43:00.000Z", duration_ms: 400_000, in_flight_reviews: 1,
  waited_on: [{ what: "review", kind: "review", settled_after_ms: 279_727 }, { what: "detached", kind: "light-pass-action", settled_after_ms: 400_565 }],
  detached_work_placement: placement(["review"]) };
const newestDrain = { step: "daemon.freshness_drain.completed", ts: "2026-11-18T16:20:56.221Z", duration_ms: 1_000, in_flight_reviews: 0,
  waited_on: [], detached_work_placement: placement(["review", "fix-dispatch", "retro"]) };
const live1620 = [olderDrain, { step: "fix.dispatch", ts: "2026-11-18T16:00:00.000Z", lane: "sweep-fix" }, newestDrain];

const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: false, verdict: "no_pr", costUsd: 0 });

function fixture() {
  resetChildWork();
  const root = mkdtempSync(join(tmpdir(), "rmd-prior-child-"));
  const stateRoot = join(root, "state");
  const rows: Array<Record<string, unknown>> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); };
  const spawned: DetachedWorkSpec[] = [];
  const spawn = (async (input: { work?: DetachedWorkSpec }) => {
    spawned.push(input.work!);
    return { started: true, runId: `work-${input.work!.kind}-1`, dir: root, pid: 1, settled: Promise.resolve(result("A")), abort: async () => ({}) };
  }) as unknown as typeof spawnRunChild;
  const probe = (async () => ({ started: false, reason: "fixture probe" })) as unknown as typeof startRunChildProbe;
  const host = (mode: "off" | "shadow" | "on" | "auto", readLedger: () => ReadonlyArray<Record<string, unknown>>,
    readUnion?: Parameters<typeof createDetachedWorkHost>[0]["readUnion"]) => createDetachedWorkHost({
    stateRoot, repoDir: root, root, repo: "fixture", log, readLedger, readMode: () => mode, spawn, probe, ...(readUnion ? { readUnion } : {}),
  });
  const askFix = (h: ReturnType<typeof host>) => h.spawnFix({ pr: { prNumber: 19439, headSha: "f".repeat(40) }, fixKey: "fix-key", envelope: {} });
  return { root, stateRoot, rows, log, spawned, host, askFix, cleanup: () => { resetChildWork(); rmSync(root, { recursive: true, force: true }); } };
}

/** One restart drain through runDaemon, with the production host installed; returns the completed drain row it wrote. */
async function drain(f: ReturnType<typeof fixture>, mode: "on" | "off" | "shadow", ledger: ReadonlyArray<Record<string, unknown>>) {
  installDetachedWorkHost(f.host(mode, () => []));
  // A fix child left running makes the restart write its drain row; it is never settled here.
  resetChildWork();
  void adoptChildWork({ runId: "work-fix-left", taskId: "A", settled: new Promise<void>(() => {}),
    work: { kind: "fix-dispatch", prNumber: 19362, headSha: "e".repeat(40), fixKey: "fix-key-left" } }, f.log);
  const planPath = join(f.root, "tasks.yaml");
  writeFileSync(planPath, "[]");
  const rows: Array<Record<string, unknown>> = [];
  const summary = await runDaemon(loadPlan(planPath), {
    adoptRunChildren: () => [], refreshMerged: () => () => true, openPrCount: () => 0,
    runOne: async (id) => result(id), sleep: async () => { await flush(); },
    log: (step, fields) => { rows.push({ step, ...fields }); },
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
    sweep: async () => {}, sleepUntilSweepWake: async () => { await flush(); return "timeout"; }, sweepLight: async () => {},
    readLedgerLines: () => ledger.map((row) => JSON.stringify(row)),
  }, { laneCount: 1, wipLimit: 1, pollIntervalMs: 5 });
  assert.equal(summary.stopReason, "stale");
  const completed = rows.find((row) => row.step === "daemon.freshness_drain.completed");
  assert.ok(completed, "the restart wrote its drain row");
  return completed;
}

test("W1-T13711 criterion 1: a fix the last drain placed in a run child starts a run child, also after a rotation", async () => {
  const f = fixture();
  try {
    assert.equal(measureDrainCosts(live1620)["fix-dispatch"], undefined, "no drain in the live ledger waited on a fix dispatch");
    const child = await f.askFix(f.host("on", () => live1620));
    assert.equal(child?.runId, "work-fix-dispatch-1", "spawnFix started a run child");
    assert.deepEqual(f.spawned.map((work) => work.kind), ["fix-dispatch"]);
    const evidence: DetachedWorkEvidence = { mode: "on", hosted: HOSTED_DETACHED_WORK_KINDS,
      measured: measureDrainCosts(live1620), priorChild: priorChildPlacements(live1620) };
    const decided = detachedWorkPlacement("fix-dispatch", evidence);
    assert.equal(decided.placement, "child");
    assert.equal(decided.reason, "it ran as a run child at the last drain");
    assert.match(detachedWorkPlacement("review", evidence).reason, /279727 ms/, "a measured wait still gives its own reason");

    // A rotation keeps the newest drain row live, so the host's real live read still finds the placement.
    const ledgerPath = join(f.stateRoot, "ledger.ndjson");
    const filler = Array.from({ length: 400 }, (_, i) => JSON.stringify({ step: "fixture.filler", i, pad: "x".repeat(200) }));
    mkdirSync(f.stateRoot, { recursive: true });
    writeFileSync(ledgerPath, [...live1620.map((row) => JSON.stringify(row)), ...filler].join("\n") + "\n");
    const rotated = rotateLedger(ledgerPath, { ceilingBytes: 4_096, smoothingWindowMs: 0 });
    assert.equal(rotated.rotated, true, "the fixture ledger rotated");
    assert.equal(readLedgerLines(ledgerPath).some((row) => row.step === "fixture.filler"), false, "the filler left the live ledger");
    const afterRotation = await f.askFix(f.host("on", () => readLedgerLines(ledgerPath)));
    assert.equal(afterRotation?.runId, "work-fix-dispatch-1", "the fix still starts a run child after the rotation");
    assert.equal(f.spawned.length, 2);
  } finally { installDetachedWorkHost(undefined); f.cleanup(); }
});

test("W1-T13711 criterion 2: a drain after a drain that placed fix-dispatch in a child places it in a child, across restarts", async () => {
  const f = fixture();
  try {
    const first = await drain(f, "on", live1620);
    const placed = first.detached_work_placement as Record<string, string>;
    assert.equal(placed["fix-dispatch"], "child", "the 16:20:57Z drain keeps the fix dispatch in a child");
    assert.equal(placed.review, "child", "the review keeps its measured placement");
    assert.equal(placed.retro, "child");
    assert.equal(placed["light-pass-action"], "process", "a kind no entry hosts stays in process");
    // The next restart reads the row the first one wrote: the placement carries from drain to drain.
    const second = await drain(f, "on", [...live1620, first]);
    assert.equal((second.detached_work_placement as Record<string, string>)["fix-dispatch"], "child");
    const third = await drain(f, "on", [first, second].map((row) => ({ ...row, waited_on: [] })));
    assert.equal((third.detached_work_placement as Record<string, string>)["fix-dispatch"], "child", "with no measured wait at all");
  } finally { installDetachedWorkHost(undefined); f.cleanup(); }
});

test("W1-T13711 criterion 3: a kind no drain waited on and no drain placed in a child stays in process", async () => {
  const f = fixture();
  try {
    // Only the NEWEST drain row counts: an older row that placed fix-dispatch in a child is not evidence.
    const newestInProcess = [newestDrain, { ...olderDrain, ts: "2026-11-18T16:20:57.510Z" }];
    assert.deepEqual([...priorChildPlacements(newestInProcess)], ["review"]);
    assert.equal(await f.askFix(f.host("on", () => newestInProcess)), undefined, "no run child for the fix");
    const evidence: DetachedWorkEvidence = { mode: "on", hosted: HOSTED_DETACHED_WORK_KINDS,
      measured: measureDrainCosts(newestInProcess), priorChild: priorChildPlacements(newestInProcess) };
    assert.equal(detachedWorkPlacement("fix-dispatch", evidence).placement, "process");
    assert.match(detachedWorkPlacement("fix-dispatch", evidence).reason, /never held a drain/);
    assert.equal(detachedWorkPlacement("retro", evidence).placement, "process");

    // A newest drain row without the field, or a torn one, gives no kinds; other rows give nothing either.
    const { detached_work_placement: _dropped, ...withoutField } = newestDrain;
    assert.equal(priorChildPlacements([newestDrain, withoutField]).size, 0);
    assert.equal(priorChildPlacements([JSON.stringify(newestDrain), "{\"step\":\"daemon.freshness_drain.completed\",\"detached_wo"]).size, 0);
    assert.equal(priorChildPlacements([{ step: "fix.dispatch", detached_work_placement: placement(["fix-dispatch"]) }]).size, 0);
    assert.equal(priorChildPlacements([]).size, 0);
    assert.deepEqual([...priorChildPlacements([JSON.stringify(newestDrain), "{ torn line"])], ["review", "fix-dispatch", "retro"],
      "a torn line that is not a drain row is skipped");
    assert.equal(await f.askFix(f.host("on", () => [newestDrain, withoutField])), undefined);
    assert.equal(f.spawned.length, 0, "no case started a run child");

    const completed = await drain(f, "on", newestInProcess);
    assert.equal((completed.detached_work_placement as Record<string, string>)["fix-dispatch"], "process", "the drain decides the same");
  } finally { installDetachedWorkHost(undefined); f.cleanup(); }
});

test("W1-T13711 criterion 4: mode off or shadow, a demoted auto mode, or an unhosted kind stays in process despite the last drain", async () => {
  const f = fixture();
  try {
    const prior = priorChildPlacements([{ ...newestDrain, detached_work_placement: placement(DETACHED_WORK_KINDS) }]);
    assert.equal(prior.size, DETACHED_WORK_KINDS.length);
    for (const mode of ["off", "shadow"] as const) {
      const evidence: DetachedWorkEvidence = { mode, hosted: HOSTED_DETACHED_WORK_KINDS, measured: {}, priorChild: prior };
      assert.deepEqual(DETACHED_WORK_KINDS.filter((kind) => detachedWorkPlacement(kind, evidence).placement === "child"), [], mode);
      assert.equal(await f.askFix(f.host(mode, () => live1620)), undefined, `${mode}: spawnFix starts no child`);
      const completed = await drain(f, mode, live1620);
      assert.equal((completed.detached_work_placement as Record<string, string>)["fix-dispatch"], "process", `${mode}: the drain keeps it in process`);
    }
    const on: DetachedWorkEvidence = { mode: "on", hosted: HOSTED_DETACHED_WORK_KINDS, measured: {}, priorChild: prior };
    for (const kind of DETACHED_WORK_KINDS.filter((k) => !HOSTED_DETACHED_WORK_KINDS.has(k))) {
      assert.equal(detachedWorkPlacement(kind, on).placement, "process", `${kind}: no entry hosts it`);
      assert.match(detachedWorkPlacement(kind, on).reason, /no run-child entry hosts it/);
    }
    assert.equal(detachedWorkPlacement("fix-dispatch", { ...on, hosted: new Set() }).placement, "process");
    assert.equal(detachedWorkPlacement("not-a-kind", on).placement, "process");

    // Auto mode demoted by a lost child: the tracker says children are unavailable, so the prior placement does not move the fix.
    const lost = [
      { step: "daemon.start", ts: "2026-10-12T12:00:00Z" },
      { step: "run_child.shadow", ts: "2026-10-12T12:01:00Z", contract: "ok", tree_peak_bytes: 100, class_estimate_bytes: 200 },
      { step: "daemon.start", ts: "2026-10-12T12:02:00Z" },
      { step: "run_child.adoption_pass", ts: "2026-10-12T12:02:01Z", live: 1, adopted: 1, misidentified: 0, unreadable: 0 },
      { step: "run_child.lost", ts: "2026-10-12T12:02:03Z", detail: "process exited without a terminal status" },
    ];
    const demoted = f.host("auto", () => live1620, () => ({ rows: lost, unread: [] }));
    assert.equal(demoted.mode(), "shadow");
    assert.equal(await f.askFix(demoted), undefined, "a demoted mode keeps the fix in process");
    assert.equal(f.spawned.length, 0, "no case started a run child");
  } finally { installDetachedWorkHost(undefined); f.cleanup(); }
});
