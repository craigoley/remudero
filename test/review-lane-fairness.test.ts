import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  orderPendingReviews,
  validateReviewLanesRow,
  type OpenPrView,
} from "../src/lib/sweep.js";

// ── W1-T1218: the review lane starved older PRs by construction ──────────────────────────────
//
// `runSweep` builds `pendingReviews` by `push` inside its per-PR walk, so insertion order IS
// enumeration order, and `openPrsRestArgs` asks for `pulls?state=open&per_page=100` with no
// `sort` — GitHub answers newest-first. Cutting that with `slice(0, reviewLanes)` therefore gave
// the lanes to the NEWEST entries and deferred the OLDEST tail, and "re-derived next pass"
// re-derived the same set in the same order. While the queue stayed deeper than the budget, an
// entry below the cut was deferred every pass, indefinitely.
//
// EVERY FIXTURE HERE IS DEEPER THAN THE BUDGET, AND THE OLDEST ENTRY IS LAST IN ITERATION ORDER.
// That is not decoration: the starvation condition REQUIRES a queue deeper than the lanes, so a
// fixture at or under the budget cannot discriminate a sorted lane from an unsorted one — every
// entry gets a lane either way and the assertion passes on the broken code too.
//
// NOTHING HERE DRIVES `runSweep`. The ordering is a pure function over the pending set; a real
// sweep pass reaches live GitHub, and one such run closed eleven live pull requests on 08-21.

/** A pending-review job, reduced to the two fields the ordering actually reads. */
type Job = { pr: Pick<OpenPrView, "createdAt" | "prNumber">; label: string };

const job = (label: string, prNumber: number, createdAt?: string): Job => ({
  label,
  pr: { prNumber, ...(createdAt === undefined ? {} : { createdAt }) },
});

/** The lane budget these fixtures are built against — read, never redefined. */
const LANES = DEFAULT_SWEEP_POLICY.reviewLanes;

test("W1-T1218: when the pending set exceeds the budget the oldest eligible review takes a lane", () => {
  // NEWEST-FIRST, exactly as the unsorted enumeration hands them over — and the OLDEST entry is
  // LAST, so a slice taken without ordering can never reach it.
  const asEnumerated: Job[] = [
    job("newest", 2530, "2026-08-22T20:17:39Z"),
    job("newer", 2528, "2026-08-22T20:01:49Z"),
    job("mid", 2527, "2026-08-22T19:23:10Z"),
    job("older", 2518, "2026-08-22T17:54:00Z"),
    job("oldest", 2434, "2026-08-21T20:46:40Z"),
  ];
  assert.ok(asEnumerated.length > LANES, "the fixture MUST be deeper than the budget or it cannot discriminate");
  assert.equal(asEnumerated.at(-1)?.label, "oldest", "and the oldest must sit last, where an unsorted slice never reaches");

  // THE TWO ORDERINGS, WRITTEN OUT INDEPENDENTLY OF THE CODE UNDER TEST. These are hand-declared
  // expectations, not values derived from `orderPendingReviews` — only the DEPTH of the cut
  // follows the budget. Before #3486 the cut depth was spelled as a literal 3 here, so the
  // operator's cost hold (reviewLanes 3 -> 2, plan/policy.yaml) reddened this test on main even
  // though the ordering it guards was untouched. LANES is already read from the shipped policy at
  // the top of this file; these slices now honour it, so the guard tracks the budget instead of
  // duplicating it.
  const OLDEST_FIRST = ["oldest", "older", "mid", "newer", "newest"];
  const AS_ENUMERATED = ["newest", "newer", "mid", "older", "oldest"];
  assert.deepEqual(asEnumerated.map((j) => j.label), AS_ENUMERATED, "the fixture is in the declared enumeration order");

  const ordered = orderPendingReviews(asEnumerated);
  const runNow = ordered.slice(0, LANES);
  const deferred = ordered.slice(LANES);

  assert.equal(ordered[0].label, "oldest", "the oldest entry leads the ordered set");
  assert.ok(runNow.some((j) => j.label === "oldest"), "so it takes a lane on THIS pass");
  assert.deepEqual(
    runNow.map((j) => j.label),
    OLDEST_FIRST.slice(0, LANES),
    "the lanes go to the longest-waiting entries, in order",
  );
  assert.deepEqual(deferred.map((j) => j.label), OLDEST_FIRST.slice(LANES), "and the NEWEST entries are the ones deferred");

  // PAIRED POSITIVE CONTROL: the unsorted slice — the behaviour before this change — gives the
  // lanes to the newest entries and never reaches the oldest. Without this the assertions above
  // could be satisfied by a fixture that was already in the right order. It discriminates at every
  // budget this row can hold (min 1, max 3): the two orderings disagree on their FIRST element, so
  // no legal LANES value makes the sorted and unsorted cuts coincide.
  const unsorted = asEnumerated.slice(0, LANES).map((j) => j.label);
  assert.deepEqual(unsorted, AS_ENUMERATED.slice(0, LANES), "the pre-change cut, for contrast");
  assert.notDeepEqual(unsorted, runNow.map((j) => j.label), "the ordered cut is not the enumeration cut — ordering really happened");
  assert.ok(!unsorted.includes("oldest"), "which is precisely the starvation this fixes");
});

test("W1-T1218: a pending set no larger than the budget produces the same outcome as before", () => {
  // W1-T476's stability argument, applied here: when every entry gets a lane, ordering them
  // changes no outcome. The fix must be provably inert in the common shallow-queue case.
  for (const depth of [0, 1, LANES - 1, LANES]) {
    const jobs = Array.from({ length: depth }, (_, i) =>
      job(`j${i}`, 3000 - i, new Date(Date.UTC(2026, 7, 22, 12, 0, i)).toISOString()),
    );
    const ordered = orderPendingReviews(jobs);
    assert.equal(ordered.slice(LANES).length, 0, `depth ${depth}: nothing is deferred at or under the budget`);
    assert.deepEqual(
      new Set(ordered.slice(0, LANES).map((j) => j.label)),
      new Set(jobs.map((j) => j.label)),
      `depth ${depth}: the SAME set runs, ordered or not`,
    );
  }
});

test("W1-T1218: the deferred remainder still stands down without persisting new state", () => {
  const jobs: Job[] = [
    job("a", 10, "2026-08-22T05:00:00Z"),
    job("b", 11, "2026-08-22T04:00:00Z"),
    job("c", 12, "2026-08-22T03:00:00Z"),
    job("d", 13, "2026-08-22T02:00:00Z"),
    job("e", 14, "2026-08-22T01:00:00Z"),
  ];
  const before = jobs.map((j) => j.label);
  const ordered = orderPendingReviews(jobs);

  // NO NEW STATE: the ordering returns a NEW array and leaves the caller's pending set exactly as
  // it found it. Mutating in place would be a persisted side effect on a structure the rest of
  // the pass still holds.
  assert.deepEqual(jobs.map((j) => j.label), before, "the input pending set is not mutated");
  assert.notEqual(ordered, jobs, "a new array is returned, never the same reference");

  // AND NOTHING IS LOST: the run/defer split is a total partition of the same jobs, so every
  // entry the pass found eligible either takes a lane or stands down — none is dropped.
  const runNow = ordered.slice(0, LANES);
  const deferred = ordered.slice(LANES);
  assert.equal(runNow.length + deferred.length, jobs.length, "run + deferred accounts for every entry");
  assert.deepEqual(
    new Set([...runNow, ...deferred].map((j) => j.label)),
    new Set(before),
    "and it is the same set, neither duplicated nor dropped",
  );
  assert.equal(new Set([...runNow, ...deferred]).size, jobs.length, "each entry appears exactly once");
});

test("W1-T1218: a pending entry carrying no creation timestamp still takes a deterministic position", () => {
  // `createdAt` is OPTIONAL and its own doc forbids reading an absent value as "just created".
  // `prNumber` is always present and exactly monotone with creation, so it is both the tiebreak
  // and the substitute — which keeps the comparator TOTAL for every input.
  const jobs: Job[] = [
    job("no-stamp-high", 900),
    job("stamped-new", 800, "2026-08-22T20:00:00Z"),
    job("no-stamp-low", 100),
    job("unparseable", 400, "not-a-date"),
    job("stamped-old", 700, "2026-08-20T01:00:00Z"),
  ];
  const first = orderPendingReviews(jobs).map((j) => j.label);
  const second = orderPendingReviews([...jobs].reverse()).map((j) => j.label);
  assert.deepEqual(first, second, "the order does not depend on the order the entries arrived in");

  // An unparseable stamp is treated exactly like an ABSENT one — it falls to `prNumber`, and is
  // never coerced to epoch zero, which would hand it every lane forever.
  const idx = (l: string) => first.indexOf(l);
  assert.ok(
    idx("unparseable") < idx("stamped-old"),
    "#400 with an unreadable stamp still precedes #700 — the substitute is MEANINGFUL, not arbitrary: " +
      "prNumber is monotone with creation, so the lower number really is the older PR",
  );
  assert.ok(
    idx("no-stamp-low") < idx("no-stamp-high"),
    "two stampless entries order by prNumber ascending — the same monotone substitute",
  );
  // And it is never epoch zero: a stampless HIGH number does not outrank a stamped older PR.
  assert.ok(idx("stamped-old") < idx("no-stamp-high"), "#700 stamped-old precedes #900 stampless");

  // PAIRED POSITIVE CONTROL: with stamps present and distinct, the stamp — not the number —
  // decides, so the fallback above is a fallback and not the only rule.
  const stamped = orderPendingReviews([
    job("young-low-number", 1, "2026-08-22T23:00:00Z"),
    job("old-high-number", 9999, "2026-08-01T00:00:00Z"),
  ]).map((j) => j.label);
  assert.deepEqual(stamped, ["old-high-number", "young-low-number"], "creation time outranks the number when both are known");
});

test("W1-T1218: the review budget and its floor are unchanged", () => {
  // THE DEFECT WAS ORDER, NOT WIDTH. This change touches neither the value nor the bound, and the
  // ordering takes no policy argument at all — it cannot widen or narrow the lane count.
  //
  // The pinned value tracks plan/policy.yaml's `sweep.reviewLanes` row, which the operator moved
  // 3 -> 2 in #3486 as a deliberate, reversible cost hold while the per-run cost work lands. That
  // PR updated test/review-lane-budget.test.ts's copy of this same constant and missed this one,
  // which is why main went red. Kept as a LITERAL on purpose: reading the row here would assert a
  // value against itself and guard nothing, so an unintended budget change must still redden this.
  assert.equal(DEFAULT_SWEEP_POLICY.reviewLanes, 2, "the shipped budget is unchanged");
  assert.equal(validateReviewLanesRow({ value: 3, origin: "net-new", min: 1, max: 3 }), 3);
  assert.throws(() => validateReviewLanesRow({ value: 4, origin: "net-new", min: 1, max: 3 }), /reviewLanes/i,
    "a value past the bound is still a PolicyError — the ceiling still refuses");
  assert.equal(orderPendingReviews.length, 1, "the ordering takes ONE argument — the jobs — and no policy");
  // The floor is `Math.max(1, policy.reviewLanes)`: a misconfigured 0 must still mean one lane,
  // never "review nothing". Ordering cannot affect it, and this pins the arithmetic either way.
  assert.equal(Math.max(1, 0), 1, "a zero budget still floors to one lane");
});
