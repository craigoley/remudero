import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import {
  applyCuratedSelection,
  buildDrainPreview,
  buildRundown,
  nextRunnable,
  plannedSequence,
  renderRundown,
  renderSummary,
  resumeCommand,
  runDrain,
  type CuratedSelection,
  type DrainSummary,
  type MergedSet,
  type OpenPrCheck,
} from "../src/lib/drain.js";
import { pauseDetail, requestPause, requestStop, stopDetail } from "../src/lib/fleet-control.js";
import { deriveStatus, type GitHub } from "../src/lib/status.js";

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
  note: "b's rationale"
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
  const dir = mkdtempSync(join(tmpdir(), "drain-"));
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
const blockedResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: false, costUsd: 0.3, verdict: "blocked_review", prUrl: "https://github.com/o/r/pull/9" });

// ── next-runnable = the DAG logic (reuses unmetDependencies) ────────────────

test("nextRunnable: first in file order whose deps are merged; skips verify:human and merged", () => {
  const plan = fixturePlan();
  // Nothing merged: A and D are runnable; A wins (file order). H (human) is skipped.
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  // A merged: B and D runnable; B wins (file order before D).
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
  // A,B,C,D merged: only H left, and it is verify:human ⇒ nothing runnable.
  assert.equal(nextRunnable(plan, mergedSetOf("A", "B", "C", "D")), undefined);
});

// ── W1-T76 (absorbs P21): creditability is LOAD-BEARING for the whole DAG,
// not just anti-orphan. The fix rung amends the SAME run-<taskId>-<epochMs>
// branch this run opened; once THAT branch merges, deriveStatus credits the
// task exactly as an unfixed merge would, and nextRunnable naturally unblocks
// its dependent — composing status.ts's existing ownership-assert with
// drain.ts's existing DAG walk, no new production code required.
test("W1-T76: once the fix rung's SAME-branch amendment merges, deriveStatus credits the fixed task AND nextRunnable unblocks its dependent", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const runId = "A-1730000000000"; // this run's OWN branch — never a fix/* head
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: (taskId) => (taskId === "A" ? { number: 50, url: "u/50", state: "MERGED" } : null),
    headRefName: (prUrl) => (prUrl === "u/50" ? `run-${runId}` : undefined),
    prBody: (prUrl) => (prUrl === "u/50" ? "Remudero-Task: A\n" : undefined),
  };
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-fixrung-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const isMerged: MergedSet = (taskId) => {
    const t = plan.tasks.find((x) => x.id === taskId);
    return t ? deriveStatus(t, { ledgerPath, github }).merged : false;
  };

  assert.equal(isMerged("A"), true, "the fixed task's SAME-branch merge is credited (source: trailer)");
  const next = nextRunnable(plan, isMerged);
  assert.equal(next?.id, "B", "A's dependent (B) is now runnable — the fix rung's merge unblocked it");
  assert.notEqual(next?.id, "A", "the already-merged/fixed task itself is EXCLUDED from runnable");
});

// ── W1-T80: dispatch dedup — an OPEN PR means IN-FLIGHT, never runnable ─────
// (the #143/#145 duplicate-build race: rmd review posted success on #143, the
// drain started seconds later — merging is async, so the task looked
// not-merged and a fresh worker rebuilt it end-to-end as #145, orphaning the
// reviewed-green #143).

test("W1-T80 canonical race fixture: a task whose latest PR is OPEN is excluded from nextRunnable, with a legible skip naming the PR", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 143 : undefined);
  const skips: Array<{ id: string; prNumber: number }> = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: (t, prNumber) => skips.push({ id: t.id, prNumber }),
  });
  // A is IN-FLIGHT (open PR #143) — excluded, never re-dispatched as a duplicate build.
  assert.deepEqual(skips, [{ id: "A", prNumber: 143 }]);
  // D is the next runnable candidate in file order once A is skipped (B/C still
  // depend on the un-merged A).
  assert.equal(next?.id, "D");
});

test("W1-T80: a CLOSED (unmerged) PR does NOT block — an abandoned/superseded attempt leaves the task runnable", () => {
  const plan = fixturePlan();
  // A's latest PR is CLOSED (not open) — isOpenPr correctly reports "not open".
  const isOpenPr: OpenPrCheck = () => undefined;
  const next = nextRunnable(plan, NONE_MERGED, { isOpenPr, onSkip: () => assert.fail("no skip expected") });
  assert.equal(next?.id, "A", "a closed-unmerged PR leaves the task runnable — re-runs stay possible");
});

test("W1-T80: merged and correction-credited tasks are excluded exactly as today, isOpenPr never even consulted for them", () => {
  const plan = fixturePlan();
  const consulted: string[] = [];
  const isOpenPr: OpenPrCheck = (id) => {
    consulted.push(id);
    return undefined;
  };
  const next = nextRunnable(plan, mergedSetOf("A"), { isOpenPr });
  assert.equal(next?.id, "B");
  assert.ok(!consulted.includes("A"), "an already-merged task is filtered out before isOpenPr is ever asked");
});

test("W1-T80: no isOpenPr wired at all ⇒ nextRunnable behaves exactly as before this guard existed", () => {
  const plan = fixturePlan();
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
});

test("W1-T80 runDrain integration: the #143 state is skipped with a dispatch.skipped ledger line (task + PR number), and the drain proceeds to the next runnable task instead of halting", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      // A's most recent PR (#143) is OPEN — reviewed-green but not yet merged
      // (merge is async). It must never be re-dispatched as a fresh build.
      isOpenPr: (id) => (id === "A" ? 143 : undefined),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (in-flight under open PR #143) was never re-dispatched as a duplicate build");
  // D is the only other runnable candidate (B/C depend on the still-open A).
  assert.deepEqual(ran, ["D"]);
  assert.equal(s.stopReason, "max_reached");
  const skipLine = lines.find((l) => l.step === "dispatch.skipped");
  assert.ok(skipLine, "a dispatch.skipped ledger line was emitted");
  assert.equal(skipLine?.extra.task, "A");
  assert.equal(skipLine?.extra.pr_number, 143);
  assert.equal(skipLine?.extra.reason, "open-pr");
});

// ── P29(ii): the per-task dispatch CIRCUIT BREAKER — the backstop that makes
// P29(i)'s sibling-credit fix safe to get wrong (MASTER-PLAN P29).

test("P29(ii): a task whose circuit breaker is tripped is excluded from nextRunnable, with a legible callback naming it", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const broken: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isCircuitTripped: (id) => id === "A",
    onCircuitBreak: (t) => broken.push(t.id),
  });
  assert.deepEqual(broken, ["A"]);
  // D is the next runnable candidate once A is halted (B/C still depend on the
  // un-merged, circuit-broken A).
  assert.equal(next?.id, "D");
});

test("P29(ii): the circuit breaker is checked BEFORE the in-flight (open-PR) guard — a tripped task halts regardless of its latest PR's state", () => {
  const plan = fixturePlan();
  const broken: string[] = [];
  const skipped: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isCircuitTripped: (id) => id === "A",
    onCircuitBreak: (t) => broken.push(t.id),
    isOpenPr: (id) => (id === "A" ? 143 : undefined), // A ALSO looks in-flight — the breaker must still win
    onSkip: (t) => skipped.push(t.id),
  });
  assert.deepEqual(broken, ["A"]);
  assert.deepEqual(skipped, [], "onSkip must never fire for a task the breaker already halted");
  assert.equal(next?.id, "D");
});

test("P29(ii): merged and correction-credited tasks are excluded exactly as today, isCircuitTripped never even consulted for them", () => {
  const plan = fixturePlan();
  const consulted: string[] = [];
  const next = nextRunnable(plan, mergedSetOf("A"), {
    isCircuitTripped: (id) => {
      consulted.push(id);
      return false;
    },
  });
  assert.equal(next?.id, "B");
  assert.ok(!consulted.includes("A"), "an already-merged task is filtered out before isCircuitTripped is ever asked");
});

test("P29(ii): no isCircuitTripped wired at all ⇒ nextRunnable behaves exactly as before this breaker existed", () => {
  const plan = fixturePlan();
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
});

// ── W1-T119: an INDETERMINATE read (GitHub could not be consulted — rate
// limit/network/auth failure) must suppress dispatch, distinct from an
// ordinary `queued` task (whose read genuinely resolved to "no evidence"),
// which dispatches normally. This is the dispatch-gating caller half of the
// task's acceptance criterion; applyCorrection (correct.ts) is the other half.

test("W1-T119: a task whose own GitHub read is INDETERMINATE is excluded from nextRunnable, with a legible callback naming it", () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const indeterminate: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isIndeterminate: (id) => id === "A",
    onIndeterminate: (t) => indeterminate.push(t.id),
  });
  assert.deepEqual(indeterminate, ["A"]);
  // D is the next runnable candidate once A is deferred (B/C still depend on
  // the un-merged, indeterminate A).
  assert.equal(next?.id, "D");
});

test("W1-T119: the SAME task dispatches normally when its read is an ordinary queued (not indeterminate) — the two must read as distinct", () => {
  const plan = fixturePlan();
  // No isIndeterminate wired at all ⇒ A is ordinary queued, and dispatches.
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  // Same task, isIndeterminate explicitly false for it ⇒ still dispatches.
  assert.equal(nextRunnable(plan, NONE_MERGED, { isIndeterminate: () => false })?.id, "A");
});

test("W1-T119: indeterminate is checked BEFORE the circuit breaker and the in-flight guard — an indeterminate task halts regardless of either", () => {
  const plan = fixturePlan();
  const indeterminate: string[] = [];
  const broken: string[] = [];
  const skipped: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isIndeterminate: (id) => id === "A",
    onIndeterminate: (t) => indeterminate.push(t.id),
    isCircuitTripped: (id) => id === "A", // A ALSO looks circuit-broken — indeterminate must still win
    onCircuitBreak: (t) => broken.push(t.id),
    isOpenPr: (id) => (id === "A" ? 143 : undefined), // A ALSO looks in-flight — indeterminate must still win
    onSkip: (t) => skipped.push(t.id),
  });
  assert.deepEqual(indeterminate, ["A"]);
  assert.deepEqual(broken, [], "onCircuitBreak must never fire for a task indeterminate already halted");
  assert.deepEqual(skipped, [], "onSkip must never fire for a task indeterminate already halted");
  assert.equal(next?.id, "D");
});

test("W1-T119: merged and correction-credited tasks are excluded exactly as today, isIndeterminate never even consulted for them", () => {
  const plan = fixturePlan();
  const consulted: string[] = [];
  const next = nextRunnable(plan, mergedSetOf("A"), {
    isIndeterminate: (id) => {
      consulted.push(id);
      return false;
    },
  });
  assert.equal(next?.id, "B");
  assert.ok(!consulted.includes("A"), "an already-merged task is filtered out before isIndeterminate is ever asked");
});

test("W1-T119 runDrain integration: an indeterminate task is skipped with a dispatch.indeterminate ledger line, the drain proceeds to the next runnable task, and the caller's onIndeterminate fires", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const indeterminate: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isIndeterminate: (id) => id === "A",
      onIndeterminate: (t) => indeterminate.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra) => lines.push({ step, extra: extra ?? {} }),
    },
    { max: 3 },
  );
  // onIndeterminate carries NO escalation side effect (unlike onCircuitBreak,
  // which dedupes because it opens a needs-human issue) — it fires every tick
  // A is consulted, same as onSkip: once dispatching D (tick 1), once more
  // when A is still indeterminate and nothing else is left to run (tick 2,
  // "no_runnable").
  assert.deepEqual(indeterminate, ["A", "A"]);
  // A is deferred every tick (still un-merged, still indeterminate) — D runs
  // instead, and the drain never touches B/C (blocked on the deferred A).
  assert.deepEqual(ran, ["D"]);
  assert.equal(s.stopReason, "no_runnable");
  const indeterminateLine = lines.find((l) => l.step === "dispatch.indeterminate");
  assert.equal(indeterminateLine?.extra.task, "A");
});

test("P29(ii) runDrain integration: a circuit-broken task is skipped with a dispatch.circuit_broken ledger line, the drain proceeds to the next runnable task, and the caller's onCircuitBreak fires", async () => {
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const broken: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isCircuitTripped: (id) => id === "A",
      onCircuitBreak: (t) => broken.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.ok(!ran.includes("A"), "A (circuit-broken) was never dispatched");
  assert.deepEqual(ran, ["D"]);
  assert.deepEqual(broken, ["A"], "the caller's onCircuitBreak fired exactly once for A");
  assert.equal(s.stopReason, "max_reached");
  const brokenLine = lines.find((l) => l.step === "dispatch.circuit_broken");
  assert.ok(brokenLine, "a dispatch.circuit_broken ledger line was emitted");
  assert.equal(brokenLine?.extra.task, "A");
});

test("P29(ii) the W1-T29 x10 spin shape: a task at N+1 dispatches with no owned PR HALTS with EXACTLY ONE escalation and ZERO further dispatches, across MULTIPLE ticks of the SAME drain run", async () => {
  // `nextRunnable` is re-invoked on EVERY tick of the loop — a naive wiring
  // re-observes (and re-escalates) a still-tripped task on every tick it
  // remains the only thing left to look at, not just the first. This plan
  // (A tripped; D independent) forces a SECOND tick after D dispatches
  // successfully: tick 1 observes A tripped then dispatches D; tick 2 (D is
  // now merged) observes A tripped AGAIN with nothing else left to run. A
  // wiring that escalates once per OBSERVATION (rather than once per TASK
  // for the whole run) fails this — the exact regression this test guards.
  const plan = fixturePlan(); // A -> B -> C (chain), D independent, H human-only
  const merged = new Set<string>();
  const ran: string[] = [];
  const broken: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isCircuitTripped: (id) => id === "A",
      onCircuitBreak: (t) => broken.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    // No --max ⇒ DEFAULT_MAX (10): enough headroom for a SECOND tick to occur
    // after D merges, so the drain runs to "no_runnable" on its own rather
    // than being cut short at exactly one tick (which would hide this bug).
  );
  assert.ok(!ran.includes("A"), "A (circuit-broken) was never dispatched, at N or at N+1");
  assert.deepEqual(ran, ["D"], "D is the only task ever dispatched — B/C stay unmet-dependency-blocked on the tripped A");
  assert.equal(s.stopReason, "no_runnable", "the drain ran a SECOND tick (proving A was re-observed, not just observed once)");
  assert.deepEqual(broken, ["A"], "onCircuitBreak fired EXACTLY ONCE for A, even though nextRunnable re-observed it tripped on a later tick too");
  const brokenLines = lines.filter((l) => l.step === "dispatch.circuit_broken");
  assert.ok(brokenLines.length >= 2, "sanity: A really was re-observed tripped on a second tick (the ledger line legibly re-logs every observation)");
});

test("plannedSequence (--dry-run order): simulates merges forward, honouring deps + --max + --until", () => {
  const plan = fixturePlan();
  assert.deepEqual(plannedSequence(plan, NONE_MERGED), ["A", "B", "C", "D"]);
  assert.deepEqual(plannedSequence(plan, NONE_MERGED, { max: 2 }), ["A", "B"]);
  assert.deepEqual(plannedSequence(plan, NONE_MERGED, { until: "B" }), ["A", "B"]);
  // --until already satisfied ⇒ empty.
  assert.deepEqual(plannedSequence(plan, mergedSetOf("A", "B"), { until: "B" }), []);
});

// ── the loop: stop-on-block, --max, headroom, until, no-runnable ────────────

test("stop-on-block: a blocked task HALTS the drain and does NOT run its dependents", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        // A merges; B blocks; C (B's dependent) must NEVER run.
        if (id === "B") return blockedResult(id);
        merged.add(id);
        return okResult(id);
      },
    },
  );
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_review/);
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(ran, ["A", "B"]); // C was NOT attempted
  assert.ok(!ran.includes("C"), "the blocked task's dependent must not run");
  assert.match(s.resumeCommand, /^rmd drain/);
});

test("--max N halts after N successful tasks", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
    },
    { max: 2 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A", "B"]);
  assert.equal(s.attempted.length, 2);
});

test("headroom: a near-limit reading STOPS with reason=headroom_exhausted BEFORE spawning", async () => {
  const plan = fixturePlan();
  const nearLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Monday" }],
  };
  let spawned = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => nearLimit,
    },
  );
  assert.equal(s.stopReason, "headroom_exhausted");
  assert.match(s.stopDetail ?? "", /weekly \(all models\) at 98% — resets Monday/);
  assert.equal(spawned, 0, "no task is spawned when a window is at/near its limit");
});

test("headroom unreadable (undefined) does NOT halt — best-effort, the drain continues", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"]);
});

test("--until: drains until the target merges, then stops", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
    },
    { until: "B", max: 10 },
  );
  assert.equal(s.stopReason, "until_reached");
  assert.deepEqual(s.merged, ["A", "B"]); // C, D not run
});

test("no_runnable: an empty/blocked-out plan stops cleanly", async () => {
  const plan = fixturePlan();
  const s = await runDrain(
    plan,
    { refreshMerged: () => mergedSetOf("A", "B", "C", "D"), runOne: async (id) => okResult(id) },
  );
  assert.equal(s.stopReason, "no_runnable"); // only H left (verify:human)
  assert.deepEqual(s.attempted, []);
});

// ── fleet control (W1-T11): STOP / Pause (drain-and-hold) / Resume ─────────

test("PAUSE (drain-and-hold): issued mid-run, the in-flight task still reaches merged; no new spawn follows", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "fleet-pause-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
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
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
  );
  assert.equal(s.stopReason, "paused");
  // A was in flight when pause was requested — it still reaches merged (drain-and-hold).
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(s.attempted, ["A"]); // B (A's dependent) never spawns
  assert.ok(lines.some((l) => l.step === "drain.pause"), "a drain.pause ledger line was emitted");
});

test("STOP: kills within one tick — ledger stop line + no subsequent spawns", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "fleet-stop-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        requestStop(root, "operator hard-stop");
        merged.add(id);
        return okResult(id);
      },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
  );
  assert.equal(s.stopReason, "stopped");
  assert.deepEqual(ran, ["A"]); // STOP is checked at the very next tick — no B/C/D spawn
  assert.ok(
    lines.some((l) => l.step === "drain.stop" && /operator hard-stop/.test(String(l.extra.detail))),
    "a drain.stop ledger line, carrying the reason, was emitted",
  );
});

test("STOP set BEFORE a drain even starts: zero tasks attempted (a fresh drain also refuses to spawn)", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "fleet-stop-pre-"));
  requestStop(root, "pre-armed");
  let spawned = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
    },
  );
  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0);
  assert.deepEqual(s.attempted, []);
});

test("STOP takes precedence over PAUSE when both flags are set", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "fleet-both-"));
  requestPause(root, "b");
  requestStop(root, "a");
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => okResult(id),
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
    },
  );
  assert.equal(s.stopReason, "stopped");
});

// ── W1-T140: drain preview + curation panel ─────────────────────────────────

test("buildDrainPreview: renders plannedSequence's order as task cards, each carrying id/title/description + direct dependency edges both ways", () => {
  const plan = fixturePlan(); // A -> B -> C (chain, B carries a note), D independent, H human-only
  const cards = buildDrainPreview(plan, NONE_MERGED);

  assert.deepEqual(cards.map((c) => c.id), plannedSequence(plan, NONE_MERGED), "card order equals plannedSequence's order exactly");

  const [a, b, c, d] = cards;
  assert.equal(a.title, "a");
  assert.equal(a.description, "", "no note on A -> empty description, never undefined");
  assert.deepEqual(a.dependsOn, [], "A has no incoming edges");
  assert.deepEqual(a.dependents, [{ id: "B", title: "b" }], "A's only direct dependent is B");

  assert.equal(b.description, "b's rationale", "B's note surfaces as its card description");
  assert.deepEqual(b.dependsOn, [{ id: "A", title: "a" }]);
  assert.deepEqual(b.dependents, [{ id: "C", title: "c" }]);

  assert.deepEqual(c.dependsOn, [{ id: "B", title: "b" }]);
  assert.deepEqual(c.dependents, [], "nothing in the plan depends on C");

  assert.deepEqual(d.dependsOn, [], "D is independent");
  assert.deepEqual(d.dependents, [], "nothing depends on D either");
});

test("buildDrainPreview: honors --max/--until exactly like plannedSequence (it IS plannedSequence, resolved to cards)", () => {
  const plan = fixturePlan();
  assert.deepEqual(buildDrainPreview(plan, NONE_MERGED, { max: 2 }).map((c) => c.id), ["A", "B"]);
  assert.deepEqual(buildDrainPreview(plan, NONE_MERGED, { until: "B" }).map((c) => c.id), ["A", "B"]);
  assert.deepEqual(buildDrainPreview(plan, mergedSetOf("A", "B"), { until: "B" }), [], "--until already satisfied -> no cards");
});

// A dedicated 3-node chain (A -> B -> C, no independent siblings) so the curated-
// selection tests below match the acceptance bar's own language exactly: "natural
// order is [A, B, C]".
const CHAIN_ABC = `
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
`;

function chainAbcPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "drain-curated-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, CHAIN_ABC);
  return loadPlan(f);
}

test("curated selection: [B, A] (depth 2) drives runOne to fire for exactly B then A, in that order — the natural order (A, B, C) is overridden entirely", async () => {
  const plan = chainAbcPlan();
  assert.deepEqual(plannedSequence(plan, NONE_MERGED), ["A", "B", "C"], "sanity: the natural order is A, B, C");

  const selection: CuratedSelection = { taskIds: ["B", "A"], depth: 2 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
    },
    opts,
  );
  assert.deepEqual(ran, ["B", "A"], "runOne fired for exactly B then A, in the curated order");
  assert.equal(s.stopReason, "max_reached");
});

test("curated selection: unselected tasks are never dispatched — no runOne call, no ledger line, and the summary's attempted excludes them", async () => {
  const plan = chainAbcPlan();
  const selection: CuratedSelection = { taskIds: ["B", "A"], depth: 2 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    opts,
  );
  assert.ok(!ran.includes("C"), "C was never passed to runOne — the falsifier: pre-fix drain ran the full plannedSequence, ignoring the selection");
  assert.ok(!s.attempted.includes("C"), "the drain summary's attempted excludes the unselected task");
  assert.ok(!lines.some((l) => l.extra.task === "C" || l.extra.id === "C"), "no ledger line names the unselected task");
  assert.deepEqual(s.attempted, ["B", "A"]);
});

test("curated selection: an id already merged or in-flight (open PR) is skipped, never re-dispatched, without derailing the rest of the curated order", async () => {
  const plan = chainAbcPlan();
  const selection: CuratedSelection = { taskIds: ["A", "B", "C"], depth: 3 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const skips: Array<{ id: string; prNumber: number }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => mergedSetOf("A"), // A already landed before this drain started
      isOpenPr: (id) => (id === "B" ? 77 : undefined), // B is in-flight under an open PR
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
      log: (step, extra = {}) => {
        if (step === "dispatch.skipped") skips.push({ id: String(extra.task), prNumber: Number(extra.pr_number) });
      },
    },
    opts,
  );
  assert.deepEqual(ran, ["C"], "A is already merged (skipped) and B is in-flight (skipped) — only C actually dispatches");
  // The loop re-evaluates the curated list fresh every tick (same as the natural
  // path), so a still-open B is re-logged on each subsequent tick until the drain
  // concludes — assert every logged skip names B's open PR, never A or C.
  assert.ok(skips.length >= 1, "B's in-flight skip is legible on the ledger, same shape as the natural path's W1-T80 guard");
  assert.ok(skips.every((s) => s.id === "B" && s.prNumber === 77), "every skip logged names B's open PR #77 — never A or C");
});

test("P29(ii) curated selection: a circuit-broken id is skipped, never re-dispatched, without derailing the rest of the curated order", async () => {
  const plan = chainAbcPlan();
  const selection: CuratedSelection = { taskIds: ["A", "B", "C"], depth: 3 };
  const opts = applyCuratedSelection({}, selection);
  const ran: string[] = [];
  const broken: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      isCircuitTripped: (id) => id === "A",
      onCircuitBreak: (t) => broken.push(t.id),
      runOne: async (id) => {
        ran.push(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" };
      },
    },
    opts,
  );
  assert.ok(!ran.includes("A"), "A (circuit-broken) was never dispatched despite being first in the curated order");
  assert.ok(broken.length >= 1 && broken.every((id) => id === "A"), "onCircuitBreak fired only for A");
  assert.deepEqual(s.attempted.filter((id) => id !== "A"), ran.filter((id) => id !== "A"));
});

test("applyCuratedSelection: truncates to depth and caps max to the same bound, regardless of a larger caller-supplied max", () => {
  const opts = applyCuratedSelection({ max: 10, until: "C" }, { taskIds: ["B", "A", "D"], depth: 2 });
  assert.deepEqual(opts.curated, ["B", "A"]);
  assert.equal(opts.max, 2);
  assert.equal(opts.until, "C", "unrelated opts fields pass through untouched");
});

// ── W1-T141: post-drain rundown ─────────────────────────────────────────────

test("buildRundown: classifies every attempted task from a DrainSummary — merged tasks 'merged', the halting task 'blocked' carrying stopDetail when nothing escalated it", () => {
  const summary: DrainSummary = {
    attempted: ["A", "B", "C"],
    merged: ["A", "B"],
    stopReason: "blocked",
    stopDetail: "C → blocked_review (https://github.com/o/r/pull/9)",
    costUsd: 0.9,
    resumeCommand: "rmd drain",
  };
  assert.deepEqual(buildRundown(summary), [
    { taskId: "A", outcome: "merged" },
    { taskId: "B", outcome: "merged" },
    { taskId: "C", outcome: "blocked", detail: "C → blocked_review (https://github.com/o/r/pull/9)" },
  ]);
});

test("buildRundown: a halting task with an escalation.issue_opened ledger line classifies 'escalated', carrying the issue ref instead of stopDetail", () => {
  const summary: DrainSummary = {
    attempted: ["A", "B"],
    merged: ["A"],
    stopReason: "blocked",
    stopDetail: "B → blocked_review",
    costUsd: 0.5,
    resumeCommand: "rmd drain",
  };
  const ledgerLines = [{ step: "escalation.issue_opened", task_id: "B", issue_url: "https://github.com/o/r/issues/42", class: "BLOCKED" }];
  assert.deepEqual(buildRundown(summary, ledgerLines), [
    { taskId: "A", outcome: "merged" },
    { taskId: "B", outcome: "escalated", escalation: { issueUrl: "https://github.com/o/r/issues/42", class: "BLOCKED" } },
  ]);
});

test("buildRundown: an escalation.issue_opened line naming a DIFFERENT task never mislabels the halting task escalated (falsifier)", () => {
  const summary: DrainSummary = {
    attempted: ["A"],
    merged: [],
    stopReason: "blocked",
    stopDetail: "A → blocked_ci",
    costUsd: 0.1,
    resumeCommand: "rmd drain",
  };
  const ledgerLines = [{ step: "escalation.issue_opened", task_id: "Z", issue_url: "https://x/1", class: "MANUAL" }];
  assert.deepEqual(buildRundown(summary, ledgerLines), [{ taskId: "A", outcome: "blocked", detail: "A → blocked_ci" }]);
});

test("buildRundown: nothing attempted -> an empty rundown", () => {
  const summary: DrainSummary = { attempted: [], merged: [], stopReason: "no_runnable", costUsd: 0, resumeCommand: "rmd drain" };
  assert.deepEqual(buildRundown(summary), []);
});

test("renderRundown: one line per task — merged, blocked (with detail), escalated (with the issue ref)", () => {
  const text = renderRundown([
    { taskId: "A", outcome: "merged" },
    { taskId: "B", outcome: "blocked", detail: "B → blocked_review" },
    { taskId: "C", outcome: "escalated", escalation: { issueUrl: "https://github.com/o/r/issues/7", class: "BLOCKED" } },
  ]);
  assert.match(text, /merged {5}: A/);
  assert.match(text, /blocked {4}: B — B → blocked_review/);
  assert.match(text, /escalated {2}: C — \[BLOCKED\] https:\/\/github\.com\/o\/r\/issues\/7/);
});

test("renderRundown: no tasks attempted renders a clear empty state, not a blank block", () => {
  assert.match(renderRundown([]), /\(no tasks attempted\)/);
});

test("renderSummary + resumeCommand: 'what happened while away' is reconstructable", () => {
  const line = renderSummary({
    attempted: ["A", "B"], merged: ["A"], stopReason: "blocked",
    stopDetail: "B → blocked_review", costUsd: 0.8, resumeCommand: resumeCommand({ until: "C" }),
  });
  assert.match(line, /attempted : A, B/);
  assert.match(line, /merged    : A/);
  assert.match(line, /stopped   : blocked — B → blocked_review/);
  assert.match(line, /resume    : rmd drain --until C/);
});
