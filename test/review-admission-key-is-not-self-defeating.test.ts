import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SWEEP_POLICY,
  oldestActivityFirst,
  reviewAdmissionKey,
  selectReviewAdmission,
  type OpenPrView,
} from "../src/lib/sweep.js";

// ── W1-T2426 — THE ADMISSION KEY IS BUMPED BY THE ADMISSION ─────────────────────────────────
//
// `selectReviewAdmission`'s own doc argues oldest-first cannot starve because "a PR that loses
// this pass is STRICTLY OLDER next pass (nothing un-ages a head)". That premise holds for the
// LOSER and fails for the WINNER: `lastActivityAt` is the PR's `updatedAt`, and posting a verdict
// moves `updatedAt` to now (measured +4s..+90s across seven PRs carrying a `review.posted` row).
// So a PR whose review FAILED is reset to newest and sorts behind PRs that have waited less.
//
// A separate file from test/sweep-review-admission.test.ts on that file's own stated principle:
// an admission-KEY regression must not be confusable with an admission-BOUND regression.

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
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

// ── acceptance 1: the key a posted verdict cannot move ──────────────────────────────────────

test("W1-T2426 (acceptance 1): the admission comparator ranks on createdAt, which a posted verdict cannot move", () => {
  // Same PR, same createdAt, updatedAt bumped as a review post bumps it.
  const before = pr({ createdAt: "2026-08-01T00:00:00Z", lastActivityAt: "2026-08-28T11:00:00Z" });
  const after = { ...before, lastActivityAt: "2026-08-28T11:59:52Z" }; // +8s, a measured post delta
  assert.equal(
    reviewAdmissionKey(before),
    reviewAdmissionKey(after),
    "the admission key must be invariant under the one event the admission itself causes",
  );
  assert.notEqual(before.lastActivityAt, after.lastActivityAt, "the fixture must actually move updatedAt, or this asserts nothing");
});

test("W1-T2426 (acceptance 1, fallback): an absent createdAt falls back to lastActivityAt and can only UNDER-rank", () => {
  // updatedAt >= createdAt for every real PR, so a fallback candidate is scored YOUNGER than its
  // true age — it can be passed over, never allowed to jump the queue.
  const noCreated = pr({ prNumber: 7, createdAt: undefined, lastActivityAt: "2026-08-01T00:00:00Z" });
  assert.equal(reviewAdmissionKey(noCreated), "2026-08-01T00:00:00Z");
  const unparseable = pr({ prNumber: 8, createdAt: "not-a-date", lastActivityAt: "2026-08-02T00:00:00Z" });
  assert.equal(reviewAdmissionKey(unparseable), "2026-08-02T00:00:00Z", "an unparseable createdAt must not be ranked on");
  const empty = pr({ prNumber: 9, createdAt: "", lastActivityAt: "2026-08-03T00:00:00Z" });
  assert.equal(reviewAdmissionKey(empty), "2026-08-03T00:00:00Z");
});

// ── acceptance 2: a just-reviewed PR is not thrown behind younger PRs ───────────────────────

test("W1-T2426 (acceptance 2): a PR whose review just failed is still chosen ahead of PRs that have waited less", () => {
  // OLD is the oldest PR and has just been reviewed, so its updatedAt is NOW-ish.
  const old = pr({ prNumber: 10, createdAt: "2026-08-01T00:00:00Z", lastActivityAt: "2026-08-28T11:59:52Z" });
  const younger = pr({ prNumber: 11, createdAt: "2026-08-20T00:00:00Z", lastActivityAt: "2026-08-27T00:00:00Z" });
  const youngest = pr({ prNumber: 12, createdAt: "2026-08-25T00:00:00Z", lastActivityAt: "2026-08-26T00:00:00Z" });

  const chosen = selectReviewAdmission([younger, old, youngest], DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(chosen?.prNumber, 10, "the oldest PR must win even though reviewing it bumped its updatedAt");

  // FALSIFIER: the pre-fix ranking would have picked the PR with the oldest updatedAt instead.
  const preFix = oldestActivityFirst([younger, old, youngest], NOW);
  assert.equal(preFix?.prNumber, 12, "the activity-keyed ranking really does pick a different, younger PR here");
  assert.notEqual(preFix?.prNumber, chosen?.prNumber, "if these agreed the fixture would prove nothing");
});

// ── acceptance 3: reviewing one PR does not reorder the rest ────────────────────────────────

test("W1-T2426 (acceptance 3): posting a verdict on one PR leaves the relative order of the others unchanged", () => {
  const a = pr({ prNumber: 20, createdAt: "2026-08-01T00:00:00Z", lastActivityAt: "2026-08-27T00:00:00Z" });
  const b = pr({ prNumber: 21, createdAt: "2026-08-05T00:00:00Z", lastActivityAt: "2026-08-26T00:00:00Z" });
  const c = pr({ prNumber: 22, createdAt: "2026-08-10T00:00:00Z", lastActivityAt: "2026-08-25T00:00:00Z" });

  const first = selectReviewAdmission([a, b, c], DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(first?.prNumber, 20);

  // Review `a`: its updatedAt moves to now. Nothing else changes.
  const aReviewed = { ...a, lastActivityAt: "2026-08-28T11:59:55Z" };
  const second = selectReviewAdmission([aReviewed, b, c], DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(second?.prNumber, 20, "a's own age is unchanged by reviewing it, so it still leads");

  // And with `a` merged away, the remaining two keep the order they always had.
  const third = selectReviewAdmission([b, c], DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(third?.prNumber, 21, "b was older than c before and must still be");
});

test("W1-T2426 (acceptance 3, monotonicity): the loser of a pass is never overtaken by the winner it lost to", () => {
  const winner = pr({ prNumber: 30, createdAt: "2026-08-01T00:00:00Z", lastActivityAt: "2026-08-20T00:00:00Z" });
  const loser = pr({ prNumber: 31, createdAt: "2026-08-02T00:00:00Z", lastActivityAt: "2026-08-21T00:00:00Z" });
  assert.equal(selectReviewAdmission([winner, loser], DEFAULT_SWEEP_POLICY, NOW)?.prNumber, 30);
  // The winner is reviewed; it stays first because createdAt did not move — which is the point.
  const reviewed = { ...winner, lastActivityAt: "2026-08-28T11:59:59Z" };
  assert.equal(selectReviewAdmission([reviewed, loser], DEFAULT_SWEEP_POLICY, NOW)?.prNumber, 30);
});

// ── acceptance 4: the bound is untouched, and no second lane exists ─────────────────────────

test("W1-T2426 (acceptance 4): selectReviewAdmission still returns at most ONE PR and no second lane is added", () => {
  const many = [10, 11, 12, 13, 14].map((n) =>
    pr({ prNumber: n, createdAt: `2026-08-0${n - 9}T00:00:00Z`, lastActivityAt: "2026-08-27T00:00:00Z" }),
  );
  const chosen = selectReviewAdmission(many, DEFAULT_SWEEP_POLICY, NOW);
  assert.ok(chosen, "one PR is admitted");
  assert.equal(typeof chosen.prNumber, "number", "the return is a single view, never a list — the bound IS the return type");
  assert.equal(selectReviewAdmission([], DEFAULT_SWEEP_POLICY, NOW), undefined, "an empty queue admits nothing");
  assert.equal(selectReviewAdmission.length, 3, "the signature is unchanged: (openPrs, policy, now)");
});

test("W1-T2426 (acceptance 4): only a post-review-eligible PR is ever a candidate", () => {
  const eligible = pr({ prNumber: 40, createdAt: "2026-08-10T00:00:00Z" });
  // Red checks never derive post-review, so this older PR must not hold the queue.
  const red = pr({ prNumber: 41, createdAt: "2026-08-01T00:00:00Z", checksState: "red" });
  assert.equal(selectReviewAdmission([red, eligible], DEFAULT_SWEEP_POLICY, NOW)?.prNumber, 40);
});

// ── acceptance 5: nothing waits, sleeps or paces ────────────────────────────────────────────

test("W1-T2426 (acceptance 5): the admission path adds nothing that waits, sleeps or paces", () => {
  const src = new URL("../src/lib/sweep.ts", import.meta.url);
  const text = readFileSyncUtf8(src);
  const fn = extractFunction(text, "export function reviewAdmissionKey");
  assert.ok(fn.length > 0, "the function must be found, or this assertion is vacuous");
  for (const banned of ["setTimeout", "await", "sleep", "delay", "Date.now"]) {
    assert.ok(!fn.includes(banned), `reviewAdmissionKey must not contain ${banned}`);
  }
  const ranking = extractFunction(text, "function oldestByKey");
  assert.ok(ranking.length > 0, "the ranking must be found, or this assertion is vacuous");
  for (const banned of ["setTimeout", "await", "sleep", "delay"]) {
    assert.ok(!ranking.includes(banned), `oldestByKey must not contain ${banned}`);
  }
});

// ── acceptance 6: the sibling consumer keeps the contract it was given ──────────────────────

test("W1-T2426 (acceptance 6): oldestActivityFirst still ranks on lastActivityAt, so W1-T528's rung is unchanged", () => {
  // W1-T528's update-branch selection consumes this comparator. For THAT rung an advancing
  // updatedAt is the correct key, so its behaviour must not move.
  const a = { prNumber: 1, lastActivityAt: "2026-08-01T00:00:00Z" };
  const b = { prNumber: 2, lastActivityAt: "2026-08-10T00:00:00Z" };
  assert.equal(oldestActivityFirst([b, a], NOW)?.prNumber, 1, "oldest lastActivityAt still wins");

  // createdAt is IGNORED here even when present — the two rungs rank on different keys by design.
  const withCreated = [
    { prNumber: 3, lastActivityAt: "2026-08-10T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
    { prNumber: 4, lastActivityAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-09T00:00:00Z" },
  ];
  assert.equal(oldestActivityFirst(withCreated, NOW)?.prNumber, 4, "the shared comparator must NOT have adopted createdAt");
});

test("W1-T2426 (acceptance 6): the shared comparator keeps its tie-break and its unreadable-date rule", () => {
  const tie = [
    { prNumber: 9, lastActivityAt: "2026-08-01T00:00:00Z" },
    { prNumber: 2, lastActivityAt: "2026-08-01T00:00:00Z" },
  ];
  assert.equal(oldestActivityFirst(tie, NOW)?.prNumber, 2, "ties break on ascending prNumber");
  const unreadable = [
    { prNumber: 1, lastActivityAt: "not-a-date" },
    { prNumber: 2, lastActivityAt: "2026-08-27T00:00:00Z" },
  ];
  assert.equal(oldestActivityFirst(unreadable, NOW)?.prNumber, 2, "an unreadable date never outranks a readable one");
  assert.equal(oldestActivityFirst([{ prNumber: 5, lastActivityAt: "nope" }], NOW)?.prNumber, 5, "but it can still win when alone");
});

// ── acceptance 7: a stand-down names the mechanism that stood it down ───────────────────────

test("W1-T2426 (acceptance 7): the light pass names the admission bound as the reason a post-review stood down", () => {
  const text = readFileSyncUtf8(new URL("../src/lib/sweep.ts", import.meta.url));
  assert.match(
    text,
    /not admitted this pass: one post-review admission per light pass/,
    "the non-admitted PR's stand-down must name the admission bound, not only the generic light-pass sentence",
  );
  assert.match(text, /standDownReasonFor\?\.\(disposition\) \?\? "deferred to full sweep \(light pass\)"/,
    "the seam must FALL BACK to the generic sentence, so an unwired caller is byte-identical to today");
  assert.match(text, /standDownReasonFor\?: \(d: Disposition\) => string \| undefined;/, "the seam is optional");
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────

function readFileSyncUtf8(url: URL): string {
  return readFileSync(url, "utf8");
}

/** The body of a top-level function, from its declaration to the first column-0 closing brace. */
function extractFunction(text: string, decl: string): string {
  const start = text.indexOf(decl);
  if (start < 0) return "";
  const end = text.indexOf("\n}", start);
  return end < 0 ? "" : text.slice(start, end + 2);
}
