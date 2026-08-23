/**
 * test/fix-spawn-bound-split.test.ts — W1-T1219 (ONE POLICY ROW BOUNDS TWO UNRELATED
 * POPULATIONS).
 *
 * THE DEFECT. `sweepWallClockBoundMs` (W1-T1044) was derived from SWEEP-TICK durations
 * (healthy p90 111.8s) and was applied VERBATIM to bound ONE fix-rung Claude worker spawn
 * inside `runFixRung` (src/run-task.ts) too — a sweep tick classifies open PRs against a
 * rollup it already fetched; a fix-rung spawn is an implement-class worker that reads a diff,
 * edits source and commits. Sharing the one row meant the rung abandoned healthy
 * implement-class work at 9m19s (three `fix.spawn_abandoned` rows on 2026-08-22, both
 * `spawnAbandonedElapsedMs` values landing within 60ms of the shared bound — nothing hung).
 * Worse, the ledger could not even measure the RIGHT bound: `fix.dispatch` is logged AFTER the
 * spawn returns (W1-T127), so every completed pair lands in the same second and encodes no
 * duration at all.
 *
 * THE FIX, per this task's own design note: (i) a NEW row, `fixSpawnWallClockBoundMs`, with its
 * own value/min/max — `sweepWallClockBoundMs` is untouched, value and bounds both, and now
 * bounds ONLY the sweep tick. (ii) a completed spawn now records its own elapsed milliseconds
 * (`fix.dispatch`'s `elapsed_ms`), the SAME field `fix.spawn_abandoned` already carried on the
 * failure path, so the population needed to derive the REAL bound starts accumulating.
 *
 * A NEW, DEDICATED file (this task's own `files:` list), never folded into
 * test/sweep-wall-clock-bound.test.ts or test/policy.test.ts — a coverage-load-bearing split is
 * its own file, the SAME convention W1-T1044's own suite doc cites for why it exists apart from
 * test/daemon.test.ts/test/run-task.test.ts.
 *
 * Six acceptance criteria, six sections below:
 *   1. the fix spawn resolves its bound from its own policy row, not the sweep tick's
 *   2. retuning the sweep tick's bound no longer moves the fix spawn's ceiling
 *   3. the sweep tick keeps its own value and its own bounds unchanged
 *   4. a completed spawn records its own elapsed milliseconds
 *   5. an absent row still resolves to a committed default rather than failing to load
 *   6. the spawn is still bounded and can still be abandoned
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS, installPolicyPath, loadPolicy } from "../src/lib/policy.js";
import { DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS } from "../src/lib/daemon.js";
import { runFixRung, type FixRungOutcome } from "../src/run-task.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function fakeWorkerResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s-w1t1219",
    costUsd: 0,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(state: "success" | "failure", headSha = "deadbeef"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria: state === "success" ? [criterion({ claim: "criterion A merges cleanly", met: true })] : [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })],
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

const NEVER_ISSUES: IssueGateway = {
  create() {
    throw new Error("no escalation expected in this fixture");
  },
};

function fixRungBaseOpts() {
  return {
    taskId: "W1-T1219FIX",
    runId: "W1-T1219FIX-1730000000000",
    task: { id: "W1-T1219FIX", title: "a task whose fix spawn is under test" },
    prUrl: "https://github.com/acme/remudero/pull/1219",
    branch: "run-W1-T1219FIX-1730000000000",
    worktreePath: "/tmp/rmd-fix-spawn-bound-split-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fix-spawn-bound-split-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 1,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fix-spawn-bound-split-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fix-spawn-bound-split-ledger-")), "ledger.ndjson");
}

// ── acceptance 1 + 2 + 5 (policy-data layer): two independent rows ─────────────────────────────

test("W1-T1219: the SHIPPED policy carries fixSpawnWallClockBoundMs and sweepWallClockBoundMs as two DISTINCT, independently-resolved rows", () => {
  const committed = loadPolicy(installPolicyPath());
  assert.equal(typeof committed.values.fixSpawnWallClockBoundMs, "number");
  assert.equal(typeof committed.values.sweepWallClockBoundMs, "number");
  assert.notEqual(
    committed.values.fixSpawnWallClockBoundMs,
    committed.values.sweepWallClockBoundMs,
    "the fix spawn's row and the sweep tick's row must not merely alias the same number",
  );
  // Each side mirrors its OWN module default — proving the split reaches all the way to the
  // fallback constants each field resolves against, not just the committed YAML value.
  assert.equal(committed.values.fixSpawnWallClockBoundMs, DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS);
  assert.equal(committed.values.sweepWallClockBoundMs, DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS);
});

test("W1-T1219 (acceptance 2): retuning sweepWallClockBoundMs's VALUE in policy.yaml does not move fixSpawnWallClockBoundMs, read from the SAME loaded file", () => {
  const real = readFileSync(installPolicyPath(), "utf8");
  const committed = loadPolicy(installPolicyPath());
  const distinctSweepValue = committed.values.sweepWallClockBoundMs + 12_345;
  const mutated = real.replace(/sweepWallClockBoundMs:\n(\s+)value: \d+/, `sweepWallClockBoundMs:\n$1value: ${distinctSweepValue}`);
  assert.notEqual(mutated, real, "the regex must actually have matched and rewritten the sweep tick's row");

  const dir = mkdtempSync(join(tmpdir(), "fix-spawn-bound-split-retune-sweep-"));
  const path = join(dir, "policy.yaml");
  writeFileSync(path, mutated);
  const reloaded = loadPolicy(path);
  assert.equal(reloaded.values.sweepWallClockBoundMs, distinctSweepValue, "the retune itself must have taken");
  assert.equal(
    reloaded.values.fixSpawnWallClockBoundMs,
    committed.values.fixSpawnWallClockBoundMs,
    "retuning the SWEEP TICK's bound must never move the fix spawn's ceiling — this is the coupling W1-T1219 breaks",
  );
});

test("W1-T1219 (acceptance 1 + 2, the reverse direction): retuning fixSpawnWallClockBoundMs's VALUE does not move sweepWallClockBoundMs", () => {
  const real = readFileSync(installPolicyPath(), "utf8");
  const committed = loadPolicy(installPolicyPath());
  const distinctFixValue = committed.values.fixSpawnWallClockBoundMs + 54_321;
  const mutated = real.replace(/fixSpawnWallClockBoundMs:\n(\s+)value: \d+/, `fixSpawnWallClockBoundMs:\n$1value: ${distinctFixValue}`);
  assert.notEqual(mutated, real, "the regex must actually have matched and rewritten the fix spawn's row");

  const dir = mkdtempSync(join(tmpdir(), "fix-spawn-bound-split-retune-fix-"));
  const path = join(dir, "policy.yaml");
  writeFileSync(path, mutated);
  const reloaded = loadPolicy(path);
  assert.equal(reloaded.values.fixSpawnWallClockBoundMs, distinctFixValue, "the retune itself must have taken");
  assert.equal(
    reloaded.values.sweepWallClockBoundMs,
    committed.values.sweepWallClockBoundMs,
    "retuning the FIX SPAWN's bound must never move the sweep tick's ceiling — the SAME coupling, the other direction",
  );
});

test("W1-T1219 (acceptance 5): a policy.yaml missing fixSpawnWallClockBoundMs entirely still loads, resolving to the committed default", () => {
  const real = readFileSync(installPolicyPath(), "utf8");
  // Strip the WHOLE row (its header line plus its four indented sub-lines) — the SAME
  // absent-means-default shape sweepWallClockBoundMs's own row already exercises.
  const stripped = real.replace(/fixSpawnWallClockBoundMs:\n(?:[ \t]+.+\n)+/, "");
  assert.notEqual(stripped, real, "the regex must actually have matched and removed the row");
  // Only the ROW ITSELF (the `fixSpawnWallClockBoundMs:` mapping with its `value:` line) must be
  // gone — the field's own name legitimately still appears in nearby prose comments (e.g.
  // sweepWallClockBoundMs's own row points readers at it), which this must not flag as a failure.
  assert.doesNotMatch(stripped, /fixSpawnWallClockBoundMs:\n\s+value:/, "the row itself must be genuinely absent, not merely blanked");

  const dir = mkdtempSync(join(tmpdir(), "fix-spawn-bound-split-absent-"));
  const path = join(dir, "policy.yaml");
  writeFileSync(path, stripped);
  const reloaded = loadPolicy(path); // must not throw
  assert.equal(reloaded.values.fixSpawnWallClockBoundMs, DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS);
  // The sibling optional row is unaffected — the two absences are independent too.
  assert.equal(reloaded.values.sweepWallClockBoundMs, DEFAULT_SWEEP_WALL_CLOCK_BOUND_MS);
});

// ── acceptance 3: the sweep tick's own row is a byte-for-byte regression guard ─────────────────

test("W1-T1219 (acceptance 3): sweepWallClockBoundMs's committed value AND bounds are UNCHANGED by the split", () => {
  const raw = readFileSync(installPolicyPath(), "utf8");
  const match = raw.match(/sweepWallClockBoundMs:\n\s+value: (\d+)\n\s+origin: "([^"]+)"\n\s+min: (\d+)\n\s+max: (\d+)/);
  assert.ok(match, "sweepWallClockBoundMs's row must still parse in the exact shape it shipped in before this task");
  const [, value, origin, min, max] = match!;
  // The SAME figures W1-T1044 committed, byte for byte — a coupling fix must never smuggle in a
  // retune of the row it did NOT set out to change (this task's own design note (v): "a refusal,
  // not an omission").
  assert.equal(Number(value), 559000);
  assert.equal(origin, "net-new");
  assert.equal(Number(min), 180000);
  assert.equal(Number(max), 900000);
});

// ── acceptance 1 (wiring layer): the REAL call sites read the fix spawn's OWN row ──────────────

test("W1-T1219 (acceptance 1, wiring): every real fix-rung-spawn call site in src/run-task.ts resolves its bound from fixSpawnWallClockBoundMs, never sweepWallClockBoundMs", () => {
  const src = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
  const fixSpawnReads = (src.match(/loadDefaultPolicy\(\)\.values\.fixSpawnWallClockBoundMs/g) ?? []).length;
  assert.ok(
    fixSpawnReads >= 2,
    `expected at least the two known fix-rung-spawn call sites (runTask's opts.spawnWallClockBoundMs ` +
      `fallback, and buildSweepEffects's spawnWallClockBoundMsOverride fallback) to read ` +
      `fixSpawnWallClockBoundMs; saw ${fixSpawnReads}`,
  );
  // The OLD, pre-split wiring — a fix-rung-spawn bound falling back to the SWEEP TICK's row —
  // must be genuinely gone, not merely supplemented.
  assert.doesNotMatch(
    src,
    /spawnWallClockBoundMs(Override)? \?\? loadDefaultPolicy\(\)\.values\.sweepWallClockBoundMs/,
    "no fix-rung-spawn bound fallback may still read the sweep tick's row",
  );
});

// ── acceptance 6: the mechanism still bounds, and can still abandon ────────────────────────────

test("W1-T1219 (acceptance 6): the fix-rung spawn is still bounded by wall-clock elapsed time and can still be abandoned", async () => {
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    initialReview: fakeReview("failure"),
    deps: {
      // A worker that never returns — the same shape W1-T1044's own measured incident took.
      spawn: () => new Promise<WorkerResult>(() => {}),
      waitForCiGreen: async () => "green",
      runReview: async () => fakeReview("failure"),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 20,
    },
  });
  assert.equal(outcome.outcome, "spawn_abandoned");
  assert.ok(outcome.spawnAbandonedElapsedMs !== undefined && outcome.spawnAbandonedElapsedMs >= 15, "bounded by the configured elapsed time");
});

// ── acceptance 4: a completed spawn records its own elapsed milliseconds ───────────────────────

test("W1-T1219 (acceptance 4): a completed (non-abandoned) spawn records its own elapsed milliseconds on the fix.dispatch ledger row", async () => {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const start = Date.now();
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    initialReview: fakeReview("failure"),
    deps: {
      // A real, small elapsed delay — a real setTimeout, not a fake clock (mirrors
      // spawnFixWorkerBounded's own tests) — so this reads a genuine wall-clock duration.
      spawn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return fakeWorkerResult({ sessionId: "fix-session-w1t1219" });
      },
      waitForCiGreen: async () => "green",
      // The strike resolves it — review succeeds on the very next read, so the rung ends
      // "fixed" after exactly one strike, with nothing left to abandon or escalate.
      runReview: async () => fakeReview("success", "sha-1"),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => events.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 5000, // comfortably above the 15ms the fake spawn actually takes
    },
  });
  const realElapsedMs = Date.now() - start;

  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);

  const dispatchLine = events.find((e) => e.step === "fix.dispatch");
  assert.ok(dispatchLine, "fix.dispatch must be logged for a demonstrably-ran spawn");
  const elapsedMs = dispatchLine!.extra?.elapsed_ms;
  assert.equal(typeof elapsedMs, "number", "elapsed_ms must be a real number, not absent/undefined");
  assert.ok((elapsedMs as number) >= 10, `expected roughly the 15ms spawn delay, saw ${elapsedMs}ms`);
  assert.ok(
    (elapsedMs as number) <= realElapsedMs + 50,
    `elapsed_ms (${elapsedMs}ms) must reflect the spawn's own duration, not the whole rung's (${realElapsedMs}ms)`,
  );

  // Before this task, the ONLY elapsed figure this rung ever emitted was `spawnAbandonedElapsedMs`
  // — right-censored at exactly the quantity a derivation needs, because it exists only for
  // spawns that HIT the bound. This spawn never hit the bound, and its duration is still named —
  // the completed population is now genuinely measurable.
  assert.equal(outcome.spawnAbandonedElapsedMs, undefined, "this spawn never hit the bound");
});
