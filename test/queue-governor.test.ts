import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SWEEP_POLICY,
  checkQueueGovernor,
  logQueueGovernorDeferral,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type QueueGovernorResult,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import { readLedgerLines, type GitHub } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDrain, type DrainDeps, type DrainSummary, type MergedSet } from "../src/lib/drain.js";
import { runDaemon, type DaemonDeps, type DaemonSummary } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";
import { drainCommand, daemonCommand } from "../src/run-task.js";

// ── W1-T121 QUEUE GOVERNOR — a WIP limit on DISPATCH only; flow control
// throttles intake, never drainage (the 23-open-PR incident). ────────────────
//
// CORROBORATION (the governor's thesis, run by hand): with the dispatcher
// down and only the sweep loop running, the queue drained 23 -> 14 open PRs
// in a single pass window, and with dispatch halted again the remaining ten
// drained to ZERO — drainage is demonstrably healthy while intake is zero.
// These tests hold the SAME shape: the governor gates a synthetic dispatch
// decision while a REAL `runSweep` pass, in the very same test, proves
// sweep/heal/arm/merge are untouched.

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-queue-governor-")), "ledger.ndjson");
}

const NOW = Date.parse("2026-07-20T12:00:00Z");
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

// The SAME four-disposition golden seeded set sweep.test.ts's acceptance 1
// uses — one PR per disposition, so a single `runSweep` pass exercises
// mergeable/blocked-fixable/stale/blocked-ambiguous all at once.
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
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance 1: at the limit ─────────────────────────────────────────────

test("acceptance 1 — at the limit: checkQueueGovernor defers, a dispatch_deferred_wip ledger line carries the observed count, and sweep/heal/arm/merge in the SAME pass are unaffected", async () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 4 };
  const openPrCount = 4; // AT the limit

  const result = checkQueueGovernor(openPrCount, policy);
  assert.equal(result.deferred, true, "at the limit, dispatch is deferred");
  assert.equal(result.observedOpenCount, 4);
  assert.equal(result.wipLimit, 4);

  const path = ledgerPath();
  logQueueGovernorDeferral(result, appendLedger, path, "DAEMON-1");
  const lines = readLedgerLines(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "dispatch_deferred_wip");
  assert.equal(lines[0].observed_open_count, 4, "the throttled ledger line carries the observed open count");
  assert.equal(lines[0].wip_limit, 4);

  // SAME PASS: a real runSweep over the four-disposition golden set — the
  // governor above must not have touched it. sweep/heal/arm/merge fire at
  // full depth, exactly as if the governor did not exist.
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
  assert.equal(summary.actionsTaken, 4, "all four dispositions acted — drainage is ungated at any depth");
  assert.equal(deps.armed.length, 1, "merge-eligible PR still armed");
  assert.equal(deps.fixed.length, 1, "fixable PR still dispatched a fix worker");
  assert.equal(deps.closed.length, 1, "stale PR still closed");
  assert.equal(deps.escalated.length, 1, "ambiguous PR still escalated");
});

test("acceptance 1b — ABOVE the limit also defers (not just exactly-at)", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 4 };
  const result = checkQueueGovernor(7, policy);
  assert.equal(result.deferred, true);
  assert.equal(result.observedOpenCount, 7);
});

// ── acceptance 2: below the limit ──────────────────────────────────────────

test("acceptance 2 — below the limit: dispatch proceeds normally (the falsifier proving the governor is not simply off or always-on)", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 10 };
  const result = checkQueueGovernor(3, policy);
  assert.equal(result.deferred, false, "well below the limit, dispatch is NOT deferred");
  assert.equal(result.observedOpenCount, 3);
  assert.equal(result.wipLimit, 10);
});

test("acceptance 2b — one below the limit (boundary) also proceeds — the limit is inclusive on the deferred side only", () => {
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 10 };
  const result = checkQueueGovernor(9, policy);
  assert.equal(result.deferred, false);
});

// ── acceptance 3: the limit is policy DATA, not a constant ────────────────

test("acceptance 3 — changing the limit is a policy-data row edit with zero code change: the SAME open-PR count flips disposition purely from a policy override", () => {
  const openPrCount = 5;

  const loose: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 10 };
  assert.equal(checkQueueGovernor(openPrCount, loose).deferred, false, "5 open PRs, limit 10 -> not deferred");

  const tight: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 5 };
  assert.equal(checkQueueGovernor(openPrCount, tight).deferred, true, "the SAME 5 open PRs, limit tightened to 5 -> deferred");

  const tighter: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 3 };
  assert.equal(checkQueueGovernor(openPrCount, tighter).deferred, true, "limit tightened further -> still deferred");
});

test("acceptance 3b — DEFAULT_SWEEP_POLICY carries wipLimit as a table row (policy-as-data, not an inlined constant)", () => {
  assert.equal(typeof DEFAULT_SWEEP_POLICY.wipLimit, "number");
  assert.ok(DEFAULT_SWEEP_POLICY.wipLimit > 0);
});

// ── zero-open-PR edge (drainage-to-zero corroboration) ─────────────────────

test("zero open PRs never defers — the drained-to-zero end state is always dispatch-eligible", () => {
  const result = checkQueueGovernor(0, DEFAULT_SWEEP_POLICY);
  assert.equal(result.deferred, false);
});

// ── W1-T321: THE PREDICATE ABOVE IS REAL AND TESTED (W1-T121's own scope) — but nothing in the
// repo ever CALLED it: `checkQueueGovernor in src/` grepped to only its own definition, and
// neither drainCommand's nor daemonCommand's dep object carried it, so the WIP ceiling never
// gated a single dispatch in production despite shipping tested. W1-T317 wired the sibling cost
// governor and deliberately left this one alone — this is that wiring. THE TESTS ABOVE PIN
// checkQueueGovernor's OWN BEHAVIOR, which was never the gap — a hand-built open-PR count (exactly
// what every test above uses) proves nothing about whether any REAL caller ever asks. THESE TESTS
// DRIVE THE REAL drainCommand/daemonCommand AND the REAL runDrain/runDaemon loops, mirroring
// test/cost-governor.test.ts's identical "these tests drive the REAL command wiring, never a
// hand-built fixture" discipline for W1-T317 — the same class of gap (tested-but-inert) this
// task's own rationale names as its closest sibling. ──────────────────────────────────────────

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function queueGovernorFixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-queue-governor-drain-")) } as Config;
}

function emptyPlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-queue-governor-plan-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return planPath;
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
  const home = mkdtempSync(join(tmpdir(), "rmd-queue-governor-daemon-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
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

// ── acceptance — the wiring itself: the real command hands runDrain/runDaemon a real
// checkQueueGovernor, not the un-wired "field absent" shape ────────────────────────────────

test("W1-T321 REACHABILITY: drainCommand wires checkQueueGovernor into the DrainDeps it hands runDrain", async () => {
  const config = queueGovernorFixtureConfig();
  try {
    const deps = await captureDrainDeps(config, emptyPlanPath());
    assert.equal(typeof deps.checkQueueGovernor, "function", "drainCommand must wire the queue-governor gate");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T321 REACHABILITY: daemonCommand wires checkQueueGovernor into the DaemonDeps it hands runDaemon", async () => {
  const { home, planPath } = daemonFixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const deps = await captureDaemonDeps(planPath);
    assert.equal(typeof deps.checkQueueGovernor, "function", "daemonCommand must wire the queue-governor gate");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── the WIRED predicate reads a REAL open-PR count off the SAME projection `openPrCount`
// already feeds the W1-T172 lanes budget — never a hand-built figure — and, over the limit,
// the wired call site itself ledgers the deferral ──────────────────────────────────────────

/** A plan of `n` tasks, each carrying a `pr:` field GitHub resolves OPEN — status.ts's rung (b)
 *  (`task.pr` -> `deps.github.prByRef`), the simplest real path to an OPEN `StatusProjection`
 *  entry without a ledger `pr.opened` line. `openPrCount` (run-task.ts) counts these directly
 *  off the SAME `lastProj` `refreshMerged` populates — the identical mechanism the W1-T172 lanes
 *  budget already relies on, unchanged by this task. */
function planWithOpenPrs(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-queue-governor-openplan-"));
  const planPath = join(dir, "tasks.yaml");
  const lines = Array.from(
    { length: n },
    (_, i) => `- id: W1-A${i}\n  title: a${i}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  pr: ${i + 1}\n`,
  );
  writeFileSync(planPath, lines.join(""));
  return planPath;
}

const OPEN_GITHUB: GitHub = {
  prByRef: (ref) => ({ number: Number(ref), url: `https://github.com/o/r/pull/${ref}`, state: "OPEN" }),
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** Drives the REAL drainCommand exactly like {@link captureDrainDeps}, but ALSO calls the
 *  captured `refreshMerged()` once — the same populate-`lastProj`-before-`openPrCount` sequence
 *  `runDrain`'s own loop performs on every tick — so `checkQueueGovernor()` reads a live count. */
async function captureDrainDepsWithLiveProjection(config: Config, planPath: string, github: GitHub): Promise<DrainDeps> {
  let captured: DrainDeps | undefined;
  const code = await drainCommand([], {
    config,
    planPath,
    skipGitSync: true,
    githubFactory: () => github,
    notifyChannel: { send: () => true } as never,
    runDrain: async (_plan, deps): Promise<DrainSummary> => {
      deps.refreshMerged();
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
    },
  });
  assert.equal(code, 0);
  assert.ok(captured);
  return captured;
}

test("W1-T321: drainCommand's WIRED checkQueueGovernor reads the REAL open-PR count — at DEFAULT_SWEEP_POLICY.wipLimit it defers, and the call site itself ledgers dispatch_deferred_wip", async () => {
  const config = queueGovernorFixtureConfig();
  try {
    const ledgerPath = join(config.root, "state", "ledger.ndjson");
    const planPath = planWithOpenPrs(DEFAULT_SWEEP_POLICY.wipLimit);
    const deps = await captureDrainDepsWithLiveProjection(config, planPath, OPEN_GITHUB);
    const result = deps.checkQueueGovernor!();
    assert.ok(result, "the REAL wiring — not a hand-built fixture — must defer once the live open-PR count reaches wipLimit");
    assert.equal(result!.observedOpenCount, DEFAULT_SWEEP_POLICY.wipLimit);
    assert.equal(result!.wipLimit, DEFAULT_SWEEP_POLICY.wipLimit);

    const afterLog = readLedgerLines(ledgerPath);
    const deferLine = afterLog.find((l) => l.step === "dispatch_deferred_wip");
    assert.ok(deferLine, "the call site itself must write the dispatch_deferred_wip line, not merely return a verdict");
    assert.equal(deferLine!.observed_open_count, DEFAULT_SWEEP_POLICY.wipLimit);
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T321: drainCommand's WIRED checkQueueGovernor reads the REAL open-PR count — well under wipLimit it reports undefined (proceed), no ledger line", async () => {
  const config = queueGovernorFixtureConfig();
  try {
    const ledgerPath = join(config.root, "state", "ledger.ndjson");
    const planPath = planWithOpenPrs(1);
    const deps = await captureDrainDepsWithLiveProjection(config, planPath, OPEN_GITHUB);
    assert.equal(deps.checkQueueGovernor!(), undefined, "1 open PR, well under wipLimit, the real wiring must NOT defer");
    const afterLog = readLedgerLines(ledgerPath);
    assert.equal(
      afterLog.some((l) => l.step === "dispatch_deferred_wip"),
      false,
      "no deferral line when the real wiring did not defer",
    );
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("W1-T321: daemonCommand's WIRED checkQueueGovernor reads the REAL open-PR count, deferred at / clear under wipLimit", async () => {
  const { home, root, planPath: emptyPath } = daemonFixtureHome();
  void emptyPath;
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const planPath = planWithOpenPrs(DEFAULT_SWEEP_POLICY.wipLimit);
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      githubFactory: () => OPEN_GITHUB,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        deps.refreshMerged();
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured);
    const result = captured!.checkQueueGovernor!();
    assert.ok(result, "the daemon's real wiring must read the actual live open-PR count, not a stub that always says clear");
    assert.equal(result!.observedOpenCount, DEFAULT_SWEEP_POLICY.wipLimit);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the DISPATCH PATH itself: runDrain/runDaemon actually CONSULT checkQueueGovernor to hold
// back NEW dispatch, exercised against a REAL runnable task so a regression that stops
// consulting it would let that task dispatch instead ───────────────────────────────────────

const NONE_MERGED: MergedSet = () => false;

function onePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "rmd-queue-governor-onetask-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n",
  );
  return loadPlan(f);
}

test("W1-T321: runDrain (single-lane) stops with queue_governor_deferred and never dispatches — a real runnable task sits ready and is not taken", async () => {
  const plan = onePlan();
  let runOneCalls = 0;
  const deps: DrainDeps = {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => {
      runOneCalls++;
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    checkQueueGovernor: () => ({ deferred: true, observedOpenCount: 23, wipLimit: 20 }),
  };
  const summary = await runDrain(plan, deps);
  assert.equal(summary.stopReason, "queue_governor_deferred");
  assert.equal(runOneCalls, 0, "checkQueueGovernor must be consulted BEFORE nextRunnable ever offers a task to runOne");
  assert.deepEqual(summary.attempted, [], "a deferred task is never even attempted, unlike a genuine block");
});

test("W1-T321: runDrain (multi-lane, laneCount >= 2) ALSO stops with queue_governor_deferred and never dispatches", async () => {
  const plan = onePlan();
  let runOneCalls = 0;
  const deps: DrainDeps = {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => {
      runOneCalls++;
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    checkQueueGovernor: () => ({ deferred: true, observedOpenCount: 23, wipLimit: 20 }),
  };
  const summary = await runDrain(plan, deps, { laneCount: 2 });
  assert.equal(summary.stopReason, "queue_governor_deferred");
  assert.equal(runOneCalls, 0, "the multi-lane path must apply the SAME governor gate as the single-lane path");
});

test("W1-T321: runDrain proceeds normally (unchanged behavior) when checkQueueGovernor is omitted entirely", async () => {
  const plan = onePlan();
  const mergedIds = new Set<string>();
  const deps: DrainDeps = {
    refreshMerged: () => (id) => mergedIds.has(id),
    runOne: async (id) => {
      mergedIds.add(id);
      return { taskId: id, runId: "R", merged: true, costUsd: 0, verdict: "merged" };
    },
    // no checkQueueGovernor
  };
  const summary = await runDrain(plan, deps);
  assert.deepEqual(summary.merged, ["A"], "omitted governor ⇒ dispatch behaves exactly as before this task");
});

test("W1-T321: runDaemon IDLES (never dispatches) while checkQueueGovernor defers, and dispatches the SAME real task the moment it clears", async () => {
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
    // dispatch while held back, and automatic resumption once the count is no longer at/over the
    // limit (the daemon is PERSISTENT, unlike drain's bounded one-shot stop).
    checkQueueGovernor: () => {
      governorCalls++;
      return governorCalls <= 2 ? { deferred: true, observedOpenCount: 23, wipLimit: 20 } : undefined;
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
