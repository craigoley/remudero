import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan, type Task } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  daemonBoot,
  parseOrphanedBranch,
  reconstructOrphan,
  reconstructState,
  runDaemon,
  type DaemonDeps,
  type OrphanedRun,
} from "../src/lib/daemon.js";
import { pauseDetail, requestPause, requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet, OpenPrCheck } from "../src/lib/drain.js";
import { deriveStatus, type GitHub, type PrRef } from "../src/lib/status.js";

// A small linear-ish plan: A → B → C (chain) + D (independent), all auto.
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
  depends_on: [A]
  status: queued
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: [B]
  status: queued
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: H
  title: human-only
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;
function mergedSetOf(...ids: string[]): MergedSet {
  const s = new Set(ids);
  return (id) => s.has(id);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });
const blockedResult = (id: string): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: false,
  costUsd: 0.3,
  verdict: "blocked_review",
  prUrl: "https://github.com/o/r/pull/9",
});

/** A fake clock: resolves instantly (no real wall-clock wait) but records every call. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

// ── daemonBoot: the ANTHROPIC-clean-env boot assertion (W1-T12b) ───────────
// Run entirely in-process over an injected log + env — NO real launchd load
// (that live commissioning step is W1-T12d).

test("daemonBoot: a clean env logs daemon.boot with env_clean=true, billing_mode=subscription", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const cleanEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op" };
  const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }), cleanEnv);
  assert.deepEqual(result, { env_clean: true, billing_mode: "subscription" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "daemon.boot");
  assert.equal(lines[0].extra.env_clean, true);
  assert.equal(lines[0].extra.billing_mode, "subscription");
});

test("daemonBoot: a contaminated env (ANTHROPIC_* present) still logs, but env_clean=false — a loud canary, not a throw", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const dirtyEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op", ANTHROPIC_API_KEY: "KEY-SHOULD-NEVER-SURVIVE" };
  const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }), dirtyEnv);
  assert.deepEqual(result, { env_clean: false, billing_mode: "subscription" });
  assert.equal(lines[0].extra.env_clean, false);
  assert.equal(lines[0].extra.billing_mode, "subscription", "billing_mode is always subscription — this repo never runs a daemon in api mode");
});

test("daemonBoot: defaults to checking process.env when no env is injected", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const prior = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }));
    assert.equal(result.env_clean, true);
  } finally {
    if (prior !== undefined) process.env.ANTHROPIC_API_KEY = prior;
  }
});

// ── daemonBoot: the injected temp-dir sweep (W1-T115, the 26,711-dir ENOSPC
// incident's structural backstop) — "boot sweep removes stale dirs and reports":
// seeded stale + fresh dirs -> stale removed, fresh kept, count logged. The
// seeded-stale/fresh/removed/kept mechanics themselves are proven directly
// against real dirs on disk in test/tmp.test.ts's `sweepStaleTempDirs` suite;
// this pins the OTHER half of the claim — that daemonBoot actually calls the
// injected sweep once at boot and logs the removed/kept COUNT (not the raw
// summary) on a dedicated `daemon.tmp_sweep` ledger step.

test("daemonBoot: calls the injected sweepTmp once and logs daemon.tmp_sweep with the removed/kept COUNT", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const cleanEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op" };
  let sweepCalls = 0;
  const sweepTmp = () => {
    sweepCalls += 1;
    // Seeded as if two stale rmd- dirs were reaped and one fresh one kept —
    // the exact seeded-stale/seeded-fresh shape tmp.test.ts proves against a
    // real filesystem; daemonBoot only needs to log the COUNT of each.
    return { removed: ["rmd-review-stale-1", "rmd-review-stale-2"], kept: ["rmd-plan-fresh-1"] };
  };
  daemonBoot((step, extra = {}) => lines.push({ step, extra }), cleanEnv, sweepTmp);

  assert.equal(sweepCalls, 1, "the sweep runs exactly once at boot");
  const sweepLine = lines.find((l) => l.step === "daemon.tmp_sweep");
  assert.ok(sweepLine, "daemon.tmp_sweep is logged");
  assert.equal(sweepLine!.extra.removed, 2, "the removed COUNT is logged (2 stale dirs), not the raw array");
  assert.equal(sweepLine!.extra.kept, 1, "the kept COUNT is logged (1 fresh dir), not the raw array");
});

test("daemonBoot: an empty sweep result still logs daemon.tmp_sweep with zero counts (a clean boot is legible too)", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const cleanEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op" };
  const sweepTmp = () => ({ removed: [], kept: [] });
  daemonBoot((step, extra = {}) => lines.push({ step, extra }), cleanEnv, sweepTmp);

  const sweepLine = lines.find((l) => l.step === "daemon.tmp_sweep");
  assert.ok(sweepLine);
  assert.equal(sweepLine!.extra.removed, 0);
  assert.equal(sweepLine!.extra.kept, 0);
});

test("daemonBoot: no sweepTmp injected -> no daemon.tmp_sweep line at all (pre-W1-T115 behavior unchanged)", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const cleanEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op" };
  daemonBoot((step, extra = {}) => lines.push({ step, extra }), cleanEnv);
  assert.equal(lines.length, 1, "only daemon.boot — no sweep attempted when the dependency is omitted");
  assert.equal(lines[0].step, "daemon.boot");
});

// ── dispatch order: reuses drain.ts's DAG selection, never reimplements it ──

test("dispatches in dependency order (DAG), skipping verify:human and merged tasks", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: clock.sleep,
    },
    { max: 4 },
  );
  assert.deepEqual(ran, ["A", "B", "C", "D"]); // A before B before C (deps); D independent
  assert.deepEqual(s.merged, ["A", "B", "C", "D"]);
  assert.equal(s.stopReason, "max_reached");
  assert.ok(!ran.includes("H"), "verify:human is never auto-dispatched");
});

// ── W1-T80: dispatch dedup — an OPEN PR means IN-FLIGHT, never runnable ─────
// (the #143/#145 duplicate-build race applies to the daemon's persistent loop
// exactly as it does to a bounded `rmd drain`: nextRunnable is the SAME shared
// machinery, reused wholesale, never reimplemented — see this module's header.)

test("W1-T80: a task whose latest PR is OPEN is never re-dispatched — the daemon skips it (dispatch.skipped, PR number) and picks the next runnable task instead of halting", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 143 : undefined);
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isOpenPr,
      runOne: async (id) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: clock.sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (in-flight under open PR #143) was never re-dispatched as a duplicate build");
  assert.deepEqual(ran, ["D"]); // B/C still depend on the un-merged A; D is the only other candidate
  assert.equal(s.stopReason, "max_reached");
  const skipLine = lines.find((l) => l.step === "dispatch.skipped");
  assert.ok(skipLine, "a dispatch.skipped ledger line was emitted");
  assert.deepEqual(skipLine?.extra, { task: "A", reason: "open-pr", pr_number: 143 });
});

test("W1-T80: no isOpenPr wired ⇒ the daemon dispatches exactly as before this guard existed", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    { refreshMerged: () => (id) => merged.has(id), runOne: async (id) => { ran.push(id); merged.add(id); return okResult(id); }, sleep: clock.sleep },
    { max: 4 },
  );
  assert.deepEqual(ran, ["A", "B", "C", "D"]);
  assert.equal(s.stopReason, "max_reached");
});

// ── P29(ii): the per-task dispatch CIRCUIT BREAKER — the backstop that makes
// P29(i)'s sibling-credit fix (status.ts) safe to get wrong.

test("P29(ii): a circuit-broken task is never (re-)dispatched — the daemon skips it (dispatch.circuit_broken) and picks the next runnable task instead of halting", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const broken: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isCircuitTripped: (id) => id === "A",
      onCircuitBreak: (t) => broken.push(t.id),
      runOne: async (id) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: clock.sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (circuit-broken) was never dispatched");
  assert.deepEqual(ran, ["D"]); // B/C still depend on the un-merged A; D is the only other candidate
  assert.deepEqual(broken, ["A"], "the daemon's own onCircuitBreak fired exactly once for A");
  assert.equal(s.stopReason, "max_reached");
  const brokenLine = lines.find((l) => l.step === "dispatch.circuit_broken");
  assert.ok(brokenLine, "a dispatch.circuit_broken ledger line was emitted");
  assert.equal(brokenLine?.extra.task, "A");
});

test("P29(ii): no isCircuitTripped wired ⇒ the daemon dispatches exactly as before this breaker existed", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    { refreshMerged: () => (id) => merged.has(id), runOne: async (id) => { ran.push(id); merged.add(id); return okResult(id); }, sleep: clock.sleep },
    { max: 4 },
  );
  assert.deepEqual(ran, ["A", "B", "C", "D"]);
  assert.equal(s.stopReason, "max_reached");
});

test("P29(ii) the W1-T29 x10 spin shape: a circuit-broken task is escalated EXACTLY ONCE across MANY idle polls of the PERSISTENT daemon loop, never re-escalated tick after tick", async () => {
  // Unlike `rmd drain` (a bounded one-shot loop), the daemon POLLS FOREVER —
  // `nextRunnable` is re-invoked on every idle tick, so a naive wiring that
  // escalates once per OBSERVATION (rather than once per TASK for the whole
  // daemon run) would open — or attempt to open — a fresh escalation on every
  // single poll, unboundedly, for as long as the daemon keeps running. That is
  // the exact unbounded-noise shape P29 exists to prevent; this proves the
  // daemon's own dedup, independent of whatever dedup the CLI-layer escalation
  // callback itself does.
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const broken: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-circuit-spin-"));
  let calls = 0;
  const sleep = async (_ms: number) => {
    calls++;
    // D dispatches+merges on tick 1; every tick after that is idle (A stays
    // tripped forever; B/C stay unmet-dependency-blocked on A). After several
    // such idle polls, the "test operator" issues STOP so the test terminates
    // — proving the loop genuinely kept polling (re-observing A tripped each
    // time), not that it happened to stop after one look.
    if (calls >= 5) requestStop(root, "test done polling");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    isCircuitTripped: (id) => id === "A",
    onCircuitBreak: (t) => broken.push(t.id),
    runOne: async (id) => {
      ran.push(id);
      merged.add(id);
      return okResult(id);
    },
    checkStop: () => stopDetail(root),
    sleep,
  });
  assert.equal(s.stopReason, "stopped");
  assert.ok(calls >= 5, "the loop really did idle-poll multiple times before the test stopped it");
  assert.ok(!ran.includes("A"), "A (circuit-broken) was never dispatched, no matter how many polls observed it tripped");
  assert.deepEqual(ran, ["D"], "D is the only task ever dispatched");
  assert.deepEqual(broken, ["A"], "onCircuitBreak fired EXACTLY ONCE for A across the WHOLE daemon run, despite 5+ re-observations");
});

// ── STOP / PAUSE (W1-T11) ───────────────────────────────────────────────────

test("STOP: checked first, every tick — halts within one tick, no subsequent spawns", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-stop-"));
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      ran.push(id);
      requestStop(root, "operator hard-stop");
      merged.add(id);
      return okResult(id);
    },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: clock.sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
  });
  assert.equal(s.stopReason, "stopped");
  assert.deepEqual(ran, ["A"]); // STOP is checked at the very next tick — no B/C/D
  assert.ok(
    lines.some((l) => l.step === "daemon.stop" && /operator hard-stop/.test(String(l.extra.detail))),
    "a daemon.stop ledger line, carrying the reason, was emitted",
  );
});

test("STOP set before the daemon even starts: zero tasks attempted", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-stop-pre-"));
  requestStop(root, "pre-armed");
  let spawned = 0;
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => { spawned++; return okResult(id); },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0);
  assert.deepEqual(s.attempted, []);
});

test("STOP takes precedence over PAUSE when both flags are set", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-both-"));
  requestPause(root, "b");
  requestStop(root, "a");
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => okResult(id),
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "stopped");
});

test("PAUSE (drain-and-hold): issued mid-run, the in-flight task still reaches merged; no new spawn follows", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      // Simulate an operator pausing WHILE task A is in flight — the flag
      // appears mid-run, before A resolves.
      if (id === "A") requestPause(root, "quiet hours");
      merged.add(id);
      return okResult(id);
    },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: clock.sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
  });
  assert.equal(s.stopReason, "paused");
  assert.deepEqual(s.merged, ["A"]); // A still reaches merged (drain-and-hold)
  assert.deepEqual(s.attempted, ["A"]); // B (A's dependent) never spawns
  assert.ok(lines.some((l) => l.step === "daemon.pause"), "a daemon.pause ledger line was emitted");
});

// ── headroom (W1-T4) ─────────────────────────────────────────────────────────

test("headroom: a near-limit reading STOPS with reason=headroom_exhausted BEFORE spawning", async () => {
  const plan = fixturePlan();
  const nearLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Monday" }],
  };
  let spawned = 0;
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => { spawned++; return okResult(id); },
    readUsage: () => nearLimit,
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "headroom_exhausted");
  assert.match(s.stopDetail ?? "", /weekly \(all models\) at 98% — resets Monday/);
  assert.equal(spawned, 0, "no task is spawned when a window is at/near its limit");
});

test("headroom unreadable (undefined) does NOT halt — best-effort, the daemon continues", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
      sleep: clock.sleep,
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"]);
});

// ── stop-on-block v1 (block-REASONING is W1-T46, a successor built on this) ─

test("stop-on-block: a blocked task HALTS the daemon and does NOT run its dependents", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      ran.push(id);
      if (id === "B") return blockedResult(id); // A merges; B blocks; C must never run.
      merged.add(id);
      return okResult(id);
    },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_review/);
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(ran, ["A", "B"]);
  assert.ok(!ran.includes("C"), "the blocked task's dependent must not run");
});

// ── W1-T46: block-REASONING supersedes v1's blunt stop-on-block ────────────

test("W1-T46 GENUINE BLOCKER: escalateBlock is invoked once, naming the real dependents", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain); B blocking means C is the dependent it protects.
  const merged = new Set<string>();
  const escalations: Array<{ task: Task; result: RunResult; dependents: string[] }> = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      if (id === "B") return blockedResult(id);
      merged.add(id);
      return okResult(id);
    },
    escalateBlock: async (info) => { escalations.push(info); },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_review/);
  assert.match(s.stopDetail ?? "", /blocks C/);
  assert.equal(escalations.length, 1, "escalateBlock is called exactly once");
  assert.equal(escalations[0].task.id, "B");
  assert.deepEqual(escalations[0].dependents, ["C"]);
  assert.equal(escalations[0].result.verdict, "blocked_review");
});

test("W1-T46 TRANSIENT: a blocked_transient verdict retries with NO strike, and the drain continues", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  let aAttempts = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id): Promise<RunResult> => {
        ran.push(id);
        if (id === "A") {
          aAttempts++;
          if (aAttempts === 1) {
            return { taskId: id, runId: id + "-run", merged: false, costUsd: 0.1, verdict: "blocked_transient" };
          }
        }
        merged.add(id);
        return okResult(id);
      },
      sleep: clock.sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 5 },
  );
  assert.deepEqual(ran, ["A", "A", "B", "C", "D"], "A retries once (transient) before B/C/D proceed");
  assert.deepEqual(s.merged, ["A", "B", "C", "D"]);
  assert.equal(s.stopReason, "max_reached", "a transient block never halts the daemon");
  const retryLine = lines.find((l) => l.step === "daemon.block.transient_retry");
  assert.ok(retryLine, "a daemon.block.transient_retry ledger line was emitted");
  assert.deepEqual(retryLine?.extra, { task: "A", verdict: "blocked_transient", transient_retries: 1 });
  assert.ok(!lines.some((l) => l.step === "daemon.blocked"), "a transient retry is never escalated");
});

test("W1-T46 INDEPENDENT-FAILURE: a block on a task with NO transitive dependents is flagged + skipped — unrelated runnable tasks still run", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id): Promise<RunResult> => {
        ran.push(id);
        if (id === "D") {
          return {
            taskId: id,
            runId: id + "-run",
            merged: false,
            costUsd: 0.2,
            verdict: "blocked_review",
            prUrl: "https://github.com/o/r/pull/11",
          };
        }
        merged.add(id);
        return okResult(id);
      },
      sleep: clock.sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 4 },
  );
  assert.deepEqual(ran, ["A", "B", "C", "D"]);
  assert.deepEqual(s.merged, ["A", "B", "C"], "D never merges — it is flagged, not silently counted as done");
  assert.equal(s.stopReason, "max_reached", "a self-contained (dependent-less) failure never halts the daemon");
  const flagLine = lines.find((l) => l.step === "daemon.block.independent_failure");
  assert.ok(flagLine, "a daemon.block.independent_failure ledger line was emitted");
  assert.deepEqual(flagLine?.extra, {
    task: "D",
    verdict: "blocked_review",
    pr_url: "https://github.com/o/r/pull/11",
  });
  assert.equal(plan.byId.get("D")?.status, "blocked", "D is flagged in-memory — nextRunnable never reconsiders it this run");
  assert.ok(!lines.some((l) => l.step === "daemon.blocked"), "an independent failure never triggers a genuine-blocker halt");
});

// ── the PERSISTENT difference from `rmd drain`: it polls instead of stopping ─

test("no runnable task right now: the daemon PACES itself (injected clock) and keeps polling instead of stopping", async () => {
  const plan = fixturePlan();
  // Everything except H (verify:human) is already merged — nothing runnable.
  const isMerged = mergedSetOf("A", "B", "C", "D");
  let calls = 0;
  const sleep: DaemonDeps["sleep"] = async (ms) => {
    calls++;
    // After a few idle ticks, this "test operator" issues STOP so the test
    // terminates — proving the loop was genuinely idling/polling, not stuck.
    if (calls >= 3) requestStop(root, "test done polling");
  };
  const root = mkdtempSync(join(tmpdir(), "daemon-idle-"));
  const s = await runDaemon(plan, {
    refreshMerged: () => isMerged,
    runOne: async (id) => okResult(id),
    checkStop: () => stopDetail(root),
    sleep,
  });
  assert.equal(s.stopReason, "stopped");
  assert.equal(s.attempted.length, 0, "nothing was ever dispatched — only H remained, and it is verify:human");
  assert.ok(s.ticks >= 3, "the loop idle-polled via the injected clock rather than exiting on no_runnable");
  assert.equal(calls, s.ticks, "one sleep() call per idle tick");
});

test("default poll interval is passed to the injected clock unless overridden", async () => {
  const plan = fixturePlan();
  const isMerged = mergedSetOf("A", "B", "C", "D");
  const seen: number[] = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-poll-ms-"));
  await runDaemon(plan, {
    refreshMerged: () => isMerged,
    runOne: async (id) => okResult(id),
    checkStop: () => {
      if (seen.length >= 1) return stopDetail(root) ?? "stop";
      requestStop(root, "one tick is enough");
      return undefined;
    },
    sleep: async (ms) => { seen.push(ms); },
  });
  assert.deepEqual(seen, [DEFAULT_POLL_INTERVAL_MS]);
});

// ── max (a bounded supervised run, or a test) ───────────────────────────────

test("--max N halts after N successful tasks (absent = unbounded, unlike a test run)", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      sleep: clock.sleep,
    },
    { max: 2 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A", "B"]);
  assert.equal(s.attempted.length, 2);
});

// ── an unexpected throw from the runner is a terminal (not a silent loop) ──

test("an unexpected error from runOne is a terminal 'error' stop, naming the task", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw new Error("boom"); },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "error");
  assert.match(s.stopDetail ?? "", /A: boom/);
});

// ── crash recovery (W1-T12c): reconstruct state from git + GitHub + the
// ledger over a SEEDED interrupted-run state — NOT a live daemon kill ───────

/** A minimal task; fields not under test get sensible defaults (mirrors status.test.ts). */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

/** A fake GitHub gateway driven by fixture maps (mirrors status.test.ts). */
function fakeGitHub(opts: { byRef?: Record<string, PrRef>; byTrailer?: Record<string, PrRef> }): GitHub {
  return {
    prByRef: (ref) => opts.byRef?.[String(ref)] ?? null,
    findMergedByTrailer: (taskId) => opts.byTrailer?.[taskId] ?? null,
    // None of these fixtures exercise rung (c)'s trailer path; unresolved
    // ownership/anchor data is correct (fail-closed, never silently credited).
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "daemon-recover-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

/** Wires status.ts's real `deriveStatus` — reused wholesale, never reimplemented. */
function statusOf(taskId: string, ledgerPath: string, github: GitHub): import("../src/lib/status.js").StatusProjection {
  return deriveStatus(task({ id: taskId }), { ledgerPath, github });
}

test("parseOrphanedBranch: splits a run-<taskId>-<epochMs> branch, task ids with hyphens included", () => {
  const orphan = parseOrphanedBranch("run-W1-T12c-1730000000000", "/root/worktrees/run-W1-T12c-1730000000000");
  assert.deepEqual(orphan, {
    taskId: "W1-T12c",
    runId: "W1-T12c-1730000000000",
    branch: "run-W1-T12c-1730000000000",
    worktreePath: "/root/worktrees/run-W1-T12c-1730000000000",
  });
});

test("parseOrphanedBranch: rejects RETRO and review-PR branches — not task-scoped", () => {
  assert.equal(parseOrphanedBranch("run-RETRO-1730000000000", "/x"), null);
  assert.equal(parseOrphanedBranch("run-review-PR9-1730000000000", "/x"), null);
});

test("parseOrphanedBranch: rejects anything not shaped run-<id>-<digits>", () => {
  assert.equal(parseOrphanedBranch("main", "/x"), null);
  assert.equal(parseOrphanedBranch("run-no-timestamp", "/x"), null);
  assert.equal(parseOrphanedBranch("run-", "/x"), null);
});

test("reconstructOrphan: an OPEN PR already on GitHub ⇒ resume, not a respawn", () => {
  const url = "https://github.com/o/r/pull/11";
  const github = fakeGitHub({ byRef: { [url]: { number: 11, url, state: "OPEN" } } });
  const ledgerPath = ledgerFile([
    { step: "run.start", task_id: "W1-TX" },
    { step: "pr.opened", task_id: "W1-TX", pr_url: url },
  ]);
  const orphan: OrphanedRun = { taskId: "W1-TX", runId: "W1-TX-1", branch: "run-W1-TX-1", worktreePath: "/w" };
  const recovered = reconstructOrphan(orphan, (id) => statusOf(id, ledgerPath, github));
  assert.equal(recovered.action, "resume");
  assert.equal(recovered.prUrl, url);
  assert.match(recovered.detail, /open PR already exists/);
});

test("reconstructOrphan: the task already MERGED ⇒ clean — the worktree is stale debris", () => {
  const url = "https://github.com/o/r/pull/12";
  const github = fakeGitHub({ byRef: { [url]: { number: 12, url, state: "MERGED" } } });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-TX", pr_url: url }]);
  const orphan: OrphanedRun = { taskId: "W1-TX", runId: "W1-TX-2", branch: "run-W1-TX-2", worktreePath: "/w" };
  const recovered = reconstructOrphan(orphan, (id) => statusOf(id, ledgerPath, github));
  assert.equal(recovered.action, "clean");
  assert.equal(recovered.prUrl, url);
  assert.match(recovered.detail, /already merged/);
});

test("reconstructOrphan: a CLOSED (unmerged) PR ⇒ clean — safe to re-run from scratch", () => {
  const url = "https://github.com/o/r/pull/13";
  const github = fakeGitHub({ byRef: { [url]: { number: 13, url, state: "CLOSED" } } });
  const ledgerPath = ledgerFile([{ step: "pr.opened", task_id: "W1-TX", pr_url: url }]);
  const orphan: OrphanedRun = { taskId: "W1-TX", runId: "W1-TX-3", branch: "run-W1-TX-3", worktreePath: "/w" };
  const recovered = reconstructOrphan(orphan, (id) => statusOf(id, ledgerPath, github));
  assert.equal(recovered.action, "clean");
  assert.match(recovered.detail, /closed without merging/);
});

test("reconstructOrphan: no PR ever opened (crash mid-implement) ⇒ clean — no GitHub evidence at all", () => {
  const ledgerPath = ledgerFile([{ step: "run.start", task_id: "W1-TX" }]); // no pr.opened
  const github = fakeGitHub({});
  const orphan: OrphanedRun = { taskId: "W1-TX", runId: "W1-TX-4", branch: "run-W1-TX-4", worktreePath: "/w" };
  const recovered = reconstructOrphan(orphan, (id) => statusOf(id, ledgerPath, github));
  assert.equal(recovered.action, "clean");
  assert.equal(recovered.prUrl, undefined);
  assert.match(recovered.detail, /crash happened before a PR existed/);
});

test("reconstructState: reconstructs a MIX of orphans in order, logging one daemon.recover line each", () => {
  const openUrl = "https://github.com/o/r/pull/21";
  const mergedUrl = "https://github.com/o/r/pull/22";
  const github = fakeGitHub({
    byRef: {
      [openUrl]: { number: 21, url: openUrl, state: "OPEN" },
      [mergedUrl]: { number: 22, url: mergedUrl, state: "MERGED" },
    },
  });
  const ledgerPath = ledgerFile([
    { step: "pr.opened", task_id: "W1-A", pr_url: openUrl },
    { step: "pr.opened", task_id: "W1-B", pr_url: mergedUrl },
    { step: "run.start", task_id: "W1-C" }, // never got a PR
  ]);
  const orphans: OrphanedRun[] = [
    { taskId: "W1-A", runId: "W1-A-1", branch: "run-W1-A-1", worktreePath: "/w/a" },
    { taskId: "W1-B", runId: "W1-B-1", branch: "run-W1-B-1", worktreePath: "/w/b" },
    { taskId: "W1-C", runId: "W1-C-1", branch: "run-W1-C-1", worktreePath: "/w/c" },
  ];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const recovered = reconstructState(
    orphans,
    (id) => statusOf(id, ledgerPath, github),
    (step, extra = {}) => lines.push({ step, extra }),
  );
  assert.deepEqual(
    recovered.map((r) => [r.taskId, r.action]),
    [
      ["W1-A", "resume"],
      ["W1-B", "clean"],
      ["W1-C", "clean"],
    ],
  );
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.step), ["daemon.recover", "daemon.recover", "daemon.recover"]);
  assert.deepEqual(lines.map((l) => l.extra.task), ["W1-A", "W1-B", "W1-C"]);
  assert.deepEqual(lines.map((l) => l.extra.action), ["resume", "clean", "clean"]);
});

// ── the loop survives a throwing sweep / escalation hook (R-1) ──────────────
// Both hooks reach GitHub through execFileSync, which throws on any nonzero
// exit. Neither sat inside the loop's only try/catch (which wraps `runOne`), so
// an unreachable `gh` ended the PROCESS; launchd's KeepAlive{SuccessfulExit:
// false} read that as a crash and relaunched into the same failure — one boot
// per minute, 2026-07-21 04:02-04:13. The daemon must degrade, not die.

test("a THROWING sweep does not kill the loop — it logs daemon.sweep.failed and keeps polling", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  let sweeps = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-sweep-throw-"));
  const s = await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    sweep: async () => {
      sweeps += 1;
      // FALSIFIER: pre-fix, this throw propagated straight out of runDaemon.
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
    checkStop: () => (sweeps >= 2 ? (requestStop(root, "two failed sweeps seen"), stopDetail(root)) : undefined),
    sleep: async () => {},
  });
  assert.ok(sweeps >= 2, `the loop kept iterating THROUGH the failures (saw ${sweeps} sweeps)`);
  assert.notEqual(s.stopReason, "error", "a failing reconciler is not a daemon error");
});

test("a THROWING onCircuitBreak hook does not kill the loop", async () => {
  const plan = fixturePlan();
  let hookCalls = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-escalate-throw-"));
  let ticks = 0;
  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    isCircuitTripped: () => true,
    onCircuitBreak: () => {
      hookCalls += 1;
      // FALSIFIER: pre-fix, `gh` failing here ended the process mid-selection.
      throw new Error("gh: could not create issue");
    },
    checkStop: () => (++ticks >= 3 ? (requestStop(root, "done"), stopDetail(root)) : undefined),
    sleep: async () => {},
  });
  assert.ok(hookCalls >= 1, "the escalation hook was actually reached");
  assert.notEqual(s.stopReason, "error", "an undeliverable escalation is not a daemon error");
});

test("daemonBoot: calls the injected lock sweep once and logs daemon.lock_sweep with reaped/kept COUNTs", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let calls = 0;
  const sweepLocks = () => {
    calls += 1;
    return { reaped: ["W1-T1"], kept: ["W1-T184"] };
  };
  daemonBoot((step, extra = {}) => lines.push({ step, extra }), { PATH: "/usr/bin" }, undefined, sweepLocks);
  assert.equal(calls, 1, "swept exactly once at boot, not per poll");
  const swept = lines.find((l) => l.step === "daemon.lock_sweep");
  assert.ok(swept, "the sweep is legible on its own ledger step");
  assert.equal(swept?.extra.reaped, 1, "the COUNT is logged, not the raw id list");
  assert.equal(swept?.extra.kept, 1);
});

test("daemonBoot: with no lock sweep injected, no daemon.lock_sweep line is written", () => {
  const lines: Array<{ step: string }> = [];
  daemonBoot((step) => lines.push({ step }), { PATH: "/usr/bin" });
  assert.equal(lines.filter((l) => l.step === "daemon.lock_sweep").length, 0);
});
