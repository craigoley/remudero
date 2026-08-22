import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_SWEEP_POLICY,
  checkCostGovernor,
  deriveDayCostUsd,
  logCostGovernorDeferral,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import { readLedgerLines, type GitHub } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDrain, type DrainDeps, type DrainSummary, type MergedSet } from "../src/lib/drain.js";
import { runDaemon, checkDispatchGovernors, type DaemonDeps, type DaemonSummary } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";
import { drainCommand, daemonCommand, dailyCostCeilingReloader, resolveRepoRoot } from "../src/run-task.js";
import {
  loadDefaultPolicy,
  writeDailyCostCeilingOverride,
  clearDailyCostCeilingOverride,
  dailyCostCeilingOverridePath,
  type Policy,
} from "../src/lib/policy.js";

// ── W1-T148 COST GOVERNOR — a daily spend ceiling as policy data; new
// DISPATCH waits (ledgered dispatch_deferred_budget) when the day's ledgered
// cost exceeds it; drainage (sweep/heal/merge) never throttles. ─────────────
//
// FIXTURE: the $206/60-run W1-T1 incident — a spin loop burned ~$206 over ~60
// runs with no daily ceiling anywhere, each run safely under its OWN per-run
// budget_usd cap, so that per-run backstop never fired. These tests hold the
// SAME shape the queue-governor's did: a synthetic dispatch decision is gated
// by the governor while a REAL runSweep pass, in the SAME test, proves
// sweep/heal/arm/merge are untouched.

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-cost-governor-")), "ledger.ndjson");
}

const TODAY = Date.parse("2026-07-29T18:00:00Z");
const RECENT = "2026-07-19T12:00:00Z";

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

// The SAME four-disposition golden seeded set sweep.test.ts's / the queue
// governor's acceptance 1 uses — one PR per disposition, so a single
// `runSweep` pass exercises mergeable/blocked-fixable/stale/blocked-ambiguous
// all at once.
function mergeablePr(): OpenPrView {
  return pr({ prNumber: 10, prUrl: "url/10", taskId: "W1-A", reviewState: "success", checksState: "green" });
}
function blockedFixablePr(): OpenPrView {
  return pr({
    prNumber: 11,
    prUrl: "url/11",
    taskId: "W1-B",
    reviewState: "failure",
    checksState: "green",
    priorStrikes: 0,
    unmetCriteria: [{ claim: "still needs work", proof: "unit test: x", met: false, reason: "not done", proof_exec: "executed_fail" }],
    reviewSummary: "one criterion unmet",
  });
}
function supersededPr(): OpenPrView {
  return pr({ prNumber: 12, prUrl: "url/12", taskId: "W1-C", supersededBy: 99 });
}
function blockedAmbiguousPr(): OpenPrView {
  return pr({ prNumber: 13, prUrl: "url/13", taskId: "W1-D", reviewState: "pending", checksState: "pending" });
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  armed: OpenPrView[];
  closed: Array<{ pr: OpenPrView; reason: string }>;
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string }>;
} {
  const armed: OpenPrView[] = [];
  const closed: Array<{ pr: OpenPrView; reason: string }> = [];
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string }> = [];
  return {
    armed,
    closed,
    fixed,
    escalated,
    arm: (p) => { armed.push(p); },
    close: (p, reason) => { closed.push({ pr: p, reason }); },
    dispatchFix: (p, evidence) => { fixed.push({ pr: p, evidence }); },
    escalate: (p, reason) => { escalated.push({ pr: p, reason }); },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1",
    now: () => TODAY,
    ...overrides,
  };
}

/**
 * Seeds a real ledger file with `count` runs each costing `eachUsd`, verdict-lined "today".
 *
 * Stamps an explicit `ts` inside the fixed `TODAY` window rather than letting
 * `appendLedger`'s default (the REAL wall clock) decide: `deriveDayCostUsd` windows
 * strictly on a line's own `ts` against the `now` it's given (`TODAY` here, a frozen
 * constant), and `TODAY`'s UTC calendar day is not always the REAL wall clock's UTC
 * calendar day (e.g. any run between ~20:00 and 23:59 US Eastern lands past the UTC
 * midnight boundary) -- an unstamped line silently falls outside the window and both
 * `dayCostUsd` assertions below read 0/short, a real, observed, clock-boundary flake
 * this fixture must never reintroduce.
 */
function seedRuns(path: string, count: number, eachUsd: number): void {
  const ts = new Date(TODAY).toISOString();
  for (let i = 0; i < count; i++) {
    const runId = `RUN-${i}`;
    appendLedger(path, { run_id: runId, task_id: "W1-T1", step: "run.start", ts });
    appendLedger(path, {
      run_id: runId,
      task_id: "W1-T1",
      step: "verdict",
      verdict: "failed",
      cost_usd: eachUsd,
      ts,
    });
  }
}

// ── regression: seedRuns dates at TODAY, not the wall clock (the 2026-07-30 rollover) ──

test("seedRuns dates its ledger lines at TODAY so deriveDayCostUsd counts them regardless of the real wall clock (midnight-rollover regression)", () => {
  const path = ledgerPath();
  seedRuns(path, 10, 1.5); // $15 across 10 runs, stamped at TODAY
  const dayCostUsd = deriveDayCostUsd(readLedgerLines(path), TODAY);
  assert.ok(
    Math.abs(dayCostUsd - 15) < 0.01,
    `seeded lines must land in TODAY's window independent of the wall clock; expected ~$15, got ${dayCostUsd}`,
  );
});

// ── acceptance 1: at/over the ceiling defers, seeded with the $206/60-run shape ──

test("acceptance 1 — over the ceiling (the $206/60-run W1-T1 shape): checkCostGovernor defers, a dispatch_deferred_budget ledger line carries day-cost + ceiling, and sweep/heal/arm/merge in the SAME pass are unaffected", async () => {
  const path = ledgerPath();
  seedRuns(path, 60, 206 / 60); // ~$206 across 60 runs, today

  const lines = readLedgerLines(path);
  const dayCostUsd = deriveDayCostUsd(lines, TODAY);
  assert.ok(Math.abs(dayCostUsd - 206) < 0.01, `expected ~$206 day-cost, got ${dayCostUsd}`);

  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 150 };
  const result = checkCostGovernor(dayCostUsd, policy);
  assert.equal(result.deferred, true, "over the $150 ceiling, dispatch is deferred");
  assert.ok(Math.abs(result.observedDayCostUsd - 206) < 0.01);
  assert.equal(result.ceilingUsd, 150);

  logCostGovernorDeferral(result, appendLedger, path, "DAEMON-1");
  const afterLog = readLedgerLines(path);
  const deferLine = afterLog.find((l) => l.step === "dispatch_deferred_budget");
  assert.ok(deferLine, "a dispatch_deferred_budget ledger line was written");
  assert.ok(Math.abs((deferLine!.observed_day_cost_usd as number) - 206) < 0.01, "the throttled ledger line carries the observed day-cost");
  assert.equal(deferLine!.daily_cost_ceiling_usd, 150);

  // SAME PASS: a real runSweep over the four-disposition golden set — the
  // governor above must not have touched it. sweep/heal/arm/merge fire at
  // full depth, exactly as if the governor did not exist — no worker spawn
  // for a NEW task, but drainage of already-open PRs is untouched.
  const deps = fakeDeps();
  const summary = await runSweep(
    [mergeablePr(), blockedFixablePr(), supersededPr(), blockedAmbiguousPr()],
    deps,
  );
  assert.deepEqual(summary.byDisposition, {
    mergeable: 1,
    "blocked-fixable": 1,
    stale: 1,
    "blocked-ambiguous": 1,
    "dep-review": 0,
    "post-review": 0,
    conflicted: 0,
    wait: 0,
  });
  assert.equal(summary.actionsTaken, 4, "all four dispositions acted — drainage is ungated at any day-cost");
  assert.equal(deps.armed.length, 1, "merge-eligible PR still armed");
  assert.equal(deps.fixed.length, 1, "fixable PR still dispatched a fix worker");
  assert.equal(deps.closed.length, 1, "stale PR still closed");
  assert.equal(deps.escalated.length, 1, "ambiguous PR still escalated");
});

test("acceptance 1b — exactly AT the ceiling also defers (the boundary is inclusive on the deferred side)", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 100 };
  const result = checkCostGovernor(100, policy);
  assert.equal(result.deferred, true);
  assert.equal(result.observedDayCostUsd, 100);
});

// ── acceptance 2: below the ceiling — dispatch proceeds ────────────────────

test("acceptance 2 — below the ceiling: dispatch proceeds normally (the falsifier proving the governor is not simply off or always-on)", () => {
  const path = ledgerPath();
  seedRuns(path, 3, 5); // $15 today, well under a $150 ceiling

  const dayCostUsd = deriveDayCostUsd(readLedgerLines(path), TODAY);
  assert.ok(Math.abs(dayCostUsd - 15) < 0.01);

  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 150 };
  const result = checkCostGovernor(dayCostUsd, policy);
  assert.equal(result.deferred, false, "well below the ceiling, dispatch is NOT deferred");
  assert.equal(result.ceilingUsd, 150);
});

test("acceptance 2b — one dollar below the ceiling (boundary) also proceeds", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 100 };
  const result = checkCostGovernor(99, policy);
  assert.equal(result.deferred, false);
});

// ── acceptance 3: the ceiling is policy DATA, not a hardcoded constant ─────

test("acceptance 3 — changing the ceiling is a policy-data row edit with zero code change: the SAME day-cost flips disposition purely from a policy override", () => {
  const dayCostUsd = 120;

  const loose: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 200 };
  assert.equal(checkCostGovernor(dayCostUsd, loose).deferred, false, "$120 spent, $200 ceiling -> not deferred");

  const tight: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 120 };
  assert.equal(checkCostGovernor(dayCostUsd, tight).deferred, true, "the SAME $120 spent, ceiling tightened to $120 -> deferred");

  const tighter: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: 50 };
  assert.equal(checkCostGovernor(dayCostUsd, tighter).deferred, true, "ceiling tightened further -> still deferred");
});

test("acceptance 3b — DEFAULT_SWEEP_POLICY carries dailyCostCeilingUsd as a table row (policy-as-data, not an inlined constant), and an absent policy value falls back to a SAFE bounded default (never unbounded)", () => {
  assert.equal(typeof DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd, "number");
  assert.ok(DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd > 0);
  // RAISED 2026-08-04, $150 -> $500. This bound used to read `< 206`, calibrated against the
  // $206/60-run W1-T1 incident. That calibration was superseded by a real measurement: the
  // governor fired in production for the first time at $152.28 observed against the $150
  // ceiling and deferred EVERY dispatch, on a day whose spend was ~10x the prior day's.
  // What must still hold is the rule-2 property — BOUNDED, never unbounded — so the assertion
  // keeps an upper bound rather than dropping one. It is deliberately not `=== 500`: pinning
  // the exact figure here would make every future retune a two-file edit for no added safety,
  // and the defers-at/does-not-defer-below lock below is what actually guards the value.
  assert.ok(
    DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd < 1000,
    "the fail-safe default must stay a bounded ceiling, never an effectively unbounded one",
  );
});

// ── the shipped default's own behaviour, at and around the ceiling ────────────
//
// THE GAP THIS CLOSES. Every other test in this file either builds its own policy
// (`{ ...DEFAULT_SWEEP_POLICY, dailyCostCeilingUsd: <literal> }`) or fakes the governor's
// result outright, so NONE of them observes the shipped default's value. Raising the ceiling
// from $150 to $500 changed live daemon behaviour and the suite was entirely blind to it.
// This test reads the default and exercises the real `checkCostGovernor` on both sides of it.

test("the SHIPPED default ceiling defers at and above itself and does NOT defer below it — the real predicate, the real DEFAULT_SWEEP_POLICY, no locally-built policy", () => {
  const ceiling = DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd;

  // BELOW: one cent under, and a comfortably-under day, both dispatch-eligible.
  assert.equal(checkCostGovernor(ceiling - 0.01).deferred, false, "a cent under the ceiling still dispatches");
  assert.equal(checkCostGovernor(ceiling / 2).deferred, false, "half the ceiling still dispatches");

  // AT: the predicate is `>=`, so the boundary itself defers. This is the case the
  // production incident hit — $152.28 observed against a $150 ceiling.
  assert.equal(checkCostGovernor(ceiling).deferred, true, "AT the ceiling defers — the predicate is >=, not >");

  // ABOVE: and the reported figures are the observed spend and the consulted ceiling,
  // not a rounded or defaulted pair.
  const over = checkCostGovernor(ceiling + 2.28);
  assert.equal(over.deferred, true, "above the ceiling defers");
  assert.equal(over.observedDayCostUsd, ceiling + 2.28);
  assert.equal(over.ceilingUsd, ceiling);

  // THE REGRESSION THIS LOCKS: $152.28 was a deferral before this change and must not be
  // one after it. A revert of the constant makes exactly this line fail.
  assert.equal(
    checkCostGovernor(152.28).deferred,
    false,
    "the production observation that triggered this raise ($152.28) must no longer defer",
  );
});

// ── day-cost derivation: per-run, not per-line (no double counting) ────────

test("deriveDayCostUsd sums exactly ONE figure per run (the verdict line), not every cost_usd-bearing line for that run — avoids double counting a run's own running total against its incremental contributors", () => {
  const lines = [
    { ts: "2026-07-29T10:00:00.000Z", run_id: "R1", task_id: "W1-T1", step: "run.start" },
    { ts: "2026-07-29T10:01:00.000Z", run_id: "R1", task_id: "W1-T1", step: "implement.done", cost_usd: 2 },
    { ts: "2026-07-29T10:02:00.000Z", run_id: "R1", task_id: "W1-T1", step: "fix.done", cost_usd: 1 },
    // The verdict line's cost_usd is R1's RUNNING TOTAL ($3), already covering the two lines above.
    { ts: "2026-07-29T10:03:00.000Z", run_id: "R1", task_id: "W1-T1", step: "verdict", cost_usd: 3 },
    // A second run, same day, no verdict yet (still in flight) — falls back to its first cost_usd line.
    { ts: "2026-07-29T11:00:00.000Z", run_id: "R2", task_id: "W1-T2", step: "run.start" },
    { ts: "2026-07-29T11:01:00.000Z", run_id: "R2", task_id: "W1-T2", step: "implement.done", cost_usd: 4 },
  ];
  const total = deriveDayCostUsd(lines, TODAY);
  assert.equal(total, 7, "R1 contributes $3 (its verdict total, not $3+2+1=$6) and R2 contributes $4 -> $7");
});

test("deriveDayCostUsd excludes lines outside today's UTC calendar day", () => {
  const lines = [
    { ts: "2026-07-28T23:59:00.000Z", run_id: "YDAY", task_id: "W1-TY", step: "verdict", cost_usd: 999 },
    { ts: "2026-07-29T00:00:01.000Z", run_id: "TODAY1", task_id: "W1-TX", step: "verdict", cost_usd: 5 },
  ];
  const total = deriveDayCostUsd(lines, TODAY);
  assert.equal(total, 5, "yesterday's $999 run must not bleed into today's total");
});

test("zero ledgered cost today never defers — a quiet/fresh day is always dispatch-eligible", () => {
  const result = checkCostGovernor(0, DEFAULT_SWEEP_POLICY);
  assert.equal(result.deferred, false);
});

test("checkCostGovernor's policy parameter defaults to DEFAULT_SWEEP_POLICY when the caller omits it entirely", () => {
  // Every OTHER test in this file passes an explicit policy argument; this is
  // the one call site that omits it, exercising the parameter's default-value
  // branch rather than a caller-supplied override.
  const result = checkCostGovernor(DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd - 1);
  assert.equal(result.deferred, false, "one dollar under the default ceiling, using the default policy, does not defer");
  assert.equal(result.ceilingUsd, DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd);
});

test("deriveDayCostUsd ignores a line with no ts field (or a non-string ts) — it can't be dated into today's window", () => {
  const lines = [
    { run_id: "NOTS", task_id: "W1-TZ", step: "verdict", cost_usd: 42 }, // no ts at all
    { ts: 12345, run_id: "BADTS", task_id: "W1-TZ2", step: "verdict", cost_usd: 43 }, // non-string ts
    { ts: "2026-07-29T09:00:00.000Z", run_id: "GOOD", task_id: "W1-TG", step: "verdict", cost_usd: 6 },
  ];
  const total = deriveDayCostUsd(lines, TODAY);
  assert.equal(total, 6, "the two undatable lines contribute nothing; only the well-formed line counts");
});

test("deriveDayCostUsd ignores an in-window line with no run_id (or a non-string run_id) — it can't be bucketed by run", () => {
  const lines = [
    { ts: "2026-07-29T09:00:00.000Z", task_id: "W1-TZ", step: "verdict", cost_usd: 42 }, // no run_id
    { ts: "2026-07-29T09:01:00.000Z", run_id: 7, task_id: "W1-TZ2", step: "verdict", cost_usd: 43 }, // non-string run_id
    { ts: "2026-07-29T09:02:00.000Z", run_id: "GOOD2", task_id: "W1-TG", step: "verdict", cost_usd: 9 },
  ];
  const total = deriveDayCostUsd(lines, TODAY);
  assert.equal(total, 9, "the two unbucketable lines contribute nothing; only the well-formed line counts");
});

test("deriveDayCostUsd contributes 0 for a run whose in-window lines carry no cost_usd at all (no verdict, no cost figure)", () => {
  const lines = [
    { ts: "2026-07-29T09:00:00.000Z", run_id: "NOCOST", task_id: "W1-TN", step: "run.start" },
    { ts: "2026-07-29T09:01:00.000Z", run_id: "NOCOST", task_id: "W1-TN", step: "implement.start" },
    { ts: "2026-07-29T09:02:00.000Z", run_id: "GOOD3", task_id: "W1-TG", step: "verdict", cost_usd: 11 },
  ];
  const total = deriveDayCostUsd(lines, TODAY);
  assert.equal(total, 11, "a run with zero cost_usd-bearing lines contributes $0, not NaN or a thrown error");
});

// ── W1-T317: THE PREDICATE ABOVE IS REAL AND TESTED (W1-T148's own scope) — but nothing in the
// repo ever CALLED it: `checkCostGovernor in src/` grepped to only its own definition, and
// neither drainCommand's nor daemonCommand's dep object carried it, so the daily ceiling never
// gated a single dispatch in production despite shipping tested. THE TESTS ABOVE PIN
// checkCostGovernor/deriveDayCostUsd's OWN BEHAVIOR, which was never the gap — a hand-built
// SweepPolicy/day-cost figure (exactly what every test above uses) proves nothing about whether
// any REAL caller ever asks. THESE TESTS DRIVE THE REAL drainCommand/daemonCommand AND the REAL
// runDrain/runDaemon loops, mirroring test/dispatch-lifetime-breaker.test.ts's identical
// "these tests drive the REAL command wiring, never a hand-built fixture" discipline for W1-T316
// — the same class of gap (tested-but-inert) this task's own rationale names as its closest
// sibling. ──────────────────────────────────────────────────────────────────────────────────

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function costGovernorFixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-cost-governor-drain-")) } as Config;
}

function emptyPlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-cost-governor-plan-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return planPath;
}

/** One `verdict` ledger line costing `totalUsd`, stamped at the REAL wall-clock "now" (via
 *  `appendLedger`'s own default timestamp) — `costGovernorGateFor` (run-task.ts) re-derives the
 *  day's spend off `Date.now()`, not an injectable clock, so a fixture proving the REAL wiring
 *  must land its line in the SAME real "today" the wiring will read, exactly like the real
 *  ledger a live run.start/verdict pair would write. */
function seedTodaySpendUsd(ledgerPath: string, totalUsd: number): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendLedger(ledgerPath, { run_id: "SEED", task_id: "W1-SEED", step: "verdict", verdict: "failed", cost_usd: totalUsd });
}

/** Drives the REAL drainCommand, capturing the DrainDeps it hands to runDrain via the
 *  W1-T316 `deps.runDrain` seam (unchanged by this task, reused here for the SAME purpose). */
async function captureDrainDeps(config: Config, planPath: string): Promise<DrainDeps> {
  let captured: DrainDeps | undefined;
  const code = await drainCommand([], {
    config,
    planPath,
    skipGitSync: true,
    githubFactory: () => OFFLINE_GITHUB,
    notifyChannel: { send: () => true } as never,
    runDrain: async (_plan, deps): Promise<DrainSummary> => {
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
    },
  });
  assert.equal(code, 0, "the injected runDrain returns a clean 'stopped' summary -> exit 0");
  assert.ok(captured, "runDrain was reached and its DrainDeps captured");
  return captured;
}

function daemonFixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-cost-governor-daemon-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  // `home` starts with RMD_TMP_PREFIX ("rmd-"), the exact prefix daemonCommand's OWN real
  // boot-time `sweepStaleTempDirs` (lib/tmp.ts) reaps anything under os.tmpdir() matching, by
  // AGE (`now() - mtimeMs > maxAgeMs`, default 24h). Every mkdirSync/writeFileSync above this
  // line updates `home`'s own mtime to the REAL OS clock (mtimes are not shiftable, same
  // mechanism CLOCK_ARTIFACTS' prune-liveness/serve.glance entries cite) — under clock-sweep's
  // future shift that real mtime reads as ancient, so the daemon's own real housekeeping sweep
  // deleted this fixture's `state/ledger.ndjson` out from under the seeded ledger row BEFORE
  // `checkCostGovernor` ever read it (measured: the seeded row and every `daemon.*` boot line
  // vanished, replaced by only the rungs that ran after the sweep). Stamping `home`'s mtime
  // from the (possibly shifted) injected clock — LAST, after every write under it, so a later
  // mkdirSync/writeFileSync cannot silently reset it back to the real OS time — keeps this
  // fixture's own age reading consistent with `Date.now()` regardless of shift, the same
  // "stamp from the injected clock" remedy #2250 established for ledger `ts` fields.
  const now = new Date();
  utimesSync(home, now, now);
  return { home, root, planPath };
}

/** Drives the REAL daemonCommand, capturing the DaemonDeps it hands to runDaemon via its
 *  pre-existing (W1-T160) `deps.runDaemon` coverage seam. */
async function captureDaemonDeps(planPath: string): Promise<DaemonDeps> {
  let captured: DaemonDeps | undefined;
  const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
    runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
  assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
  return captured;
}

// ── acceptance 1 / 4 — the wiring itself: the real command hands runDrain/runDaemon a real
// checkCostGovernor, not the un-wired "field absent" shape ─────────────────────────────────

test("W1-T317 REACHABILITY: drainCommand wires checkCostGovernor into the DrainDeps it hands runDrain", async () => {
  const config = costGovernorFixtureConfig();
  try {
    const deps = await captureDrainDeps(config, emptyPlanPath());
    assert.equal(typeof deps.checkCostGovernor, "function", "drainCommand must wire the cost-governor gate");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T317 REACHABILITY: daemonCommand wires checkCostGovernor into the DaemonDeps it hands runDaemon", async () => {
  const { home, planPath } = daemonFixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const deps = await captureDaemonDeps(planPath);
    assert.equal(typeof deps.checkCostGovernor, "function", "daemonCommand must wire the cost-governor gate");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── the WIRED predicate reads a REAL ledger (not a hand-built fixture), and the wired call
// site itself ledgers the deferral — never just the predicate under test elsewhere ─────────

test("W1-T317: drainCommand's WIRED checkCostGovernor reads a REAL ledger — deferred over the daily ceiling, and the deferral is ledgered by the call site itself", async () => {
  const config = costGovernorFixtureConfig();
  try {
    const ledgerPath = join(config.root, "state", "ledger.ndjson");
    seedTodaySpendUsd(ledgerPath, DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd + 1);
    const deps = await captureDrainDeps(config, emptyPlanPath());
    const result = deps.checkCostGovernor!();
    assert.ok(result, "over the ceiling, the REAL wiring — not a hand-built fixture — must report deferred");
    assert.equal(result!.deferred, true);
    assert.equal(result!.ceilingUsd, DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd);

    const afterLog = readLedgerLines(ledgerPath);
    const deferLine = afterLog.find((l) => l.step === "dispatch_deferred_budget");
    assert.ok(deferLine, "the call site itself must write the dispatch_deferred_budget line, not merely return a verdict");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T317: drainCommand's WIRED checkCostGovernor reads a REAL ledger — well under the ceiling it reports undefined (proceed)", async () => {
  const config = costGovernorFixtureConfig();
  try {
    const ledgerPath = join(config.root, "state", "ledger.ndjson");
    seedTodaySpendUsd(ledgerPath, 1);
    const deps = await captureDrainDeps(config, emptyPlanPath());
    assert.equal(deps.checkCostGovernor!(), undefined, "well under the ceiling, the real wiring must NOT defer");
    const afterLog = readLedgerLines(ledgerPath);
    assert.equal(
      afterLog.some((l) => l.step === "dispatch_deferred_budget"),
      false,
      "no deferral line when the real wiring did not defer",
    );
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T317: daemonCommand's WIRED checkCostGovernor reads a REAL ledger, deferred over / clear under the daily ceiling", async () => {
  const { home, root, planPath } = daemonFixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    seedTodaySpendUsd(ledgerPath, DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd + 1);
    const deps = await captureDaemonDeps(planPath);
    const result = deps.checkCostGovernor!();
    assert.ok(result, "the daemon's real wiring must read the actual ledger, not a stub that always says clear");
    assert.equal(result!.deferred, true);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── W1-T331 acceptance 1 (the reloader itself): dailyCostCeilingReloader resolves the ceiling
// from the CURRENT injected policy on every call, never a value captured once at construction.

test("W1-T331: dailyCostCeilingReloader resolves its ceiling from the CURRENT injected policy on every call — a policy swapped between two calls changes what the SAME reloader returns", () => {
  const base = loadDefaultPolicy();
  const tight: Policy = { ...base, values: { ...base.values, sweep: { ...base.values.sweep, dailyCostCeilingUsd: 7 } } };
  const loose: Policy = { ...base, values: { ...base.values, sweep: { ...base.values.sweep, dailyCostCeilingUsd: 999 } } };
  const deps: { policy?: Policy } = { policy: tight };
  const reload = dailyCostCeilingReloader(deps);
  assert.equal(reload(), 7, "the reloader resolves the ceiling from the policy it is given, not a source literal");
  deps.policy = loose;
  assert.equal(
    reload(),
    999,
    "the SAME reloader, called again after the injected policy changed, returns the NEW value — never the first call's figure, which is exactly what a value captured once at construction (or at import) would do",
  );
});

test("W1-T331: dailyCostCeilingReloader with no injected policy reads the REAL checked-in plan/policy.yaml (repoRoot-scoped), the same value DEFAULT_SWEEP_POLICY carries", () => {
  const reload = dailyCostCeilingReloader();
  assert.equal(reload(), DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd);
});

// ── W1-T363: the daily-ceiling override store (W1-T332) is a CONSUMER of dailyCostCeilingReloader,
// not just of the console's provenance render (W1-T333) — a `state/DAILY_COST_CEILING_OVERRIDE`
// written for the repo the daemon actually reads from must move the SAME reloader's return value,
// on the very next call, with no restart. Before this task the reloader read
// `policy.values.sweep.dailyCostCeilingUsd` directly and this override was inert to it.
test("W1-T363: dailyCostCeilingReloader picks up a written state/DAILY_COST_CEILING_OVERRIDE on its very next call — the override store is no longer inert to the governor", () => {
  const policy = loadDefaultPolicy();
  const root = resolveRepoRoot(process.argv.slice(2), process.cwd()); // SAME construction run-task.ts's module-level `repoRoot` uses
  const overridePath = dailyCostCeilingOverridePath(root);
  const hadPriorOverride = existsSync(overridePath);
  const priorOverrideContents = hadPriorOverride ? readFileSync(overridePath, "utf8") : undefined;
  try {
    const reload = dailyCostCeilingReloader();
    const committedDefault = reload();
    assert.notEqual(committedDefault, 137, "fixture value must differ from whatever the committed default happens to be");

    writeDailyCostCeilingOverride(root, 137, policy);
    assert.equal(
      reload(),
      137,
      "the SAME reloader, called again after an override was written, returns the OVERRIDDEN value — proving " +
        "the governor's per-tick read now goes through resolveDailyCostCeiling instead of the raw committed row",
    );

    clearDailyCostCeilingOverride(root);
    assert.equal(
      reload(),
      committedDefault,
      "clearing the override reverts the reloader's next call to the committed default, matching resolveDailyCostCeiling's precedence rule",
    );
  } finally {
    if (hadPriorOverride) writeFileSync(overridePath, priorOverrideContents!);
    else clearDailyCostCeilingOverride(root);
  }
});

// ── W1-T331 acceptance 1: the ceiling is resolved from the loaded policy PER CONSULTATION,
// never a value fixed once at construction (module-import time) — the closest sibling gap
// W1-T330 alone left open (see plan/tasks.d/W1-T331…: "a row is necessary and not sufficient").
// Drives the REAL wired checkCostGovernor (daemonCommand's captured DaemonDeps), never a
// hand-built fixture — the SAME "these tests drive the real command wiring" discipline the
// W1-T317 REACHABILITY tests above already established. ───────────────────────────────────

test("W1-T331: daemonCommand's WIRED checkCostGovernor resolves its ceiling from the CALLER's per-consultation argument — the SAME closure, the SAME ledgered spend, defers under one ceiling and clears under another", async () => {
  const { home, root, planPath } = daemonFixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    seedTodaySpendUsd(ledgerPath, 120);
    const deps = await captureDaemonDeps(planPath);
    const strict = deps.checkCostGovernor!(100);
    assert.ok(strict, "a $100 ceiling argument, against the SAME $120 ledgered day, must defer");
    assert.equal(strict!.ceilingUsd, 100, "the reported ceiling is the ARGUMENT supplied, not DEFAULT_SWEEP_POLICY's frozen figure");
    const loose = deps.checkCostGovernor!(500);
    assert.equal(
      loose,
      undefined,
      "the IDENTICAL closure, re-consulted with a $500 ceiling instead, clears the SAME $120 day — proving the decision is NOT fixed at construction",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T331: daemonCommand's WIRED checkCostGovernor falls back to DEFAULT_SWEEP_POLICY (never unbounded) when called with no live ceiling at all", async () => {
  const { home, root, planPath } = daemonFixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    seedTodaySpendUsd(ledgerPath, DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd + 1);
    const deps = await captureDaemonDeps(planPath);
    const result = deps.checkCostGovernor!(); // no argument — the pre-reload / no-reloader shape
    assert.ok(result, "an omitted ceiling argument must still fall back to a BOUNDED default, never proceed unbounded");
    assert.equal(result!.ceilingUsd, DEFAULT_SWEEP_POLICY.dailyCostCeilingUsd);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── W1-T331 acceptance 3: an unreadable policy read must never SILENTLY WIDEN the ceiling —
// it holds the last known-good value rather than falling back to an unbounded/permissive one.
// Drives the REAL runDaemon loop (never a hand-built single-call fixture) so the falsifier is
// about the ACTUAL per-tick threading, not just DaemonDeps.reloadDailyCostCeilingUsd in isolation.

test("W1-T331: reloadDailyCostCeilingUsd failing on tick 2+ holds tick 1's ceiling — the governor NEVER sees undefined (which would silently widen back to the frozen default)", async () => {
  const plan = onePlan();
  const received: Array<number | undefined> = [];
  let reloadCalls = 0;
  // W1-T1065: the bound counts GOVERNOR CONSULTATIONS — the quantity both assertions below are
  // written against — not `checkStop` CALLS. The daemon now reads checkStop TWICE per tick, at
  // the top and again immediately before admission, so a call-counting bound both halves the
  // ticks it names (this test saw 2 reloads where it requires 3) and can stop MID-tick, between
  // the tick-wide consultation and the per-dispatch one, leaving an odd count the parity
  // assertion then rejects. Bounding on the consultations themselves is immune to both.
  await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      checkStop: () => (received.length >= 6 ? "tick cap" : undefined),
      reloadDailyCostCeilingUsd: () => {
        reloadCalls++;
        if (reloadCalls === 1) return 42;
        throw new Error("plan/policy.yaml is unreadable this tick");
      },
      checkCostGovernor: (ceilingUsd) => {
        received.push(ceilingUsd);
        return undefined; // never defer — this test is only about WHAT ceiling was threaded in
      },
      runOne: async (id) => ({ taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" }),
      sleep: async () => {},
    },
  );
  assert.ok(reloadCalls >= 3, `the reload must be retried every tick despite failing — got ${reloadCalls} calls`);
  // W1-T342: A is never merged (`NONE_MERGED`), so every tick dispatches — and a dispatching
  // tick now makes TWO governor consultations (tick-wide + the fresh per-dispatch one
  // immediately before `runOne`, see daemon.ts's `checkDispatchGovernors`), never one. Every
  // element must still be 42 regardless of count — that is the property this test protects.
  assert.ok(
    received.length >= 6 && received.length % 2 === 0,
    `expected 3 dispatching ticks x 2 consultations each — got ${JSON.stringify(received)}`,
  );
  assert.ok(
    received.every((v) => v === 42),
    `every tick's governor consultation must see the LAST KNOWN-GOOD ceiling, never undefined, despite ticks 2+ failing to reload — got ${JSON.stringify(received)}`,
  );
});

// ── acceptance 2 — the dispatch path itself: runDrain/runDaemon actually CONSULT
// checkCostGovernor to hold back NEW dispatch, exercised against a REAL runnable task so a
// regression that stops consulting it would let that task dispatch instead ────────────────

const NONE_MERGED: MergedSet = () => false;

function onePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "rmd-cost-governor-onetask-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n",
  );
  return loadPlan(f);
}

test("W1-T317: runDrain (single-lane) stops with cost_governor_deferred and never dispatches — a real runnable task sits ready and is not taken", async () => {
  const plan = onePlan();
  let runOneCalls = 0;
  const deps: DrainDeps = {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => {
      runOneCalls++;
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    checkCostGovernor: () => ({ deferred: true, observedDayCostUsd: 206, ceilingUsd: 150 }),
  };
  const summary = await runDrain(plan, deps);
  assert.equal(summary.stopReason, "cost_governor_deferred");
  assert.equal(runOneCalls, 0, "checkCostGovernor must be consulted BEFORE nextRunnable ever offers a task to runOne");
  assert.deepEqual(summary.attempted, [], "a deferred task is never even attempted, unlike a genuine block");
});

test("W1-T317: runDrain (multi-lane, laneCount >= 2) ALSO stops with cost_governor_deferred and never dispatches", async () => {
  const plan = onePlan();
  let runOneCalls = 0;
  const deps: DrainDeps = {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => {
      runOneCalls++;
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    checkCostGovernor: () => ({ deferred: true, observedDayCostUsd: 206, ceilingUsd: 150 }),
  };
  const summary = await runDrain(plan, deps, { laneCount: 2 });
  assert.equal(summary.stopReason, "cost_governor_deferred");
  assert.equal(runOneCalls, 0, "the multi-lane path must apply the SAME governor gate as the single-lane path");
});

test("W1-T317: runDrain proceeds normally (unchanged behavior) when checkCostGovernor is omitted entirely", async () => {
  const plan = onePlan();
  // Tracks which ids the real GitHub-derived projection would now report merged, so the loop
  // naturally stops via `no_runnable` after dispatching A exactly once — never a hand-waved
  // `refreshMerged` that always reports false, which would just re-offer A forever.
  const mergedIds = new Set<string>();
  const deps: DrainDeps = {
    refreshMerged: () => (id) => mergedIds.has(id),
    runOne: async (id) => {
      mergedIds.add(id);
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    // no checkCostGovernor
  };
  const summary = await runDrain(plan, deps);
  assert.deepEqual(summary.merged, ["A"], "omitted governor ⇒ dispatch behaves exactly as before this task");
});

test("W1-T317: runDaemon IDLES (never dispatches) while checkCostGovernor defers, and dispatches the SAME real task the moment it clears", async () => {
  const plan = onePlan();
  const dispatched: string[] = [];
  let governorCalls = 0;
  const deps: DaemonDeps = {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => {
      dispatched.push(id);
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    // Defers the first two consultations, then clears — proving BOTH halves in one pass: no
    // dispatch while held back, and automatic resumption once the ceiling is no longer crossed
    // (the daemon is PERSISTENT, unlike drain's bounded one-shot stop).
    checkCostGovernor: () => {
      governorCalls++;
      return governorCalls <= 2 ? { deferred: true, observedDayCostUsd: 206, ceilingUsd: 150 } : undefined;
    },
    // Terminates the otherwise-infinite loop right after the one real dispatch happens.
    checkStop: () => (dispatched.length > 0 ? "test done" : undefined),
    sleep: async () => {},
  };
  const summary = await runDaemon(plan, deps);
  assert.equal(summary.stopReason, "stopped");
  assert.deepEqual(dispatched, ["A"], "exactly one dispatch, only AFTER the governor stopped deferring");
  assert.ok(governorCalls >= 3, "the governor must be re-consulted on every idle tick, not cached past the first defer");
});

// ── W1-T342: THE PER-DISPATCH GOVERNOR GATE — governors were consulted ONCE per tick, before
// dispatch, so two dispatches admitted in one batch would both pass a single reading. The fix
// (daemon.ts's `checkDispatchGovernors`) gives every dispatch its OWN, freshly-taken reading.
//
// `runDaemon` cannot yet be driven through two dispatches inside ONE tick — there is no
// multi-lane loop to admit a second lane (W1-T343, explicitly out of THIS task's scope) — so
// these tests drive the exported seam DIRECTLY: the same seam `runDaemon`'s per-dispatch call
// site uses today, and the same seam a future lane loop must call once per lane. Calling it
// TWICE, explicitly, is the whole falsifier: a caller that (wrongly) took one reading and reused
// it for two "dispatches" would never see the second call at all, so a mock whose behaviour
// changes between calls would go unnoticed. These tests would not catch that mistake by driving
// `runDaemon` over two SEPARATE ticks either — the old per-tick call was already fresh across
// ticks; the defect only exists WITHIN one batch, which is exactly what calling the seam twice
// in a row, with no tick boundary between the calls, reproduces.

test("W1-T342 acceptance 1: a governor that trips BETWEEN the first and second dispatch of one batch refuses the second — never the first lane's cached reading", () => {
  let calls = 0;
  const deps: Pick<DaemonDeps, "checkCostGovernor" | "checkQueueGovernor"> = {
    checkCostGovernor: () => {
      calls++;
      // Dispatch 1's reading: under the ceiling. Dispatch 2's reading — the SAME batch, one
      // dispatch later — is now AT the ceiling: the exact "a ceiling that just fired for the
      // first time ever" shape this task's rationale names (the $152.28/$150 incident).
      return calls === 1 ? undefined : { deferred: true, observedDayCostUsd: 150, ceilingUsd: 150 };
    },
  };
  const first = checkDispatchGovernors(deps, 150);
  assert.equal(first, undefined, "dispatch 1 is admitted — the ceiling had not tripped yet");
  const second = checkDispatchGovernors(deps, 150);
  assert.ok(second, "dispatch 2 must be refused — it has to see the ceiling that tripped after dispatch 1 was admitted");
  assert.equal(second!.kind, "cost");
  assert.equal(calls, 2, "each dispatch called the seam fresh — never a single cached reading reused for both");
});

test("W1-T342 acceptance 1 (queue governor): the SAME shape holds for the WIP ceiling — a trip between dispatch 1 and 2 refuses the second", () => {
  let calls = 0;
  const deps: Pick<DaemonDeps, "checkCostGovernor" | "checkQueueGovernor"> = {
    checkQueueGovernor: () => {
      calls++;
      return calls === 1 ? undefined : { deferred: true, observedOpenCount: 20, wipLimit: 20 };
    },
  };
  const first = checkDispatchGovernors(deps, undefined);
  assert.equal(first, undefined, "dispatch 1 is admitted — the WIP limit had not tripped yet");
  const second = checkDispatchGovernors(deps, undefined);
  assert.ok(second, "dispatch 2 must be refused — it has to see the WIP limit that tripped after dispatch 1 was admitted");
  assert.equal(second!.kind, "queue");
  assert.equal(calls, 2);
});

test("W1-T342 acceptance 2: an unreadable governor observation (a throw) admits NO further dispatch in that batch — never a silent fall-through to admitted", () => {
  let calls = 0;
  const deps: Pick<DaemonDeps, "checkCostGovernor" | "checkQueueGovernor"> = {
    checkCostGovernor: () => {
      calls++;
      if (calls === 1) return undefined; // dispatch 1: readable, genuinely under the ceiling
      throw new Error("ledger read failed"); // dispatch 2: the SAME batch, now unreadable
    },
  };
  const first = checkDispatchGovernors(deps, 150);
  assert.equal(first, undefined, "dispatch 1 is admitted — a genuinely readable, under-ceiling verdict");
  const second = checkDispatchGovernors(deps, 150);
  assert.ok(second, "dispatch 2 must be refused — an unreadable observation fails CLOSED, never falls through to admitted");
  assert.equal(second!.kind, "unreadable");
  if (second!.kind === "unreadable") {
    assert.equal(second.source, "cost");
    assert.equal(second.error, "ledger read failed", "the unreadable verdict carries the real failure, never swallowed");
  }
});

test("W1-T342 acceptance 2 (queue governor): an unreadable QUEUE observation also fails closed, independently of the cost governor", () => {
  const deps: Pick<DaemonDeps, "checkCostGovernor" | "checkQueueGovernor"> = {
    checkCostGovernor: () => undefined, // cost side is genuinely readable and under ceiling
    checkQueueGovernor: () => {
      throw new Error("gh pr list failed");
    },
  };
  const verdict = checkDispatchGovernors(deps, undefined);
  assert.ok(verdict, "an unreadable queue observation must also defer, never fall through to admitted");
  assert.equal(verdict!.kind, "unreadable");
  if (verdict!.kind === "unreadable") assert.equal(verdict.source, "queue");
});

test("W1-T342: omitting BOTH governors entirely still admits every dispatch — unchanged behaviour for a caller that never wired either", () => {
  const deps: Pick<DaemonDeps, "checkCostGovernor" | "checkQueueGovernor"> = {};
  assert.equal(checkDispatchGovernors(deps, 150), undefined);
  assert.equal(checkDispatchGovernors(deps, undefined), undefined);
});

test("W1-T342: runDaemon's per-dispatch call site (immediately before runOne) genuinely defers on its OWN reading, independently of the tick-wide check having already passed", async () => {
  const plan = onePlan();
  const dispatched: string[] = [];
  let calls = 0;
  const deps: DaemonDeps = {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => {
      dispatched.push(id);
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    // ODD calls are the tick-wide site (before retro/kicks/nextRunnable) — always clear.
    // EVEN calls are the per-dispatch site (immediately before runOne) — deferred on tick 1
    // only. This is the exact "the tick-wide reading already passed, but THIS dispatch's own
    // fresh reading must still be consulted on its own merits" shape design (i) requires.
    checkCostGovernor: () => {
      calls++;
      if (calls % 2 === 0 && calls <= 2) return { deferred: true, observedDayCostUsd: 150, ceilingUsd: 150 };
      return undefined;
    },
    checkStop: () => (dispatched.length > 0 ? "test done" : undefined),
    sleep: async () => {},
  };
  const summary = await runDaemon(plan, deps);
  assert.equal(summary.stopReason, "stopped");
  assert.deepEqual(dispatched, ["A"], "dispatched only once the PER-DISPATCH consultation also cleared, not merely the tick-wide one");
  assert.ok(
    calls >= 3,
    `expected the tick-wide pass, the per-dispatch defer, and at least one later successful pair — got ${calls} calls`,
  );
});
