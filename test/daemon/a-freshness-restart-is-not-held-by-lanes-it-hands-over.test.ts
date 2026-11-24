// test/daemon/a-freshness-restart-is-not-held-by-lanes-it-hands-over.test.ts — W1-T14662.
//
// 2026-11-24, host ledger: 214 daemon.freshness_decision defer rows against 2 restarts, 210 of them busy on "lanes", while
// the blue-green switch (state/daemon-handoff.on) was on and the successor adopted every live run child it found. A lane
// whose run child the successor adopts is not work a restart interrupts, so under the switch it no longer holds the
// restart; an in-process lane, a lane whose child is not adoptable, a review, a direct merge and interruptible detached
// work still do. Adoptability is asked through the same guards boot adoption applies, without adopting anything.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import { attemptArmAsync, directMergeOperationsInFlight, openDirectMergeAdmissions } from "#src/lib/arm-auto-merge.js";
import { runDaemon, type DaemonDeps, type DaemonFreshness } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import * as runChild from "#src/lib/run-child.js";
import * as runChildReservation from "#src/lib/run-child-reservation.js";
import { RUN_CHILD_SCHEMA, writeSpec, writeStatus, type RunChildProbe, type RunChildStatus } from "#src/lib/run-child-contract.js";
import { detachSweepAction, trackInFlightReview } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const tempRoot = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14662-${label}-`));
  scratch.push(dir);
  return dir;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const result = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: false, verdict: "no_pr", costUsd: 0 });
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await delay(2); }
  assert.fail(`never observed: ${what}`);
}

// A low-weight advance: a busy daemon defers it, an idle one restarts at once (W1-T10054's own fixture change).
const STALE: DaemonFreshness = { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "feat: x", files: ["src/lib/inbox.ts"] }] };

type LaneKind = "child" | "in-process";
type Decision = Record<string, unknown>;

/**
 * The real daemon with two lanes running (A and B, on disjoint files). Once both started, freshness reads stale and the
 * first freshness_decision taken while they run is returned. `switchOn` undefined leaves DaemonDeps.handoff unwired;
 * `adoptable` undefined leaves DaemonDeps.runChildAdoptable unwired.
 */
async function decisionWhileLanesRun(input: {
  lanes: Record<"A" | "B", LaneKind>;
  switchOn?: boolean;
  adoptable?: (dir: string) => boolean;
  /** Starts other work before the daemon runs; returns its release. */
  hold?: () => () => void;
}): Promise<{ decision: Decision; asked: string[]; dirs: Record<string, string> }> {
  const root = tempRoot("lanes");
  const path = join(root, "tasks.yaml");
  writeFileSync(path, (["A", "B"] as const).map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const dirs = { A: join(root, "runs", "A-run"), B: join(root, "runs", "B-run") };
  const settles = new Map((["A", "B"] as const).map((id) => [id, deferred<RunResult>()]));
  const rows: Array<{ step: string } & Decision> = [];
  const asked: string[] = [];
  const started: string[] = [];
  let stale = false;
  let stop = false;
  const release = input.hold?.();
  const handoff = input.switchOn === undefined ? {} : {
    handoff: { enabled: () => input.switchOn!, begin: async () => undefined },
  };
  const adoptable = input.adoptable === undefined ? {} : {
    runChildAdoptable: (dir: string) => { asked.push(dir); return input.adoptable!(dir); },
  };
  const run = runDaemon(loadPlan(path), {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => false,
    checkStop: () => stop ? "cleanup" : undefined,
    checkFreshness: () => stale ? STALE : { stale: false },
    sleep: async () => { await delay(1); },
    runOne: (id, options) => {
      started.push(id);
      const settled = settles.get(id as "A" | "B")!.promise;
      if (input.lanes[id as "A" | "B"] === "child") {
        options!.onChild!({ started: true, runId: `${id}-run`, dir: dirs[id as "A" | "B"], pid: process.pid, settled,
          abort: async () => { throw new Error("a freshness restart never aborts a child"); } });
      }
      return settled;
    },
    log: (step, extra) => { rows.push({ step, ...extra }); },
    ...handoff,
    ...adoptable,
  } as DaemonDeps, { laneCount: 2, pollIntervalMs: 5, freshnessMinLifetimeMs: 0 });
  try {
    await until(() => started.length >= 2, "both lanes started");
    stale = true;
    await until(() => rows.some((r) => r.step === "daemon.freshness_decision"), "a freshness decision while the lanes run");
    const decision = rows.find((r) => r.step === "daemon.freshness_decision")!;
    return { decision, asked, dirs };
  } finally {
    stop = true;
    release?.();
    for (const [id, settle] of settles) settle.resolve(result(id));
    await run;
  }
}

const bothChildren = { A: "child", B: "child" } as const;

test("W1-T14662 criterion 1: live lanes whose run children are adoptable read idle under the handoff switch, so the restart is decided at once", async () => {
  const { decision, asked, dirs } = await decisionWhileLanesRun({ lanes: bothChildren, switchOn: true, adoptable: () => true });
  assert.deepEqual(decision.busy_reasons, [], "a lane the successor adopts is nothing a restart interrupts");
  assert.equal(decision.busy, false);
  assert.equal(decision.action, "restart", "an idle daemon restarts on a low-weight advance");
  assert.match(String(decision.reason), /^idle/);
  assert.equal(decision.adoptable_lanes, 2, "the row names how many lanes the restart hands over");
  assert.deepEqual([...new Set(asked)].sort(), [dirs.A, dirs.B], "each lane's own run directory was asked");
});

// ── the pure guards adoption applies, over run directories on disk ─────────────────────────────────────────────────────
const GENERATION = { containerId: "w1-t14662-host", initStart: "proc:1" };
const LIVE_PID = 424_242, GONE_PID = 424_243, UNKNOWN_PID = 424_244;
const probe: RunChildProbe = {
  process: (pid) => pid === LIVE_PID ? { state: "alive", start: "proc:7" }
    : pid === UNKNOWN_PID ? { state: "unknown", reason: "fixture: start time unreadable" } : { state: "gone" },
  generation: () => GENERATION,
};
const INSTANCE = "w1-t14662";

function runDirs() {
  const stateRoot = join(tempRoot("runs"), "state");
  const add = (runId: string, over: {
    instance?: string; reservationId?: string; specRunId?: string; pid?: number; state?: RunChildStatus["state"];
    work?: unknown; statusText?: string;
  } = {}): string => {
    const dir = join(stateRoot, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const spec = { schema: RUN_CHILD_SCHEMA, runId: over.specRunId ?? runId, taskId: `T-${runId}`, instance: over.instance ?? INSTANCE,
      engine: { sha: "abc", sourceHash: "hash" }, planSnapshotPath: join(stateRoot, "plan.json"),
      reservationId: over.reservationId ?? `res-${runId}`, options: {} };
    writeSpec(dir, spec);
    // A work child's spec carries `work` beside the contract's own fields (run-child.ts readWorkSpec).
    if (over.work !== undefined) writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec, work: over.work }));
    if (over.statusText !== undefined) { writeFileSync(join(dir, "status.json"), over.statusText); return dir; }
    writeStatus(dir, { schema: RUN_CHILD_SCHEMA, runId: over.specRunId ?? runId,
      identity: { pid: over.pid ?? LIVE_PID, startTicks: "proc:7", containerGeneration: GENERATION },
      engineSha: "abc", entryKind: "bundle", phase: "implement", heartbeatAt: 0, state: over.state ?? "running" });
    return dir;
  };
  return { stateRoot, add };
}

test("W1-T14662 criterion 1: a live run child of this instance holding its reservation is adoptable under run-child mode on or auto", () => {
  const { stateRoot, add } = runDirs();
  const dir = add("live");
  const ask = { instance: INSTANCE, settledRunIds: new Set<string>(), probe, stateRoot };
  assert.equal(runChild.runChildAdoptionRefusal(dir, ask), undefined, "boot adoption would reattach it");
  const reservation = runChildReservation.runChildReservationAdoptable(dir, probe);
  assert.equal(reservation?.reservationId, "res-live", "and reclaim the reservation its spec names");
  assert.equal(reservation?.identity.pid, LIVE_PID);
  for (const mode of ["on", "auto"] as const) {
    assert.equal(runChild.runChildHandsOver(dir, { ...ask, mode }), true, `mode ${mode}`);
  }
});

test("W1-T14662 criterion 2: with the handoff switch off, live lanes still make the restart busy exactly as on origin/main", async () => {
  for (const switchOn of [false, undefined]) {
    const { decision } = await decisionWhileLanesRun({ lanes: bothChildren, switchOn, adoptable: () => true });
    assert.deepEqual(decision.busy_reasons, ["lanes"], `switch ${String(switchOn)}`);
    assert.equal(decision.action, "defer");
    assert.equal("adoptable_lanes" in decision, false, "no adoptability is asked without the switch");
  }
});

test("W1-T14662 criterion 2: left unwired, or answering not adoptable, the run-child question keeps lanes busy", async () => {
  const unwired = await decisionWhileLanesRun({ lanes: bothChildren, switchOn: true });
  assert.deepEqual(unwired.decision.busy_reasons, ["lanes"], "unwired answers not adoptable");
  assert.equal(unwired.decision.action, "defer");
  assert.equal(unwired.decision.adoptable_lanes, 0);
  const refused = await decisionWhileLanesRun({ lanes: bothChildren, switchOn: true, adoptable: (dir) => dir.endsWith("A-run") });
  assert.deepEqual(refused.decision.busy_reasons, ["lanes"], "one lane whose child is not adoptable holds the restart");
  assert.equal(refused.decision.action, "defer");
  assert.equal(refused.decision.adoptable_lanes, 1);
});

test("W1-T14662 criterion 2: a lane running inside the daemon's own process has no child to adopt and stays busy", async () => {
  const { decision, asked, dirs } = await decisionWhileLanesRun({ lanes: { A: "child", B: "in-process" }, switchOn: true, adoptable: () => true });
  assert.deepEqual(decision.busy_reasons, ["lanes"]);
  assert.equal(decision.action, "defer");
  assert.equal(decision.adoptable_lanes, 1);
  assert.deepEqual([...new Set(asked)], [dirs.A], "only the child lane is asked");
});

test("W1-T14662 criterion 2: the composition root's question reads the mode at each ask and the instance once", () => {
  const { stateRoot, add } = runDirs();
  const live = add("live");
  let mode: "on" | "off" | undefined = "on";
  let instanceReads = 0;
  const adoptable = runChild.runChildAdoptableAt({ stateRoot, readMode: () => mode, probe,
    instance: () => { instanceReads += 1; return INSTANCE; }, settledRunIds: new Set<string>() });
  assert.equal(adoptable(live), true, "mode on: the live child with its reservation is handed over");
  mode = "off";
  assert.equal(adoptable(live), false, "the mode is read again: off adopts nothing");
  mode = undefined;
  assert.equal(adoptable(live), false, "an unreadable mode adopts nothing");
  assert.equal(instanceReads, 1, "the instance name is read once");
  const foreign = runChild.runChildAdoptableAt({ stateRoot, readMode: () => "on", probe, instance: () => "elsewhere", settledRunIds: new Set<string>() });
  assert.equal(foreign(live), false, "a child of another instance is not this boot's to hand over");
});

test("W1-T14662 criterion 2: run-child mode off, no reservation, an unreadable child or no child process is not adoptable", () => {
  const { stateRoot, add } = runDirs();
  const ask = { instance: INSTANCE, settledRunIds: new Set(["settled"]), probe, mode: "on" as const, stateRoot };
  const live = add("live");
  assert.equal(runChild.runChildHandsOver(live, { ...ask, mode: "off" }), false, "run-child mode off");
  assert.equal(runChild.runChildHandsOver(live, { ...ask, mode: "shadow" }), false, "run-child mode shadow");
  assert.equal(runChild.runChildHandsOver(live, { ...ask, mode: undefined }), false, "an unreadable mode");
  const refused: Record<string, string> = {
    "no reservation": add("unreserved", { reservationId: "" }),
    "unreadable status": add("torn", { statusText: "{" }),
    "unreadable start time": add("unknown", { pid: UNKNOWN_PID }),
    "no child process": add("gone", { pid: GONE_PID }),
    "terminal child": add("done", { state: "done" }),
    "another instance": add("foreign", { instance: "elsewhere" }),
    "misidentified directory": add("misnamed", { specRunId: "other" }),
    "malformed work spec": add("malformed", { work: { kind: "not-a-kind" } }),
    "settled run": add("settled"),
  };
  assert.equal(runChild.runChildHandsOver(live, { ...ask, stateRoot: join(stateRoot, "elsewhere") }), false,
    "a directory outside the state root's runs/ is never scanned by boot adoption");
  for (const [why, dir] of Object.entries(refused)) assert.equal(runChild.runChildHandsOver(dir, ask), false, why);
  assert.equal(runChild.runChildHandsOver(live, ask), true, "the positive control in the same tree");
});

test("W1-T14662 criterion 3: an in-flight review, a direct merge and interruptible detached work still hold the restart under the switch", async () => {
  const held = {
    reviews: () => { const d = deferred<void>(); void trackInFlightReview(d.promise, { taskId: "A", prNumber: 1 }); return () => d.resolve(); },
    detached_work: () => { const d = deferred<void>(); detachSweepAction(d.promise, { actionKind: "fix-dispatch", taskId: "A" }); return () => d.resolve(); },
    direct_merge: () => {
      openDirectMergeAdmissions();
      const write = deferred<void>();
      const merging = attemptArmAsync("https://github.com/craigoley/remudero/pull/14662", {
        armAuto: async () => { throw Object.assign(new Error("refused"), { stderr: "GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)" }); },
        isMerged: async () => false, say: () => {}, mergeDirect: () => write.promise,
      } as unknown as Parameters<typeof attemptArmAsync>[1], "c".repeat(40));
      return () => { write.resolve(); void merging; };
    },
  } as const;
  for (const [reason, hold] of Object.entries(held)) {
    const { decision } = await decisionWhileLanesRun({ lanes: bothChildren, switchOn: true, adoptable: () => true, hold });
    assert.deepEqual(decision.busy_reasons, [reason], `${reason} is interrupted by a restart whatever the switch`);
    assert.equal(decision.action, "defer");
    assert.equal(decision.adoptable_lanes, 2, "the lanes themselves were handed over");
    await until(() => directMergeOperationsInFlight().length === 0, "the held merge settled");
  }
});

// ── the extraction leaves boot adoption as it was ──────────────────────────────────────────────────────────────────────
test("W1-T14662: boot adoption reattaches exactly the run directories the extracted guard leaves unrefused", async () => {
  const { stateRoot, add } = runDirs();
  for (const runId of ["live", "unreserved", "settled"]) add(runId);
  add("gone", { pid: GONE_PID });
  add("done", { state: "done" });
  add("unreserved2", { reservationId: "" });
  add("torn", { statusText: "{" });
  add("unknown", { pid: UNKNOWN_PID });
  add("foreign", { instance: "elsewhere" });
  add("misnamed", { specRunId: "other" });
  add("misnamed-dead", { specRunId: "other2", pid: GONE_PID });
  add("malformed", { work: { kind: "not-a-kind" } });
  add("review", { work: { kind: "review", prNumber: 7 } });
  mkdirSync(join(stateRoot, "runs", "probe-1"), { recursive: true });
  const settledRunIds = new Set(["settled"]);
  const rows: Array<Record<string, unknown>> = [];
  const reserved: string[] = [];
  const adopted = runChild.adoptRunChildren({ stateRoot, instance: INSTANCE, settledRunIds, log: (step, extra) => { rows.push({ step, ...extra }); } }, {
    probe, watch: false, pollMs: 5,
    reserve: (dir, _deps, seen) => {
      reserved.push(dir);
      assert.equal(seen, probe, "the reservation guard reads the same probe");
      return undefined;
    },
  });
  try {
    const unrefused = ["live", "unreserved", "gone", "done", "settled", "unreserved2", "torn", "unknown", "foreign", "misnamed",
      "misnamed-dead", "malformed", "review", "probe-1"]
      .filter((runId) => runChild.runChildAdoptionRefusal(join(stateRoot, "runs", runId), { instance: INSTANCE, settledRunIds, probe }) === undefined)
      .sort();
    assert.deepEqual(adopted.map((child) => child.runId).sort(), unrefused);
    assert.deepEqual(unrefused, ["done", "gone", "live", "review", "unreserved", "unreserved2"], "the population is what adoption has always taken");
    assert.deepEqual(reserved.map((dir) => dir.split("/").at(-1)).sort(), ["live", "review", "unreserved", "unreserved2"], "only live children reach the reservation");
    assert.deepEqual(rows.filter((r) => String(r.step).startsWith("run_child.adoption")).map((r) => [r.step, r.run_id]).sort(), [
      ["run_child.adoption_misidentified", "misnamed"],
      ["run_child.adoption_pass", undefined],
      ["run_child.adoption_unreadable", "malformed"],
      ["run_child.adoption_unreadable", "torn"],
      ["run_child.adoption_unreadable", "unknown"],
    ]);
    assert.deepEqual(rows.find((r) => r.step === "run_child.adoption_pass"), { step: "run_child.adoption_pass", live: 5, adopted: 4, unreadable: 3, misidentified: 1 });
    assert.equal(runChildReservation.runChildReservationAdoptable(join(stateRoot, "runs", "unreserved2"), probe), undefined, "a spec naming no reservation");
  } finally {
    for (const child of adopted) child.detach?.();
  }
});
