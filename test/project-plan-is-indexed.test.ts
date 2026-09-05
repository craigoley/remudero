import { strict as assert } from "node:assert";
import { test } from "node:test";
import fc from "fast-check";
import {
  buildLedgerIndex,
  dispatchesEver,
  dispatchesWithoutNewOwnedPr,
  isDispatchBreakerTripped,
  isLifetimeDispatchCapExceeded,
  latestEscalationLine,
  latestManualCompletion,
  projectPlan,
  seedCountFromCircuitBreak,
  type DeriveDeps,
  type GitHub,
  type LedgerIndex,
  type PrRef,
  type StatusProjection,
} from "../src/lib/status.js";
import type { Plan, Task } from "../src/lib/plan.js";

/**
 * R-23 — `projectPlan` INDEXES THE LEDGER ONCE PER PROJECTION.
 *
 * WHAT CHANGED AND WHAT MUST NOT. `projectPlan` already read the ledger once (W1-T187), but
 * `deriveStatus`'s ten per-task helpers each walked that whole array end to end, once per task —
 * O(tasks x rows), MEASURED at 867 ms per projection over the real 1,393-task plan against a
 * 4 MiB ledger, on every daemon/drain tick and every console snapshot recompute. The fix buckets
 * the rows ONCE (`buildLedgerIndex`) and hands each helper only the rows naming its task. That is
 * a pure substitution of the row SET each helper walks; every derived value must be identical.
 *
 * SO THIS FILE ASSERTS TWO DIFFERENT THINGS, AND NEITHER ALONE IS THE TEST:
 *
 *   (a) EQUIVALENCE, by property. The indexed projection must deep-equal the projection the
 *       pre-index whole-ledger scan produces, over generated ledgers built to hit the shapes that
 *       could break the substitution — out-of-order timestamps, duplicate run ids, rows missing
 *       the fields the helpers read, rotated-union duplicates (the SAME row object appearing
 *       twice), escalations for ids the plan does not own, and above all `dispatch.circuit_broken`
 *       rows that name their task in `task` rather than `task_id`, the ONE field divergence that
 *       makes a `task_id`-only bucket silently wrong. The unindexed side is the PRODUCTION
 *       function under `unindexedForEquivalenceTest`, never a second copy of the logic here: a
 *       hand-written oracle would drift away from what ships and stop falsifying anything.
 *
 *   (b) THAT IT ACTUALLY STOPPED RESCANNING. Equivalence alone passes just as well if the index
 *       is built and then ignored — which is exactly the regression this file has to catch. So
 *       the ledger array counts how many times it is iterated end to end, and the indexed
 *       projection must do that a CONSTANT number of times while the unindexed one does it once
 *       per task per helper. Delete the index and (b) reddens; (a) stays green.
 *
 *   (c) WALL CLOCK, PRINTED AND NEVER ASSERTED. A timing assertion in CI is a flake generator on
 *       a shared runner. The numbers are here to be read in the log, not to gate.
 */

/** Pinned so a failure is reproducible and a pass is stable — same discipline as
 *  test/property-parsers.test.ts, whose SEED note states the cost of a fixed seed. */
const SEED = 20260905;
/** Modest on purpose: each run builds a plan AND projects it twice. Wall-clock is reported below. */
const RUNS = 60;
const CFG = { seed: SEED, numRuns: RUNS } as const;

/** A `Task` with only the fields `deriveStatus`/`projectPlan` actually read. */
function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `t ${id}`,
    repo: "o/r",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...over,
  } as Task;
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/**
 * A deterministic, OFFLINE gateway. Every answer is a pure function of the string it is asked
 * about, so the two projections under comparison see byte-identical GitHub facts and any
 * difference between them is the indexing change and nothing else.
 */
function gateway(): GitHub {
  const pr = (url: string, state: string): PrRef => ({
    number: Number(url.match(/(\d+)$/)?.[1] ?? 0),
    url,
    state,
    headRefName: `run-W1-T1-1700000000000`,
    body: "",
  });
  return {
    prByRef: (ref: string | number) =>
      String(ref).includes("9") ? pr(String(ref), "MERGED") : pr(String(ref), "OPEN"),
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    // CLOSED for half the ids, so `resolveEscalation`'s drop-the-row arm and its fail-closed
    // keep-the-row arm are BOTH exercised on both sides of the comparison.
    issueByUrl: (url: string) => ({ state: url.length % 2 === 0 ? "CLOSED" : "OPEN", title: `issue ${url}` }),
  };
}

/** The two halves of the comparison, over the SAME rows and the SAME gateway. */
function bothProjections(p: Plan, rows: Array<Record<string, unknown>>): {
  indexed: Map<string, StatusProjection>;
  unindexed: Map<string, StatusProjection>;
} {
  const base: DeriveDeps = {
    ledgerPath: "/nonexistent/state/ledger.ndjson",
    github: gateway(),
    readLedger: () => rows,
    readCreditStore: () => ({}),
    writeCreditStore: () => {},
    now: () => Date.parse("2026-09-05T00:00:00.000Z"),
  };
  return {
    unindexed: projectPlan(p, { ...base, unindexedForEquivalenceTest: true }),
    indexed: projectPlan(p, base),
  };
}

/** Sorted plain-object form, so the comparison is over CONTENT and never Map insertion order. */
function normalize(m: Map<string, StatusProjection>): Array<[string, StatusProjection]> {
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Ids the generated ledger may name — deliberately WIDER than the plan, so `task_id`s belonging
 *  to no task (the task-less-escalation path) and ids the plan owns both occur. */
const LEDGER_IDS = ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "ghost-A", "ghost-B"] as const;
const PLAN_IDS = ["W1-T1", "W1-T2", "W1-T3"] as const;

/** One ledger row, weighted toward the shapes the ten helpers actually branch on. */
const rowArb = fc.record(
  {
    id: fc.constantFrom(...LEDGER_IDS),
    step: fc.constantFrom(
      "run.start",
      "pr.opened",
      "verdict",
      "verdict.merged",
      "correction.provenance",
      "manual.completed",
      "escalation.issue_opened",
      "dispatch.circuit_broken",
      "recon.done",
      "implement.done",
      "fix.dispatch",
      "fix.resolved",
      "worker.state",
      "daemon.alive",
    ),
    // OUT OF ORDER BY CONSTRUCTION: the stamp is drawn independently of position in the array,
    // so nothing in these ledgers is sorted by time.
    tsMs: fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
    runId: fc.constantFrom("r1", "r1", "r2", "r3"), // duplicated on purpose
    prN: fc.integer({ min: 1, max: 12 }),
    planOnly: fc.boolean(),
    // DROP FIELDS: a row missing `task_id`, `ts`, `pr_url` or `run_id` must be read the same way
    // by both sides — every helper's own `typeof` guard is what makes that true.
    omit: fc.subarray(["task_id", "ts", "pr_url", "run_id"], { maxLength: 2 }),
    // THE FIELD DIVERGENCE: `seedCountFromCircuitBreak` reads `task`, every other helper reads
    // `task_id`. A row carrying only `task` must still reach the seed arm through the index.
    useTaskField: fc.boolean(),
    verdict: fc.constantFrom("merged", "blocked_ci", "blocked_containment", "blocked_isolation"),
    fresh: fc.integer({ min: 0, max: 7 }),
    state: fc.constantFrom("busy", "quiet", "nonsense"),
  },
  { requiredKeys: undefined },
).map((r) => {
  const row: Record<string, unknown> = {
    ts: new Date(r.tsMs).toISOString(),
    step: r.step,
    task_id: r.id,
    run_id: r.runId,
    pr_url: `https://github.com/o/r/pull/${r.prN}`,
    issue_url: `https://github.com/o/r/issues/${r.prN}`,
    actor: "operator",
    verdict: r.verdict,
    freshCount: r.fresh,
    state: r.state,
    class: "budget",
  };
  if (r.step === "pr.opened" && r.planOnly) row.plan_only = true;
  if (r.step === "correction.provenance") {
    row.claimed_pr_url = `https://github.com/o/r/pull/${r.prN}`;
    if (r.planOnly) row.actual_pr_url = `https://github.com/o/r/pull/${r.prN + 100}`;
  }
  if (r.useTaskField) {
    row.task = r.id;
    if (r.step === "dispatch.circuit_broken") delete row.task_id; // the seed-arm-only shape
  }
  for (const k of r.omit) delete row[k];
  return row;
});

/** A whole ledger: rows in generated order, then a rotated-union style duplication pass that
 *  re-appends some of the SAME row objects, which is how the real three-form union reads. */
const ledgerArb = fc
  .array(rowArb, { minLength: 0, maxLength: 90 })
  .chain((rows) =>
    fc.subarray(rows, { maxLength: Math.min(rows.length, 12) }).map((dupes) => [...rows, ...dupes]),
  );

test("R-23 (a) the indexed projection is deep-equal to the pre-index whole-ledger scan", () => {
  const p = plan([
    task(PLAN_IDS[0]),
    task(PLAN_IDS[1], { pr: 9 }),
    task(PLAN_IDS[2], { verify: "human" }),
  ]);
  fc.assert(
    fc.property(ledgerArb, (rows) => {
      const { indexed, unindexed } = bothProjections(p, rows);
      assert.deepEqual(normalize(indexed), normalize(unindexed));
    }),
    CFG,
  );
});

test("R-23 (a2) buildLedgerIndex preserves ledger order and never double-counts a row", () => {
  const shared = { ts: "2026-09-05T00:00:00.000Z", step: "run.start", task_id: "X", task: "X" };
  const rows: Array<Record<string, unknown>> = [
    { ts: "b", step: "pr.opened", task_id: "X" },
    { ts: "a", step: "run.start", task_id: "Y" },
    shared,
    { ts: "c", step: "dispatch.circuit_broken", task: "X", freshCount: 3 },
    { step: 7, task_id: "X" }, // non-string step: bucketed by task, absent from byStep
  ];
  const index: LedgerIndex = buildLedgerIndex(rows);
  assert.equal(index.rows, rows, "the index names the exact array it was built over");
  // Same row object carrying the id in BOTH fields appears ONCE in that id's bucket.
  assert.deepEqual(index.byTask.get("X"), [rows[0], shared, rows[3], rows[4]]);
  assert.deepEqual(index.byTask.get("Y"), [rows[1]]);
  assert.deepEqual(index.byStep.get("run.start"), [rows[1], shared]);
  assert.equal(index.byStep.has("7"), false);
});

test("R-23 (a4) the trailer rung reads the same plan-only-filing and debunk answers from the index", () => {
  // THE RUNGS PROPERTY (a)'s gateway cannot reach: rung (c)'s anchored-trailer credit is the only
  // caller of `isPlanOnlyFilingPr` and of the SECOND `debunkedTrailerUrls` call site, so without a
  // gateway that returns a trailer PR both of those index reads would go unexercised.
  const trailerPr: PrRef = {
    number: 41,
    url: "https://github.com/o/r/pull/41",
    state: "MERGED",
    headRefName: "run-W1-T1-1700000000000",
    body: "Remudero-Task: W1-T1\n",
  };
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => trailerPr,
    headRefName: () => trailerPr.headRefName,
    prBody: () => trailerPr.body,
    issueByUrl: () => null,
  };
  // Three ledgers: the filing row that must REFUSE the credit, a debunking correction, and neither.
  const variants: Array<{ label: string; rows: Array<Record<string, unknown>> }> = [
    { label: "clean", rows: [{ ts: "2026-09-01T00:00:00.000Z", step: "run.start", task_id: "W1-T1" }] },
    {
      label: "plan-only filing",
      rows: [{ ts: "2026-09-01T00:00:00.000Z", step: "pr.opened", task_id: "W1-T9", pr_url: trailerPr.url, plan_only: true }],
    },
    {
      label: "debunked",
      rows: [{ ts: "2026-09-01T00:00:00.000Z", step: "correction.provenance", task_id: "W1-T1", claimed_pr_url: trailerPr.url }],
    },
  ];
  const p = plan([task("W1-T1")]);
  for (const v of variants) {
    const base: DeriveDeps = {
      ledgerPath: "/nonexistent/state/ledger.ndjson",
      github,
      readLedger: () => v.rows,
      readCreditStore: () => ({}),
      writeCreditStore: () => {},
      now: () => Date.parse("2026-09-05T00:00:00.000Z"),
    };
    assert.deepEqual(
      normalize(projectPlan(p, base)),
      normalize(projectPlan(p, { ...base, unindexedForEquivalenceTest: true })),
      `trailer rung diverged for the ${v.label} ledger`,
    );
  }
  // A CONTROL ON THE FIXTURE ITSELF: the three ledgers must not all produce the SAME projection,
  // or the comparison above would hold over a rung that never fired. The filing row must refuse
  // the credit the clean ledger grants.
  const project = (rows: Array<Record<string, unknown>>) =>
    projectPlan(p, {
      ledgerPath: "/nonexistent/state/ledger.ndjson",
      github,
      readLedger: () => rows,
      readCreditStore: () => ({}),
      writeCreditStore: () => {},
    }).get("W1-T1");
  assert.equal(project(variants[0].rows)?.merged, true, "the clean ledger must credit the trailer PR");
  assert.equal(project(variants[1].rows)?.merged, false, "a plan-only filing PR must not credit the task");
  assert.equal(project(variants[2].rows)?.merged, false, "a debunked trailer PR must not credit the task");
});

/**
 * EVERY exported helper the index now feeds, paired with a call that takes the index and one that
 * does not. `seedCountFromCircuitBreak`, `dispatchesEver`, `dispatchesWithoutNewOwnedPr` and the
 * two breaker predicates are NOT on `projectPlan`'s path (`evaluateDispatchBreakerDetailed` is
 * their caller), so property (a) above is structurally blind to them — this is where the same
 * with-index/without-index equivalence is asserted for the helpers directly, including the ONE
 * that reads `task` rather than `task_id`.
 */
const INDEXED_HELPERS: ReadonlyArray<{
  name: string;
  run: (rows: Array<Record<string, unknown>>, id: string, index?: LedgerIndex) => unknown;
}> = [
  { name: "latestManualCompletion", run: (r, id, i) => latestManualCompletion(r, id, i) },
  { name: "seedCountFromCircuitBreak", run: (r, id, i) => seedCountFromCircuitBreak(r, id, i) },
  { name: "dispatchesWithoutNewOwnedPr", run: (r, id, i) => dispatchesWithoutNewOwnedPr(r, id, i) },
  { name: "dispatchesEver", run: (r, id, i) => dispatchesEver(r, id, i) },
  { name: "isDispatchBreakerTripped", run: (r, id, i) => isDispatchBreakerTripped(r, id, 2, i) },
  { name: "isLifetimeDispatchCapExceeded", run: (r, id, i) => isLifetimeDispatchCapExceeded(r, id, 3, i) },
  { name: "latestEscalationLine", run: (r, id, i) => latestEscalationLine(r, id, i) },
];

test("R-23 (a3) every indexed helper answers identically with and without the index", () => {
  fc.assert(
    fc.property(ledgerArb, (rows) => {
      const index = buildLedgerIndex(rows);
      // A DELIBERATELY MISMATCHED index (built over a COPY, so `index.rows !== rows`) must be
      // ignored rather than trusted — the identity guard is what makes a drifted index cost time
      // and never an answer.
      const foreign = buildLedgerIndex([...rows, { step: "run.start", task_id: "W1-T1" }]);
      for (const id of LEDGER_IDS) {
        for (const helper of INDEXED_HELPERS) {
          const bare = helper.run(rows, id);
          assert.deepEqual(helper.run(rows, id, index), bare, `${helper.name} diverged for ${id}`);
          assert.deepEqual(helper.run(rows, id, foreign), bare, `${helper.name} trusted a foreign index for ${id}`);
        }
      }
    }),
    CFG,
  );
});

/**
 * An array that counts how many times it is iterated end to end. `for..of` is what every helper
 * uses, so an acquired iterator IS a whole-ledger scan; the per-task buckets the index hands back
 * are ordinary arrays and are not counted.
 */
function countingRows(rows: Array<Record<string, unknown>>): {
  rows: Array<Record<string, unknown>>;
  fullScans: () => number;
} {
  let scans = 0;
  const out = [...rows];
  const inner = Array.prototype[Symbol.iterator];
  Object.defineProperty(out, Symbol.iterator, {
    value: function (this: Array<Record<string, unknown>>) {
      scans++;
      return inner.call(this);
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return { rows: out, fullScans: () => scans };
}

test("R-23 (b) one projection walks the whole ledger a constant number of times, not once per task", () => {
  const tasks = Array.from({ length: 40 }, (_, i) => task(`W1-T${i + 1}`));
  const p = plan(tasks);
  const raw: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 400; i++) {
    raw.push({
      ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      step: i % 3 === 0 ? "run.start" : i % 3 === 1 ? "pr.opened" : "verdict",
      task_id: `W1-T${(i % 40) + 1}`,
      run_id: `r${i}`,
      pr_url: `https://github.com/o/r/pull/${i}`,
      verdict: "blocked_ci",
    });
  }

  const indexedRows = countingRows(raw);
  const unindexedRows = countingRows(raw);
  const base = (rows: Array<Record<string, unknown>>): DeriveDeps => ({
    ledgerPath: "/nonexistent/state/ledger.ndjson",
    github: gateway(),
    readLedger: () => rows,
    readCreditStore: () => ({}),
    writeCreditStore: () => {},
    now: () => Date.parse("2026-09-05T00:00:00.000Z"),
  });

  const t0 = performance.now();
  projectPlan(p, base(indexedRows.rows));
  const indexedMs = performance.now() - t0;
  const t1 = performance.now();
  projectPlan(p, { ...base(unindexedRows.rows), unindexedForEquivalenceTest: true });
  const unindexedMs = performance.now() - t1;

  const indexed = indexedRows.fullScans();
  const unindexed = unindexedRows.fullScans();
  // (c) SOFT SIGNAL ONLY — printed, never asserted. See this file's header for why.
  console.log(
    `[R-23] 40 tasks x 400 rows — full-ledger scans: indexed=${indexed} unindexed=${unindexed}; ` +
      `wall-clock: indexed=${indexedMs.toFixed(1)}ms unindexed=${unindexedMs.toFixed(1)}ms`,
  );

  // THE FALSIFIER. Bounded by a small constant that does NOT grow with the plan: the index build
  // itself is one pass, and nothing else may walk the whole array. Delete the index and each of
  // the ten per-task helpers walks it once per task, so this count leaves 4 immediately.
  assert.ok(indexed <= 4, `indexed projection scanned the whole ledger ${indexed} times (expected <= 4)`);
  // And the unindexed side proves the counter is not blind: it must be far above the plan size,
  // or a green (b) would mean nothing.
  assert.ok(
    unindexed >= tasks.length,
    `the unindexed control scanned only ${unindexed} times — the scan counter is not observing the helpers`,
  );
});
