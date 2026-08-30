/**
 * test/a-retired-task-is-not-a-recoverable-blocker.test.ts — W1-T2474.
 *
 * THE DEFECT: `isDispatchEligible` (drain.ts) refuses every `status: "blocked"` task under one
 * `DispatchFilterReason`, `"blocked"` — a retirement RECORD (W1-T314's design block: "NOT TO BE
 * BUILT AS ONE TASK... a RECORD of the decomposition decision, not a work item") and a merely
 * dependency-stalled task both land in the same bucket. `StarvationCensus` (daemon.ts) then
 * classes that whole bucket RECOVERABLE — a class a human is expected to resolve — even though
 * a retirement ruling never clears no matter how long anyone waits. The field that already tells
 * the two populations apart, `Task.retirement` (plan.ts, W1-T1287), appeared zero times in
 * drain.ts or daemon.ts before this task.
 *
 * THE FIX: split the bucket AT THE FILTER (drain.ts mints a new `"retired"` DispatchFilterReason
 * for a blocked task carrying a `retirement` ruling, leaving plain `"blocked"` unchanged) and
 * exclude the new `"retired"` bucket from the census's RECOVERABLE set (daemon.ts), while still
 * naming it on the census so the count stays legible rather than silently vanishing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPlanFromYaml, type Plan, type Task } from "../src/lib/plan.js";
import { nextRunnable, runnableCandidates, tallyDispatchFilters } from "../src/lib/drain.js";
import { runDaemon, type StarvationCensus } from "../src/lib/daemon.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  } as never;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as never;
}

const NONE_MERGED = () => false;

// ── claims 1, 2, 6: the filter split and the tally's new bucket ────────────────────────────────

test("claim 1: a blocked task carrying a retirement ruling is filtered under its own named reason", () => {
  const retired = task("W1-T1000", { status: "blocked", retirement: "retired" } as Partial<Task>);
  const tally = tallyDispatchFilters();
  nextRunnable(planOf([retired]), NONE_MERGED, { onFiltered: tally.onFiltered });
  const snapshot = tally.snapshot();
  assert.deepEqual(snapshot.retired.ids, ["W1-T1000"], "the retired task files under 'retired', not under 'blocked'");
  assert.equal(snapshot.blocked.count, 0, "and NOT counted under 'blocked' too — first-match, not both");
});

test("claim 2: a blocked task with no retirement ruling still files under the unchanged 'blocked' reason", () => {
  const plainBlocked = task("W1-T1001", { status: "blocked" });
  const tally = tallyDispatchFilters();
  nextRunnable(planOf([plainBlocked]), NONE_MERGED, { onFiltered: tally.onFiltered });
  const snapshot = tally.snapshot();
  assert.deepEqual(snapshot.blocked.ids, ["W1-T1001"], "a plain blocked task keeps filing under 'blocked'");
  assert.equal(snapshot.retired.count, 0, "and never under 'retired' — retirement is the only discriminator");
});

test("claim 6: the idle-reason tally carries the retired bucket separately, distinct from blocked, unmet-deps, etc.", () => {
  const retired = task("R1", { status: "blocked", retirement: "closed" } as Partial<Task>);
  const plainBlocked = task("B1", { status: "blocked" });
  const runnableTask = task("Q1");
  const tally = tallyDispatchFilters();
  for (const t of [retired, plainBlocked, runnableTask]) {
    nextRunnable(planOf([t]), NONE_MERGED, { onFiltered: tally.onFiltered });
  }
  const snapshot = tally.snapshot();
  assert.deepEqual(snapshot.retired.ids, ["R1"]);
  assert.deepEqual(snapshot.blocked.ids, ["B1"]);
  assert.equal(snapshot.retired.count, 1);
  assert.equal(snapshot.blocked.count, 1);
  // The union has a named member for 'retired' distinct from every other bucket — this line
  // itself is the type-enforced guarantee the task's rationale describes: `IdleReasonTally` is
  // `Record<DispatchFilterReason, IdleReasonBucket>`, so `snapshot.retired` would not even
  // type-check if the member did not exist.
  assert.ok("retired" in snapshot, "the tally names a 'retired' bucket");
});

// ── claim 7: no dispatch decision changes for any task whose status is not blocked ─────────────

test("claim 7: no dispatch decision changes for any task whose status is not blocked, retirement or not", () => {
  // `retirement` is documented as OPERATOR-ONLY and inert off a blocked task (plan.ts's own
  // doc: "a task with and without `retirement` filters identically" at every enforcement
  // point) — a queued task carrying a stray `retirement` value must still be picked exactly
  // like one without it.
  const queuedWithRetirement = task("Q-RET", { retirement: "withdrawn" } as Partial<Task>);
  const queuedPlain = task("Q-PLAIN");

  const tally = tallyDispatchFilters();
  const pickedWith = nextRunnable(planOf([queuedWithRetirement]), NONE_MERGED, { onFiltered: tally.onFiltered });
  const pickedPlain = nextRunnable(planOf([queuedPlain]), NONE_MERGED, { onFiltered: tally.onFiltered });

  assert.equal(pickedWith?.id, "Q-RET", "a non-blocked task carrying retirement is still dispatched");
  assert.equal(pickedPlain?.id, "Q-PLAIN", "and identically for one without it");
  const snapshot = tally.snapshot();
  assert.equal(snapshot.retired.count, 0, "neither task was ever filtered, so 'retired' stays empty");
  assert.equal(snapshot.blocked.count, 0, "nor 'blocked' — only status: blocked ever reaches this branch");

  // Also exercised through the concurrent-candidate path (runnableCandidates), which must
  // apply the EXACT SAME chain as nextRunnable.
  const candidates = runnableCandidates(planOf([queuedWithRetirement, queuedPlain]), NONE_MERGED, 10);
  assert.deepEqual(
    candidates.map((t) => t.id).sort(),
    ["Q-PLAIN", "Q-RET"],
    "both non-blocked tasks remain candidates regardless of the retirement field",
  );
});

// ── claims 3, 4, 5, 8: the starvation census excludes retired from the recoverable set ─────────

/** A fake clock that counts polls and, after `stopAfter` of them, requests a fleet STOP —
 *  mirrors test/queue-starvation.test.ts's own idiom for driving the persistent daemon loop
 *  through several idle ticks before ending the test. */
function pollingClock(root: string, stopAfter: number): { sleep: (ms: number) => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    sleep: async () => {
      calls++;
      if (calls >= stopAfter) requestStop(root, "test done polling");
    },
    calls: () => calls,
  };
}

// Every blocker in this plan carries a retirement ruling — a deliberate record, not stalled work.
const RETIRED_ONLY_YAML = `
- id: R1
  title: a retired record, never to be built
  repo: remudero
  type: implement
  depends_on: []
  status: blocked
  retirement: retired
- id: R2
  title: a second retired record
  repo: remudero
  type: implement
  depends_on: []
  status: blocked
  retirement: closed
- id: HU
  title: needs a human, never becomes machine-dispatchable
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

// The retired-only plan PLUS one genuinely dependency-stalled blocked task.
const RETIRED_PLUS_ONE_RECOVERABLE_YAML = `
${RETIRED_ONLY_YAML}
- id: STUCK
  title: a plain blocked task, no retirement ruling, waiting on a human to resolve it
  repo: remudero
  type: implement
  depends_on: []
  status: blocked
`;

test("claim 4: a queue whose only remaining blockers are retired reports no recoverable blocker (never escalates)", async () => {
  const plan = loadPlanFromYaml(RETIRED_ONLY_YAML, "retired-only");
  const root = mkdtempSync(join(tmpdir(), "retired-only-root-"));
  const clock = pollingClock(root, 6);
  const censuses: StarvationCensus[] = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    onStarvation: (census) => {
      censuses.push(census);
    },
    runOne: async (id) => {
      throw new Error(`FALSIFIER: ${id} was dispatched — nothing in this plan should ever be eligible`);
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(clock.calls() >= 6, "the loop really idle-polled many times before the test stopped it");
  assert.equal(
    censuses.length,
    0,
    "a retired-only blocked queue is DONE-BY-RULING, not starved — waiting never helps it, so nothing escalates",
  );
});

test("claim 5 + 3: the same queue plus one non-retired blocked task still reports a recoverable blocker, naming retired separately", async () => {
  const plan = loadPlanFromYaml(RETIRED_PLUS_ONE_RECOVERABLE_YAML, "retired-plus-one");
  const root = mkdtempSync(join(tmpdir(), "retired-plus-one-root-"));
  const clock = pollingClock(root, 6);
  const censuses: StarvationCensus[] = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    onStarvation: (census) => {
      censuses.push(census);
    },
    runOne: async (id) => {
      throw new Error(`FALSIFIER: ${id} was dispatched — nothing in this plan should ever be eligible`);
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.equal(censuses.length, 1, "the one genuinely stalled task escalates starvation exactly once");
  // claim 3: the retired class is EXCLUDED from the recoverable set the escalation is keyed
  // on, even though it is still present and named on the census.
  assert.equal(censuses[0].blocked.count, 1, "the plain blocked task ('STUCK') is the recoverable blocker");
  assert.deepEqual(censuses[0].blocked.ids, ["STUCK"]);
  assert.equal(censuses[0].retired.count, 2, "both retirement records are STILL named on the census...");
  assert.deepEqual(censuses[0].retired.ids.sort(), ["R1", "R2"], "...by id, for legibility");
});

test("claim 8 (falsifier): the exclusion is load-bearing — a census that folded retired back into blocked would wrongly read as starved", () => {
  // This does not mutate src/ (that would defeat the point); it demonstrates, on the SAME
  // shaped data claim 4's plan produces, that treating retired as part of the recoverable
  // set (the pre-fix behaviour: retired counted under 'blocked') flips the starvation verdict
  // from false to true — i.e. that dropping the exclusion is exactly the regression this task
  // exists to prevent, and claim 4's daemon-level test is the guard that would catch it.
  const retiredOnlyCensus: StarvationCensus = {
    circuitBroken: { count: 0, ids: [], truncated: 0 },
    blocked: { count: 0, ids: [], truncated: 0 },
    unmetDeps: { count: 0, ids: [], truncated: 0 },
    retired: { count: 2, ids: ["R1", "R2"], truncated: 0 },
  };
  const starvedToday =
    retiredOnlyCensus.circuitBroken.count > 0 || retiredOnlyCensus.blocked.count > 0 || retiredOnlyCensus.unmetDeps.count > 0;
  assert.equal(starvedToday, false, "today's predicate (retired excluded) reports NOT starved");

  // The pre-fix shape: retired folded into blocked instead of split out.
  const preFixBlockedCount = retiredOnlyCensus.blocked.count + retiredOnlyCensus.retired.count;
  const starvedPreFix = retiredOnlyCensus.circuitBroken.count > 0 || preFixBlockedCount > 0 || retiredOnlyCensus.unmetDeps.count > 0;
  assert.equal(starvedPreFix, true, "FALSIFIER: folding retired back into blocked reports starved — the bug this task fixes");
});
