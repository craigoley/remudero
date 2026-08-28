import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

// ── W1-T2427 ──────────────────────────────────────────────────────────────────────────────────
//
// THE DEFECT: `runSweep`'s `alreadyDone` switch has eight arms. Three set `dedupStandDownReason`
// beside the flag — `mergeable` (W1-T1116, four disjuncts), `blocked-fixable`/`conflicted`
// (W1-T1110) and `wait` (W1-T1116 design iv). FOUR assigned the flag and fell straight to
// `break`: `stale`, `blocked-ambiguous`, `dep-review` and `post-review`. `finalizeDisposition`
// spreads `...(standDownReason ? { stand_down_reason: standDownReason } : {})`, so an undefined
// value writes NO KEY AT ALL and a deduped stand-down is byte-indistinguishable from an unwired
// action path.
//
// THE LIVE POPULATION, measured over a controlled three-form ledger union: 10,676 rows, NOT the
// 32,290 a naive count gives. `wait` (20,596), `mergeable` (778) and `stale` (222) stopped firing
// silently in August as W1-T1116's fix landed. Still silent on 2026-08-27: `blocked-ambiguous`
// 7,888, `blocked-fixable` 2,497, `post-review` 291.
//
// AND `stale` IS FIXED HERE ANYWAY, despite being quiet since 2026-08-17: a population that
// stopped firing is not a fixed arm. Its code was unchanged, so it goes silent again the next
// time a closed PR is deduped.
//
// THE COST ALREADY BANKED: W1-T2426 could not attribute PR #3152's nine consecutive post-review
// stand-downs to `selectReviewAdmission`, because all nine carry no reason. The mechanism was
// confirmed independently; the instance could not be.
//
// SCOPE: this changes NO disposition and NO `acted` value — see the byte-identity test at the
// foot of this file. The admission ORDER is W1-T2426's and the repeated COMMENT is W1-T2419's;
// this only makes their fixes provable.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-28T12:00:00Z");
const RECENT = "2026-08-28T11:00:00Z";
const ANCIENT = "2026-01-01T00:00:00Z";
// A pending check FRESH enough not to trip `pendingCeilingMinutes` — otherwise the
// blocked-ambiguous stuck-pending arm claims it before `wait` ever sees it.
const FRESH = "2026-08-28T11:57:00Z";
/** One unmet criterion in the shape `OpenPrView.unmetCriteria` actually declares. */
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];
const HEAD = "d00dfeed";
const PR_NUMBER = 900;
const TASK = "W1-T900";

function fakeDeps(lines: Array<Record<string, unknown>>, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-t2427-")), "ledger.ndjson"),
    runId: "SWEEP-W1-T2427",
    now: () => NOW,
    readLedger: () => lines,
    ...overrides,
  };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`,
    taskId: TASK,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

/** One `sweep.disposed` row per PR is the standing invariant — assert it, then hand it back. */
async function disposeOne(view: OpenPrView, lines: Array<Record<string, unknown>>, overrides: Partial<SweepDeps> = {}) {
  const deps = fakeDeps(lines, overrides);
  const summary = await runSweep([view], deps);
  const rows = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(rows.length, 1, "the one-row-per-PR invariant still holds");
  return { row: rows[0], summary, all: readLedgerLines(deps.ledgerPath) };
}

/** A prior `acted:true` disposal — what `priorActionsFromLedger` folds into its `prior.*` sets. */
function priorDisposal(disposition: string, extra: Record<string, unknown> = {}) {
  return { step: "sweep.disposed", acted: true, pr_number: PR_NUMBER, head_sha: HEAD, disposition, ...extra };
}

// ── Acceptance 1: post-review ─────────────────────────────────────────────────────────────────
//
// W1-T1110's CRITERION is the bar, not "did it decline": could a reader otherwise tell this from
// a broken action path? A silent post-review row reads identically whether THIS dedup fired,
// `deps.postReview` was never wired, the light-pass admission was lost to another PR, or the
// pass was a dry run. The sentence must separate them, and it must say WHICH set matched.

test("a dedup that suppresses a post-review dispatch names itself on the row it already writes", async () => {
  const delivered = { step: "review.posted", task_id: TASK, head_sha: HEAD };
  const { row } = await disposeOne(pr(), [delivered], { postReview: async () => {} });

  assert.equal(row.disposition, "post-review");
  assert.equal(row.acted, false, "the dedup still suppresses exactly as it did before");
  assert.match(
    String(row.stand_down_reason),
    /already DELIVERED/,
    "the row must say a verdict was already delivered, not merely that nothing happened",
  );
  assert.match(String(row.stand_down_reason), /W1-T900@d00dfeed/, "and it must name the dedup KEY");
  assert.match(
    String(row.stand_down_reason),
    /not lost to an admission and not unwired/,
    "W1-T1110's criterion: the sentence separates this from the paths it used to be confused with",
  );
});

test("a REFUSED prior post is named as refused, never conflated with a delivered verdict", async () => {
  const refused = { step: "review.post_refused", task_id: TASK, head_sha: HEAD, reason: "no acceptance criteria" };
  const { row } = await disposeOne(pr(), [refused], { postReview: async () => {} });

  assert.equal(row.acted, false);
  assert.match(String(row.stand_down_reason), /already REFUSED/);
  assert.doesNotMatch(String(row.stand_down_reason), /DELIVERED/, "the two outcomes must stay distinguishable");
});

// ── Acceptance 2: blocked-ambiguous — the LARGEST live silent population (7,888 rows) ──────────

test("a dedup that suppresses an escalation names itself on the row it already writes", async () => {
  const { row } = await disposeOne(pr({ reviewState: "failure" }), [priorDisposal("blocked-ambiguous")]);

  assert.equal(row.disposition, "blocked-ambiguous");
  assert.equal(row.acted, false);
  assert.match(String(row.stand_down_reason), /escalation was already filed for this head/);
  assert.match(String(row.stand_down_reason), /d00dfee/, "the head sha is named so a new head is visibly a new attempt");
});

// ── Acceptance 3: dep-review ──────────────────────────────────────────────────────────────────

test("a dedup that suppresses a dependency review names itself on the row it already writes", async () => {
  const prior = priorDisposal("dep-review", { dep_review_outcome: "escalate" });
  const { row } = await disposeOne(pr({ isDependabot: true }), [prior], { depReview: async () => "escalate" });

  assert.equal(row.disposition, "dep-review");
  assert.equal(row.acted, false);
  assert.match(String(row.stand_down_reason), /TERMINAL outcome/, "a terminal outcome is what dedups");
  assert.match(String(row.stand_down_reason), /a hold would have re-run/, "and a hold deliberately does not");
});

test("a dep-review HOLD does not dedup, so no dedup sentence is written for it", async () => {
  const prior = priorDisposal("dep-review", { dep_review_outcome: "hold" });
  const { row } = await disposeOne(pr({ isDependabot: true }), [prior], { depReview: async () => "hold" });

  assert.equal(row.disposition, "dep-review");
  assert.equal(row.acted, true, "a hold must re-run — the dedup is deliberately not seeded");
  assert.equal(row.stand_down_reason, undefined, "and nothing stood down, so nothing is named");
});

// ── Acceptance 4: stale — quiet since 2026-08-17, and fixed anyway ────────────────────────────

test("a dedup that suppresses a stale close names itself on the row it already writes", async () => {
  const { row } = await disposeOne(pr({ lastActivityAt: ANCIENT, createdAt: ANCIENT }), [priorDisposal("stale")]);

  assert.equal(row.disposition, "stale");
  assert.equal(row.acted, false);
  assert.match(String(row.stand_down_reason), /already recorded CLOSED by a prior sweep pass/);
  assert.match(String(row.stand_down_reason), /deduped, not skipped/, "a reader can tell this from a broken close path");
});

// ── Acceptance 5: a disposal that never reached a dedup check writes NO field ──────────────────
//
// The risk this change introduces is the opposite one: writing a reason where none is due. The
// field must stay ABSENT — not empty-string, not null — whenever no dedup fired.

test("a disposal that never reached a dedup check still writes no reason field at all", async () => {
  const { row } = await disposeOne(pr(), [], { postReview: async () => {} });

  assert.equal(row.disposition, "post-review");
  assert.equal(row.acted, true, "nothing deduped it, so it acted");
  assert.equal("stand_down_reason" in row, false, "the KEY is absent, never an empty value");
});

// ── Acceptance 6: the three already-reasoned arms keep their exact sentences ───────────────────

test("the sibling arms that already name themselves keep the exact sentences they write today", async () => {
  const armed = await disposeOne(pr({ reviewState: "success" }), [priorDisposal("mergeable")]);
  assert.equal(armed.row.disposition, "mergeable");
  assert.equal(
    armed.row.stand_down_reason,
    "auto-merge already armed by a prior sweep pass at this head (d00dfee)",
    "W1-T1116's mergeable sentence is byte-identical",
  );

  // W1-T1210: a dedup with no owning `fix.dispatch` row reads as STALLED and deliberately does
  // NOT suppress, so the owning row is seeded here to reach the dedup this assertion is about.
  const fixing = await disposeOne(pr({ reviewState: "failure", unmetCriteria: UNMET }), [
    priorDisposal("blocked-fixable"),
    { step: "fix.dispatch", task_id: TASK, head_sha: HEAD },
  ]);
  assert.equal(fixing.row.disposition, "blocked-fixable");
  assert.equal(
    fixing.row.stand_down_reason,
    "fix already dispatched for this head (d00dfee) — awaiting its outcome before spending another strike",
    "W1-T1110's blocked-fixable sentence is byte-identical",
  );

  const waiting = await disposeOne(pr({ checksState: "pending", lastActivityAt: FRESH, checksPendingSince: FRESH }), []);
  assert.equal(waiting.row.disposition, "wait");
  assert.equal(
    waiting.row.stand_down_reason,
    waiting.row.reason,
    "W1-T1116 design iv: wait reuses its own derived reason verbatim rather than a second sentence",
  );
});

// ── Acceptance 7: no new step, no second reason field ─────────────────────────────────────────

test("no new ledger step is emitted and the disposed row gains no second reason field", async () => {
  const delivered = { step: "review.posted", task_id: TASK, head_sha: HEAD };
  const { row, all } = await disposeOne(pr(), [delivered], { postReview: async () => {} });

  const steps = [...new Set(all.map((l) => String(l.step)))].sort();
  assert.deepEqual(steps, ["sweep.disposed"], "a deduped pass writes its disposed row and nothing else — no new step name");

  const reasonKeys = Object.keys(row).filter((k) => k.includes("reason"));
  assert.deepEqual(reasonKeys.sort(), ["reason", "stand_down_reason"], "exactly the two that already existed");
});

// ── Q3: the disposition and `acted` are byte-identical with and without this change ────────────
//
// Every fixture above, tabulated. These tuples were captured against the PRE-change `sweep.ts`
// and are asserted against the POST-change one, so a disposition or action that moved fails here
// rather than being noticed later on live rows.

test("no disposition and no acted value changes: every fixture's tuple is what it was before", async () => {
  const cases: Array<[string, OpenPrView, Array<Record<string, unknown>>, Partial<SweepDeps>, string, boolean]> = [
    ["post-review deduped", pr(), [{ step: "review.posted", task_id: TASK, head_sha: HEAD }], { postReview: async () => {} }, "post-review", false],
    ["post-review fresh", pr(), [], { postReview: async () => {} }, "post-review", true],
    ["escalation deduped", pr({ reviewState: "failure" }), [priorDisposal("blocked-ambiguous")], {}, "blocked-ambiguous", false],
    ["dep-review deduped", pr({ isDependabot: true }), [priorDisposal("dep-review", { dep_review_outcome: "escalate" })], { depReview: async () => "escalate" }, "dep-review", false],
    ["dep-review hold", pr({ isDependabot: true }), [priorDisposal("dep-review", { dep_review_outcome: "hold" })], { depReview: async () => "hold" }, "dep-review", true],
    ["stale deduped", pr({ lastActivityAt: ANCIENT, createdAt: ANCIENT }), [priorDisposal("stale")], {}, "stale", false],
    ["mergeable deduped", pr({ reviewState: "success" }), [priorDisposal("mergeable")], {}, "mergeable", false],
    ["blocked-fixable deduped", pr({ reviewState: "failure", unmetCriteria: UNMET }), [priorDisposal("blocked-fixable"), { step: "fix.dispatch", task_id: TASK, head_sha: HEAD }], {}, "blocked-fixable", false],
    ["wait", pr({ checksState: "pending", lastActivityAt: FRESH, checksPendingSince: FRESH }), [], {}, "wait", false],
  ];
  for (const [name, view, lines, overrides, disposition, acted] of cases) {
    const { row } = await disposeOne(view, lines, overrides);
    assert.equal(row.disposition, disposition, `${name}: disposition moved`);
    assert.equal(row.acted, acted, `${name}: acted moved`);
  }
});
