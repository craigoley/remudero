import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import {
  nextRunnable,
  runnableCandidates,
  runDrain,
  type DrainDeps,
  type MergedSet,
  type OpenPrCheck,
} from "../src/lib/drain.js";
import { partitionByFileOverlap } from "../src/lib/dispatch-overlap.js";
import type { RunResult } from "../src/run-task.js";

// ── W1-T1035 (STOOD-DOWN-MERGED-TASK-STILL-ADMITTED) ────────────────────────────────────────
//
// `isDispatchEligible`'s in-flight guard (drain.ts) used to fire `onStoodDown` on ANY fresh
// MERGED/CLOSED read and then fall through unconditionally to `return true` — admitting the
// task as a dispatch candidate even when the fresh read's own merge already finishes it. THE
// SAME GUARD MUST STILL ADMIT the W1-T177 case (a merge that does NOT credit the task that
// opened the PR) — this suite proves BOTH directions so a chain that has simply reverted
// W1-T177 (refusing every stand-down) fails it just as hard as the un-fixed fall-through does
// (design (vi)).
//
// NONE_MERGED never changes its answer no matter when it is consulted — the credit projection
// genuinely never resolves this task, exactly like the historical W1-T177 fixture (PR #388
// merged without crediting the task that opened it).
const NONE_MERGED: MergedSet = () => false;

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

function planFrom(yaml: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), "drain-stale-credit-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, yaml);
  return loadPlan(f);
}

// A -> nothing, D independent — same shape as drain.test.ts's W1-T177 fixture, so a reader can
// compare the two suites' fixtures directly.
function twoTaskPlan(): Plan {
  return planFrom(
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n" +
      "- id: D\n  title: d\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n",
  );
}

// ── claim 1: a stand-down whose fresh read says MERGED no longer admits the task when that
// merge credits it (the stale-credit case, 24 of 32 measured incidents) ────────────────────────

test("W1-T1035: a fresh MERGED read that ALSO credits the task (isLiveMergeCredited) excludes it — onStoodDown AND onStaleCreditExcluded both fire, and the next candidate is offered instead", () => {
  const plan = twoTaskPlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 975 : undefined);
  const stoodDown: Array<{ id: string; prNumber: number; state: string }> = [];
  const excluded: Array<{ id: string; prNumber: number; state: string }> = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: () => assert.fail("no skip expected — the live read is MERGED, not OPEN"),
    readLiveState: (id, prNumber) => (id === "A" && prNumber === 975 ? "MERGED" : "OPEN"),
    onStoodDown: (t, prNumber, state) => stoodDown.push({ id: t.id, prNumber, state }),
    isLiveMergeCredited: (id, prNumber) => id === "A" && prNumber === 975,
    onStaleCreditExcluded: (t, prNumber, state) => excluded.push({ id: t.id, prNumber, state }),
  });
  assert.deepEqual(stoodDown, [{ id: "A", prNumber: 975, state: "MERGED" }], "the PR-level observation still fires — this is the same ledger row the un-fixed chain already produced");
  assert.deepEqual(excluded, [{ id: "A", prNumber: 975, state: "MERGED" }], "the exclusion is ALSO observed, distinctly from the plain stand-down");
  assert.equal(next?.id, "D", "A is excluded — its own merge already finishes it — D is offered instead");
});

test("W1-T1035 runDrain integration: a stale-credit stand-down never dispatches and never ledgers dispatch.refused_already_merged's cause — dispatch.stale_credit_excluded fires instead, and the drain proceeds to the next runnable task", async () => {
  const plan = twoTaskPlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const deps: DrainDeps = {
    refreshMerged: () => (id) => merged.has(id),
    isOpenPr: (id) => (id === "A" ? 975 : undefined),
    readLiveState: (id, prNumber) => (id === "A" && prNumber === 975 ? "MERGED" : "OPEN"),
    isLiveMergeCredited: (id, prNumber) => id === "A" && prNumber === 975,
    runOne: async (id) => {
      ran.push(id);
      merged.add(id);
      return okResult(id);
    },
    log: (step, extra = {}) => lines.push({ step, extra }),
  };
  const s = await runDrain(plan, deps, { max: 1 });
  assert.deepEqual(ran, ["D"], "A is never dispatched — the live read's own merge already finishes it — only D runs");
  assert.equal(s.stopReason, "max_reached");
  const excludedLine = lines.find((l) => l.step === "dispatch.stale_credit_excluded");
  assert.ok(excludedLine, "the exclusion is ledgered under its own step");
  assert.equal(excludedLine?.extra.task, "A");
  assert.equal(excludedLine?.extra.pr_number, 975);
  assert.equal(excludedLine?.extra.state, "MERGED");
  const stoodDownLine = lines.find((l) => l.step === "dispatch.stood_down");
  assert.ok(stoodDownLine, "the plain PR-level observation still fires too");
});

// ── claim 2 (design (vi)'s second direction): the W1-T177 case — genuinely uncredited — MUST
// stay admitted, proven again HERE (not only in test/drain.test.ts), so a chain that reverted
// W1-T177 wholesale (refusing every stand-down) fails this suite too ─────────────────────────

test("W1-T1035 (W1-T177 must survive): a fresh MERGED read that does NOT credit the task (isLiveMergeCredited false) stays admitted — onStaleCreditExcluded never fires", () => {
  const plan = twoTaskPlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 388 : undefined);
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: () => assert.fail("no skip expected"),
    readLiveState: (id, prNumber) => (id === "A" && prNumber === 388 ? "MERGED" : "OPEN"),
    onStoodDown: () => {},
    // The merge does NOT credit A — the genuine W1-T177 shape (a PR that merged without
    // crediting the task that opened it).
    isLiveMergeCredited: () => false,
    onStaleCreditExcluded: () => assert.fail("onStaleCreditExcluded must not fire — this merge does not credit A"),
  });
  assert.equal(next?.id, "A", "A stays admitted — it genuinely still needs a run");
});

test("W1-T1035 (W1-T177 must survive): isLiveMergeCredited OMITTED ⇒ behaves EXACTLY as before this discrimination existed — the unconditional fall-through", () => {
  const plan = twoTaskPlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 388 : undefined);
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: () => assert.fail("no skip expected"),
    readLiveState: (id, prNumber) => (id === "A" && prNumber === 388 ? "MERGED" : "OPEN"),
    onStoodDown: () => {},
    // isLiveMergeCredited deliberately omitted.
  });
  assert.equal(next?.id, "A", "omitted ⇒ unchanged pre-W1-T1035 behaviour — A stays admitted");
});

test("W1-T1035: isLiveMergeCredited is never consulted on a CLOSED read — an abandoned PR credits nothing and always stays admitted", () => {
  const plan = twoTaskPlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "A" ? 200 : undefined);
  const next = nextRunnable(plan, NONE_MERGED, {
    isOpenPr,
    onSkip: () => assert.fail("no skip expected"),
    readLiveState: (id, prNumber) => (id === "A" && prNumber === 200 ? "CLOSED" : "OPEN"),
    onStoodDown: () => {},
    isLiveMergeCredited: () => assert.fail("isLiveMergeCredited must not be consulted on a CLOSED read"),
  });
  assert.equal(next?.id, "A", "CLOSED never blocks and never routes through the credit discrimination");
});

// ── claim 3 (design (iv)): no task is serialized behind a candidate whose own stand-down fired
// in the same pass — proven at both the runnableCandidates/partitionByFileOverlap layer and via
// the exact compound shape rationale (4)/(5) measured: a "ghost" (G, analogous to W1-T975)
// stood down MERGED+credited in the SAME pass two OTHER file-overlapping candidates (analogous
// to W1-T983/W1-T1011) were about to be offered against ─────────────────────────────────────

function ghostAndOverlapPlan(): Plan {
  // G: the stale-credit ghost, declaring the same file P and Q both declare — before this fix,
  // G would have been admitted first (dispatchOrder: G < P < Q) and named as `blocked_by` for
  // whichever of P/Q it collided with first.
  return planFrom(
    "- id: G\n  title: ghost\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/run-task.ts]\n" +
      "- id: P\n  title: p\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/run-task.ts]\n" +
      "- id: Q\n  title: q\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/run-task.ts]\n",
  );
}

test("W1-T1035: runnableCandidates excludes the stale-credit ghost entirely — it can never reach partitionByFileOverlap, so it can never be named as another candidate's blocked_by in the same pass", () => {
  const plan = ghostAndOverlapPlan();
  const isOpenPr: OpenPrCheck = (id) => (id === "G" ? 975 : undefined);
  const candidates = runnableCandidates(plan, NONE_MERGED, 10, {
    isOpenPr,
    onSkip: () => assert.fail("no skip expected"),
    readLiveState: (id, prNumber) => (id === "G" && prNumber === 975 ? "MERGED" : "OPEN"),
    onStoodDown: () => {},
    isLiveMergeCredited: (id, prNumber) => id === "G" && prNumber === 975,
  });
  const ids = candidates.map((t) => t.id);
  assert.ok(!ids.includes("G"), "the ghost is excluded from the eligible pool outright");
  assert.deepEqual(ids.sort(), ["P", "Q"], "P and Q remain — both genuinely runnable, both overlapping only each other");

  // THE HONEST CLAIM (design (v)): removing the ghost admits ONE of P/Q, not both — they overlap
  // EACH OTHER, not only the ghost. `blocked_by` must name the surviving sibling, NEVER the ghost.
  const partition = partitionByFileOverlap(candidates);
  assert.equal(partition.dispatch.length, 1, "P and Q overlap each other — only one dispatches this pass");
  assert.equal(partition.serialized.length, 1, "the other is deferred to a later pass");
  assert.notEqual(partition.serialized[0]!.blockedBy, "G", "the ghost — stood down THIS pass — must never be named as a blocker");
  assert.ok(["P", "Q"].includes(partition.serialized[0]!.blockedBy), "the real blocker is the surviving sibling, not the excluded ghost");
});

test("W1-T1035 runDrainLanes integration: the 15:15 pass shape — a stale-credit ghost stood down mid-pass dispatches real work instead of nothing, and dispatch.serialized never blames the ghost", async () => {
  const plan = ghostAndOverlapPlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const deps: DrainDeps = {
    refreshMerged: () => (id) => merged.has(id),
    isOpenPr: (id) => (id === "G" ? 975 : undefined),
    readLiveState: (id, prNumber) => (id === "G" && prNumber === 975 ? "MERGED" : "OPEN"),
    isLiveMergeCredited: (id, prNumber) => id === "G" && prNumber === 975,
    runOne: async (id) => {
      ran.push(id);
      merged.add(id);
      return okResult(id);
    },
    log: (step, extra = {}) => lines.push({ step, extra }),
  };
  const s = await runDrain(plan, deps, { max: 1, laneCount: 2 });

  // Net dispatches: exactly one real task, never zero (rationale (4)'s "net dispatches from a
  // pass with a full disjoint set available: zero" is exactly what this fix removes) and never
  // the ghost itself.
  assert.equal(ran.length, 1, "exactly one of P/Q dispatches — not zero, and not both (they overlap each other)");
  assert.ok(["P", "Q"].includes(ran[0]!), "the dispatched task is a real candidate, never the ghost");
  assert.deepEqual(s.merged, ran);

  const serializedLines = lines.filter((l) => l.step === "dispatch.serialized");
  for (const l of serializedLines) {
    assert.notEqual(l.extra.blocked_by, "G", "no dispatch.serialized row may blame the ghost stood down this same pass");
  }
  const excludedLine = lines.find((l) => l.step === "dispatch.stale_credit_excluded");
  assert.ok(excludedLine, "the ghost's exclusion is ledgered");
  assert.equal(excludedLine?.extra.task, "G");
});
