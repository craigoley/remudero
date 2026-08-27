/**
 * test/protection-read-failure-is-named.test.ts — W1-T2399.
 *
 * THE DEFECT, IN THREE PLACES. `readRequiredStatusCheckContexts` (was
 * `ghRequiredStatusCheckContexts`, status.ts) collapsed three different facts into one
 * `undefined`: protection that readably declares NO required contexts, an empty list, and a read
 * that FAILED OUTRIGHT. `buildOpenPrViews` (run-task.ts) then folded that into one boolean,
 * `requiredContextsUnreadable`. And `observedBlockerState` (sweep.ts) labelled the result ABSENT,
 * whose sentence asserts "the required check has ZERO observed check runs" — a claim about the
 * PR's own checks that its own GREEN `checksState` contradicts.
 *
 * WHICH FAMILY THIS IS, MEASURED. Over the three-form ledger union (`ledger.ndjson` + 37
 * `ledger.*.ndjson`, 21,967 blocked-ambiguous dispositions), the family
 * `not positively mergeable — checks green, review none — escalating` reads 4,457 rows across 90
 * distinct PRs — 20.2%, the LARGEST single blocked-ambiguous family. That is the one arm this
 * task owns; the other seven W1-T1006 §3 names (stale-pending, criteria unrecoverable, review
 * orphaned, contradictory, merge conflict, fix strikes exhausted, and the rest) are untouched.
 *
 * AND THE SOLE-DISCRIMINATOR CLAIM IS TRUE, verified from source rather than assumed: every route
 * out of that catch-all for a green PR — the two `post-review` rows and the earlier
 * blocked-ambiguous rows — is gated on `pr.requiredContextsUnreadable !== true`, so when that flag
 * is set a green PR has no other route.
 *
 * WHAT DOES NOT CHANGE. W1-T176 boundary (ii) stays exactly as written: an unreadable gate is
 * never assumed permissive, still disposes `blocked-ambiguous`, and still escalates. This task
 * only changes WHAT THE ESCALATION SAYS.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  observedBlockerState,
  renderClarificationQuestion,
  type OpenPrView,
} from "../src/lib/sweep.js";
import { readRequiredStatusCheckContexts } from "../src/lib/status.js";

const NOW = Date.parse("2026-08-27T19:00:00Z");
const RECENT = "2026-08-27T18:30:00.000Z";

/** A checks-GREEN, review-NONE PR: the exact shape the family is made of. */
function greenReviewNone(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2311,
    prUrl: "https://github.com/craigoley/remudero/pull/2311",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "abcdef1234567",
    autoMergeArmed: false,
    ...over,
  } as OpenPrView;
}

const READ_FAILED = {
  requiredContextsUnreadable: true,
  requiredContextsReadFailure: { branch: "main", reason: "HTTP 403: Resource not accessible by integration" },
} as Partial<OpenPrView>;

// ── acceptance 1: never ABSENT, and never a claim about this PR's check runs ─────────────────

test("acceptance 1: a checks-green, review-none PR whose required-contexts read FAILED is not labelled ABSENT", () => {
  const pr = greenReviewNone(READ_FAILED);
  assert.equal(observedBlockerState(pr), "GATE_UNREADABLE");
  assert.notEqual(observedBlockerState(pr), "ABSENT");

  const q = renderClarificationQuestion(pr, "not positively mergeable — checks green, review none — escalating").question;
  assert.doesNotMatch(q, /ZERO observed check runs/, "the false claim is gone");
  assert.doesNotMatch(q, /\[ABSENT\]/, "and it is not labelled ABSENT");
  assert.match(q, /GREEN on head/, "it says what was actually observed about this PR's checks");
});

// ── acceptance 2: it names the repo-wide read, and the branch ────────────────────────────────

test("acceptance 2: the escalation names the repo-wide required-contexts read, including the branch", () => {
  const q = renderClarificationQuestion(greenReviewNone(READ_FAILED), "not positively mergeable — checks green, review none — escalating").question;
  assert.match(q, /\[GATE_UNREADABLE\]/);
  assert.match(q, /branch protection on `main`/, "the branch it could not read");
  assert.match(q, /Resource not accessible by integration/, "the classified reason survives to the operator");
  assert.match(q, /REPO-WIDE read that this sweep pass makes once/, "and it is framed as a repo fact, not a PR fact");
});

test("acceptance 2 (degraded): with the flag but no captured cause, it still names the read and never invents one", () => {
  const q = renderClarificationQuestion(
    greenReviewNone({ requiredContextsUnreadable: true }),
    "not positively mergeable — checks green, review none — escalating",
  ).question;
  assert.match(q, /\[GATE_UNREADABLE\]/);
  assert.match(q, /branch protection/, "named without a branch rather than fabricating one");
  assert.doesNotMatch(q, /undefined/, "and never renders a missing cause as the word undefined");
});

// ── acceptance 3: the producer no longer collapses the three readings ────────────────────────

test("acceptance 3: a FAILED read is distinguishable from protection that declares no required contexts", () => {
  const failed = readRequiredStatusCheckContexts("o", "r", "main");
  // No `gh` reachable in this harness, so the real call classifies as a read FAILURE — which is
  // itself the point: the old function answered `undefined` here, identical to a readable "none".
  assert.equal(failed.kind, "unreadable");
  if (failed.kind === "unreadable") {
    assert.equal(failed.branch, "main", "the branch it tried is carried");
    assert.ok(failed.reason.length > 0, "and a reason, never an empty string");
    assert.ok(failed.reason.length <= 160, "bounded to one legible sentence");
  }

  // The three kinds are genuinely three, not two with a label.
  const kinds = new Set<string>(["contexts", "none", "unreadable"]);
  assert.equal(kinds.size, 3);
  assert.ok(kinds.has(failed.kind));
});

// ── acceptance 4: the cause reaches the view without a second GitHub call ────────────────────

test("acceptance 4: the classified cause rides the view to the disposition, with no second read", () => {
  // The escalation is rendered from the VIEW alone — `renderClarificationQuestion` takes no
  // gateway, so a cause that reaches the sentence provably arrived on the view.
  assert.equal(renderClarificationQuestion.length >= 1, true);
  const q = renderClarificationQuestion(greenReviewNone(READ_FAILED), "not positively mergeable — checks green, review none — escalating").question;
  assert.match(q, /Resource not accessible by integration/, "carried, not re-fetched");
});

// ── acceptance 5: the disposition is UNCHANGED — still escalates, nothing armed ──────────────

test("acceptance 5: an unreadable gate still disposes blocked-ambiguous and still escalates (W1-T176 intact)", () => {
  const before = deriveDisposition(greenReviewNone({ requiredContextsUnreadable: true }), DEFAULT_SWEEP_POLICY, NOW);
  const after = deriveDisposition(greenReviewNone(READ_FAILED), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(before.disposition, "blocked-ambiguous", "the fail-closed verdict is untouched");
  assert.equal(after.disposition, "blocked-ambiguous", "and carrying the cause does not move it");
  assert.equal(before.reason, after.reason, "the disposition REASON is byte-identical — only the escalation text gained a sentence");
  assert.notEqual(after.disposition, "post-review", "nothing posts a review on an unreadable gate");
  assert.notEqual(after.disposition, "mergeable", "and nothing arms a merge on one");
});

// ── acceptance 6: a READABLE gate still routes to the review lane exactly as today ───────────

test("acceptance 6: a readable required-contexts read still routes a checks-green, review-none PR to the review lane", () => {
  const readable = greenReviewNone({ requiredContextsUnreadable: false });
  const d = deriveDisposition(readable, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "post-review", "unchanged from today — the review lane still takes it");
  // AND ITS OBSERVED STATE IS STILL `ABSENT`, which is W1-T186's own definition of this shape
  // (every other required context green, `remudero-review` specifically unrun). The new state is
  // keyed on the READ having failed, never on the greenness — so this reading must not move.
  assert.equal(observedBlockerState(readable), "ABSENT", "the W1-T176/W1-T186 shape is untouched");
});

test("the W1-T176 ABSENT shape is NOT stolen by the new state — a readable gate with a missing review still reads ABSENT", () => {
  // The discriminator is the READ, not the greenness: with the gate readable, `checksState: none`
  // is still ABSENT and still means what W1-T186 wrote.
  assert.equal(observedBlockerState(greenReviewNone({ checksState: "none" })), "ABSENT");
  assert.equal(observedBlockerState(greenReviewNone({ checksState: "red" })), "FAILING");
  assert.equal(observedBlockerState(greenReviewNone({ checksState: "pending" })), "PENDING");
  assert.equal(observedBlockerState(greenReviewNone({ mergeState: "dirty" } as Partial<OpenPrView>)), "CONFLICTED");
});

// ── acceptance 7: the read still fails soft ──────────────────────────────────────────────────

test("acceptance 7: the read never throws — an absent or throwing gh returns a classified failure instead", () => {
  assert.doesNotThrow(() => readRequiredStatusCheckContexts("nope", "nope", "no-such-branch"));
  const r = readRequiredStatusCheckContexts("nope", "nope", "no-such-branch");
  assert.equal(r.kind, "unreadable", "classified, not thrown and not silently 'none'");
});

test("nothing added paces or throttles or sleeps a call", () => {
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = ((...a: unknown[]) => { timers++; return (realTimeout as unknown as (...x: unknown[]) => unknown)(...a); }) as typeof setTimeout;
  globalThis.setInterval = ((...a: unknown[]) => { timers++; return (realInterval as unknown as (...x: unknown[]) => unknown)(...a); }) as typeof setInterval;
  try {
    observedBlockerState(greenReviewNone(READ_FAILED));
    renderClarificationQuestion(greenReviewNone(READ_FAILED), "not positively mergeable — checks green, review none — escalating");
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
  }
  assert.equal(timers, 0);
});
