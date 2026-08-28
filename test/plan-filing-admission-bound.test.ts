import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SWEEP_POLICY,
  oldestActivityFirst,
  reviewAdmissionKey,
  selectReviewAdmission,
  selectReviewAdmissions,
  type OpenPrView,
} from "../src/lib/sweep.js";

// ── W1-T2439 — THE REVIEW CAP IS PRICED FOR A JUDGE 98% OF PLAN-ONLY REVIEWS NEVER SPAWN ────
//
// Half one wires `isPlanFiling`'s producer; half two splits the admission on it. The bound
// cannot key on `reviewer_outcome` — that is written AFTER the review runs, and this selector
// receives only views, a policy and a clock (the shard's Q1). `isPlanFiling` is the one signal
// available at admission, which is why the producer had to land first.

const NOW = Date.parse("2026-08-28T12:00:00Z");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-28T11:00:00Z",
    createdAt: "2026-08-01T00:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}
const filing = (n: number, created: string) => pr({ prNumber: n, createdAt: created, isPlanFiling: true });
const build = (n: number, created: string) => pr({ prNumber: n, createdAt: created, isPlanFiling: false });

// ── acceptance 1: the producer populates the signal ─────────────────────────────────────────

test("W1-T2439 (acceptance 1): buildOpenPrViews assigns isPlanFiling from the ledger predicate", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.match(src, /isPlanFiling: isPlanOnlyFilingPr\(ledger, pr\.url\),/,
    "the producer must assign the key with a plain call, never a conditional spread");
  // The census walks TOP-LEVEL KEYS and pushes any spread onto `unresolvableSpreads` — the shape
  // that made #3127 read as unwired. Assert the key is not inside one.
  assert.ok(!/\.\.\.\([^)]*isPlanFiling/.test(src), "isPlanFiling must not be assigned via a spread");
});

test("W1-T2439 (acceptance 1, control): the KNOWN_UNWIRED entry is removed, not left in place", () => {
  const allow = readFileSync(new URL("../src/lib/producer-completeness.ts", import.meta.url), "utf8");
  // Strip comments before asserting: the mechanism this test pins is that `isPlanFiling` is no
  // longer a LIVE key of the KNOWN_UNWIRED object literal (that is what the completeness audit
  // actually reads) -- not that some comment nearby happens to say a sentence. A comment-only
  // match would be satisfiable by prose alone, never by the audit's own code path.
  const withoutComments = allow.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const entry = /^\s{2}isPlanFiling:\s*$/m.test(allow) || /^\s{2}isPlanFiling:\s*"/m.test(allow);
  assert.equal(entry, false, "the field is wired, so its allowlist entry must be gone (this file's own rule)");
  assert.ok(!/\bisPlanFiling\s*:/.test(withoutComments),
    "isPlanFiling must not appear as a live key anywhere in KNOWN_UNWIRED once comments are stripped");
});

// ── acceptance 2: the cheap lane admits more than one ───────────────────────────────────────

test("W1-T2439 (acceptance 2): the non-spawning lane admits more than one plan filing per pass", () => {
  const q = [filing(10, "2026-08-01T00:00:00Z"), filing(11, "2026-08-02T00:00:00Z"), filing(12, "2026-08-03T00:00:00Z")];
  const { planFilings } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(planFilings.length, 3, "three filings, bound 3 — all admitted");
  assert.ok(planFilings.length > 1, "the whole point: MORE than one, which today's cap forbids");
  assert.deepEqual(planFilings.map((p) => p.prNumber), [10, 11, 12], "and oldest-first by the immutable key");
});

test("W1-T2439 (acceptance 2): the cheap lane is BOUNDED — a queue deeper than the bound is truncated", () => {
  const q = [10, 11, 12, 13, 14].map((n, i) => filing(n, `2026-08-0${i + 1}T00:00:00Z`));
  const { planFilings } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(planFilings.length, DEFAULT_SWEEP_POLICY.planFilingAdmissionBound,
    "a lane with no bound would spend the budget faster than the one this unblocks");
  assert.deepEqual(planFilings.map((p) => p.prNumber), [10, 11, 12], "the OLDEST three, never an arbitrary three");
});

// ── acceptance 3: the spawning lane's bound is unchanged ────────────────────────────────────

test("W1-T2439 (acceptance 3): the spawning lane still admits exactly one", () => {
  const q = [build(20, "2026-08-01T00:00:00Z"), build(21, "2026-08-02T00:00:00Z"), build(22, "2026-08-03T00:00:00Z")];
  const { spawning } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(spawning?.prNumber, 20, "the oldest build wins");
  assert.equal(selectReviewAdmission(q, DEFAULT_SWEEP_POLICY, NOW)?.prNumber, 20,
    "and the singular entry point is byte-identical in behaviour to what W1-T526 always ran");
});

test("W1-T2439 (acceptance 3): a build is REFUSED by the spawning bound even while filings are admitted", () => {
  const q = [
    build(20, "2026-08-01T00:00:00Z"),
    build(21, "2026-08-02T00:00:00Z"),
    filing(30, "2026-08-03T00:00:00Z"),
    filing(31, "2026-08-04T00:00:00Z"),
  ];
  const { spawning, planFilings } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(spawning?.prNumber, 20, "one build admitted");
  assert.ok(!planFilings.some((p) => p.prNumber === 21), "the SECOND build is not smuggled into the cheap lane");
  assert.deepEqual(planFilings.map((p) => p.prNumber), [30, 31], "only real filings ride the cheap lane");
});

// ── acceptance 4: a plan-only review that reaches the judge is charged to the spawning side ──

test("W1-T2439 (acceptance 4): the split never RAISES the spawning bound, so a filing that spawns eats capacity that was never expanded", () => {
  const onlyFilings = [filing(30, "2026-08-01T00:00:00Z"), filing(31, "2026-08-02T00:00:00Z")];
  const { spawning } = selectReviewAdmissions(onlyFilings, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(spawning, undefined, "a pass of only filings admits NOBODY to the spawning lane");
  // The guarantee: spawn-capable admissions never exceed the unchanged bound of one, whatever the
  // cheap lane does. Detecting WHICH filing spawns is unbuildable at admission (the shard's Q1),
  // so the design charges it rather than predicting it.
  const mixed = [build(20, "2026-08-01T00:00:00Z"), ...onlyFilings];
  const r = selectReviewAdmissions(mixed, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.spawning ? 1 : 0, 1, "still exactly one spawn-capable admission, never one-per-filing");
});

// ── acceptance 5: an unpopulated signal falls back to today's behaviour ─────────────────────

test("W1-T2439 (acceptance 5): isPlanFiling undefined is treated as SPAWNING — fail-open, unchanged", () => {
  const q = [pr({ prNumber: 40, createdAt: "2026-08-01T00:00:00Z" }), pr({ prNumber: 41, createdAt: "2026-08-02T00:00:00Z" })];
  assert.equal(q[0].isPlanFiling, undefined, "the fixture must actually omit it, or this asserts nothing");
  const { spawning, planFilings } = selectReviewAdmissions(q, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(planFilings.length, 0, "an absent signal never rides the cheap lane");
  assert.equal(spawning?.prNumber, 40, "it competes for the single slot exactly as before");
});

test("W1-T2439 (acceptance 5): isPlanFiling false is also SPAWNING, not merely undefined", () => {
  const { planFilings } = selectReviewAdmissions([build(50, "2026-08-01T00:00:00Z")], DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(planFilings.length, 0, "only an explicit true opts into the cheap lane");
});

// ── acceptance 6: ordering unchanged, still on the immutable key ────────────────────────────

test("W1-T2439 (acceptance 6): both lanes rank on reviewAdmissionKey, which a posted verdict cannot move", () => {
  const old = filing(60, "2026-08-01T00:00:00Z");
  const reviewed = { ...old, lastActivityAt: "2026-08-28T11:59:55Z" }; // a verdict just bumped updatedAt
  const younger = filing(61, "2026-08-20T00:00:00Z");
  const { planFilings } = selectReviewAdmissions([younger, reviewed], DEFAULT_SWEEP_POLICY, NOW);
  assert.deepEqual(planFilings.map((p) => p.prNumber), [60, 61], "createdAt still leads; the review did not reorder it");
  assert.equal(reviewAdmissionKey(reviewed), reviewAdmissionKey(old), "the key is invariant under the bump");
});

test("W1-T2439 (acceptance 6): W1-T528's shared comparator is untouched", () => {
  const a = { prNumber: 1, lastActivityAt: "2026-08-01T00:00:00Z" };
  const b = { prNumber: 2, lastActivityAt: "2026-08-10T00:00:00Z" };
  assert.equal(oldestActivityFirst([b, a], NOW)?.prNumber, 1, "still ranks on lastActivityAt");
});

// ── acceptance 7 & 8: no lane unbounded, no bound raised, nothing paces ─────────────────────

test("W1-T2439 (acceptance 7): no lane is unbounded and no existing bound is raised", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.planFilingAdmissionBound, 3, "the derived number, not a picked one");
  assert.ok(DEFAULT_SWEEP_POLICY.planFilingAdmissionBound > 1, "it must admit more than one to be worth building");
  assert.equal(DEFAULT_SWEEP_POLICY.repeatDispositionBound, 50, "the repeat bound is untouched");
  assert.equal(DEFAULT_SWEEP_POLICY.strikeCap, 2, "the strike cap is untouched");
  // A zero/negative bound must not become "unbounded" through a sign slip.
  const q = [filing(70, "2026-08-01T00:00:00Z"), filing(71, "2026-08-02T00:00:00Z")];
  const zero = selectReviewAdmissions(q, { ...DEFAULT_SWEEP_POLICY, planFilingAdmissionBound: 0 }, NOW);
  assert.equal(zero.planFilings.length, 0, "bound 0 admits none — never all");
  const neg = selectReviewAdmissions(q, { ...DEFAULT_SWEEP_POLICY, planFilingAdmissionBound: -5 }, NOW);
  assert.equal(neg.planFilings.length, 0, "a negative bound clamps to none, never to unbounded");
});

test("W1-T2439 (acceptance 8): nothing added paces, sleeps, or arms auto-merge earlier", () => {
  const src = readFileSync(new URL("../src/lib/sweep.ts", import.meta.url), "utf8");
  const start = src.indexOf("export function selectReviewAdmissions");
  const body = src.slice(start, src.indexOf("\n}", start) + 2);
  assert.ok(body.length > 0, "the function must be found, or this assertion is vacuous");
  for (const banned of ["setTimeout", "await", "sleep", "delay", "arm("]) {
    assert.ok(!body.includes(banned), `selectReviewAdmissions must not contain ${banned}`);
  }
});
