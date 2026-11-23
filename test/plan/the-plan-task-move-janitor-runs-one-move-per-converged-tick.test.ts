/**
 * W1-T13681: the daemon's move janitor runs one movePlanTask step per converged tick. Every tick here drives the real
 * mover (src/lib/plan-task-move.ts) over two real Git origins (test/helpers/plan-move-world.ts); the janitor's own
 * ports are this suite's model of the host: the switch file, the daemon's ops dispatch hold and catalog read, and
 * GitHub's direct pull request read.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, type DaemonDeps, type OpsTaskDispatchRead } from "#src/lib/daemon.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { detachedActionInFlight, drainDetachedSweepActions } from "#src/lib/sweep.js";
import type { MovePin, MoverPull, PlanTaskMover, PlanTaskMovePorts, PlanTaskMoveSwitch } from "#src/lib/plan-task-move-janitor.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { moveWorld, OPS, PUBLIC, record, shard, type ModelPull, type MoveWorld } from "#test/helpers/plan-move-world.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Json = Record<string, unknown>;
type Row = { step: string; data: Json };
const A = "W1-T1", B = "W1-T2";
const ON: PlanTaskMoveSwitch = { move: { outcome: "on", repository: OPS, checkoutDir: "" }, dispatch: { outcome: "on", repository: OPS, checkoutDir: "" } };

/** Loaded at call time, so on a tree without the janitor the daemon-loop claim above still reads red for its own reason. */
const janitor = () => import("#src/lib/plan-task-move-janitor.js");
const cli = () => import("#src/cli/commands/daemon.js");

interface Model {
  ports: PlanTaskMovePorts;
  calls: { switch: number; heads: number; dry: number; apply: number; pulls: number };
  /** Every port but the mover, with both origins' refs compared before and after: a read never writes. */
  readsWrote: string[];
  merge(pr: ModelPull): string;
  /** Hold every apply at its start until `release`; `entered` settles when the first one starts. */
  hold(): { entered: Promise<void>; release(): void };
  set(over: Partial<{ sw: PlanTaskMoveSwitch; catalog: string | undefined; lag: boolean; onMain: boolean; failApply: boolean; apiDown: boolean }>): void;
}

/** The janitor's ports over one move world: each move is the real verb at both current mains. */
function janitorModel(w: MoveWorld): Model {
  const merges = new Map<number, string>();
  const calls = { switch: 0, heads: 0, dry: 0, apply: 0, pulls: 0 };
  let sw = ON, catalog: string | undefined = "ok", lag = false, mainOverride: boolean | undefined, failApply = false, apiDown = false;
  const readsWrote: string[] = [];
  let held: { gate: Promise<void>; enter: () => void } | undefined;
  const refsOf = (side: "public" | "ops") => w.sides[side].origin.git("for-each-ref", "--format=%(refname) %(objectname)");
  const both = () => `${refsOf("public")}\n--\n${refsOf("ops")}`;
  const reading = <T>(name: string, read: () => Promise<T>) => async (): Promise<T> => {
    const before = both();
    try { return await read(); } finally { if (both() !== before) readsWrote.push(name); }
  };
  const ports: PlanTaskMovePorts = {
    readSwitch: () => { calls.switch++; return sw; },
    readOpsCatalog: () => catalog,
    readHeads: async ops => reading("readHeads", async () => {
      calls.heads++;
      return { ops, publicRepository: PUBLIC, publicCommit: w.main("public"), opsCommit: w.main("ops"), key: both() };
    })(),
    move: async (_pin: MovePin, apply: boolean) => {
      if (apply) { calls.apply++; if (held) { held.enter(); await held.gate; } } else calls.dry++;
      // A mover process killed mid-step: the promise rejects and nothing reports.
      if (apply && failApply) { failApply = false; throw new Error("mover child killed"); }
      if (apiDown) return { status: 1, out: (await w.run(apply, { graphql: async () => ({ errors: [{ message: "rate limited" }] }) })).out };
      // GitHub's search can lag a pull request just opened: the model hides open mover pull requests from it.
      const run = await w.run(apply, lag ? { graphql: async query => {
        const answer = w.answer(query) as { data: Json };
        const none = { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] };
        return { data: { ...answer.data, publicMoves: none, opsMoves: none } };
      } } : {});
      return { status: run.status, out: run.out };
    },
    readPull: async (_pin, _side, number) => reading("readPull", async () => {
      calls.pulls++;
      const pr = w.pulls.find(row => row.number === number);
      if (!pr) throw new Error("no such pull request");
      return pr.state === "MERGED" ? { state: "MERGED" as const, mergeCommit: merges.get(number)! } : { state: pr.state as "OPEN" | "CLOSED" };
    })(),
    onMain: async (_pin, side, commit) => reading("onMain", async () => {
      if (mainOverride !== undefined) return mainOverride;
      try { w.sides[side].origin.git("merge-base", "--is-ancestor", commit, "main"); return true; }
      catch (error) { void error; return false; }
    })(),
  };
  return {
    ports, calls, readsWrote,
    merge: pr => { const sha = w.merge(pr); merges.set(pr.number, sha); return sha; },
    hold: () => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      held = { gate, enter };
      return { entered, release: () => { held = undefined; release(); } };
    },
    set: over => {
      if (over.sw) sw = over.sw; if ("catalog" in over) catalog = over.catalog; if (over.lag !== undefined) lag = over.lag;
      if ("onMain" in over) mainOverride = over.onMain; if (over.failApply !== undefined) failApply = over.failApply;
      if (over.apiDown !== undefined) apiDown = over.apiDown;
    },
  };
}

const EMPTY_OPS = mergePlanBlobs([{ label: "ops", text: "[]\n" }]);
const HEALTHY_OPS: OpsTaskDispatchRead = { outcome: "selected", publicCommit: "a".repeat(40),
  source: { outcome: "ok", plan: EMPTY_OPS, opsCommit: "b".repeat(40), identityDigest: "c".repeat(64) } };

/** `ticks` iterations of the real daemon loop with the janitor wired, every other rung idle. */
async function daemonIterations(mover: PlanTaskMover, ticks: number, readOps: () => OpsTaskDispatchRead = () => HEALTHY_OPS): Promise<Row[]> {
  const plan = mergePlanBlobs([{ label: "public", text: "- id: PUBLIC-T1\n  title: public fixture\n  repo: remudero\n  type: implement\n" }]);
  const rows: Row[] = [];
  let tick = 0;
  const deps = {
    refreshMerged: () => () => true, targetRepo: "remudero",
    runOne: async (id: string) => ({ taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }),
    checkPause: () => undefined, checkStop: () => (++tick > ticks ? "fixture stop" : undefined),
    sleep: async () => {}, log: (step: string, data: Json = {}) => { rows.push({ step, data }); },
    readOpsTaskDispatch: readOps,
    planTaskMover: mover,
  } as unknown as DaemonDeps;
  await runDaemon(plan, deps);
  return rows;
}

/** A bounded wait: on a tree without the janitor nothing ever settles it, and the claim reads red, not hung. */
const within = (work: Promise<void>, ms = 60_000) => Promise.race([work.then(() => true), delay(ms).then(() => false)]);

test("W1-T13681 criterion 1: with move_public_tasks true and every gate open, one daemon iteration starts exactly one movePlanTask --apply step, detached as plan-task-move, and an iteration while it is in flight starts none", async t => {
  const w = moveWorld(t, { [A]: record(A), [B]: record(B) });
  const m = janitorModel(w);
  const mover: PlanTaskMover = { ports: m.ports, memory: {} };
  const held = m.hold();
  await daemonIterations(mover, 3);
  assert.equal(await within(held.entered), true, "THE CLAIM: a daemon iteration with the switch on started a move step");
  assert.equal(detachedActionInFlight("plan-task-move"), true, "the step runs detached as the plan-task-move action");
  assert.equal(m.calls.switch, 1, "the two iterations after it started no second tick while the first was in flight");
  await daemonIterations(mover, 2);
  assert.equal(m.calls.switch, 1, "nor do two more iterations while the step is still in flight");
  assert.deepEqual([m.calls.dry, m.calls.apply], [1, 1], "one dry run and one --apply step");
  held.release();
  await drainDetachedSweepActions({ boundMs: 120_000 });
  assert.equal(detachedActionInFlight("plan-task-move"), false);
  assert.deepEqual(w.pulls.map(pr => [pr.repository, pr.state]), [["ops", "OPEN"]], "exactly one step ran: the ops copy");

  // The next iteration, with that copy still open, takes no step.
  await daemonIterations(mover, 1);
  await drainDetachedSweepActions({ boundMs: 120_000 });
  assert.equal(m.calls.apply, 1, "no second step while the first step's pull request is open");
  assert.equal(w.pulls.length, 1);
});

/** One tick of the janitor itself, its rows collected. */
async function tick(mover: PlanTaskMover, rows: Row[], opsDispatchHold?: string) {
  const { runPlanTaskMoveTick } = await janitor();
  return runPlanTaskMoveTick({ opsDispatchHold, log: (step, data) => { rows.push({ step, data }); } }, mover);
}
const standDowns = (rows: Row[]) => rows.filter(row => row.step === "plan.move.stand_down").map(row => [row.data.reason, row.data.detail ?? null]);
const openMovers = (w: MoveWorld) => w.pulls.filter(pr => pr.state === "OPEN" && pr.head.startsWith("plan-move-"));
const sharedIds = (w: MoveWorld, ids: string[]) => ids.filter(id => w.holds("public", id) && w.holds("ops", id));

test("W1-T13681 criterion 2: no new pick while a move is pending (only its converging step runs), a mover pull request is open, the last step is unverified on its main, the preview is unknown, ops dispatch is held or the ops catalog read is not ok; one stand_down row per change of reason; it resumes on the first tick after the condition clears", async t => {
  const w = moveWorld(t, { [A]: record(A), [B]: record(B) });
  const m = janitorModel(w);
  const mover: PlanTaskMover = { ports: m.ports, memory: {} };
  const rows: Row[] = [];

  // Pick gates closed: the ops catalog read the claim path uses answers anything but ok, or ops dispatch is held.
  for (const catalog of ["ref_moved", "stale", "unreadable", undefined]) {
    m.set({ catalog });
    assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "ops_catalog_unavailable", detail: catalog ?? "pending" });
  }
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "ops_catalog_unavailable", detail: "pending" }, "an unchanged reason");
  m.set({ catalog: "ok" });
  assert.deepEqual(await tick(mover, rows, "ref_moved"), { outcome: "stand_down", reason: "ops_dispatch_held", detail: "ref_moved" });
  assert.equal(m.calls.apply, 0, "no pick while a pick gate is closed");
  assert.equal(m.calls.dry, 1, "the dry-run answer is kept while no ref of either repository moved");
  assert.deepEqual(standDowns(rows), [["ops_catalog_unavailable", "ref_moved"], ["ops_catalog_unavailable", "stale"],
    ["ops_catalog_unavailable", "unreadable"], ["ops_catalog_unavailable", "pending"], ["ops_dispatch_held", "ref_moved"]],
  "one row per change of reason: the repeated pending tick wrote none");

  // The first tick after the gates clear takes the step, with no time passing and nothing else changed.
  assert.deepEqual(await tick(mover, rows), { outcome: "step", step: "copy" });
  const [copy] = w.pulls;
  // The copy is open: GitHub's search lags it, and the janitor's own direct read still holds every step.
  m.set({ lag: true });
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "mover_pull_request_open" });
  assert.equal(w.pulls.length, 1, "no second pick while the mover pull request is open, even unseen by search");

  // Merged, but not yet verified on its main: nothing runs; verified, the converging step runs.
  m.merge(copy!);
  m.set({ lag: false, onMain: false });
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "last_step_unverified" });
  m.set({ onMain: undefined });
  // A move is pending (the copied id in both catalogs): with every pick gate closed, only its converging step runs.
  m.set({ catalog: "ref_moved" });
  assert.deepEqual(await tick(mover, rows, "duplicate_task_id"), { outcome: "step", step: "remove" });
  // W1-T14345: one copy carries the whole batch, so the whole batch is pending, and only its converging step runs.
  assert.deepEqual(copy!.files, [shard(A), shard(B)]);
  assert.deepEqual(sharedIds(w, [A, B]), [A, B], "positive control: the removal ran while the copied batch was pending");
  assert.equal(w.pulls.filter(pr => pr.repository === "ops").length, 1, "and no new copy was picked");
  const [, removal] = w.pulls;
  m.merge(removal!);
  // W1-T14345: the batch carried both records, so no pick is left to wait for the ops catalog read.
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "nothing_to_move" },
    "the batch moved every record: nothing is left to pick");

  // A mover pull request another writer opened: the mover's own WAIT holds the pick.
  m.set({ catalog: "ok" });
  const hand = w.openPull("public", { head: "plan-move-W1-T7-1", files: [shard("W1-T7")] });
  // GitHub writes refs/pull/<n>/head when a pull request opens, so a ref of the public repository moved.
  w.pub.origin.git("update-ref", `refs/pull/${hand.number}/head`, w.main("public"));
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "mover_pull_request_open" });
  w.close(hand);
  w.commitTo("public", { "notes.txt": "a main moved\n" }, "an unrelated merge");

  // The preview answers unknown: no step; the first tick after the read answers again takes it, with no ref moved.
  m.set({ apiDown: true });
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "preview_unknown", detail: "api_unreadable" });
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "preview_unknown", detail: "api_unreadable" });
  m.set({ apiDown: false });
  // W1-T14345: the read answers again on the first tick; with the batch moved, its answer is that nothing is left.
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "nothing_to_move" }, "resumed on the first tick after the condition cleared");
  assert.deepEqual(openMovers(w).map(pr => pr.repository), []);
  assert.equal(standDowns(rows).filter(([reason]) => reason === "preview_unknown").length, 1, "one row for a repeated unknown");
  assert.deepEqual(m.readsWrote, [], "no read port wrote a ref");

  // Event-gated: the janitor holds no timer, interval, clock or count of its own. With every timer and the clock mocked
  // and frozen, each tick settles on microtasks alone, and step after step runs at the same instant as soon as the
  // last one lands; a second run at another wall time answers the same.
  const { createPlanTaskMover, runPlanTaskMoveTick } = await janitor();
  const fixed: MovePin = { ops: { repository: OPS, checkoutDir: "/nonexistent" }, publicRepository: PUBLIC, publicCommit: "a".repeat(40), opsCommit: "b".repeat(40), key: "k" };
  const clockFree = async () => {
    let gate = "stale", pull: MoverPull = { state: "OPEN" };
    const pure = createPlanTaskMover({ readSwitch: () => ON, readOpsCatalog: () => gate, readHeads: async () => fixed,
      move: async (_pin, apply) => ({ status: 0, out: apply ? { step: "copy", applied: true, repository: OPS, pullRequest: 7 } : { step: "copy" } }),
      readPull: async () => pull, onMain: async () => true });
    const seen: unknown[] = [];
    const settle = async () => {
      let settled = false;
      const done = runPlanTaskMoveTick({ opsDispatchHold: undefined, log: () => {} }, pure).then(out => { settled = true; return out; });
      for (let turn = 0; turn < 1000 && !settled; turn++) await null;
      assert.equal(settled, true, "a tick settles on microtasks alone: it waits on no timer");
      seen.push(await done);
    };
    await settle();
    gate = "ok";
    for (let round = 0; round < 5; round++) { await settle(); pull = { state: "OPEN" }; await settle(); pull = { state: "MERGED", mergeCommit: "c".repeat(40) }; }
    await settle();
    return seen;
  };
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "setImmediate", "Date"], now: 0 });
  try {
    const early = await clockFree();
    assert.deepEqual(early, [{ outcome: "stand_down", reason: "ops_catalog_unavailable", detail: "stale" },
      ...Array.from({ length: 5 }, () => [{ outcome: "step", step: "copy" }, { outcome: "stand_down", reason: "mover_pull_request_open" }]).flat(),
      { outcome: "step", step: "copy" }], "every landed step frees the next one at the same frozen instant: no interval, no count");
    t.mock.timers.setTime(10 * 365 * 86_400_000);
    assert.deepEqual(await clockFree(), early, "and the same gates answer the same at any wall time");
  } finally { t.mock.timers.reset(); }
});

test("W1-T13681 criterion 2: the daemon hands its own ops dispatch hold to the tick, and a daemon with no ops dispatch wired picks nothing", async t => {
  const w = moveWorld(t, { [A]: record(A) });
  const m = janitorModel(w);
  const unwired: PlanTaskMover = { ports: m.ports, memory: {} };
  const plan = mergePlanBlobs([{ label: "public", text: "- id: PUBLIC-T1\n  title: public fixture\n  repo: remudero\n  type: implement\n" }]);
  const rows: Row[] = [];
  let tickCount = 0;
  await runDaemon(plan, { refreshMerged: () => () => true, targetRepo: "remudero", sleep: async () => {},
    runOne: async (id: string) => ({ taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }),
    checkStop: () => (++tickCount > 1 ? "fixture stop" : undefined), log: (step: string, data: Json = {}) => { rows.push({ step, data }); },
    planTaskMover: unwired } as unknown as DaemonDeps);
  await drainDetachedSweepActions({ boundMs: 120_000 });
  const held = await daemonIterations({ ports: m.ports, memory: {} }, 1, () => ({ outcome: "unavailable", reason: "ref_moved",
    source: { outcome: "ref_moved", refusalStage: "final_ref" } }) as OpsTaskDispatchRead);
  await drainDetachedSweepActions({ boundMs: 120_000 });
  assert.deepEqual(standDowns(rows), [["ops_dispatch_held", "ops_dispatch_unwired"]]);
  assert.deepEqual(standDowns(held), [["ops_dispatch_held", "ref_moved"]], "the hold the daemon ledgered is the reason the tick names");
  assert.equal(m.calls.apply, 0);
  assert.equal(w.pulls.length, 0);
});

test("W1-T13681 criterion 3: move_public_tasks absent or false does nothing and writes no row; any other value or a file changed during the read stands down; dispatch_ops_tasks off stands down too", async t => {
  const { planTaskMoveSwitch } = await cli();
  const w = moveWorld(t, { [A]: record(A) });
  const stateDir = join(w.root, "host", "state");
  mkdirSync(stateDir, { recursive: true });
  const write = (record: Json | undefined) => {
    const path = join(stateDir, "plan-destination.json");
    if (record === undefined) rmSync(path, { force: true }); else writeFileSync(path, JSON.stringify(record));
  };
  const base = { repository: OPS, kinds: [] };
  const read = () => planTaskMoveSwitch(stateDir);
  write(undefined);
  assert.deepEqual(read(), { move: { outcome: "off" }, dispatch: { outcome: "off" } });
  write({ ...base, dispatch_ops_tasks: true });
  assert.deepEqual(read().move, { outcome: "off" }, "absent is off");
  write({ ...base, dispatch_ops_tasks: true, move_public_tasks: false });
  assert.deepEqual(read().move, { outcome: "off" }, "false is off");
  write({ ...base, dispatch_ops_tasks: true, move_public_tasks: "yes" });
  assert.deepEqual(read().move, { outcome: "unavailable", reason: "invalid_move_flag" });
  write({ ...base, dispatch_ops_tasks: true, move_public_tasks: true });
  const on = { outcome: "on", repository: OPS, checkoutDir: join(stateDir, "..", "repos", "ops") };
  assert.deepEqual(read(), { move: on, dispatch: on }, "both on name the ops repository and its host checkout");
  write({ ...base, repository: "other/ops", move_public_tasks: true });
  let first = true;
  const changing = planTaskMoveSwitch(stateDir, path => {
    const text = readFileSync(path, "utf8");
    if (first) { first = false; writeFileSync(path, JSON.stringify({ ...base, move_public_tasks: true })); }
    return text;
  });
  assert.deepEqual(changing.move, { outcome: "unavailable", reason: "selection_changed" }, "a file that changes during the read");
  write({ repository: OPS, kinds: "task", move_public_tasks: true });
  assert.deepEqual(read().move, { outcome: "unavailable", reason: "selection_unreadable" }, "the canonical repository validation applies");
  writeFileSync(join(stateDir, "plan-destination.json"), "[]");
  assert.deepEqual(read().move, { outcome: "unavailable", reason: "selection_unreadable" });
  writeFileSync(join(stateDir, "plan-destination.json"), "{");
  assert.deepEqual(read().move, { outcome: "unavailable", reason: "selection_unreadable" });

  // The tick over the real file: off writes no row and reads nothing else, even with a move pending.
  const m = janitorModel(w);
  const fromFile: PlanTaskMovePorts = { ...m.ports, readSwitch: () => planTaskMoveSwitch(stateDir) };
  const mover: PlanTaskMover = { ports: fromFile, memory: {} };
  const rows: Row[] = [];
  write({ ...base, dispatch_ops_tasks: true, move_public_tasks: true });
  assert.deepEqual(await tick(mover, rows), { outcome: "step", step: "copy" }, "positive control: switched on, the tick steps");
  m.merge(w.pulls[0]!);
  for (const off of [undefined, { ...base, dispatch_ops_tasks: true }, { ...base, dispatch_ops_tasks: true, move_public_tasks: false }]) {
    write(off);
    const heads = m.calls.heads;
    assert.deepEqual(await tick(mover, rows), { outcome: "off" });
    assert.equal(m.calls.heads, heads, "switched off, the tick reads no main");
  }
  assert.deepEqual(rows.filter(row => row.step.startsWith("plan.move.")).map(row => row.step), ["plan.move.janitor_step"], "off writes no row");
  assert.deepEqual(sharedIds(w, [A]), [A], "the pending move is left for the switch: off stops the converging step too");
  write({ ...base, dispatch_ops_tasks: true, move_public_tasks: 1 });
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "move_switch_unavailable", detail: "invalid_move_flag" });
  write({ ...base, move_public_tasks: true });
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "ops_dispatch_off" });
  write({ ...base, dispatch_ops_tasks: "on", move_public_tasks: true });
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "ops_dispatch_unavailable", detail: "invalid_dispatch_flag" });
  assert.equal(w.pulls.length, 1, "nothing moved while the switch stood the tick down");
  write({ ...base, dispatch_ops_tasks: true, move_public_tasks: true });
  assert.deepEqual(await tick(mover, rows), { outcome: "step", step: "remove" }, "switched back on, the pending move converges");
});

test("W1-T13681 criterion 5: a tick cut off mid-step leaves a state the next tick's converging step repairs; the janitor removes no record itself and only ever calls movePlanTask", async t => {
  const w = moveWorld(t, { [A]: record(A) });
  const m = janitorModel(w);
  const mover: PlanTaskMover = { ports: m.ports, memory: {} };
  const rows: Row[] = [];
  const somewhere = () => assert.ok(w.holds("public", A) || w.holds("ops", A), "A is held by at least one catalog at every point");

  // The mover process killed during its copy: the tick fails, and the next one takes the same step again.
  m.set({ failApply: true });
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "tick_failed", detail: "Error" });
  somewhere();
  assert.deepEqual(await tick(mover, rows), { outcome: "step", step: "copy" });
  m.merge(w.pulls[0]!);
  // Cut off after the removal branch was pushed but before its pull request opened: no pull request, the next tick repeats it.
  w.failCreate(new Error("connection reset"));
  assert.deepEqual(await tick(mover, rows), { outcome: "stand_down", reason: "step_not_applied", detail: "pull_request_failed" });
  somewhere();
  w.failCreate(undefined);
  assert.deepEqual(await tick(mover, rows), { outcome: "step", step: "remove" });
  m.merge(w.pulls[1]!);
  somewhere();
  // A hand edit then deleted the ops copy: neither catalog holds A, and the next tick restores it.
  w.commitTo("ops", { [shard(A)]: null }, "a hand deletion");
  assert.deepEqual(await tick(mover, rows), { outcome: "step", step: "restore" });
  m.merge(w.pulls[2]!);
  somewhere();
  assert.ok(w.holds("public", A), "restored");
  assert.deepEqual(m.readsWrote, [], "no port but the mover changed either repository");
  assert.ok(m.calls.heads > 0 && m.calls.pulls > 0, "positive control: the read ports ran");

  // The host ports run git for reads only and read GitHub with no write method; every step is the move-task verb in its
  // own process. Recorded at the ports' own seams, with canned answers, so no real git, gh or mover runs: a step that
  // lands here can only have come through that one process.
  const { planTaskMovePorts, runPlanTaskMoveTick } = await janitor();
  const argv = { git: [] as string[][], exec: [] as string[][], gh: [] as string[][] };
  const head = "c".repeat(40), fetched = new Set<string>();
  let pullRow: unknown = { state: "open", merged: false };
  const host = planTaskMovePorts({ publicRoot: "/public", publicRepository: PUBLIC, readSwitch: () => ON, readOpsCatalog: () => "ok",
    cliEntry: "/rmd-cli.ts", execArgv: [],
    git: root => async args => {
      argv.git.push(args);
      if (args[0] === "fetch") fetched.add(root);
      const status = args[0] === "cat-file" && !fetched.has(root) ? 1 : 0;
      return { status, stdout: args[0] === "ls-remote" ? `${head}\tHEAD\n${head}\trefs/heads/main\n` : "", stderr: "" };
    },
    exec: async (file, args) => {
      argv.exec.push([file, ...args]);
      return { stdout: `${JSON.stringify(args.includes("--apply") ? { step: "copy", applied: true, repository: OPS, pullRequest: 3 } : { step: "copy" })}\n`, stderr: "" };
    },
    gh: async args => { argv.gh.push(args); return pullRow; } });
  const hostMover: PlanTaskMover = { ports: host, memory: {} };
  const hostTick = () => runPlanTaskMoveTick({ opsDispatchHold: undefined, log: () => {} }, hostMover);
  assert.deepEqual(await hostTick(), { outcome: "step", step: "copy" });
  assert.deepEqual(await hostTick(), { outcome: "stand_down", reason: "mover_pull_request_open" });
  pullRow = { state: "closed", merged: true, merge_commit_sha: head };
  assert.deepEqual(await hostTick(), { outcome: "step", step: "copy" }, "the landed step frees the next, through the same verb");
  assert.deepEqual([...new Set(argv.git.map(args => args[0]))].sort(), ["cat-file", "fetch", "ls-remote", "merge-base"], "read-only git verbs");
  assert.ok(argv.git.filter(args => args[0] === "fetch").every(args => args.includes("--no-write-fetch-head")), "a fetch writes no FETCH_HEAD");
  assert.deepEqual(argv.gh, [["api", `repos/${OPS}/pulls/3`], ["api", `repos/${OPS}/pulls/3`]], "one direct REST read per tick, no write method");
  assert.equal(argv.exec.length, 4, "a dry run and an --apply step per step taken");
  for (const call of argv.exec) assert.deepEqual(call.slice(0, 3), [process.execPath, "/rmd-cli.ts", "move-task"], "each in its own process, through the verb");
  assert.deepEqual(argv.exec.map(call => call.includes("--apply")), [false, true, false, true]);
});

test("W1-T13681 criterion 6: no new pick while any id is held by both catalogs or a mover pull request is open, so at most one id is ever in the transient state", async t => {
  const ids = [A, B, "W1-T3"];
  const w = moveWorld(t, Object.fromEntries(ids.map(id => [id, record(id)])));
  const m = janitorModel(w);
  const mover: PlanTaskMover = { ports: m.ports, memory: {} };
  const rows: Row[] = [];
  // GitHub's search lags every mover pull request throughout: only the janitor's own gates hold the picks.
  m.set({ lag: true });
  // W1-T14345: one copy carries a batch, so the transient state holds at most the one batch the open step copied.
  const copied: string[] = [];
  let batch: string[] = [];
  for (let round = 0; round < 30 && w.pulls.filter(pr => pr.state === "MERGED").length < 2 * ids.length; round++) {
    const outcome = await tick(mover, rows);
    if (outcome.outcome === "step" && outcome.step === "copy") { batch = ids.filter(id => w.pulls.at(-1)!.files.includes(shard(id))); copied.push(...batch); }
    assert.ok(sharedIds(w, ids).every(id => batch.includes(id)), `only the one copied batch in both catalogs (round ${round})`);
    assert.ok(openMovers(w).length <= 1, `at most one mover pull request open (round ${round})`);
    // A second tick before any merge: nothing more.
    const again = await tick(mover, rows);
    assert.equal(again.outcome, "stand_down", `round ${round}: a tick with a step open takes none`);
    assert.ok(openMovers(w).length <= 1);
    const open = openMovers(w)[0];
    if (open) m.merge(open);
  }
  assert.deepEqual([...copied].sort(), [...ids].sort(), "each id was copied exactly once");
  assert.ok(ids.every(id => w.holds("ops", id) && !w.holds("public", id)), "and all three moved");
});

test("W1-T13681 criterion 7: across ticks that complete a move, roll one back and restore one, no refs/rmd-id ref is pushed, deleted or minted", async t => {
  const reservations = (w: MoveWorld) => [w.reservations(), w.ops.origin.git("for-each-ref", "refs/rmd-id/")];
  const run = async (w: MoveWorld, m: Model, mover: PlanTaskMover, until: (w: MoveWorld) => boolean) => {
    for (let round = 0; round < 12 && !until(w); round++) {
      await tick(mover, []);
      const open = openMovers(w)[0];
      if (open) m.merge(open);
    }
    assert.ok(until(w), "positive control: the move reached its end");
  };
  // Completed.
  const done = moveWorld(t, { [A]: record(A) });
  const before = reservations(done);
  assert.match(before[0]!, /^refs\/rmd-id\/W1-T1 [0-9a-f]{40}$/);
  const dm = janitorModel(done);
  await run(done, dm, { ports: dm.ports, memory: {} }, w => w.holds("ops", A) && !w.holds("public", A));
  assert.deepEqual(reservations(done), before);

  // Rolled back: the public copy is claimed once the ops copy landed.
  const rolled = moveWorld(t, { [A]: record(A) });
  const rolledBefore = reservations(rolled);
  const rm = janitorModel(rolled);
  const rmover: PlanTaskMover = { ports: rm.ports, memory: {} };
  assert.deepEqual(await tick(rmover, []), { outcome: "step", step: "copy" });
  rm.merge(rolled.pulls[0]!);
  rolled.pub.origin.git("update-ref", `refs/rmd-dispatch/${A}`, rolled.main("public"));
  assert.deepEqual(await tick(rmover, []), { outcome: "step", step: "rollback" });
  rm.merge(rolled.pulls[1]!);
  assert.ok(rolled.holds("public", A) && !rolled.holds("ops", A));
  assert.deepEqual(reservations(rolled), rolledBefore);

  // Restored: the ops copy vanished after the public removal landed.
  const restored = moveWorld(t, { [A]: record(A) });
  const restoredBefore = reservations(restored);
  const sm = janitorModel(restored);
  const smover: PlanTaskMover = { ports: sm.ports, memory: {} };
  await run(restored, sm, smover, w => !w.holds("public", A));
  restored.commitTo("ops", { [shard(A)]: null }, "a hand deletion");
  assert.deepEqual(await tick(smover, []), { outcome: "step", step: "restore" });
  sm.merge(restored.pulls.at(-1)!);
  assert.ok(restored.holds("public", A));
  assert.deepEqual(reservations(restored), restoredBefore);
  assert.equal(restoredBefore[1], "", "the ops repository holds no reservation ref either");
});

test("W1-T13681: every remaining stand-down is named, and a row that cannot be written takes no step", async () => {
  const { createPlanTaskMover, opsCatalogOutcomeReader, PLAN_MOVE_STAND_DOWN } = await janitor();
  const pin: MovePin = { ops: { repository: OPS, checkoutDir: "/nonexistent" }, publicRepository: PUBLIC, publicCommit: "a".repeat(40), opsCommit: "b".repeat(40), key: "k" };
  const fake = (over: Partial<PlanTaskMovePorts>): PlanTaskMover => createPlanTaskMover({
    readSwitch: () => ON, readOpsCatalog: () => "ok", readHeads: async () => pin,
    move: async () => ({ status: 0, out: { step: "none" } }), readPull: async () => ({ state: "OPEN" }), onMain: async () => true, ...over });
  const rows: Row[] = [];
  const reason = async (mover: PlanTaskMover, hold?: string) => { const out = await tick(mover, rows, hold); return out.outcome === "stand_down" ? [out.reason, out.detail ?? null] : [out.outcome]; };
  assert.deepEqual(await reason(fake({})), ["nothing_to_move", null]);
  assert.deepEqual(await reason(fake({ move: async () => ({ status: 0, out: { step: "complete" } }) })), ["nothing_to_move", null]);
  assert.deepEqual(await reason(fake({ move: async () => ({ status: 0, out: { step: "held", reason: "ops_copy_differs" } }) })), ["move_held", "ops_copy_differs"]);
  assert.deepEqual(await reason(fake({ move: async () => ({ status: 1, out: {} }) })), ["preview_unknown", null]);
  assert.deepEqual(await reason(fake({ readHeads: async () => { throw new Error("offline"); } })), ["heads_unreadable", "offline"]);
  assert.deepEqual(await reason(fake({ readHeads: async () => { throw new Error("a message that varies per call"); } })), ["heads_unreadable", "Error"],
    "a varying message is named by its class, so it never writes a row per tick");
  assert.deepEqual(await reason(fake({ readHeads: async () => { throw "offline"; } })), ["heads_unreadable", "string"]);
  assert.deepEqual(await reason(fake({ readSwitch: () => { throw new Error("EACCES"); } })), ["tick_failed", "EACCES"]);
  assert.deepEqual(await reason(fake({ readSwitch: () => ({ move: ON.move, dispatch: { outcome: "on", repository: "other/ops", checkoutDir: "" } }) })),
    ["move_switch_unavailable", "selection_changed"]);
  // The last step's reads failing hold every step.
  const opened = (over: Partial<PlanTaskMovePorts>) => { const mover = fake(over); mover.memory.lastStep = { side: "ops", number: 9 }; return mover; };
  assert.deepEqual(await reason(opened({ readPull: async () => { throw new Error("502"); } })), ["last_step_unreadable", "502"]);
  assert.deepEqual(await reason(opened({ readPull: async () => ({ state: "MERGED", mergeCommit: "c".repeat(40) }), onMain: async () => { throw new Error("128"); } })), ["last_step_unreadable", "128"]);
  const closed = opened({ readPull: async () => ({ state: "CLOSED" }) });
  assert.deepEqual(await reason(closed), ["nothing_to_move", null], "a closed last step frees the next tick");
  assert.equal(closed.memory.lastStep, undefined);
  // A step whose answer names no pull request is not recorded as open.
  const quiet = fake({ move: async (_pin, apply) => ({ status: apply ? 1 : 0, out: apply ? { step: "copy", applied: false } : { step: "copy" } }) });
  assert.deepEqual(await reason(quiet), ["step_not_applied", "copy"]);
  assert.equal(quiet.memory.lastStep, undefined);
  const publicStep = fake({ move: async (_pin, apply) => ({ status: 0, out: apply ? { step: "remove", applied: true, repository: PUBLIC, pullRequest: 4, id: A } : { step: "remove" } }) });
  assert.deepEqual(await reason(publicStep), ["step"]);
  assert.deepEqual(publicStep.memory.lastStep, { side: "public", number: 4 });
  assert.ok(rows.some(row => row.step === "plan.move.janitor_step" && row.data.side === "public" && row.data.pull_request === 4));
  // A ledger that throws costs the row, never the decision.
  const { runPlanTaskMoveTick } = await janitor();
  const broken = { opsDispatchHold: undefined, log: () => { throw new Error("disk full"); } };
  assert.deepEqual(await runPlanTaskMoveTick(broken, fake({})), { outcome: "stand_down", reason: "nothing_to_move" });
  const stepping = fake({ move: async (_pin, apply) => ({ status: 0, out: apply ? { step: "copy", applied: true, repository: OPS, pullRequest: 5 } : { step: "copy" } }) });
  assert.deepEqual(await runPlanTaskMoveTick(broken, stepping), { outcome: "step", step: "copy" });
  assert.equal(PLAN_MOVE_STAND_DOWN, "plan.move.stand_down");
  assert.equal(opsCatalogOutcomeReader(undefined)(), undefined);
  assert.equal(opsCatalogOutcomeReader({ forDispatch: () => ({ outcome: "ref_moved" }) })(), "ref_moved");
  assert.equal(opsCatalogOutcomeReader({ forDispatch: () => undefined })(), undefined);
});

/** Run `fn` with the world's Git URL rewrites, a gh shim and a scratch HOME in this process's environment. */
async function withHostEnv<T>(t: TestContext, w: MoveWorld, routes: Parameters<typeof ghShim>[0], fn: (shim: ReturnType<typeof ghShim>) => Promise<T>): Promise<T> {
  const shim = ghShim(routes);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const home = join(w.root, "home"); mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { ...w.env, PATH: `${shim.dir}:${process.env.PATH}`, HOME: home, RMD_GH_CACHE_HOME: home, RMD_SELF_SYNC_DONE: "1" };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return await fn(shim); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("W1-T13681: the host ports pin both mains with bounded git reads, read a pull request over REST, and run the verb in its own process", async t => {
  const { planTaskMovePorts } = await janitor();
  const w = moveWorld(t, { [A]: record(A) });
  const answer = join(w.root, "answer.json");
  const opsTarget = { repository: OPS, checkoutDir: w.ops.clone.dir };
  // The ops main moves after the clone was made: the pin must fetch the head's objects, writing no ref.
  const opsHead = w.commitTo("ops", { "notes.txt": "ops moved\n" }, "an ops merge");
  w.ops.clone.git("reset", "--quiet", "--hard", "HEAD~1");
  w.ops.clone.git("update-ref", "-d", "ORIG_HEAD");
  w.ops.clone.git("update-ref", "refs/remotes/origin/main", "HEAD");
  w.ops.clone.git("reflog", "expire", "--expire=now", "--all");
  w.ops.clone.git("gc", "--quiet", "--prune=now");
  const refsBefore = w.ops.clone.git("for-each-ref");
  await withHostEnv(t, w, [{ when: "api graphql", stdoutFile: answer },
    { when: `api repos/${OPS}/pulls/12`, stdout: JSON.stringify({ state: "open", merged: false }) },
    { when: "", exit: 97, stderr: "unexpected GitHub call" }], async () => {
    const ports = planTaskMovePorts({ publicRoot: w.pub.clone.dir, publicRepository: PUBLIC, readSwitch: () => ON, readOpsCatalog: () => "ok",
      cliEntry: join(REPO_ROOT, "src/run-task.ts"), execArgv: ["--import", import.meta.resolve("tsx")] });
    const pin = await ports.readHeads(opsTarget);
    assert.deepEqual([pin.publicCommit, pin.opsCommit], [w.main("public"), opsHead]);
    assert.equal(w.ops.clone.git("cat-file", "-t", opsHead), "commit", "the ops head's objects were fetched");
    assert.equal(w.ops.clone.git("for-each-ref"), refsBefore, "and no ref was written");
    w.commitTo("public", { "notes.txt": "public moved\n" }, "a public merge");
    assert.notEqual((await ports.readHeads(opsTarget)).key, pin.key, "a moved ref changes the key");
    await assert.rejects(ports.readHeads({ repository: OPS, checkoutDir: join(w.root, "no-checkout") }));

    // The verb's dry run, in its own process, through the CLI's own GitHub read.
    const fresh = await ports.readHeads(opsTarget);
    writeFileSync(answer, JSON.stringify(w.answer("")));
    const dry = await ports.move(fresh, false);
    assert.equal(dry.status, 0, JSON.stringify(dry));
    assert.deepEqual([dry.out.step, dry.out.would, dry.out.applied], ["copy", true, false]);
    assert.equal(w.pulls.length, 0);
    assert.equal(ports.readSwitch(), ON);
    assert.equal(ports.readOpsCatalog(), "ok");

    // GitHub's REST pull read, and ancestry on the pinned main.
    assert.deepEqual(await ports.readPull(fresh, "ops", 12), { state: "OPEN" });
    assert.equal(await ports.onMain(fresh, "ops", w.ops.clone.git("rev-parse", "HEAD")), true);
    const stray = w.pub.clone.git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", "-m", "stray", `${fresh.publicCommit}^{tree}`);
    assert.equal(await ports.onMain(fresh, "public", stray), false, "a commit off the pinned main is not on it");
    await assert.rejects(ports.onMain(fresh, "public", "f".repeat(40)), /ancestry_unreadable/);
  });

  // The verb exiting 1 still prints its one line; an unparsable answer reads as unknown.
  const fails = (stdout: unknown, code: unknown = 1) => planTaskMovePorts({ publicRoot: w.pub.clone.dir, publicRepository: PUBLIC, readSwitch: () => ON,
    readOpsCatalog: () => "ok", cliEntry: "unused", exec: async () => { throw Object.assign(new Error("Command failed"), { code, stdout }); } });
  const pin: MovePin = { ops: opsTarget, publicRepository: PUBLIC, publicCommit: w.main("public"), opsCommit: w.main("ops"), key: "k" };
  assert.deepEqual(await fails('{"step":"unknown","reason":"api_unreadable"}\n').move(pin, true), { status: 1, out: { step: "unknown", reason: "api_unreadable" } });
  assert.deepEqual(await fails("not json").move(pin, false), { status: 1, out: { reason: "answer_unparsable", detail: "SyntaxError" } });
  assert.deepEqual(await fails("[1]", null).move(pin, false), { status: 1, out: { reason: "answer_not_an_object" } });
  assert.deepEqual(await fails(undefined, 2).move(pin, false), { status: 2, out: { reason: "answer_unparsable", detail: "SyntaxError" } });
  // The REST answer's three states, and anything else refused.
  const pulls = (row: unknown) => planTaskMovePorts({ publicRoot: w.pub.clone.dir, publicRepository: PUBLIC, readSwitch: () => ON,
    readOpsCatalog: () => "ok", cliEntry: "unused", gh: async args => { assert.match(args[1]!, /^repos\/fixture\/remudero\/pulls\/3$/); return row; } });
  assert.deepEqual(await pulls({ state: "closed", merged: true, merge_commit_sha: "c".repeat(40) }).readPull(pin, "public", 3), { state: "MERGED", mergeCommit: "c".repeat(40) });
  assert.deepEqual(await pulls({ state: "closed", merged: false }).readPull(pin, "public", 3), { state: "CLOSED" });
  await assert.rejects(pulls(null).readPull(pin, "public", 3), /pull_request_unreadable/);
  // A head the fetch cannot bring is unreadable, never a stale pin.
  const { gitReservationRunnerAsync } = await import("#src/lib/task-id-reservation.js");
  const blind = planTaskMovePorts({ publicRoot: w.pub.clone.dir, publicRepository: PUBLIC, readSwitch: () => ON, readOpsCatalog: () => "ok", cliEntry: "unused",
    git: root => async args => args[0] === "cat-file" ? { status: 1, stdout: "", stderr: "" } : gitReservationRunnerAsync(root)(args) });
  await withHostEnv(t, w, [], async () => { await assert.rejects(blind.readHeads(opsTarget), /head_unfetched/); });
  // One side refused never leaves the other side's git running into the checkout: the pin settles both first.
  let slowExited = false;
  const uneven = planTaskMovePorts({ publicRoot: w.pub.clone.dir, publicRepository: PUBLIC, readSwitch: () => ON, readOpsCatalog: () => "ok", cliEntry: "unused",
    git: root => async () => {
      if (root !== w.pub.clone.dir) return { status: 128, stdout: "", stderr: "" };
      await delay(200); slowExited = true; return { status: 128, stdout: "", stderr: "" };
    } });
  await assert.rejects(uneven.readHeads(opsTarget), /ls_remote_unreadable/);
  assert.equal(slowExited, true, "the refusal waited for the other side's git to exit");
});
