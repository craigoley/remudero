import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import { pauseDetail, requestPause, requestStop, resumeFleet, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet } from "../src/lib/drain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T2965 — THE TOP-OF-TICK FRESHNESS EXIT PRECEDES EVERY DISPATCH.
//
// The loop has TWO stale exits. W1-T2960 guarded the lower one, at the admission gate. This file
// covers the upper one, which runs before the sweep and before dispatch — so on a lifetime that
// reads a stale main on its FIRST tick, the lower gate is unreachable and the process returns
// having dispatched nothing. Measured on the fleet: 33 consecutive container lifetimes ended
// `idle ticks: 0` while `daemon.freshness_deferred` was never written once.
//
// Same minimal plan the sibling freshness suite uses: two independent queued tasks, so "did this
// lifetime dispatch anything at all" is answerable without modelling the DAG.
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2965-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: true,
  costUsd: 0.5,
  verdict: "merged",
});

function fakeClock(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ── claim 1 ────────────────────────────────────────────────────────────────────
// The outage exactly: origin/main is already past this process's boot sha on the FIRST read, and
// stays past it forever. Before this task the daemon returned `stale` having attempted nothing.
test("W1-T2965: a stale main on the first tick does not exit before dispatch", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => mergedSet,
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    sleep: fakeClock().sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
    // Stale on EVERY read — the container's own merges keep main ahead of its boot sha.
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
  });

  assert.ok(
    s.attempted.length > 0,
    "a lifetime that has completed no cycle must reach dispatch before honouring a restart — " +
      "this is the `idle ticks: 0` livelock, and an empty `attempted` is it reproduced",
  );

  const deferred = lines.filter((l) => l.step === "daemon.freshness_deferred" && l.extra.phase === "pre_cycle");
  assert.equal(deferred.length, 1, "the deferral is a ONE-SHOT per lifetime, and it says so in the ledger");
  assert.equal(deferred[0]?.extra.old_sha, OLD_SHA);
  assert.equal(deferred[0]?.extra.new_sha, NEW_SHA);

  assert.equal(s.stopReason, "stale", "staleness is still honoured — deferred by one cycle, never discarded");
});

// ── claim 2 ────────────────────────────────────────────────────────────────────
// The bound. Once a cycle is behind it, the process is making progress, so the three-clocks guard
// (W1-T126) reclaims its priority at the very next tick boundary and nothing is deferred twice.
test("W1-T2965: a stale main exits at the top of the tick once a cycle has completed", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const lines: Array<{ step: string }> = [];
  let reads = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => mergedSet,
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    sleep: fakeClock().sleep,
    log: (step) => lines.push({ step }),
    // Fresh across the whole of the first tick (both its boundaries), stale from then on: this
    // lifetime HAS completed a cycle, so it must take the ordinary exit with nothing deferred.
    checkFreshness: (): DaemonFreshness =>
      ++reads <= 2 ? { stale: false } : { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA },
  });

  assert.equal(s.stopReason, "stale");
  assert.deepEqual(s.attempted, ["A"], "exactly the first cycle's batch ran — the second tick exited at the top");
  assert.ok(!merged.has("B"), "no extra cycle was granted to a process that had already made progress");
  assert.equal(
    lines.filter((l) => l.step === "daemon.freshness_deferred").length,
    0,
    "a process with a completed cycle defers nothing",
  );
  assert.equal(
    lines.filter((l) => l.step === "daemon_selfrestart_for_freshness").length,
    1,
    "the restart is still ledgered under its own step name, unchanged",
  );
});

// ── claim 3 ────────────────────────────────────────────────────────────────────
// PAUSE is checked ABOVE freshness (W1-T936) and `continue`s without entering the cycle. So paused
// heartbeats must not spend the one deferral a starved process is owed — otherwise a fleet resumed
// onto a stale main falls straight back into the livelock this task exists to end.
test("W1-T2965: pause still wins over a first-tick freshness deferral", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2965-pause-`));
  requestPause(root, "quiet hours");
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sleeps = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => mergedSet,
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    // Several paused heartbeats first, then resume onto a main that is still stale.
    sleep: async () => {
      if (++sleeps === 3) resumeFleet(root);
    },
    log: (step, extra = {}) => lines.push({ step, extra }),
    checkPause: () => pauseDetail(root),
    checkFreshness: (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
  });

  assert.ok(
    lines.filter((l) => l.step === "daemon.pause").length >= 2,
    "PAUSE was honoured first and idled in-process, never exiting for freshness",
  );
  assert.ok(
    s.attempted.length > 0,
    "the deferral survived the pause — paused heartbeats never enter a cycle, so they cannot spend it",
  );
  assert.equal(
    lines.filter((l) => l.step === "daemon.freshness_deferred" && l.extra.phase === "pre_cycle").length,
    1,
    "still exactly one PRE-CYCLE deferral, taken on the first cycle actually entered. Counted by " +
      "phase because W1-T2960's admission-gate deferral shares the step name and, once this cycle " +
      "is reachable at all, legitimately fires inside it — that it now does is this fix working.",
  );
  assert.equal(s.stopReason, "stale");
  requestStop(root, "done");
  stopDetail(root);
});
