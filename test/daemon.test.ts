import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlan, type Plan, type Task } from "../src/lib/plan.js";
import { daemonCommand, ledgerPathFor, runInflightLockSweepRung, type RunResult } from "../src/run-task.js";
import { CLAUDE_BIN_ENV_OVERRIDE, claudeExecutableCache } from "../src/lib/worker.js";
import { HEADROOM_LIMIT_PCT, type UsageSnapshot } from "../src/lib/headroom.js";
import {
  DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DAEMON_EXIT_BLOCKED,
  DAEMON_EXIT_STALE,
  DEFAULT_UNREADABLE_DEGRADED_LIMIT,
  buildDefaultHeadroomPolicy,
  canonicalizeResetInstant,
  daemonBoot,
  daemonExitCode,
  formatResetInstant,
  parseOrphanedBranch,
  parseResetInstant,
  reconstructOrphan,
  resolveHeadroomLimitPct,
  runDaemon,
  type DaemonDeps,
  type DaemonStopReason,
  type DaemonSummary,
  type HeadroomPolicy,
  type OrphanedRun,
} from "../src/lib/daemon.js";
import { resolveHeadroomEnabled, type Config } from "../src/lib/config.js";
import { runSweep, DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { pauseDetail, requestPause, requestStop, resumeFleet, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet, OpenPrCheck } from "../src/lib/drain.js";
import { deriveStatus, type GitHub, type PrRef } from "../src/lib/status.js";
import {
  RUN_ID_ENV,
  TASK_ID_ENV,
  WORKER_SCOPE_ENV,
  defaultReadMarkers,
  isPidAlive,
  killProcessGroup,
  spawnDetachedGroup,
  workerInstallationScope,
} from "../src/lib/worker-containment.js";

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
  // W1-T991: result also carries node_path/node_version (and possibly node_drift) —
  // checked precisely by the dedicated test/node-runtime-provenance.test.ts suite, so this
  // pre-existing test only pins the billing fields it was written to prove.
  assert.equal(result.env_clean, true);
  assert.equal(result.billing_mode, "subscription");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "daemon.boot");
  assert.equal(lines[0].extra.env_clean, true);
  assert.equal(lines[0].extra.billing_mode, "subscription");
});

test("daemonBoot: a NON-valve ANTHROPIC_* (e.g. BASE_URL) still logs env_clean=false but billing_mode=subscription — a loud canary, not a throw, and NOT api", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const dirtyEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op", ANTHROPIC_BASE_URL: "https://example.invalid" };
  const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }), dirtyEnv);
  assert.equal(result.env_clean, false);
  assert.equal(result.billing_mode, "subscription");
  assert.equal(lines[0].extra.env_clean, false);
  assert.equal(lines[0].extra.billing_mode, "subscription", "only the sanctioned ANTHROPIC_API_KEY valve flips billing to api");
});

test("daemonBoot: the KEY ALONE (no config intent) stays subscription — an inherited key can't silently flip the daemon to api", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const keyEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op", ANTHROPIC_API_KEY: "sk-ant-daemon" };
  const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }), keyEnv); // allowApiKey defaults false
  assert.equal(result.env_clean, false);
  assert.equal(result.billing_mode, "subscription");
});

test("daemonBoot: BOTH factors (config intent allowApiKey=true + the key) log env_clean=false AND billing_mode=api (overnight-on-credits, W1-T258)", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const valveEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op", ANTHROPIC_API_KEY: "sk-ant-daemon" };
  // allowApiKey is daemonBoot's 8th param; the intervening optional hooks are unused here.
  const result = daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    valveEnv,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.equal(result.env_clean, false);
  assert.equal(result.billing_mode, "api");
  assert.equal(lines[0].extra.billing_mode, "api", "the daemon deliberately drains on API credits");
});

/**
 * Save and remove every process.env key matching /^ANTHROPIC_/i for the duration of `fn`,
 * then restore exactly what was removed (including keys whose value was ""; keys that were
 * absent stay absent). This makes `env_clean` assertions over the REAL process.env
 * deterministic regardless of what the host shell happens to export (W1-T1087) — a single
 * hard-coded `delete process.env.ANTHROPIC_API_KEY` only scrubs one name, but `env_clean`
 * (via `isBillingClean` in src/lib/env.ts) is false for ANY ANTHROPIC_* name, so a host
 * exporting e.g. ANTHROPIC_BASE_URL failed this test identically on every branch.
 */
function withScrubbedAnthropicEnv<T>(fn: () => T): T {
  const ANTHROPIC_KEY = /^ANTHROPIC_/i;
  const saved: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (ANTHROPIC_KEY.test(key)) {
      saved[key] = process.env[key] as string;
      delete process.env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      process.env[key] = saved[key];
    }
  }
}

test("daemonBoot: defaults to checking process.env when no env is injected", () => {
  withScrubbedAnthropicEnv(() => {
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }));
    const surviving = Object.keys(process.env).filter((k) => /^ANTHROPIC_/i.test(k));
    assert.equal(
      result.env_clean,
      true,
      surviving.length > 0
        ? `expected a clean env but found surviving ANTHROPIC_* keys: ${surviving.join(", ")}`
        : "expected a clean env",
    );
  });
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

// ── W1-T316: the LIFETIME dispatch cap, wired into runDaemon itself ─────────
// (mirrors P29(ii)'s onCircuitBreak coverage immediately above, one field over)

test("W1-T316: a lifetime-capped task is never (re-)dispatched — the daemon skips it (dispatch.lifetime_capped) and picks the next runnable task instead of halting", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const capped: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isLifetimeCapExceeded: (id) => id === "A",
      onLifetimeCapExceeded: (t) => capped.push(t.id),
      runOne: async (id) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: fakeClock().sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (lifetime-capped) was never dispatched");
  assert.deepEqual(ran, ["D"]); // B/C still depend on the un-merged A; D is the only other candidate
  assert.deepEqual(capped, ["A"], "the daemon's own onLifetimeCapExceeded fired exactly once for A");
  assert.equal(s.stopReason, "max_reached");
  const cappedLine = lines.find((l) => l.step === "dispatch.lifetime_capped");
  assert.ok(cappedLine, "a dispatch.lifetime_capped ledger line was emitted");
  assert.equal(cappedLine?.extra.task, "A");
});

test("W1-T316: no isLifetimeCapExceeded wired ⇒ the daemon dispatches exactly as before this cap existed", async () => {
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

test("W1-T316 the x10 spin shape: a lifetime-capped task is escalated EXACTLY ONCE across MANY idle polls of the PERSISTENT daemon loop, never re-escalated tick after tick", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const capped: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-lifetime-cap-spin-"));
  let calls = 0;
  const sleep = async (_ms: number) => {
    calls++;
    if (calls >= 5) requestStop(root, "test done polling");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    isLifetimeCapExceeded: (id) => id === "A",
    onLifetimeCapExceeded: (t) => capped.push(t.id),
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
  assert.ok(!ran.includes("A"), "A (lifetime-capped) was never dispatched, no matter how many polls observed it capped");
  assert.deepEqual(ran, ["D"], "D is the only task ever dispatched");
  assert.deepEqual(capped, ["A"], "onLifetimeCapExceeded fired EXACTLY ONCE for A across the WHOLE daemon run, despite 5+ re-observations");
});

test("W1-T316: a THROWING onLifetimeCapExceeded hook does not kill the loop", async () => {
  const plan = fixturePlan();
  let hookCalls = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-lifetime-cap-throw-"));
  let ticks = 0;
  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    isLifetimeCapExceeded: () => true,
    onLifetimeCapExceeded: () => {
      hookCalls += 1;
      // FALSIFIER: pre-fix, an unreachable escalation sink here could kill the process mid-selection.
      throw new Error("gh: could not create issue");
    },
    checkStop: () => (++ticks >= 3 ? (requestStop(root, "done"), stopDetail(root)) : undefined),
    sleep: async () => {},
  });
  assert.ok(hookCalls >= 1, "the escalation hook was actually reached");
  assert.notEqual(s.stopReason, "error", "an undeliverable escalation is not a daemon error");
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

test("PAUSE (drain-and-hold): issued mid-run, the in-flight task still reaches merged, no new spawn follows — and the loop IDLES IN-PROCESS (heartbeat per tick), never exiting on the pause itself", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    // The 2026-07-22 storm falsifier: pre-fix, the loop RETURNED "paused" (exit 1)
    // and KeepAlive relaunched a fresh process every ~10s. Here a "test operator"
    // issues a hard STOP only after several paused heartbeats — the loop reaching
    // sleep #3 with ticks accumulating IN THIS ONE SUMMARY proves it was idling
    // in-process, not exiting (a launchd relaunch starts a fresh process at tick 0).
    if (sleeps >= 3) requestStop(root, "test done polling — pause never cleared");
  };
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
    sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
  });
  // STOP is what ended the loop — PAUSE alone never does (and STOP during a
  // pause still terminates cleanly: checked first, exit 0 via daemonExitCode).
  assert.equal(s.stopReason, "stopped");
  assert.equal(daemonExitCode(s.stopReason), 0, "a hard STOP during a pause is a clean exit — no KeepAlive relaunch");
  assert.deepEqual(s.merged, ["A"]); // A still reaches merged (drain-and-hold)
  assert.deepEqual(s.attempted, ["A"]); // B (A's dependent) never spawns while paused
  const heartbeats = lines.filter((l) => l.step === "daemon.pause");
  assert.ok(heartbeats.length >= 3, "one daemon.pause heartbeat per idle tick, all within ONE process");
  assert.equal(heartbeats[0].extra.detail, "PAUSE requested: quiet hours");
  assert.ok(typeof heartbeats[0].extra.poll_interval_ms === "number", "the heartbeat names its own pacing");
  assert.ok(s.ticks >= 3, "ticks accumulate across the pause — proof no relaunch/boot-cycle occurred");
});

test("PAUSE clears via rmd resume and the SAME process resumes dispatching on its next tick — no exit, no relaunch on either side", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-resume-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  requestPause(root, "starts paused"); // the daemon boots INTO an already-paused fleet
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    // The "operator" runs `rmd resume` (flag deleted) after two paused heartbeats.
    if (sleeps === 2) resumeFleet(root); // the real `rmd resume` verb — deletes the PAUSE flag
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        merged.add(id);
        return okResult(id);
      },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 2 },
  );
  assert.equal(s.stopReason, "max_reached", "the run ended by max — never by the pause");
  assert.deepEqual(s.attempted, ["A", "B"], "dispatch resumed in the SAME process once the flag cleared");
  const heartbeats = lines.filter((l) => l.step === "daemon.pause");
  assert.equal(heartbeats.length, 2, "exactly one heartbeat per paused tick before resume");
  assert.ok(s.ticks >= 2, "the paused ticks and the dispatching ticks share one summary — one process throughout");
});

// ── headroom (W1-T4) ─────────────────────────────────────────────────────────

// A `now` far from any weekday-name ambiguity: fixed, injected, never the
// real wall clock — every headroom test below is deterministic regardless of
// which real calendar day the suite happens to run on.
const JUL_20_2026_2200 = () => new Date(2026, 6, 20, 22, 0, 0, 0); // Mon 2026-07-20 22:00 local
const JUL_19_2026_2200 = () => new Date(2026, 6, 19, 22, 0, 0, 0); // Sun 2026-07-19 22:00 local — 26h from the same reset

test("headroom: a near-limit reading is an IN-PROCESS idle heartbeat, never a stop — no spawn while over the limit", async () => {
  const plan = fixturePlan();
  // resets_at is FAR from `now` (5 days out) so the time-aware ceiling holds
  // at the default reserve throughout — this test is about the idle-loop
  // SHAPE, not the time-aware relaxation (covered separately below).
  const nearLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Jul 25 at 12am" }],
  };
  let spawned = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-headroom-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let calls = 0;
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    calls++;
    // Same pattern as the no-runnable idle test: prove the loop is genuinely
    // pacing itself (never exiting on its own) by having a "test operator"
    // request STOP after a few heartbeats.
    if (calls >= 3) requestStop(root, "test done polling — headroom never freed up");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => { spawned++; return okResult(id); },
    readUsage: () => nearLimit,
    now: JUL_20_2026_2200,
    checkStop: () => stopDetail(root),
    sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
  });
  // The daemon HALTS here only because the fake "operator" issued STOP above —
  // headroom exhaustion by itself never ends the loop (KeepAlive would just
  // relaunch a process that exits, restart-looping every idle poll instead of
  // sleeping through the window's actual reset). This is also the FALSIFIER
  // for "the daemon does not relaunch-storm while a KNOWN-DURATION condition
  // holds": ticks accumulate WITHIN this one process/summary across every
  // heartbeat below, rather than resetting to 0 the way a launchd relaunch
  // (a fresh process) would — proving no boot-cycle occurred.
  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0, "no task is spawned while any window is at/near its limit");
  assert.ok(s.ticks >= 3, "the loop idle-heartbeated via the injected clock rather than exiting on headroom");
  assert.equal(calls, s.ticks, "one sleep() call per headroom heartbeat tick");
  const heartbeats = lines.filter((l) => l.step === "daemon.headroom");
  assert.ok(heartbeats.length >= 3, "one daemon.headroom heartbeat logged per idle tick");
  assert.equal(heartbeats[0].extra.window, "weekly (all models)");
  assert.equal(heartbeats[0].extra.percent_used, 98);
  assert.equal(heartbeats[0].extra.limit_pct, HEADROOM_LIMIT_PCT, "far from reset, the ceiling holds at the reserve");
});

// ── headroom GOVERNOR SWITCH (operator ruling fb-1784894405468-a4153e) ────────
// With the governor DISABLED, no percent_used condition pauses dispatch, but headroom
// is still READ and LEDGERED every cycle so the console shows weekly burn. When
// ENABLED, the curve enforces exactly as today.
// RETARGETED (operator ruling 2026-07-25): "disabled" is no longer the inherited
// default — resolveHeadroomEnabled now defaults ON and disablement is an EXPLICIT
// config/env opt-out (this host's `headroom.enabled: false`). These cases therefore
// pass `headroomEnabled: false` as the resolved posture of a deliberately opted-out
// host, which is what the a4153e mechanism must honor; the library's own default is
// and always was TRUE.

test("headroom governor DISABLED (ruling a4153e): percent_used 99 does NOT pause dispatch — the task runs AND headroom is still ledgered (telemetry, enforced:false)", async () => {
  const plan = fixturePlan();
  const overLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 99, resetsAt: "Jul 25 at 12am" }], // 5 days out ⇒ ceiling 95, so 99 is over
  };
  let spawned = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-headroom-off-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => overLimit,
      now: JUL_20_2026_2200,
      checkStop: () => stopDetail(root),
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: false, max: 1 },
  );
  assert.equal(s.stopReason, "max_reached", "the loop dispatched and reached its bound — it never idled on headroom");
  assert.ok(spawned >= 1, "dispatch PROCEEDS despite a 99% window when the governor is disabled");
  const telem = lines.filter((l) => l.step === "daemon.headroom");
  assert.ok(telem.length >= 1, "headroom is still READ and LEDGERED every cycle (telemetry without enforcement)");
  assert.equal(telem[0].extra.percent_used, 99, "the burn reading is on the ledger line for the console to display");
  assert.equal(telem[0].extra.enforced, false, "the telemetry line is explicitly marked non-enforcing");
  assert.equal(telem[0].extra.over_ceiling, true, "it WAS over the ceiling — and dispatched anyway");
});

test("a4153e falsifier (retargeted to disabled-by-config): with the governor disabled, NO headroom condition pauses dispatch — the daemon never enters the idle heartbeat", async () => {
  const plan = fixturePlan();
  const overLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 99, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 99, resetsAt: "Jul 25 at 12am" }],
  };
  let spawned = 0;
  let sleeps = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-headroom-falsifier-"));
  // The posture is RESOLVED, not asserted: an explicitly opted-out config (this host's
  // `headroom.enabled: false`, the credits-burst posture) goes through the real
  // resolveHeadroomEnabled — so the falsifier covers the whole chain config ⇒ no gate,
  // not just the library flag. A default-ON regression that ignored the explicit false
  // would fail here first.
  const optedOut = resolveHeadroomEnabled({ headroom: { enabled: false } }, {});
  assert.equal(optedOut, false, "an explicit config opt-out resolves the governor OFF");
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => overLimit,
      now: JUL_20_2026_2200,
      checkStop: () => stopDetail(root),
      sleep: async () => { sleeps++; },
      log: () => {},
    },
    { headroomEnabled: optedOut, max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.ok(spawned >= 1, "dispatch was not paused by any headroom condition");
  assert.equal(s.ticks, 0, "no idle heartbeat tick ever fired — the governor is off");
  assert.equal(sleeps, 0, "the loop never slept on headroom before dispatching");
});

test("headroom governor ENABLED explicitly: an at-ceiling reading idles EXACTLY as today — no spawn while over the limit", async () => {
  const plan = fixturePlan();
  const nearLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Jul 25 at 12am" }],
  };
  let spawned = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-headroom-on-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let calls = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => nearLimit,
      now: JUL_20_2026_2200,
      checkStop: () => stopDetail(root),
      sleep: async () => { calls++; if (calls >= 3) requestStop(root, "test done polling"); },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: true },
  );
  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0, "with the governor ENABLED, no task spawns while a window is over the limit");
  assert.ok(s.ticks >= 3, "it idle-heartbeated exactly as before");
  const heartbeats = lines.filter((l) => l.step === "daemon.headroom");
  assert.equal(heartbeats[0].extra.percent_used, 98);
  assert.equal(heartbeats[0].extra.limit_pct, HEADROOM_LIMIT_PCT);
  assert.notEqual(heartbeats[0].extra.enforced, false, "the enforcement heartbeat is NOT tagged enforced:false");
});

test("headroom governor DISABLED + UNREADABLE usage: absent telemetry, never a hold — dispatch proceeds with no headroom line and no degraded idle", async () => {
  const plan = fixturePlan();
  let spawned = 0;
  let sleeps = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-headroom-off-unreadable-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => undefined, // unreadable every tick
      now: JUL_20_2026_2200,
      checkStop: () => stopDetail(root),
      sleep: async () => { sleeps++; },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: false, max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.ok(spawned >= 1, "an unreadable read while disabled never holds dispatch");
  assert.equal(sleeps, 0, "no degraded idle — the bounded-allowance escalation is enforcement-only");
  assert.equal(
    lines.filter((l) => l.step.startsWith("daemon.headroom")).length,
    0,
    "unreadable + disabled = ABSENT telemetry, not a headroom line",
  );
});

// ── CONSOLE WRITE-ACTIONS: Run kick + Drain now (fb-1784988460437-9daa9b) ─────
// The daemon consumes markers the write-token API drops. A Run kick dispatches THAT
// task by id through the SAME assertRunnable-gated path; a refused kick is cleared +
// its reason ledgered (never silent); the ledger line names the console as actor.

test("console kick: a Run on a runnable queued task dispatches THAT task by id (ahead of ordering) and ledgers console.kick_dispatched with the console-actor origin; marker consumed-once", async () => {
  const plan = fixturePlan();
  const spawned: string[] = [];
  const cleared: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let kicks = [{ taskId: "D", origin: "console-abc123" }];
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned.push(id); return okResult(id); },
      pendingKicks: () => kicks,
      clearKick: (id) => { cleared.push(id); kicks = kicks.filter((k) => k.taskId !== id); },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: false, max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(spawned, ["D"], "the KICKED task D dispatched, ahead of A (nextRunnable's natural pick)");
  const dispatched = lines.find((l) => l.step === "console.kick_dispatched");
  assert.ok(dispatched, "console.kick_dispatched ledgered");
  assert.equal(dispatched!.extra.task, "D");
  assert.equal(dispatched!.extra.origin, "console-abc123", "the dispatch ledger line names the console as actor");
  assert.deepEqual(cleared, ["D"], "the kick marker is consumed-once");
});

test("console kick: a verify:human target is REFUSED with its named reason (rendered via the ledger, never silent), the marker cleared, and never dispatched", async () => {
  const plan = fixturePlan();
  const spawned: string[] = [];
  const cleared: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let kicks = [{ taskId: "H", origin: "console-xyz" }];
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned.push(id); return okResult(id); },
      pendingKicks: () => kicks,
      clearKick: (id) => { cleared.push(id); kicks = kicks.filter((k) => k.taskId !== id); },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: false, max: 1 },
  );
  const refused = lines.find((l) => l.step === "console.kick_refused");
  assert.ok(refused, "console.kick_refused ledgered");
  assert.equal(refused!.extra.task, "H");
  assert.match(String(refused!.extra.reason), /verify:human/, "the assertRunnable named reason surfaces");
  assert.equal(refused!.extra.origin, "console-xyz");
  assert.deepEqual(cleared, ["H"], "the refused marker is cleared, not left to retry forever");
  assert.ok(!spawned.includes("H"), "a verify:human task is NEVER dispatched via a kick — assertRunnable still gates");
});

test("console kick: a STALE kick for an already-merged task is refused via the projection (86793d class), cleared, reason ledgered — never re-dispatched", async () => {
  const plan = fixturePlan();
  const spawned: string[] = [];
  const cleared: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let kicks = [{ taskId: "D", origin: "console-stale" }];
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => mergedSetOf("D"), // D already merged/done per the projection
      runOne: async (id) => { spawned.push(id); return okResult(id); },
      pendingKicks: () => kicks,
      clearKick: (id) => { cleared.push(id); kicks = kicks.filter((k) => k.taskId !== id); },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: false, max: 1 },
  );
  const refused = lines.find((l) => l.step === "console.kick_refused");
  assert.ok(refused, "console.kick_refused ledgered");
  assert.equal(refused!.extra.task, "D");
  assert.match(String(refused!.extra.reason), /already merged/, "the stale-merged reason surfaces");
  assert.deepEqual(cleared, ["D"], "the stale marker is cleared");
  assert.ok(!spawned.includes("D"), "a merged task is never re-dispatched off a stale kick");
});

test("console kick: an unknown task id is refused (unknown task id) and the marker cleared", async () => {
  const plan = fixturePlan();
  const cleared: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let kicks = [{ taskId: "NOPE", origin: "console-q" }];
  await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => okResult(id),
      pendingKicks: () => kicks,
      clearKick: (id) => { cleared.push(id); kicks = kicks.filter((k) => k.taskId !== id); },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: false, max: 1 },
  );
  const refused = lines.find((l) => l.step === "console.kick_refused");
  assert.ok(refused);
  assert.match(String(refused!.extra.reason), /unknown task id/);
  assert.deepEqual(cleared, ["NOPE"]);
});

test("console drain-now: consuming DRAIN_REQUESTED ledgers console.drain_consumed with the console origin, dispatch proceeds", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let drain: { origin: string } | null = { origin: "console-drain-1" };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => okResult(id),
      consumeDrainNow: () => { const d = drain; drain = null; return d; },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { headroomEnabled: false, max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  const consumed = lines.find((l) => l.step === "console.drain_consumed");
  assert.ok(consumed, "console.drain_consumed ledgered");
  assert.equal(consumed!.extra.origin, "console-drain-1", "the drain line names the console as actor");
});

test("headroom exhaustion resumes ON ITS OWN once the underlying window actually resets — no exit either side", async () => {
  // Proves acceptance criterion (a): "the daemon does not exit at all... it
  // RESUMES after the clock passes resets_at". readUsage is a fresh call
  // every tick (never cached), so once the real subscription window resets
  // and /usage starts reporting a fresh low percentage, the VERY NEXT poll
  // picks it up automatically — no separate "wake at resets_at" timer is
  // needed, and the process never terminated in between.
  const plan = fixturePlan();
  const merged = new Set<string>();
  let simNowMs = JUL_20_2026_2200().getTime();
  const RESET_AT_MS = new Date(2026, 6, 21, 0, 0, 0, 0).getTime(); // 2h after simNow starts
  // The window's OWN reset (per its raw resetsAt text) is deliberately far
  // away (8 days) — this test isolates "keeps polling until the underlying
  // reading changes" from the SEPARATE time-aware-ceiling behaviour (covered
  // by its own tests below); the simulated /usage flip at RESET_AT_MS models
  // an actual subscription reset landing mid-poll, independent of what the
  // ceiling itself would have permitted.
  const exhausted: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 10, resetsAt: "x" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Jul 28 at 12am" }],
  };
  const fresh: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 10, resetsAt: "x" },
    weekly: [{ label: "all models", percentUsed: 3, resetsAt: "Jul 28 at 12am" }],
  };
  let sleeps = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => (simNowMs < RESET_AT_MS ? exhausted : fresh),
      now: () => new Date(simNowMs),
      sleep: async (ms) => {
        sleeps++;
        simNowMs += ms; // the loop's own pacing clock advances the simulated wall clock
      },
    },
    { max: 1, pollIntervalMs: 30 * 60_000 }, // 30-min polls cross the 2h gap in a few ticks
  );
  assert.equal(s.stopReason, "max_reached", "dispatch resumed once the window reset, with no process exit in between");
  assert.deepEqual(s.merged, ["A"]);
  assert.ok(sleeps >= 3, "idled across multiple ticks while exhausted before the reset landed");
});

// ── time-aware ceiling (operator ruling 2026-07-21: policy DATA, not a code constant) ─

test("resolveHeadroomLimitPct: unknown (null) hours-to-reset is READ CONSERVATIVELY — never the relaxed final-day rung", () => {
  assert.equal(resolveHeadroomLimitPct(null), HEADROOM_LIMIT_PCT);
  assert.equal(resolveHeadroomLimitPct(NaN), HEADROOM_LIMIT_PCT);
});

test("resolveHeadroomLimitPct: inside the final day (<=24h) relaxes to 100%; every other day holds at the reserve", () => {
  const policy = buildDefaultHeadroomPolicy();
  assert.equal(resolveHeadroomLimitPct(1, policy), 100);
  assert.equal(resolveHeadroomLimitPct(24, policy), 100);
  assert.equal(resolveHeadroomLimitPct(24.01, policy), HEADROOM_LIMIT_PCT);
  assert.equal(resolveHeadroomLimitPct(24 * 6, policy), HEADROOM_LIMIT_PCT);
});

test("buildDefaultHeadroomPolicy: the HOLD rung is DATA, not hardcoded — a custom reserve threads through", () => {
  const policy = buildDefaultHeadroomPolicy(80);
  assert.equal(resolveHeadroomLimitPct(100, policy), 80);
  assert.equal(resolveHeadroomLimitPct(1, policy), 100); // final-day relax is unaffected
});

test("headroom: the SAME percent_used(98%) — inside the window's final day, dispatch PROCEEDS; earlier, it idles", async () => {
  // FALSIFIER for the fixture in this task's rationale: on Monday 2026-07-20
  // the fleet parked 22:22-00:00 EDT, 56 consecutive headroom_exhausted stops
  // over ~98 minutes, protecting 95%-exhausted headroom that EXPIRED at the
  // midnight reset regardless. Same window, same percent_used, same
  // resets_at string — only `now` (hours-to-reset) differs between the two
  // runs below.
  const plan = fixturePlan();
  const snapAt98 = (): UsageSnapshot => ({
    billingMode: "subscription",
    session: { percentUsed: 10, resetsAt: "x" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Jul 21 at 12am" }],
  });

  // Two hours to reset (inside the final day) ⇒ the ceiling relaxes to 100%,
  // 98% no longer binds, dispatch proceeds.
  const insideFinalDay = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => okResult(id),
      readUsage: snapAt98,
      now: JUL_20_2026_2200, // 2026-07-20 22:00, resets Jul 21 00:00 ⇒ 2h away
      sleep: async () => {},
    },
    { max: 1 },
  );
  assert.equal(insideFinalDay.stopReason, "max_reached", "relaxed ceiling let the task dispatch");
  assert.deepEqual(insideFinalDay.merged, ["A"]);

  // 26 hours to the SAME reset (outside the final day) ⇒ the ceiling holds
  // at the reserve, 98% binds, the daemon idles instead of dispatching.
  let spawned = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-headroom-timeaware-"));
  let calls = 0;
  const outsideFinalDay = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => { spawned++; return okResult(id); },
    readUsage: snapAt98,
    now: JUL_19_2026_2200, // 2026-07-19 22:00, resets Jul 21 00:00 ⇒ 26h away
    checkStop: () => stopDetail(root),
    sleep: async () => {
      calls++;
      if (calls >= 2) requestStop(root, "outside-final-day proof done");
    },
  });
  assert.equal(outsideFinalDay.stopReason, "stopped");
  assert.equal(spawned, 0, "held ceiling ⇒ 98% still binds ⇒ no dispatch, 26h from the same reset");
});

test("headroom policy is OVERRIDABLE DATA — a custom curve changes behaviour without touching source", async () => {
  const plan = fixturePlan();
  const snapAt80 = (): UsageSnapshot => ({
    billingMode: "subscription",
    session: { percentUsed: 10, resetsAt: "x" },
    weekly: [{ label: "all models", percentUsed: 80, resetsAt: "Jul 21 at 12am" }],
  });
  // A custom policy (plain data, constructed entirely in the TEST, not in
  // daemon.ts) that holds a much tighter reserve (50%) regardless of
  // time-to-reset — proves the curve is consulted, not a hardcoded 95/100.
  const tightPolicy: HeadroomPolicy = [{ maxHoursToReset: Infinity, limitPct: 50 }];
  let spawned = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-headroom-policy-"));
  let calls = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: snapAt80,
      now: JUL_20_2026_2200, // inside the final day of the DEFAULT policy — would normally relax to 100%
      checkStop: () => stopDetail(root),
      sleep: async () => {
        calls++;
        if (calls >= 2) requestStop(root, "custom-policy proof done");
      },
    },
    { headroomPolicy: tightPolicy },
  );
  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0, "80% >= the custom policy's 50% reserve ⇒ idles, even inside what the default curve treats as the final day");
});

// ── unreadable headroom: BOUNDED degraded mode (recon R-7: unreadable ~78% of the time) ─

test("headroom unreadable (undefined), WITHIN the bounded allowance, does not silently continue — it dispatches under an explicit, logged policy", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
      sleep: clock.sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"], "still dispatches within the bounded degraded-mode allowance");
  const unavailable = lines.filter((l) => l.step === "daemon.headroom.unavailable");
  assert.ok(unavailable.length >= 1, "an unreadable read is logged as an explicit, distinguishable condition — never silent");
  assert.equal(unavailable[0].extra.consecutive_unreadable, 1);
  assert.equal(unavailable[0].extra.degraded_limit, DEFAULT_UNREADABLE_DEGRADED_LIMIT);
  assert.equal(lines.some((l) => l.step === "daemon.headroom.degraded"), false, "the bound was never exceeded, so it never escalates");
});

test("headroom unreadable BEYOND the bounded allowance ESCALATES to the in-process idle heartbeat — it stops dispatching", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-headroom-degraded-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let spawned = 0;
  let calls = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => undefined, // NEVER readable — the "78% of the time" fixture, worst case
      checkStop: () => stopDetail(root),
      sleep: async () => {
        calls++;
        if (calls >= 6) requestStop(root, "degraded-escalation proof done");
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { unreadableDegradedLimit: 2 }, // small bound so the test doesn't need many ticks
  );
  assert.equal(s.stopReason, "stopped");
  // First 2 misses stay within the bound and dispatch (A, then D — both have
  // no deps and B/C are gated behind A). Once misses exceed the bound, the
  // daemon must stop spawning new work and idle instead — READING THE
  // UNREADABLE STATE AS "PROCEED AS IF UNLIMITED" (the fail-open polarity
  // this criterion forbids) would keep spawning forever instead.
  assert.ok(spawned <= 2, "spawning stopped once the unreadable streak exceeded its bound");
  const degraded = lines.filter((l) => l.step === "daemon.headroom.degraded");
  assert.ok(degraded.length >= 1, "the escalation is logged as a distinct, named condition");
  assert.equal(degraded[0].extra.degraded_limit, 2);
  assert.ok((degraded[0].extra.consecutive_unreadable as number) > 2);
});

test("a single successful read RESETS the consecutive-unreadable counter — it does not accumulate across a good read", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  // undefined, undefined, GOOD READ (headroom clear), undefined, undefined —
  // never 3 CONSECUTIVE misses, so with a degraded limit of 2 this must
  // never escalate. Bounded to EXACTLY these 5 reads via a read-count-based
  // checkStop (not `max`, which would stop after the first dispatch, before
  // the sequence plays out; not a real temp-dir stop file, which this doesn't
  // need) — no `no_runnable`/hang risk either way since checkStop is
  // evaluated at the top of every iteration regardless of that iteration's
  // dispatch-or-idle outcome.
  const reads: Array<UsageSnapshot | undefined> = [
    undefined,
    undefined,
    { billingMode: "subscription", session: { percentUsed: 1, resetsAt: "x" }, weekly: [{ label: "all models", percentUsed: 1, resetsAt: "y" }] },
    undefined,
    undefined,
  ];
  let readCount = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => reads[readCount++],
      checkStop: () => (readCount >= reads.length ? "read the whole scripted sequence" : undefined),
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { unreadableDegradedLimit: 2 },
  );
  assert.equal(s.stopReason, "stopped");
  assert.equal(readCount, reads.length, "exercised exactly the scripted sequence, no more");
  assert.equal(lines.some((l) => l.step === "daemon.headroom.degraded"), false, "the good read in between reset the streak — never 3 in a row");
});

// ── resets_at canonical rendering (this task's SECOND, smaller defect) ──────

test("parseResetInstant: recognizes every /usage shape observed in this task's rationale", () => {
  const now = JUL_20_2026_2200();
  assert.deepEqual(parseResetInstant("Jul 21 at 12am", now), new Date(2026, 6, 21, 0, 0, 0, 0));
  assert.deepEqual(parseResetInstant("Jul 20 at 11:59pm", now), new Date(2026, 6, 20, 23, 59, 0, 0));
  assert.deepEqual(parseResetInstant("Jul 14, 8:00pm", now), new Date(2027, 6, 14, 20, 0, 0, 0)); // already past ⇒ next year
  assert.equal(parseResetInstant("not a recognized shape at all", now), null);
});

// ── W1-T482: the upstream flipped to ISO-8601 on 2026-08-12; the parser must accept BOTH ────

test("parseResetInstant: recognizes ISO-8601 (the format /usage switched to on 2026-08-12), additively", () => {
  const now = new Date("2026-08-14T12:00:00Z");
  // The three shapes from the shard's own falsification table, run against the real function.
  assert.deepEqual(parseResetInstant("2026-08-14T16:20:00.069763+00:00", now), new Date("2026-08-14T16:20:00.069763+00:00"));
  assert.deepEqual(parseResetInstant("2026-08-14T16:20:00Z", now), new Date("2026-08-14T16:20:00Z"));
  assert.deepEqual(parseResetInstant("2026-08-14T16:20:00+00:00", now), new Date("2026-08-14T16:20:00+00:00"));
  // ADDITIVE, NOT A REPLACEMENT: every human form this parser matched before still matches.
  assert.deepEqual(parseResetInstant("Jul 21 at 12am", JUL_20_2026_2200()), new Date(2026, 6, 21, 0, 0, 0, 0));
  assert.notEqual(parseResetInstant("Monday", now), null, "human weekday form still parses");
  assert.equal(parseResetInstant("not a recognized shape at all", now), null);
});

test("resolveHeadroomLimitPct: the falsification table — a successful ISO parse landing inside the final day relaxes, one further out does not", () => {
  const now = new Date("2026-08-14T12:00:00Z");
  const closeIso = parseResetInstant("2026-08-14T16:20:00Z", now); // ~4h out
  const hoursToReset = closeIso ? (closeIso.getTime() - now.getTime()) / 3_600_000 : null;
  assert.equal(resolveHeadroomLimitPct(hoursToReset), 100);
  // "Monday" parses (unlike an unrecognised string, which falls back to `null`) but is always
  // MORE than 24h out from any `now` — a successful parse is NOT sufficient for the relaxation;
  // only landing inside the final day is.
  const monday = parseResetInstant("Monday", now)!;
  const mondayHours = (monday.getTime() - now.getTime()) / 3_600_000;
  assert.ok(mondayHours > 24, `expected "Monday" to resolve beyond the final day, got ${mondayHours}h`);
  assert.equal(resolveHeadroomLimitPct(mondayHours), HEADROOM_LIMIT_PCT);
});

test("resets_at renders IDENTICALLY for the same reset instant across boots — the observed 'Jul 21 at 12am' vs 'Jul 20 at 11:59pm' defect", () => {
  const now = JUL_20_2026_2200();
  const a = parseResetInstant("Jul 21 at 12am", now)!;
  const b = parseResetInstant("Jul 20 at 11:59pm", now)!;
  // Different raw text, 60 real seconds apart — but the same MEANINGFUL
  // reset moment; canonicalizing rounds the sub-hour jitter away so both
  // render identically.
  assert.equal(formatResetInstant(a), formatResetInstant(b));
  assert.deepEqual(canonicalizeResetInstant(a), canonicalizeResetInstant(b));
});

test("headroom heartbeat: two boots reading the SAME window a minute apart log the IDENTICAL resets_at string", async () => {
  const plan = fixturePlan();
  const snapWith = (resetsAt: string): UsageSnapshot => ({
    billingMode: "subscription",
    session: { percentUsed: 10, resetsAt: "x" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt }],
  });
  const runOnce = async (resetsAt: string, now: () => Date) => {
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const root = mkdtempSync(join(tmpdir(), "daemon-headroom-canon-"));
    let calls = 0;
    await runDaemon(plan, {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => okResult(id),
      readUsage: () => snapWith(resetsAt),
      now,
      checkStop: () => stopDetail(root),
      sleep: async () => {
        calls++;
        if (calls >= 1) requestStop(root, "one heartbeat is enough");
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    });
    return lines.find((l) => l.step === "daemon.headroom")?.extra.resets_at;
  };
  // Same `now` in both (as two consecutive real boots minutes apart would
  // share) — only the /usage WORDING of the SAME reset instant differs,
  // exactly the observed defect. `now` is deliberately OUTSIDE the final day
  // (26h from the reset) so the 98% reading still binds the (unrelaxed)
  // reserve and a heartbeat actually fires — the time-aware ceiling itself is
  // covered by a separate test above.
  const boot1 = await runOnce("Jul 21 at 12am", JUL_19_2026_2200);
  const boot2 = await runOnce("Jul 20 at 11:59pm", JUL_19_2026_2200);
  assert.ok(boot1, "first boot logged a heartbeat");
  assert.equal(boot1, boot2, "the SAME reset instant renders identically regardless of /usage's wording that boot");
});

// ── daemonExitCode: the pure stop-reason -> exit-code mapping (Rule 18) ─────

test("daemonExitCode: stopped/max_reached are the ONLY clean (zero) exits", () => {
  const zero: DaemonStopReason[] = ["stopped", "max_reached"];
  const nonzero: DaemonStopReason[] = ["blocked", "error", "stale"];
  for (const r of zero) assert.equal(daemonExitCode(r), 0, `${r} should exit 0`);
  // W1-T2537: still ALL non-zero — the polarity is unchanged and launchd's
  // KeepAlive{SuccessfulExit:false} restarts on every one of them exactly as before. What
  // changed is only that they are now DISTINGUISHABLE, which is the assertion below.
  for (const r of nonzero) assert.notEqual(daemonExitCode(r), 0, `${r} should exit nonzero`);
});

test("W1-T2537: a blocked pass is distinguishable from a crash, because docker charges them the same otherwise", () => {
  // THE DEFECT. `daemonExitCode` mapped `blocked` and `error` both to 1, and docker's
  // `--restart=on-failure:N` counts every non-zero exit against N without reading the value
  // (W1-T490 MEASURED that: `exit 1` and `exit 42` both parked at RestartCount=2 under
  // `on-failure:2`). So a COMPLETED drain pass that found a task blocked spent the same finite
  // budget as a crash — and a red board is exactly what produces blocked passes, so the budget
  // emptied fastest when the fleet was most needed. MEASURED 2026-08-30: 46+ minutes down after a
  // pass that had dispatched three tasks and opened three PRs.
  assert.equal(daemonExitCode("blocked"), DAEMON_EXIT_BLOCKED);
  assert.notEqual(daemonExitCode("blocked"), daemonExitCode("error"), "a blocked pass and a crash must not share a code");
});

test("W1-T2537: error KEEPS 1, so a genuine crash stays countable against the on-failure budget", () => {
  // The bound W1-T490 protected is not being removed, only narrowed to what it is for. `error` is
  // the daemon throwing; it must still reach docker's count on its first attempt.
  assert.equal(daemonExitCode("error"), 1);
});

test("W1-T2537: every non-zero stop reason has its OWN code, so the entrypoint can route each one", () => {
  // The routing is only possible if the codes are pairwise distinct — a shared code silently
  // re-merges two policies the entrypoint is meant to treat differently.
  const codes = (["blocked", "error", "stale"] as DaemonStopReason[]).map(daemonExitCode);
  assert.equal(new Set(codes).size, codes.length, `expected distinct codes, got ${codes.join(", ")}`);
  assert.equal(codes.filter((c) => c === 0).length, 0, "none of these is a clean exit");
});

test("daemonExitCode: a genuine crash (stopReason='error') STILL exits nonzero — preserving the KeepAlive restart the kill -9 drill verified", async () => {
  // Belt-and-suspenders: exercise the SAME path runDaemon actually returns on
  // an unexpected throw, then feed that real stopReason through the mapping
  // — not just a literal "error" string constructed by hand.
  const plan = fixturePlan();
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw new Error("boom — a genuine crash, not a policy stop"); },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "error");
  assert.equal(daemonExitCode(s.stopReason), 1, "a real crash must still map to a nonzero exit so launchd's KeepAlive restarts it");
});

// ── W1-T490: A FRESHNESS EXIT AND A CRASH MUST BE TELLABLE APART ────────────
//
// BOTH DIRECTIONS OR NOTHING. The defect was that `blocked`, `error` and `stale` all mapped to 1,
// so docker's `--restart=on-failure:N` charged a routine freshness restart — one per merge — to the
// same finite budget as a crash, and no amount of healthy running refunded it. The fix must make
// `stale` distinguishable WITHOUT making a crash indistinguishable from a clean stop: a change that
// stops freshness spending the budget but also stops a crash loop being caught is a regression
// wearing a fix's clothes. The pair below asserts each direction separately.

test("W1-T490: a freshness stop carries its OWN code, so the entrypoint can tell it from a crash", () => {
  assert.equal(daemonExitCode("stale"), DAEMON_EXIT_STALE);
  // THE DISCRIMINATION THAT MATTERS. Before this change both sides of each comparison were 1, so
  // the entrypoint had no signal at all to branch on.
  assert.notEqual(daemonExitCode("stale"), daemonExitCode("error"), "a freshness restart must not look like a crash");
  assert.notEqual(daemonExitCode("stale"), daemonExitCode("blocked"), "nor like a blocked stop");
});

test("W1-T490: and a crash is STILL nonzero-and-countable — the freshness carve-out must not swallow it", () => {
  // The regression this guards: giving a stop reason its own code by widening the ZERO set instead
  // of the nonzero one. `error` staying at 1 is what leaves `on-failure:N` bounding a crash loop.
  //
  // W1-T2537 MOVED `blocked` OFF 1, AND THAT IS THIS TEST'S CONTRACT CHANGING, NOT ITS GUARANTEE
  // WEAKENING. What this test exists to protect is that a CRASH stays countable; `blocked` was
  // never a crash — it is a drain pass that ran to completion and found a task blocked, and
  // charging it to the crash budget is what left the container down for 46+ minutes on
  // 2026-08-30. `error` still carries the whole guarantee, and the non-zero assertion below keeps
  // `blocked` from doing the OTHER damage this test guards against (crossing to zero).
  assert.equal(daemonExitCode("error"), 1, "error must stay 1 so docker still counts a crash against the budget");
  assert.notEqual(daemonExitCode("blocked"), 0, "a blocked stop must still RESTART; 0 would leave the container down");
  // AND `stale` MUST NOT HAVE CROSSED TO ZERO. Zero is the one value that stops a restart happening
  // at all — `--restart=on-failure` leaves the container DOWN on a clean exit — so mapping freshness
  // to 0 would trade a spent budget for a dead fleet, which is the worse failure.
  assert.notEqual(daemonExitCode("stale"), 0, "a freshness stop must still RESTART; 0 would leave the container down");
  for (const r of ["stopped", "max_reached"] as DaemonStopReason[]) {
    assert.equal(daemonExitCode(r), 0, `${r} must stay a clean exit so an operator STOP really stops the fleet`);
  }
});

test("W1-T490: every DaemonStopReason maps to a real exit code, and the classes stay distinct", () => {
  // EXHAUSTIVE OVER THE UNION, so a sixth member added later cannot silently inherit a class.
  // W1-T2537: the class count is now four — see the deepEqual below for why each one exists.
  const all: DaemonStopReason[] = ["stopped", "blocked", "max_reached", "error", "stale"];
  for (const r of all) {
    const code = daemonExitCode(r);
    assert.ok(Number.isInteger(code) && code >= 0 && code <= 255, `${r} -> ${code} is not a valid process exit code`);
  }
  assert.deepEqual(
    [...new Set(all.map(daemonExitCode))].sort((a, b) => a - b),
    [0, 1, DAEMON_EXIT_STALE, DAEMON_EXIT_BLOCKED],
    "exactly FOUR classes: clean stop, crash, freshness, blocked (W1-T2537 split blocked off the crash class)",
  );
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

// ── W1-T174: drain/sweep PARITY — a FIXABLE genuine blocker dispatches to
// the fix rung instead of halting; halt narrows to the truly-stuck. ────────

test("W1-T174: a FIXABLE genuine blocker (blocked_ci, the #382 fixture's own verdict) dispatches to deps.dispatchFix — NOT halt+escalate — and the retry succeeds", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const dispatches: Array<{ task: Task; result: RunResult; dependents: string[] }> = [];
  const escalations: unknown[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  let bAttempts = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id): Promise<RunResult> => {
        ran.push(id);
        if (id === "B") {
          bAttempts++;
          if (bAttempts === 1) {
            return {
              taskId: id,
              runId: id + "-run",
              merged: false,
              costUsd: 0.2,
              verdict: "blocked_ci",
              prUrl: "https://github.com/o/r/pull/382",
            };
          }
        }
        merged.add(id);
        return okResult(id);
      },
      dispatchFix: async (info) => { dispatches.push(info); },
      escalateBlock: async (info) => { escalations.push(info); },
      sleep: clock.sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 5 },
  );
  assert.deepEqual(ran, ["A", "B", "B", "C", "D"], "B retries once (fixable) before merging and C proceeds");
  assert.deepEqual(s.merged, ["A", "B", "C", "D"]);
  assert.equal(s.stopReason, "max_reached", "a fixable block with the fix rung wired never halts the daemon");
  assert.equal(dispatches.length, 1, "dispatchFix is called exactly once, for the ONE fixable block");
  assert.equal(dispatches[0].task.id, "B");
  assert.deepEqual(dispatches[0].dependents, ["C"]);
  assert.equal(dispatches[0].result.verdict, "blocked_ci");
  assert.equal(escalations.length, 0, "a fixable block the rung is wired to handle never escalates");
  assert.ok(!lines.some((l) => l.step === "daemon.blocked"), "a fixable block dispatched to the rung is never a halt-and-escalate");
  const dispatchLine = lines.find((l) => l.step === "daemon.block.fixable_dispatch");
  assert.ok(dispatchLine, "a daemon.block.fixable_dispatch ledger line was emitted");
  assert.deepEqual(dispatchLine?.extra, { task: "B", verdict: "blocked_ci", dependents: ["C"], strikes: 1 });
});

test("W1-T174: an UNFIXABLE genuine blocker still halts + escalates immediately, even with dispatchFix wired — halt narrows to the truly-stuck, it is not removed", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const dispatches: unknown[] = [];
  const escalations: Array<{ task: Task; result: RunResult; dependents: string[] }> = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id): Promise<RunResult> => {
      if (id === "B") {
        return { taskId: id, runId: id + "-run", merged: false, costUsd: 0.2, verdict: "blocked_budget" };
      }
      merged.add(id);
      return okResult(id);
    },
    dispatchFix: async (info) => { dispatches.push(info); },
    escalateBlock: async (info) => { escalations.push(info); },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_budget/);
  assert.equal(dispatches.length, 0, "an unfixable block never reaches the fix rung — no nameable criterion to act on");
  assert.equal(escalations.length, 1, "an unfixable genuine blocker still escalates exactly as before");
  assert.equal(escalations[0].task.id, "B");
});

test("W1-T174: a FIXABLE genuine blocker with NO dispatchFix wired still halts + escalates — never a silent stall on a block it has no rung to act on", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const escalations: Array<{ task: Task; result: RunResult; dependents: string[] }> = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id): Promise<RunResult> => {
      if (id === "B") {
        return { taskId: id, runId: id + "-run", merged: false, costUsd: 0.2, verdict: "blocked_ci" };
      }
      merged.add(id);
      return okResult(id);
    },
    escalateBlock: async (info) => { escalations.push(info); },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_ci/);
  assert.equal(escalations.length, 1, "no dispatchFix wired ⇒ the SAME halt+escalate a genuine blocker always got");
  assert.equal(escalations[0].task.id, "B");
});

// ── W1-T976: block reasoning must consult the tick's OWN merged projection before ──
// ── trusting `result.verdict` — a PR that merges gate-side after the run stopped ──
// ── must not be classed a fixable blocker, spend a strike, or hold dependents.    ──

test("W1-T976: a task whose pull request already merged is not treated as blocked", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id): Promise<RunResult> => {
        if (id === "B") {
          // The PR merged gate-side (GitHub's required-status contract) AFTER this run's
          // own bounded check stopped — the tick's merged projection now credits B even
          // though this result still says unmerged, exactly the rationale's case (3)/(4).
          merged.add("B");
          return { taskId: "B", runId: "B-run", merged: false, costUsd: 0.2, verdict: "blocked_ci", prUrl: "https://github.com/o/r/pull/600" };
        }
        merged.add(id);
        return okResult(id);
      },
      dispatchFix: async () => {},
      escalateBlock: async () => {},
      sleep: clock.sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 4 },
  );
  assert.equal(s.stopReason, "max_reached", "an already-merged task never routes into block reasoning's halt path");
  assert.ok(!lines.some((l) => l.step === "daemon.blocked"), "never the halt+escalate genuine-blocker line");
  assert.ok(s.merged.includes("B"), "credited merged, exactly like a task whose result.merged was true");
});

test("W1-T976: an already merged task does not block its dependents", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id): Promise<RunResult> => {
        ran.push(id);
        if (id === "B") {
          merged.add("B");
          return { taskId: "B", runId: "B-run", merged: false, costUsd: 0.2, verdict: "blocked_ci", prUrl: "https://github.com/o/r/pull/601" };
        }
        merged.add(id);
        return okResult(id);
      },
      dispatchFix: async () => {},
      escalateBlock: async () => {},
      sleep: clock.sleep,
    },
    { max: 4 },
  );
  assert.ok(ran.includes("C"), "C — B's transitive dependent — still gets dispatched, never held");
  assert.deepEqual(s.merged, ["A", "B", "C", "D"]);
  assert.equal(s.stopReason, "max_reached");
});

test("W1-T976: no fix rung is dispatched for a task that already merged", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const dispatches: unknown[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id): Promise<RunResult> => {
        if (id === "B") {
          merged.add("B");
          return { taskId: "B", runId: "B-run", merged: false, costUsd: 0.2, verdict: "blocked_ci", prUrl: "https://github.com/o/r/pull/602" };
        }
        merged.add(id);
        return okResult(id);
      },
      dispatchFix: async (info) => { dispatches.push(info); },
      sleep: clock.sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 4 },
  );
  assert.equal(dispatches.length, 0, "the fix rung is never reached — the task was already merged, not a fixable blocker");
  assert.ok(!lines.some((l) => l.step === "daemon.block.fixable_dispatch"), "no strike-spending ledger line for an already-merged task");
});

test("W1-T976: a task that genuinely did not merge still blocks", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const escalations: Array<{ task: Task; result: RunResult; dependents: string[] }> = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id): Promise<RunResult> => {
      if (id === "B") {
        // Genuinely unmerged — never added to the projection — so this is the falsifier:
        // block reasoning must still run and still hold C, exactly as before this task.
        return { taskId: "B", runId: "B-run", merged: false, costUsd: 0.2, verdict: "blocked_budget" };
      }
      merged.add(id);
      return okResult(id);
    },
    escalateBlock: async (info) => { escalations.push(info); },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "blocked", "a genuinely unmerged task still halts — block reasoning is not disabled");
  assert.match(s.stopDetail ?? "", /B → blocked_budget/);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].task.id, "B");
  assert.ok(!s.merged.includes("B"), "never credited as merged");
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

// ── W1-T113 DEGRADE, DON'T DIE (the vanished-binary incident): a spawn-
// INFRASTRUCTURE failure (worker.ts's `ClaudeToolchainBlockedError` shape,
// duck-typed here via a plain object — daemon.ts never imports worker.ts as a
// value) must never crash-loop the daemon. Pre-fix shape: error -> process
// exit -> launchd KeepAlive restart -> the identical failure again, five
// consecutive polls, zero escalations, zero backoff.

/** The exact duck-typed shape `isSpawnInfraBlocked` classifies — mirrors
 * worker.ts's `ClaudeToolchainBlockedError` without importing it. */
function toolchainBlockedError(reason = "claude executable not found or not runnable — searched: npm-global=... (missing)") {
  return Object.assign(new Error(reason), { reasonClass: "blocked_toolchain" as const });
}

test("W1-T113: a spawn-infra (blocked_toolchain) failure is NEVER a terminal 'error' stop", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-spawn-infra-"));
  let calls = 0;
  const sleep = async (_ms: number) => {
    calls++;
    if (calls >= 3) requestStop(root, "test done polling");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw toolchainBlockedError(); },
    checkStop: () => stopDetail(root),
    sleep,
  });
  assert.equal(s.stopReason, "stopped", "the loop kept polling until the test itself stopped it");
  assert.notEqual(s.stopReason, "error", "a spawn-infra failure is degraded state, never a crash");
  assert.ok(calls >= 3, "the daemon really did back off and re-poll multiple times");
});

test("W1-T113: repeated spawn-infra failures escalate EXACTLY ONCE per distinct cause, never once per tick", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-spawn-infra-dedup-"));
  const escalations: Array<{ task: string; reason: string }> = [];
  let calls = 0;
  const sleep = async (_ms: number) => {
    calls++;
    if (calls >= 5) requestStop(root, "test done polling");
  };
  await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw toolchainBlockedError("same cause every time"); },
    onSpawnInfraBlocked: async (info) => { escalations.push({ task: info.task.id, reason: info.reason }); },
    checkStop: () => stopDetail(root),
    sleep,
  });
  assert.ok(calls >= 5, "the daemon polled (and failed to dispatch) repeatedly");
  assert.equal(escalations.length, 1, "exactly one escalation for the whole run, despite 5+ identical failures");
  assert.equal(escalations[0].reason, "same cause every time");
});

test("W1-T113: a DIFFERENT spawn-infra cause escalates again — dedup is content-keyed, not a blanket one-shot", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-spawn-infra-dedup2-"));
  const escalations: string[] = [];
  let calls = 0;
  const sleep = async (_ms: number) => {
    calls++;
    if (calls >= 2) requestStop(root, "test done polling");
  };
  await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw toolchainBlockedError(calls === 0 ? "cause A" : "cause B"); },
    onSpawnInfraBlocked: async (info) => { escalations.push(info.reason); },
    checkStop: () => stopDetail(root),
    sleep,
  });
  assert.deepEqual(escalations, ["cause A", "cause B"], "a genuinely new cause is not suppressed by the prior cause's dedup entry");
});

test("W1-T113: dispatch backs off with DOUBLING sleeps while sweep keeps running every tick", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-spawn-infra-backoff-"));
  const backoffs: number[] = [];
  let sweepCalls = 0;
  const sleep = async (ms: number) => {
    backoffs.push(ms);
    if (backoffs.length >= 4) requestStop(root, "test done polling");
  };
  await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw toolchainBlockedError(); },
    sweep: async () => { sweepCalls++; },
    checkStop: () => stopDetail(root),
    sleep,
  }, { pollIntervalMs: 1000 });
  assert.deepEqual(backoffs, [1000, 2000, 4000, 8000], "each consecutive failure doubles the backoff from pollIntervalMs");
  assert.ok(sweepCalls >= 4, "the reconciler ran on every tick, even while dispatch itself backed off");
});

test("W1-T113: the backoff is capped at maxSpawnInfraBackoffMs, never grows unbounded", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-spawn-infra-backoff-cap-"));
  const backoffs: number[] = [];
  const sleep = async (ms: number) => {
    backoffs.push(ms);
    if (backoffs.length >= 6) requestStop(root, "test done polling");
  };
  await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => { throw toolchainBlockedError(); },
      checkStop: () => stopDetail(root),
      sleep,
    },
    { pollIntervalMs: 1000, maxSpawnInfraBackoffMs: 3000 },
  );
  assert.deepEqual(backoffs, [1000, 2000, 3000, 3000, 3000, 3000], "backoff caps at maxSpawnInfraBackoffMs instead of doubling forever");
});

test("W1-T113: a THROWING onSpawnInfraBlocked hook does not kill the loop", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-spawn-infra-escalation-throws-"));
  let calls = 0;
  const sleep = async (_ms: number) => {
    calls++;
    if (calls >= 2) requestStop(root, "test done polling");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw toolchainBlockedError(); },
    onSpawnInfraBlocked: () => { throw new Error("gh unreachable"); },
    checkStop: () => stopDetail(root),
    sleep,
  });
  assert.notEqual(s.stopReason, "error", "an undeliverable spawn-infra escalation is not a daemon error");
});

test("W1-T113: an unrelated throw (no reasonClass) still terminates as an 'error' stop — only the named infra class degrades", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw Object.assign(new Error("disk full"), { reasonClass: "blocked_something_else" }); },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "error", "this daemon does not learn to swallow every throw, only the classified spawn-infra one");
});

test("W1-T113: DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS is exported policy data, not a buried literal", () => {
  assert.equal(typeof DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS, "number");
  assert.ok(DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS > DEFAULT_POLL_INTERVAL_MS);
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

// ── W1-T117 part (ii): the per-POLL half of the orphan sweep ───────────────
// daemonBoot (above) runs the sweep once at boot; runDaemon's own tick loop
// runs the SAME entry point once per iteration, alongside the existing
// PR-pipeline `sweep` — a stray from a run that ends BETWEEN polls is still
// found within one cycle, not only at the next boot.

test("runDaemon: sweepOrphans runs once per tick and logs daemon.orphan_sweep with the killed/left-alone COUNT", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  let sweepCalls = 0;
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-orphan-sweep-"));
  const s = await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    sweepOrphans: () => {
      sweepCalls += 1;
      return {
        killed: [{ pid: 111, run_id: "run-1", task_id: "W1-T1", cmdline: "sleep 300" }],
        leftAlone: [],
      };
    },
    checkStop: () => (sweepCalls >= 1 ? (requestStop(root, "one orphan sweep seen"), stopDetail(root)) : undefined),
    sleep: async () => {},
    log: (step, extra) => lines.push({ step, extra }),
  });
  assert.ok(sweepCalls >= 1, "the orphan sweep ran at least once per tick");
  const line = lines.find((l) => l.step === "daemon.orphan_sweep");
  assert.ok(line, "daemon.orphan_sweep is logged");
  assert.equal(line?.extra?.killed, 1);
  assert.equal(line?.extra?.left_alone, 0);
  assert.notEqual(s.stopReason, "error");
});

test("runDaemon: a THROWING sweepOrphans does not kill the loop — it logs daemon.orphan_sweep.failed and keeps polling", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  let sweepCalls = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-orphan-sweep-throw-"));
  const s = await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    sweepOrphans: () => {
      sweepCalls += 1;
      throw new Error("ps: command not found");
    },
    checkStop: () => (sweepCalls >= 2 ? (requestStop(root, "two failed orphan sweeps seen"), stopDetail(root)) : undefined),
    sleep: async () => {},
  });
  assert.ok(sweepCalls >= 2, `the loop kept iterating THROUGH the failures (saw ${sweepCalls} sweeps)`);
  assert.notEqual(s.stopReason, "error", "a failing orphan sweep is not a daemon error");
});

test("runDaemon: with no sweepOrphans injected, the loop behaves exactly as before W1-T117 (no daemon.orphan_sweep line)", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string }> = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-no-orphan-sweep-"));
  await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    checkStop: () => (requestStop(root, "stop immediately"), stopDetail(root)),
    sleep: async () => {},
    log: (step) => lines.push({ step }),
  });
  assert.equal(lines.filter((l) => l.step.startsWith("daemon.orphan_sweep")).length, 0);
});

// ── W1-T356: DaemonDeps.sweepOrphans WIRED into the REAL production deps ───
// The two tests above lock runDaemon's OWN consumption of `deps.sweepOrphans` against a
// hand-built fixture — that already passed while the real daemonCommand never set the field
// at all (zero production calls, per this task's own rationale). This section instead drives
// the REAL `daemonCommand`, injecting only the existing `runDaemon` loop-stub seam (the SAME
// seam test/daemon-command-retro-wiring.test.ts uses for the retro hooks), and proves the
// CAPTURED `deps.sweepOrphans` is the real production closure — not merely present, but
// functionally identical to the boot-time half: it kills+ledgers a marker-carrying stray from
// an ended run and leaves a marker-less process alone, alive, and unsignalled.

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-orphan-poll-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, root, planPath };
}


/**
 * W1-T2350: SERIALISE THE TWO REAL, SYSTEM-WIDE ORPHAN SWEEPS ACROSS TEST FILES.
 *
 * THE DEFECT THIS CLOSES. `sweepOrphanWorkers`'s production `listCandidates` is
 * `defaultListCandidates` -- `ps -eo pid=,command=`, EVERY pid on the machine, not this
 * fixture's. Both this suite and its twin (test/daemon.test.ts <-> test/worker-containment.test.ts)
 * spawn a marker-carrying stray and then run the REAL `daemonCommand`, whose boot sweep kills
 * every marked pid whose runId is not active in ITS OWN `state/inflight` directory. The two
 * fixtures have different roots, so neither sweep can see that the other's stray belongs to a
 * live test. `node --test` runs FILES concurrently, so whichever sweep reaches the process table
 * first kills BOTH strays and ledgers both into ITS OWN ledger. The loser then finds its stray
 * already dead -- so `waitUntilDead` and the ESRCH assertion still PASS -- and no
 * `worker_orphan_killed` line in its own ledger: `actual: undefined, expected: true` at the
 * ledger assertion. That is the observed CI failure verbatim (run 33025181897 attempt 1,
 * test/daemon.test.ts:2261), and it is what `scripts/test-with-retry.mjs` was re-running the
 * whole instrumented suite to paper over.
 *
 * IT IS NOT A MARKER-VISIBILITY PROBLEM. `waitUntilMarkersVisible` never throws in these
 * failures -- if it had, the error would be its own message, not an assertion. MEASURED on this
 * host: each file's W1-T356 test passes 20/20 run alone, and the pair fails 10/10 run
 * concurrently, with no artificial load at all.
 *
 * WHY A LOCK AND NOT A FAKE PROCESS TABLE. "the REAL daemonCommand" is the point of both tests:
 * injecting a fake `listCandidates` would stop proving that the wired closure reads the real one,
 * which is the entire wiring claim. So both sweeps stay real and are merely kept from OVERLAPPING.
 *
 * SHAPE (W1-T1066: never pace, never sleep a fixed beat). A bounded wait on the CONDITION -- the
 * lock directory being free -- polled at the same 20 ms beat `waitUntilDead` and
 * `waitUntilMarkersVisible` already use, and it THROWS at its ceiling so a wedged lock fails
 * loudly instead of silently letting the caller run unserialised. `mkdirSync` is the atomic
 * primitive: it fails EEXIST rather than clobbering. A holder that died mid-test is reclaimed by
 * pid, so one SIGKILL cannot wedge every later run on a developer machine.
 */
const REAL_SWEEP_LOCK = join(tmpdir(), "rmd-real-orphan-sweep.lock");

async function withRealSweepLock<T>(fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(REAL_SWEEP_LOCK);
      writeFileSync(join(REAL_SWEEP_LOCK, "holder.pid"), String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A holder pid of 0 means the directory exists but its pid file is not written yet -- the
      // other process is mid-acquire. That is a LIVE holder, never a stale one, so it is waited
      // out rather than reclaimed.
      let holder = 0;
      try {
        holder = Number(readFileSync(join(REAL_SWEEP_LOCK, "holder.pid"), "utf8").trim()) || 0;
      } catch {
        holder = 0;
      }
      if (holder > 0 && !isPidAlive(holder)) {
        rmSync(REAL_SWEEP_LOCK, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `real-sweep lock ${REAL_SWEEP_LOCK} (holder pid ${holder || "unknown"}) never released within ${timeoutMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(REAL_SWEEP_LOCK, { recursive: true, force: true });
  }
}

function ledgerLines(root: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPathFor({ root } as never), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (isPidAlive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * W1-T459: wait for the CONDITION the orphan sweep reads — `ps eww` having published `pid`'s
 * marker ENV — rather than sleeping a fixed beat. Twin of the helper in
 * test/worker-containment.test.ts, duplicated here for the same reason `waitUntilDead` above
 * already is: these two suites keep their process helpers local rather than sharing a module.
 *
 * MEASURED on the mini (10 cores): first visibility is 2 ms idle, but 48 ms median / 150 ms max at
 * load 58-86, with 4 of 25 samples past the 100 ms the old beat allowed. Ceiling 5000 ms matches
 * `waitUntilDead`; it THROWS rather than proceeding, so a never-published pid fails loudly instead
 * of turning this wiring lock into a vacuous pass.
 */
async function waitUntilMarkersVisible(pid: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (defaultReadMarkers(pid) === undefined) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`ps eww never published marker env for pid ${pid} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("W1-T356 wiring: the REAL daemonCommand sets DaemonDeps.sweepOrphans to the SAME production closure daemonBoot uses — calling the CAPTURED dep kills+ledgers an ended-run stray and leaves an unattributable process alone", async () => {
  await withRealSweepLock(async () => {
    const { home, root, planPath } = fixtureHome();
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const strayEnv = {
      ...process.env,
      [RUN_ID_ENV]: "run-ended-poll-1",
      [TASK_ID_ENV]: "W1-T356-poll-fixture",
      [WORKER_SCOPE_ENV]: workerInstallationScope(root),
    };
    const stray = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: strayEnv });
    const foreign = spawnDetachedGroup({
      command: "/bin/sh",
      args: ["-c", "sleep 300"],
      env: {
        ...process.env,
        [RUN_ID_ENV]: "run-ended-foreign",
        [TASK_ID_ENV]: "W1-T356-foreign-control",
        [WORKER_SCOPE_ENV]: workerInstallationScope(`${root}-foreign`),
      },
    });
    const unrelated = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: { PATH: process.env.PATH } });
    let captured: DaemonDeps | undefined;
    try {
      // W1-T459: the sweep can only attribute this stray once `ps eww` publishes its marker env, so
      // wait for exactly that condition — same discipline as worker-containment.test.ts's own
      // defaultReadMarkers test. This is the beat whose expiry produced the observed
      // `killedLine undefined`: unattributed means unkilled means unledgered.
      await waitUntilMarkersVisible(stray.pid);
      await waitUntilMarkersVisible(foreign.pid);
      const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
        runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
          captured = deps;
          return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
        },
      });
      assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
      assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
      assert.equal(typeof captured!.sweepOrphans, "function", "the per-poll half must be set, not left undefined");

      // The boot-time half already ran during this SAME daemonCommand call (daemonBoot's own
      // sweepOrphanWorkers param) and may have already reaped the stray — call the CAPTURED
      // per-poll dep too, so this test proves the per-poll field independently, not merely that
      // boot ran first. Either call reaching it is a pass: the assertion is on the OUTCOME
      // (killed + ledgered), not on which of the two wired call sites did it.
      const report = await captured!.sweepOrphans!();
      assert.ok(report, "the per-poll dep, called directly, must return a real OrphanSweepReport");

      await waitUntilDead(stray.pid);
      assert.throws(() => process.kill(stray.pid, 0), /ESRCH/, "the attributed stray must be dead via one of the two wired call sites");
      assert.equal(isPidAlive(unrelated.pid), true, "a marker-less process must never be signalled, no matter how suspicious it looks");
      assert.equal(isPidAlive(foreign.pid), true, "a foreign-scoped process must never be signalled");

      const lines = ledgerLines(root);
      const killedLine = lines.find((l) => l.step === "worker_orphan_killed" && l.pid === stray.pid);
      assert.ok(killedLine, "the real production ledger dep must record the kill");
      assert.equal(killedLine!.run_id, "run-ended-poll-1");
      assert.equal(killedLine!.task_id, "W1-T356-poll-fixture");
      assert.equal(killedLine!.worker_scope, workerInstallationScope(root));
    } finally {
      try {
        killProcessGroup(stray.pid);
      } catch {
        // best-effort cleanup only
      }
      try {
        killProcessGroup(foreign.pid);
      } catch {
        // best-effort cleanup only
      }
      try {
        killProcessGroup(unrelated.pid);
      } catch {
        // best-effort cleanup only
      }
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── W1-T254 (the #707 fix): the restricted LIGHT-SWEEP TICKER ──────────────
// `runOne` is unbounded — a long task run holds the daemon inside a single
// call, during which the outer per-iteration `deps.sweep` above never runs
// again. #707: the daemon swept at 13:12 (armed the OLD head), entered
// `runOne`, and never swept again to see the NEW head for the whole window —
// unbounded latency, total invisibility. `sweepLight` ticks ALONGSIDE an
// in-flight `runOne` to close that gap.

test("W1-T254: the light sweep runs while runOne is in flight, so a green PR with an absent review re-posts within one poll interval (the #707 fix)", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  let lightSweeps = 0;
  let sleeps = 0;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    if (sleeps >= 3) releaseRunOne?.();
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        // FALSIFIER: pre-fix, nothing ran again to see a new head until this
        // (unbounded) call finally returned — stays "in flight" here until the
        // ticker has ticked a few times, proving it runs CONCURRENTLY, not
        // only before/after.
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async () => {
        lightSweeps++;
      },
      sleep,
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"], "runOne still completed once the ticker's sleeps released it");
  assert.ok(lightSweeps >= 3, `the light-sweep ticker ran while runOne was in flight (saw ${lightSweeps} tick(s))`);
});

test("W1-T254: a THROWING sweepLight does not kill the loop — it logs daemon.sweep_light.failed and runOne still completes", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let lightSweeps = 0;
  let sleeps = 0;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    if (sleeps >= 2) releaseRunOne?.();
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async () => {
        lightSweeps++;
        // FALSIFIER: pre-fix shape (the daemon.sweep.failed containment) applied
        // to the full sweep only — this proves the SAME containment covers the
        // light ticker too, so a `gh` hiccup here costs one logged tick, never
        // the daemon's liveness.
        throw new Error("gh: HTTP 500");
      },
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached", "runOne still completed despite the throwing ticker");
  assert.ok(lightSweeps >= 2, `the ticker kept retrying THROUGH the failures (saw ${lightSweeps})`);
  const failLine = lines.find((l) => l.step === "daemon.sweep_light.failed");
  assert.ok(failLine, "a daemon.sweep_light.failed ledger line was emitted");
});

test("W1-T254: no sweepLight wired -> the daemon dispatches exactly as before this ticker existed", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        merged.add(id);
        return okResult(id);
      },
      sleep: clock.sleep,
    },
    { max: 4 },
  );
  assert.deepEqual(s.merged, ["A", "B", "C", "D"]);
  assert.equal(s.stopReason, "max_reached");
});

// ── W1-T513 — all four acceptance criteria ─────────────────────────────────────────────────
// Round 2 shipped two of the four against the ticker exactly as it stood, with no third
// `startInFlightTicker` call site: the other two were left unmet because the mutex that would
// make a third caller safe (`claimedReviewKeys`, `src/lib/sweep.ts`) was declared FRESH inside
// every `runSweep` call, so it only ever arbitrated PRs inside ONE call — never between two
// genuinely concurrent callers. This round lifts that mutex to a module-level, cross-call
// `Set` (`inFlightReviewKeys`, `src/lib/sweep.ts`) shared by every caller in the process with NO
// change needed outside that one file, which is what makes wrapping `deps.sweep()` with its own
// ticker (below, and in `src/lib/daemon.ts`) finally safe: the two tests immediately below prove
// each half directly.

test("W1-T513: the light pass interval is unchanged by the fix", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const seenIntervals: number[] = [];
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  let sleeps = 0;
  // A deliberately weird value: if the ticker ever computed its OWN cadence (e.g. half the
  // interval, to sweep "more often"), a bare `pollIntervalMs` echo would still coincidentally
  // pass on common round numbers — this one only passes if the ticker truly reuses the exact
  // injected value, never a derived one.
  const configuredIntervalMs = 12345;
  const sleep: DaemonDeps["sleep"] = async (ms) => {
    seenIntervals.push(ms);
    sleeps++;
    if (sleeps >= 3) releaseRunOne?.();
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async () => {},
      sleep,
    },
    { max: 1, pollIntervalMs: configuredIntervalMs },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.ok(seenIntervals.length >= 3, `the ticker slept at least 3 times (saw ${seenIntervals.length})`);
  assert.ok(
    seenIntervals.every((ms) => ms === configuredIntervalMs),
    `every light-pass tick used the SAME configured pollIntervalMs (${configuredIntervalMs}), never a ` +
      `second, faster cadence that would increase the call budget — saw ${JSON.stringify(seenIntervals)}`,
  );
});

test("W1-T513: a heartbeat alone is not counted as a sweep", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let lightSweepAttempts = 0;
  let sleeps = 0;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    if (sleeps >= 3) releaseRunOne?.();
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      // The light pass NEVER once succeeds this whole pass — every attempt throws. If a
      // `daemon.alive` heartbeat row were ever mistaken for "a sweep ran", this scenario would
      // read as a healthy sweeping daemon; it must instead read as a heartbeat next to a wall of
      // failures.
      sweepLight: async () => {
        lightSweepAttempts++;
        throw new Error("gh: rate limited");
      },
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.ok(lightSweepAttempts >= 3, `the light pass was genuinely attempted every tick (saw ${lightSweepAttempts})`);
  const heartbeats = lines.filter((l) => l.step === "daemon.alive");
  const failures = lines.filter((l) => l.step === "daemon.sweep_light.failed");
  assert.ok(heartbeats.length >= 3, `the heartbeat kept firing every tick regardless (saw ${heartbeats.length})`);
  assert.equal(
    failures.length,
    heartbeats.length,
    "every single heartbeat this pass paired with a FAILED sweep attempt, never a successful one — " +
      "proving the heartbeat's mere presence never stands in for evidence that a sweep actually ran",
  );
});

test("W1-T513: a long tick occupant does not block the light pass", async () => {
  const plan = fixturePlan();
  // Nothing dispatchable this run — the ONLY long-running tick occupant this scenario
  // exercises is `deps.sweep()` itself (the full reconciler), never dispatch, so a light-pass
  // tick observed here can only be explained by `deps.sweep()`'s OWN ticker (W1-T513), not the
  // pre-existing dispatch ticker.
  const isMerged = mergedSetOf("A", "B", "C", "D");
  const root = mkdtempSync(join(tmpdir(), "daemon-t513-sweep-ticks-"));
  let releaseSweep: (() => void) | undefined;
  const sweepGate = new Promise<void>((resolve) => {
    releaseSweep = resolve;
  });
  let lightSweepAttempts = 0;
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async (_ms) => {
    sleeps++;
    // Let `deps.sweep()` finally return once the light pass has genuinely ticked a few times
    // WHILE it was still in flight — the falsifier this test exists to catch is `deps.sweep()`
    // resolving (or the light pass never firing) before that happens.
    if (sleeps >= 3) releaseSweep?.();
    if (sleeps >= 6) requestStop(root, "test done polling");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => isMerged,
    runOne: async (id) => okResult(id),
    sweep: async () => {
      await sweepGate;
    },
    sweepLight: async () => {
      lightSweepAttempts++;
    },
    checkStop: () => stopDetail(root),
    sleep,
  });
  assert.equal(s.stopReason, "stopped");
  assert.ok(
    lightSweepAttempts >= 2,
    `the light pass ticked at least twice WHILE the long-running deps.sweep() occupant was still ` +
      `in flight (saw ${lightSweepAttempts} attempt(s)) — proving that occupant no longer blocks it`,
  );
});

test("W1-T513: two light passes cannot double review one pull request", async () => {
  // A single-PR ledger scenario, driven straight through `runSweep` (the shared entry point
  // BOTH the daemon's `deps.sweep()` walk and every `sweepLight()` tick ultimately call) —
  // exercises the module-level, cross-call mutex `src/lib/sweep.ts` now shares (W1-T513),
  // rather than re-deriving the whole daemon loop's timing to force two REAL concurrent
  // `sweepLight()` ticks. Two overlapping `runSweep([pr], …)` calls over the SAME PR are
  // exactly what two overlapping light passes (or a light pass racing the full sweep) reduce
  // to at this shared layer.
  const root = mkdtempSync(join(tmpdir(), "daemon-t513-double-review-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const pr = {
    prNumber: 9513,
    prUrl: "url/9513",
    taskId: "W1-T9513",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-15T12:00:00Z",
    headSha: "bbbb222",
    autoMergeArmed: false,
  } as never;
  let postReviewCalls = 0;
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const disposeLines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const deps = {
    ledgerPath,
    runId: "T513-DOUBLE-REVIEW",
    now: () => Date.parse("2026-08-15T12:00:00Z"),
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    log: (step: string, extra: Record<string, unknown> = {}) => disposeLines.push({ step, extra }),
    postReview: async () => {
      postReviewCalls++;
      // Held open deliberately: the SECOND concurrent `runSweep` call (below) is invoked, and
      // must run its own synchronous claim check, BEFORE this first attempt ever settles —
      // exactly the overlap window two real, independently-ticking light passes would hit.
      await gate;
    },
  } as never;
  // Both calls are invoked synchronously in this array literal, in order: the FIRST runs to
  // its own internal `await gate` (inside `postReview`) before the SECOND is even called (no
  // `await` separates the mutex claim from the `postReview` call it schedules), so the second
  // call's own claim attempt genuinely observes the first call's still-held key.
  const runs = Promise.all([runSweep([pr], deps, DEFAULT_SWEEP_POLICY), runSweep([pr], deps, DEFAULT_SWEEP_POLICY)]);
  releaseGate?.();
  const [first, second] = await runs;
  assert.equal(postReviewCalls, 1, "only ONE of the two concurrent passes over the same PR ever reached postReview");
  const firstAction = first.actions[0];
  const secondAction = second.actions[0];
  assert.equal(firstAction.disposition, "post-review");
  assert.equal(firstAction.acted, true, "the first pass to claim the review key genuinely acted");
  assert.equal(secondAction.disposition, "post-review");
  assert.equal(secondAction.acted, false, "the second, concurrent pass stood down rather than double-reviewing");
  const standDown = disposeLines.find(
    (l) => l.step === "sweep.dispose.not_open" && typeof l.extra.reason === "string" && /duplicate review key/.test(l.extra.reason as string),
  );
  assert.ok(
    standDown,
    "the second pass's stand-down is explicitly ledgered against the shared review-key mutex, never a silent drop " +
      `(saw steps: ${JSON.stringify(disposeLines.map((l) => l.step))})`,
  );
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
    return { reaped: ["W1-T1"], kept: ["W1-T184"], live: ["W1-T184"], unverifiableForeignHost: [] };
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

// ── W1-T461: `kept` collapsed a confirmed-live holder with an unverifiable foreign-host one, on
// BOTH the boot sweep above and the per-poll rung below — a container replacement strands the
// latter forever (isHolderStale's rung 1, W1-T396, never reaps a foreign host), so a split
// reported at only one site would leave the other still silently misleading.

test("daemonBoot: daemon.lock_sweep carries `live` and `unverifiable_foreign_host` as their OWN counts, distinct from each other", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const sweepLocks = () => ({
    reaped: ["W1-T900"],
    kept: ["W1-T184", "W1-T395"],
    live: ["W1-T184"],
    unverifiableForeignHost: ["W1-T395"],
  });
  daemonBoot((step, extra = {}) => lines.push({ step, extra }), { PATH: "/usr/bin" }, undefined, sweepLocks);
  const swept = lines.find((l) => l.step === "daemon.lock_sweep");
  assert.ok(swept, "the boot sweep is legible on its own ledger step");
  assert.equal(swept?.extra.reaped, 1);
  assert.equal(swept?.extra.kept, 2, "the total is unchanged — a superset of the two new counts");
  assert.equal(swept?.extra.live, 1, "a same-host confirmed-alive holder has its own count");
  assert.equal(
    swept?.extra.unverifiable_foreign_host,
    1,
    "a foreign-host holder — never verified alive — is reported distinctly from `live`",
  );
});

test("runInflightLockSweepRung: daemon.inflight_sweep (the per-poll rung) ALSO carries `live`/`unverifiable_foreign_host` — not just the boot sweep", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-daemon-inflight-sweep-"));
  try {
    const dir = join(root, "state", "inflight");
    mkdirSync(dir, { recursive: true });
    // A confirmed-live same-host holder (this test process's own pid) beside a foreign-host
    // lock naming a container-shaped host this process can never verify or clear.
    writeFileSync(
      join(dir, "W1-T184.lock"),
      JSON.stringify({ pid: process.pid, run_id: "live-r", host: hostname(), startedAt: new Date().toISOString() }),
    );
    writeFileSync(
      join(dir, "W1-T395.lock"),
      JSON.stringify({ pid: 4242, run_id: "stranded-r", host: "container-shaped-abc123", startedAt: "2026-08-11T00:00:00Z" }),
    );
    const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const result = runInflightLockSweepRung({ root } as Config, (step, extra) => lines.push({ step, extra }));

    assert.deepEqual(result.reaped, [], "neither lock's holder is dead on this host");
    assert.deepEqual(result.live.sort(), ["W1-T184"]);
    assert.deepEqual(result.unverifiableForeignHost, ["W1-T395"]);
    assert.ok(existsSync(join(dir, "W1-T395.lock")), "the foreign-host lock is never deleted");

    const swept = lines.find((l) => l.step === "daemon.inflight_sweep");
    assert.ok(swept, "the per-poll rung is legible on its own ledger step");
    assert.equal(swept?.extra?.live, 1);
    assert.equal(swept?.extra?.unverifiable_foreign_host, 1, "the SAME split as daemon.lock_sweep, on the per-poll rung");
    assert.equal(swept?.extra?.kept, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── daemonBoot: W1-T113 part (i) — resolve + log the claude binary ONCE ────

test("daemonBoot: a successful resolveClaudeBin logs daemon.claude_bin with the resolved path, exactly once", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let calls = 0;
  const resolveClaudeBin = () => {
    calls++;
    return "/home/op/.local/bin/claude";
  };
  daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    { PATH: "/usr/bin" },
    undefined,
    undefined,
    undefined,
    undefined,
    resolveClaudeBin,
  );
  assert.equal(calls, 1, "resolved exactly once at boot, not per spawn");
  const line = lines.find((l) => l.step === "daemon.claude_bin");
  assert.ok(line, "daemon.claude_bin is logged");
  assert.equal(line?.extra.blocked, false);
  assert.equal(line?.extra.path, "/home/op/.local/bin/claude");
});

test("daemonBoot: a REFUSING resolveClaudeBin logs daemon.claude_bin blocked=true and STILL COMPLETES boot (never throws onward)", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const resolveClaudeBin = (): string => {
    throw Object.assign(new Error("claude executable not found or not runnable — searched: npm-global=... (missing)"), {
      reasonClass: "blocked_toolchain",
    });
  };
  const result = daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    { PATH: "/usr/bin" },
    undefined,
    undefined,
    undefined,
    undefined,
    resolveClaudeBin,
  );
  assert.ok(result, "daemonBoot returns normally — a toolchain refusal never aborts boot itself");
  const line = lines.find((l) => l.step === "daemon.claude_bin");
  assert.ok(line, "daemon.claude_bin is logged even on refusal");
  assert.equal(line?.extra.blocked, true);
  assert.equal(line?.extra.error_class, "blocked_toolchain");
  assert.match(String(line?.extra.error), /searched:/);
});

test("daemonBoot: with no resolveClaudeBin injected, no daemon.claude_bin line is written (pre-W1-T113 behavior unchanged)", () => {
  const lines: Array<{ step: string }> = [];
  daemonBoot((step) => lines.push({ step }), { PATH: "/usr/bin" });
  assert.equal(lines.filter((l) => l.step === "daemon.claude_bin").length, 0);
});

// ── daemonCommand wiring: W1-T357 — the resolveClaudeBin slot is no longer `undefined` ─────
//
// The tests above drive `daemonBoot` in isolation with a hand-built `resolveClaudeBin`; they
// prove the PARAMETER works but not that the real command ever supplies one. This test drives
// the REAL `daemonCommand` (the only injection is the existing `runDaemon` loop stub, same seam
// as daemon-crashloop-wiring.test.ts) and reads the ledger it writes — proving daemonCommand's
// boot rung now passes `() => resolveClaudeExecutable(claudeExecutableCache)` in the slot that
// used to be `undefined, // resolveClaudeBin — default`, resolving through the SAME shared,
// per-process cache `spawnWorker` reuses (worker.ts), never a private or second resolution.

function claudeWiringFixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-claude-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, root, planPath };
}

function claudeWiringLedgerLines(root: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPathFor({ root } as never), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("W1-T357 wiring: daemonCommand wires the REAL resolveClaudeExecutable + shared cache into daemonBoot — daemon.claude_bin logs the SAME path spawnWorker would resolve", async () => {
  const { home, root, planPath } = claudeWiringFixtureHome();
  const oldHome = process.env.HOME;
  const oldOverride = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const priorResolved = claudeExecutableCache.resolved;
  process.env.HOME = home;
  // The env override is resolveClaudeExecutable's FIRST candidate — pinning it to the node
  // binary this test is already running under keeps resolution deterministic across hosts,
  // with no dependency on a real `claude` on PATH.
  process.env[CLAUDE_BIN_ENV_OVERRIDE] = process.execPath;
  claudeExecutableCache.resolved = undefined; // force a fresh resolution for THIS boot
  try {
    const loopStub = async () => ({ attempted: [], merged: [], stopReason: "stopped" as const, costUsd: 0, ticks: 0 });
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: loopStub });
    assert.equal(code, 0);
    const lines = claudeWiringLedgerLines(root);
    const line = lines.find((l) => l.step === "daemon.claude_bin");
    assert.ok(line, "daemonCommand's real daemonBoot call must resolve+log daemon.claude_bin — the undefined default this task replaces logged nothing at all");
    assert.equal(line!.blocked, false);
    assert.equal(line!.path, process.execPath, "the wired resolver honors the SAME env override resolveClaudeExecutable/spawnWorker would");
    assert.equal(
      claudeExecutableCache.resolved,
      process.execPath,
      "daemonCommand must resolve through the SHARED per-process cache spawnWorker reuses, never a second, private resolution",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldOverride === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
    else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldOverride;
    claudeExecutableCache.resolved = priorResolved;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── daemonBoot: W1-T117 part (ii) — the boot-time orphan sweep ─────────────

test("daemonBoot: calls the injected orphan sweep once and logs daemon.orphan_sweep with the killed/left-alone COUNT", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let calls = 0;
  const sweepOrphanWorkers = () => {
    calls += 1;
    return {
      killed: [{ pid: 111, run_id: "run-1", task_id: "W1-T1", cmdline: "sleep 300" }],
      leftAlone: [{ pid: 222, reason: "unattributable" as const }],
    };
  };
  daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    { PATH: "/usr/bin" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    sweepOrphanWorkers,
  );
  assert.equal(calls, 1, "swept exactly once at boot, not per poll");
  const line = lines.find((l) => l.step === "daemon.orphan_sweep");
  assert.ok(line, "daemon.orphan_sweep is logged");
  assert.equal(line?.extra.killed, 1, "the killed COUNT is logged, not the raw list");
  assert.equal(line?.extra.left_alone, 1);
});

test("daemonBoot: a THROWING orphan sweep still completes boot (never throws onward) — logged as a failure, not silently dropped", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const sweepOrphanWorkers = (): never => {
    throw new Error("ps: command not found");
  };
  const result = daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    { PATH: "/usr/bin" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    sweepOrphanWorkers,
  );
  assert.ok(result, "daemonBoot returns normally — a sweep failure never aborts boot itself (T197 doctrine)");
  const line = lines.find((l) => l.step === "daemon.orphan_sweep");
  assert.ok(line, "the failure is logged on the SAME step name, not swallowed silently");
  assert.match(String(line?.extra.error), /ps: command not found/);
});

test("daemonBoot: with no orphan sweep injected, no daemon.orphan_sweep line is written (behavior unchanged from before W1-T117)", () => {
  const lines: Array<{ step: string }> = [];
  daemonBoot((step) => lines.push({ step }), { PATH: "/usr/bin" });
  assert.equal(lines.filter((l) => l.step === "daemon.orphan_sweep").length, 0);
});

// ── daemonBoot: W1-T2332 — the checkout-depth history horizon on daemon.boot ───────────────
//
// The boot record already carried env, node path, node version and head sha (its sibling facts)
// but never the horizon those reads are computed over. These tests drive `checkoutDepth`, the
// trailing param appended after `declaredNodeVersion` (daemon.ts's own "no positional caller
// shifts" discipline), with no real git and no daemon — a pure record-shape assertion.

test("daemonBoot: a measured checkout depth is recorded on the SAME daemon.boot row, alongside its siblings", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const result = daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    { PATH: "/usr/bin" },
    undefined, // sweepTmp
    undefined, // sweepLocks
    undefined, // unlockWorkerKeychain
    undefined, // crashLoopCheck
    undefined, // resolveClaudeBin
    false, // allowApiKey
    undefined, // sweepOrphanWorkers
    undefined, // bootHeadSha
    undefined, // sweepFeedbackLanding
    undefined, // nodeRuntime — default
    undefined, // declaredNodeVersion
    { shallow: false, commitCount: 980 },
  );
  assert.ok(result, "a checkout-depth measurement never blocks boot from returning normally");
  const boots = lines.filter((l) => l.step === "daemon.boot");
  assert.equal(boots.length, 1, "NO NEW LEDGER ROW — the boot record is the boot record");
  assert.equal(boots[0]?.extra.checkout_shallow, false);
  assert.equal(boots[0]?.extra.checkout_commit_count, 980);
  assert.ok("env_clean" in boots[0]!.extra, "still carries its sibling boot facts on the same row");
});

test("daemonBoot: a SHALLOW checkout is recorded on daemon.boot AND the boot still completes — it never halts boot", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const result = daemonBoot(
    (step, extra = {}) => lines.push({ step, extra }),
    { PATH: "/usr/bin" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { shallow: true, commitCount: 208 },
  );
  assert.ok(result, "T197 doctrine: the daemon sleeps through problems — a shallow tree must not refuse to come up");
  const boot = lines.find((l) => l.step === "daemon.boot");
  assert.ok(boot);
  assert.equal(boot?.extra.checkout_shallow, true);
  assert.equal(boot?.extra.checkout_commit_count, 208);
});

test("daemonBoot: with no checkoutDepth measurement (unreadable), the fields are OMITTED rather than a guessed value — and boot still completes", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }), { PATH: "/usr/bin" });
  assert.ok(result, "an absent measurement never blocks boot");
  const boot = lines.find((l) => l.step === "daemon.boot");
  assert.ok(boot);
  assert.equal("checkout_shallow" in boot!.extra, false, "omitted, never a guessed false");
  assert.equal("checkout_commit_count" in boot!.extra, false, "omitted, never a guessed count");
});

// ── WHY THE DAEMON IS IDLE (impl-DF) ────────────────────────────────────────────────────────

test("idle reasons: an idle daemon SAYS why, and does not repeat an unchanged picture on every tick", async () => {
  // On 2026-08-01 the daemon idled ~10 hours emitting ~390 bare `daemon.idle` lines and ZERO
  // `dispatch.*`, while 31 unmerged tasks sat behind four silent filters. This asserts both
  // halves of the fix: the reasons are stated, and stating them does not add ~390 lines.
  const plan = fixturePlan(); // A,B(dep A),C(dep B),D,H(verify:human)
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let polls = 0;

  // Everything merged except H (human) and the dep chain -> nothing dispatchable, so it idles.
  const merged = new Set<string>(["A", "B", "C", "D"]);
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => okResult(id),
      // Bound the otherwise-endless idle loop: stop after the 3rd poll.
      sleep: async () => {
        if (++polls >= 3) throw new Error("STOP-IDLE-FIXTURE");
      },
      log: (step, extra) => lines.push({ step, extra: extra ?? {} }),
    },
  ).catch((e: Error) => {
    if (!/STOP-IDLE-FIXTURE/.test(e.message)) throw e;
    return undefined;
  });

  const idle = lines.filter((l) => l.step === "daemon.idle");
  const reasons = lines.filter((l) => l.step === "daemon.idle_reasons");

  assert.ok(idle.length >= 2, `expected repeated idle ticks, got ${idle.length}`);
  assert.equal(reasons.length, 1, `the picture never changed, so the reasons line must appear ONCE, not ${idle.length} times`);

  const t = reasons[0].extra as Record<string, { count: number; ids: string[] }>;
  assert.equal(t["verify-not-auto"].count, 1, "H is human-verify");
  assert.deepEqual(t["verify-not-auto"].ids, ["H"], "and the operator is told WHICH");
  assert.equal(t["already-merged"].count, 4, "A,B,C,D were filtered as already merged");
  assert.equal(s, undefined, "the fixture stopped the loop, not the daemon");
});

// ── W1-T463 acceptance 4 / W1-T513 — "if a lane ships, a real per-PR guard replaces the
//    ledger-read dedup before it is enabled" ────────────────────────────────────────────────
// W1-T463's own diagnosis (see test/retro-sweep-ticker.test.ts and src/lib/sweep.ts's
// `runSweepLightPass`) closed the ~15-minute stall WITHOUT shipping a second review lane, and
// this file's tripwire pinned that NO third `startInFlightTicker` call site existed until the
// per-PR guard below stopped being a fresh-per-call `Set` and became a real, module-level,
// cross-call mutex ({@link "../src/lib/sweep.js".inFlightReviewKeys}). W1-T513 is that guard:
// the first test below now pins the OPPOSITE invariant — a third call site (`deps.sweep()`,
// daemon.ts) DOES exist, because it is finally safe to ship one.

const daemonSrc = readFileSync(fileURLToPath(new URL("../src/lib/daemon.ts", import.meta.url)), "utf8");

test("W1-T513: a third startInFlightTicker call site now exists (retro, dispatch, sweep) — safe because the review-key mutex is shared across calls, not per-call", () => {
  const calls = [...daemonSrc.matchAll(/\bstartInFlightTicker\(/g)];
  // Four occurrences total: the function's own `function startInFlightTicker(` declaration,
  // plus exactly three CALL sites. Before W1-T513 this pinned exactly THREE (1 declaration + 2
  // calls) and forbade a third — see the design note this task's shard carries for why that
  // was safe advice only until the per-PR mutex below stopped being per-call.
  assert.equal(calls.length, 4, `expected 1 declaration + 3 call sites (retro, dispatch, sweep), found ${calls.length} occurrence(s) of startInFlightTicker(`);
  // W1-T1082: every call site now threads the SAME shared `diskHeadroomLatch` reference (never
  // a fresh latch per call — see that variable's own doc in daemon.ts) as a trailing 5th
  // argument, alongside the pre-existing 4 positional args these regexes already pinned.
  //
  // W1-T1272: "retro" and "dispatch" now ALSO thread the shared `sweepRetrigger` config as a
  // trailing 6th argument — this is the RE-TRIGGER half of design (ii): either phase can hold
  // the loop for as long as a fired retro or a long dispatch runs, so either is eligible to
  // re-fire the full sweep on its own cadence while it does. "sweep" deliberately does NOT
  // receive it: that ticker exists to keep `sweepLight` running WHILE a full sweep is already in
  // flight, and threading a retrigger there would let a full sweep re-enter itself.
  assert.match(
    daemonSrc,
    /startInFlightTicker\(deps, pollIntervalMs, log, "retro", diskHeadroomLatch, sweepRetrigger\)/,
    "the retro call site threads sweepRetrigger",
  );
  // W1-T2565: both regexes now tolerate a TRAILING argument after the ones they pin, because the
  // in-flight headroom sampler is threaded to "dispatch" and "sweep" as a 7th positional. What each
  // assertion CLAIMS is unchanged and still exact — "dispatch" threads sweepRetrigger in the 6th
  // slot, "sweep" passes `undefined` there and so still never receives one. Widening to `.*` would
  // have let a real sweepRetrigger slip into the sweep site unnoticed, which is the whole point of
  // the second assertion; `undefined` is matched literally instead.
  assert.match(
    daemonSrc,
    /startInFlightTicker\(deps, pollIntervalMs, log, "dispatch", diskHeadroomLatch, sweepRetrigger(, headroomSampler)?\)\.stop/,
    "the dispatch call site threads sweepRetrigger",
  );
  assert.match(
    daemonSrc,
    /startInFlightTicker\(deps, pollIntervalMs, log, "sweep", diskHeadroomLatch(, undefined, headroomSampler)?\)\.stop/,
    "the sweep-phase call site NEVER threads sweepRetrigger — it must not re-enter itself",
  );
  // W1-T2565: and the claim above is now ALSO pinned positively rather than only by the absence of
  // the word — the sweep site must pass `undefined` in sweepRetrigger's own slot.
  assert.doesNotMatch(
    daemonSrc,
    /startInFlightTicker\(deps, pollIntervalMs, log, "sweep", diskHeadroomLatch, sweepRetrigger/,
    "the sweep ticker must never be handed a real sweepRetrigger, whatever follows it",
  );
});

// ── W1-T1272: THE FULL SWEEP IS UNREACHABLE AFTER A BOOT'S FIRST ITERATION ─────────────────
// Before this task, `checkFreshness`'s stale-return sat 64 lines ABOVE the loop's only
// `deps.sweep!()` call, so once the fleet's own merges advanced origin/main past the boot sha,
// EVERY later iteration returned before ever reaching the sweep — the review cadence tracked
// the daemon's restart rate, not the queue. The fix has two halves (design (ii)): the ORDERING
// (a stale iteration still reaches the gate before it returns) and the RE-TRIGGER (a phase that
// holds the loop for a long dispatch/retro re-fires the sweep on its own cadence, not only once
// at the top of the iteration that started it).

test("W1-T1272: a stale freshness verdict still reaches the full sweep before it returns", async () => {
  const plan = fixturePlan();
  let sweeps = 0;
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => {
      throw new Error("FALSIFIER: dispatch must never be reached once freshness is stale");
    },
    checkFreshness: () => ({ stale: true, oldSha: "aaaaaaa1111111111111111111111111111111", newSha: "bbbbbbb2222222222222222222222222222222" }),
    sweep: async () => {
      sweeps += 1;
    },
    sleep: async () => {},
  });
  assert.equal(sweeps, 1, "the full sweep ran exactly once, reached from the stale branch, before runDaemon returned");
  assert.equal(s.stopReason, "stale", "the stale verdict still ends the boot — running the sweep did not suppress it");
});

test("W1-T1272: a stale freshness verdict still ends the boot rather than being suppressed", async () => {
  // A slow-but-healthy sweep (well inside the bound) must not turn a stale verdict into
  // anything else — no swallowed exit, no fall-through into dispatch, no "error".
  const plan = fixturePlan();
  let sweepCompleted = false;
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => {
      throw new Error("FALSIFIER: dispatch must never be reached once freshness is stale");
    },
    checkFreshness: () => ({ stale: true, oldSha: "aaaaaaa1111111111111111111111111111111", newSha: "bbbbbbb2222222222222222222222222222222" }),
    sweep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sweepCompleted = true;
    },
    sleep: async () => {},
  });
  assert.ok(sweepCompleted, "the gate really ran (a no-op stub would prove nothing about ordering)");
  assert.equal(s.stopReason, "stale", "the restart stays — design (iii): reaching the gate is additive, never a replacement for the exit");
});

test("W1-T1272: a boot that outlives one iteration runs the full sweep more than once", async () => {
  // The SIMPLEST shape the criterion names: two non-stale iterations in the SAME boot each
  // reach the gate — `checkStop` fires only once TWO sweeps have already been observed, so a
  // regression that re-introduces a once-per-boot gate (e.g. a stray early return) fails this
  // by never reaching the second one.
  const plan = fixturePlan();
  const merged = new Set<string>();
  let sweeps = 0;
  const root = mkdtempSync(join(tmpdir(), "daemon-sweep-retrigger-iterations-"));
  const s = await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    sweep: async () => {
      sweeps += 1;
    },
    checkStop: () => (sweeps >= 2 ? (requestStop(root, "two sweeps observed across two iterations"), stopDetail(root)) : undefined),
    sleep: async () => {},
  });
  assert.ok(sweeps >= 2, `expected the full sweep to run more than once across this boot (saw ${sweeps})`);
  assert.notEqual(s.stopReason, "error");
});

test("W1-T1272: a long-held dispatch re-triggers the full sweep more than once without waiting for the iteration to end", async () => {
  // THE RE-TRIGGER, specifically: ONE single `runOne` call held open (the "a task can hold the
  // daemon inside one call for a whole session" shape design (ii) names) — no second top-of-
  // iteration pass happens until this one settles, so the ONLY way a second sweep can happen
  // during it is the mid-flight retrigger inside the dispatch ticker, never the once-per-
  // iteration call site.
  const plan = fixturePlan();
  const merged = new Set<string>();
  let sweepCalls = 0;
  let nowMs = 0;
  let ticks = 0;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 10;
    if (ticks >= 20) releaseRunOne?.();
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweep: async () => {
        sweepCalls += 1;
      },
      sweepLight: async () => {},
      now: () => new Date(nowMs),
      sleep,
    },
    { max: 1, sweepRetriggerIntervalMs: 5 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"]);
  // 1 (the once-per-iteration call before dispatch began) + at least 1 retrigger while `runOne`
  // was held open — a regression that dropped the retrigger, or gated it on the top-of-iteration
  // call site instead of the ticker, leaves this at exactly 1.
  assert.ok(sweepCalls > 1, `expected more than one full sweep during this one long-held dispatch (saw ${sweepCalls})`);
});

test("W1-T1272: an over-running sweep is still abandoned when reached from the stale branch", async () => {
  const REAL_SLEEP: DaemonDeps["sleep"] = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const root = mkdtempSync(join(tmpdir(), "daemon-sweep-retrigger-bound-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sweepStarted = false;
  const s = await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw new Error("FALSIFIER: dispatch must never be reached once freshness is stale");
      },
      checkFreshness: () => ({ stale: true, oldSha: "aaaaaaa1111111111111111111111111111111", newSha: "bbbbbbb2222222222222222222222222222222" }),
      // Never resolves — the measured incident's own shape, reused here against the NEW
      // stale-branch call site rather than only the pre-existing once-per-iteration one.
      sweep: () => {
        sweepStarted = true;
        return new Promise<void>(() => {});
      },
      sleep: REAL_SLEEP,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { pollIntervalMs: 30, sweepWallClockBoundMs: 20 },
  );
  assert.ok(sweepStarted, "the sweep genuinely started from the stale branch");
  assert.equal(s.stopReason, "stale", "the bound firing does not change WHY the boot ended");
  const abandoned = lines.find((l) => l.step === "daemon.sweep.abandoned");
  assert.ok(abandoned, `expected daemon.sweep.abandoned, saw steps: ${lines.map((l) => l.step).join(", ")}`);
  assert.equal(abandoned!.extra.bound_ms, 20);
  void root;
});

test("W1-T2584: the daemon sweep bound closes the continuation gate handed to the still-settling sweep", async () => {
  const REAL_SLEEP: DaemonDeps["sleep"] = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let continuation: (() => boolean) | undefined;
  let releaseSweep: () => void = () => {};
  const sweepSettled = new Promise<void>((resolve) => { releaseSweep = resolve; });
  const summary = await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw new Error("FALSIFIER: dispatch must never be reached once freshness is stale");
      },
      checkFreshness: () => ({ stale: true, oldSha: "aaaaaaa1111111111111111111111111111111", newSha: "bbbbbbb2222222222222222222222222222222" }),
      sweep: async (continueReviewAdmissions) => {
        continuation = continueReviewAdmissions;
        await sweepSettled;
      },
      sleep: REAL_SLEEP,
    },
    { pollIntervalMs: 30, sweepWallClockBoundMs: 20 },
  );

  assert.equal(summary.stopReason, "stale");
  assert.ok(continuation, "runGatedSweep supplies the continuation gate to the real sweep dependency");
  assert.equal(continuation!(), false, "the same timer that abandons the await closes later review admissions");
  releaseSweep();
});

test("W1-T2584: the continuation gate re-checks both existing STOP and PAUSE controls before later admissions", async () => {
  let stopDetail: string | undefined;
  let pauseDetail: string | undefined;
  const observations: boolean[] = [];
  const merged = new Set<string>();
  const summary = await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (taskId) => merged.has(taskId),
      runOne: async (taskId) => {
        merged.add(taskId);
        return okResult(taskId);
      },
      checkStop: () => stopDetail,
      checkPause: () => pauseDetail,
      sweep: (continueReviewAdmissions) => {
        assert.ok(continueReviewAdmissions);
        observations.push(continueReviewAdmissions!());
        stopDetail = "STOP requested during sweep";
        observations.push(continueReviewAdmissions!());
        stopDetail = undefined;
        pauseDetail = "PAUSE requested during sweep";
        observations.push(continueReviewAdmissions!());
        pauseDetail = undefined;
      },
      sleep: async () => {},
    },
    { max: 1 },
  );

  assert.deepEqual(observations, [true, false, false]);
  assert.equal(summary.stopReason, "max_reached", "clearing the test controls leaves ordinary dispatch unchanged");
});

test("W1-T1272: the sweep still runs one at a time and no additional lane is taken", async () => {
  // Concurrency guard: across the once-per-iteration call AND every mid-flight retrigger, at
  // most ONE `deps.sweep()` may be in flight at any instant, and `runOne` is still called
  // exactly once for the one admitted task — the retrigger must never widen `laneCount`/
  // `dispatchLanes` or race a second sweep against the first (design (i)/(v)).
  const plan = fixturePlan();
  const merged = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  let sweepCalls = 0;
  let runOneCalls = 0;
  let nowMs = 0;
  let ticks = 0;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  const sleep: DaemonDeps["sleep"] = async () => {
    ticks++;
    nowMs += 10;
    if (ticks >= 20) releaseRunOne?.();
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        runOneCalls += 1;
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweep: async () => {
        sweepCalls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A microtask-only gap (never a real timer — this suite's `sleep`/`now` are a fake,
        // always-resolves-immediately clock, and racing a real `setTimeout` against a tight
        // microtask loop elsewhere can starve the timer phase indefinitely). Yielding via an
        // already-resolved promise is enough to surface a genuine overlap: a caller that ever
        // invoked a second `deps.sweep()` without awaiting the first would run its own
        // increment while this one is still suspended here.
        await Promise.resolve();
        inFlight -= 1;
      },
      sweepLight: async () => {},
      now: () => new Date(nowMs),
      sleep,
    },
    { max: 1, sweepRetriggerIntervalMs: 5 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.ok(sweepCalls > 1, `expected the retrigger to have fired at least once (saw ${sweepCalls} sweep calls)`);
  assert.equal(maxInFlight, 1, "no two `deps.sweep()` calls ever overlapped");
  assert.equal(runOneCalls, 1, "exactly one dispatch lane ran — the retrigger never widened laneCount/dispatchLanes");
});

test("W1-T463: DaemonOpts still carries exactly ONE lane-sizing knob (laneCount, dispatch-only) — no second, per-kind budget was introduced", () => {
  const start = daemonSrc.indexOf("export interface DaemonOpts {");
  assert.ok(start >= 0, "DaemonOpts must still exist verbatim");
  const end = daemonSrc.indexOf("\n}", start);
  const body = daemonSrc.slice(start, end);
  // Every declared field, in order — matches `name?: type;` (JSDoc lines are skipped, they
  // carry no trailing semicolon at column 2). A second lane-shaped field (e.g.
  // `reviewLaneCount`/`reviewBudget`) would show up here as an extra match.
  const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  const laneFields = fields.filter((f) => /lane|budget/i.test(f));
  assert.deepEqual(laneFields, ["laneCount"], `DaemonOpts's only lane/budget-shaped field must still be laneCount; found ${JSON.stringify(laneFields)}`);
});

test("W1-T513: the review-key mutex is now cross-call — two concurrent runSweep passes over the SAME PR never both post (closes the exact race design (iv) named)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-daemon-t513-mutex-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const pr = {
    prNumber: 584,
    prUrl: "url/584",
    taskId: "W1-T584",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-07-16T12:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
  } as never;
  let posted = 0;
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const deps = {
    ledgerPath,
    runId: "SWEEP-RACE",
    now: () => Date.parse("2026-07-17T12:00:00Z"),
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: async () => {
      // Held open until BOTH `runSweep` calls below have been invoked — the first call's own
      // claim on the review key is already made (synchronously, before `postReview` is ever
      // scheduled) by the time this fires, so the second call's claim attempt genuinely
      // observes it still held, exactly the overlap design (iv) originally named as unguarded.
      await gate;
      posted++;
    },
  } as never;
  const runs = Promise.all([runSweep([pr], deps, DEFAULT_SWEEP_POLICY), runSweep([pr], deps, DEFAULT_SWEEP_POLICY)]);
  releaseGate?.();
  await runs;
  assert.equal(
    posted,
    1,
    "only ONE of the two concurrent passes over the same PR posted — the module-level review-key " +
      "mutex (src/lib/sweep.ts's inFlightReviewKeys, W1-T513) now arbitrates between simultaneous " +
      "callers, closing the race this test used to demonstrate was open",
  );
});
