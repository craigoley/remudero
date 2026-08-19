import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenPrViews, buildSweepEffects, reviewOrphansFor } from "../src/run-task.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  isCappedReviewOrphanEscalation,
  type OpenPrView,
} from "../src/lib/sweep.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { writeMutantModule } from "./helpers/mutant-module.js";

/**
 * W1-T225's two fields shipped their MECHANISM in full — two disposition rows, a reason branch,
 * unit tests — and no producer. Measured over the unioned ledger, the two arms of the ternary at
 * sweep.ts:1305-1309 have fired 886 and 0 times: the orphan arm has never executed in fifteen days.
 *
 * EVERY TEST HERE DRIVES THE REAL DERIVATION. Hand-assigning `reviewOrphanedByPush: true` on a
 * fixture is exactly the shape that let impl-DX's falsifier catch only one test — a fabricated
 * field cannot fail when the population breaks.
 */

const CURRENT = "cafe1234cafe1234cafe1234cafe1234cafe1234";
const PRIOR_A = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const PRIOR_B = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

function ledgerLine(step: string, taskId: string, headSha?: string): Record<string, unknown> {
  return headSha === undefined ? { step, task_id: taskId } : { step, task_id: taskId, head_sha: headSha };
}

test("a review posted against a SUPERSEDED sha is detected as orphaned by a push", () => {
  const ledger = [ledgerLine("review.posted", "W1-A", PRIOR_A)];
  const facts = reviewOrphansFor(ledger, "W1-A", CURRENT);
  assert.equal(facts.orphanedByPush, true, "the verdict describes a head that no longer exists");
  assert.equal(facts.priorOrphans, 1);
});

test("a review posted against the CURRENT head is NOT orphaned", () => {
  // FALSE-POSITIVE LOCK 1. The review describes exactly this code; nothing is stale.
  const facts = reviewOrphansFor([ledgerLine("review.posted", "W1-A", CURRENT)], "W1-A", CURRENT);
  assert.equal(facts.orphanedByPush, false);
  assert.equal(facts.priorOrphans, 0);
});

test("a PR whose review has NEVER posted is NOT orphaned — it is awaiting its first review", () => {
  // FALSE-POSITIVE LOCK 2. The cap row's own comment requires this: "a PR awaiting its FIRST
  // review never matches this row — only a PR that has demonstrably been reviewed before can
  // exhaust this cap."
  const ledger = [ledgerLine("run.start", "W1-A", CURRENT), ledgerLine("pr.opened", "W1-A", CURRENT)];
  const facts = reviewOrphansFor(ledger, "W1-A", CURRENT);
  assert.equal(facts.orphanedByPush, false);
  assert.equal(facts.priorOrphans, 0);
});

test("a posted line carrying NO head sha is never counted as a prior head", () => {
  // FALSE-POSITIVE LOCK 3, and the one the `mergeable` lesson names directly: an absent field is
  // missing information, not evidence of a different head. The ledger genuinely carries such rows
  // (the pre-#981 blind-arm class wrote outcomes with no sha), so this is not hypothetical.
  const ledger = [ledgerLine("review.posted", "W1-A", undefined), ledgerLine("review.posted", "W1-A", "")];
  const facts = reviewOrphansFor(ledger, "W1-A", CURRENT);
  assert.equal(facts.orphanedByPush, false, "unknown must never read as a definite answer");
  assert.equal(facts.priorOrphans, 0);
});

test("another task's review never leaks into this PR's orphan count", () => {
  const ledger = [ledgerLine("review.posted", "W1-OTHER", PRIOR_A), ledgerLine("review.posted", "W1-A", CURRENT)];
  assert.equal(reviewOrphansFor(ledger, "W1-A", CURRENT).orphanedByPush, false);
});

test("a PR with no task id is never orphaned — there is nothing to key the ledger scan on", () => {
  assert.deepEqual(reviewOrphansFor([ledgerLine("review.posted", "W1-A", PRIOR_A)], undefined, CURRENT), {
    orphanedByPush: false,
    priorOrphans: 0,
  });
});

test("priorReviewOrphans counts DISTINCT prior heads, not posted lines", () => {
  // The doc specifies "counting the distinct prior heads it found" — a head re-reviewed twice is
  // ONE orphan, not two, or the cap of 2 would trip on a single push that got re-reviewed.
  const ledger = [
    ledgerLine("review.posted", "W1-A", PRIOR_A),
    ledgerLine("review.posted", "W1-A", PRIOR_A), // same head again
    ledgerLine("review.post_refused", "W1-A", PRIOR_A), // and a refusal on it
    ledgerLine("review.posted", "W1-A", PRIOR_B),
    ledgerLine("review.posted", "W1-A", CURRENT), // the current head never counts
  ];
  const facts = reviewOrphansFor(ledger, "W1-A", CURRENT);
  assert.equal(facts.priorOrphans, 2, "two distinct prior heads: A and B");
  assert.equal(facts.orphanedByPush, true);
});

test("a refused post also proves the PR was reviewed before", () => {
  const facts = reviewOrphansFor([ledgerLine("review.post_refused", "W1-A", PRIOR_A)], "W1-A", CURRENT);
  assert.equal(facts.orphanedByPush, true, "the review lane ran for that sha; the verdict is still stale");
});

test("buildOpenPrViews POPULATES both fields, so the orphan arm can finally execute", async () => {
  // THE END-TO-END DRIVE. This exercises the producer literal itself — not a fixture — which is
  // what makes the falsifier below land on a test that proves population rather than fabrication.
  const dir = mkdtempSync(join(tmpdir(), "rmd-orphan-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(
    ledgerPath,
    [
      JSON.stringify(ledgerLine("review.posted", "W1-T225", PRIOR_A)),
      JSON.stringify(ledgerLine("review.posted", "W1-T225", PRIOR_B)),
    ].join("\n") + "\n",
  );

  const fetch = (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) {
      return [
        {
          number: 477,
          html_url: "https://github.com/craigoley/remudero/pull/477",
          head: { ref: "feat/x", sha: CURRENT },
          updated_at: "2026-08-01T18:00:00.000Z",
          body: "Remudero-Task: W1-T225",
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/\/pulls\/477$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
    return [];
  };

  const views = buildOpenPrViews("craigoley", "remudero", ledgerPath, { fetch, requiredContexts: () => ["ci-gate"] });
  assert.equal(views.length, 1);
  assert.equal(views[0].reviewOrphanedByPush, true, "the producer sets it — it is no longer always undefined");
  assert.equal(views[0].priorReviewOrphans, 2, "and the distinct-head count comes from the same scan");
});

test("the orphan REASON arm renders once the field is populated, where before it could not", () => {
  const base: OpenPrView = {
    prNumber: 477,
    prUrl: "u",
    taskId: "W1-T225",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-08-01T18:00:00.000Z",
    headSha: CURRENT,
    autoMergeArmed: false,
    isDependabot: false,
  } as OpenPrView;

  // Derived, never hand-set: one prior head ⇒ orphaned, and below the cap of 2.
  const facts = reviewOrphansFor([ledgerLine("review.posted", "W1-T225", PRIOR_A)], "W1-T225", CURRENT);
  const d = deriveDisposition(
    { ...base, reviewOrphanedByPush: facts.orphanedByPush, priorReviewOrphans: facts.priorOrphans },
    DEFAULT_SWEEP_POLICY,
    Date.parse("2026-08-01T18:05:00.000Z"),
  );
  assert.equal(d.disposition, "post-review", "the dispatch is unchanged — only the stated reason differs");
  assert.match(d.reason, /orphaned by a push/, "the arm that had fired 0 times now renders");

  // And the never-reviewed PR still gets the original sentence.
  const none = reviewOrphansFor([], "W1-T225", CURRENT);
  const d2 = deriveDisposition(
    { ...base, reviewOrphanedByPush: none.orphanedByPush, priorReviewOrphans: none.priorOrphans },
    DEFAULT_SWEEP_POLICY,
    Date.parse("2026-08-01T18:05:00.000Z"),
  );
  assert.equal(d2.disposition, "post-review");
  assert.match(d2.reason, /review never posted/);
});

test("the cap row escalates only once the DERIVED count reaches policy.reviewOrphanCap", () => {
  const base: OpenPrView = {
    prNumber: 477,
    prUrl: "u",
    taskId: "W1-T225",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-08-01T18:00:00.000Z",
    headSha: CURRENT,
    autoMergeArmed: false,
    isDependabot: false,
  } as OpenPrView;
  const at = Date.parse("2026-08-01T18:05:00.000Z");

  const one = reviewOrphansFor([ledgerLine("review.posted", "W1-T225", PRIOR_A)], "W1-T225", CURRENT);
  assert.equal(
    deriveDisposition({ ...base, ...renamed(one) }, DEFAULT_SWEEP_POLICY, at).disposition,
    "post-review",
    "one prior head is under the cap — keep re-reviewing",
  );

  const two = reviewOrphansFor(
    [ledgerLine("review.posted", "W1-T225", PRIOR_A), ledgerLine("review.posted", "W1-T225", PRIOR_B)],
    "W1-T225",
    CURRENT,
  );
  assert.equal(two.priorOrphans, DEFAULT_SWEEP_POLICY.reviewOrphanCap);
  assert.equal(
    deriveDisposition({ ...base, ...renamed(two) }, DEFAULT_SWEEP_POLICY, at).disposition,
    "blocked-ambiguous",
    "at the cap it escalates instead of retrying indefinitely — the loop falsifier",
  );
});

function renamed(f: { orphanedByPush: boolean; priorOrphans: number }): Partial<OpenPrView> {
  return { reviewOrphanedByPush: f.orphanedByPush, priorReviewOrphans: f.priorOrphans };
}

// ── W1-T983: THE ESCALATION-TIER RECLASSIFICATION ──────────────────────────────────────────
//
// The cap row above (`priorReviewOrphans` at `policy.reviewOrphanCap`) is correct — it stops the
// sweep re-reviewing a PR indefinitely and genuinely does mean a human is needed. But every
// blocked-ambiguous escalation the sweep opens, this disposition included, used to pass
// `class: "BLOCKED"` to `buildSweepEffects`'s `escalate` closure (run-task.ts) — a class the
// operator's real-time channel never pages on. `isCappedReviewOrphanEscalation` (lib/sweep.ts) is
// the pure predicate that closure now reads to pick MANUAL instead, for THIS disposition only;
// every other blocked-ambiguous shape (merge conflicts, strikes exhausted, stale-pending, the
// catch-all) keeps BLOCKED exactly as before.
//
// Tests below drive the REAL closure (`buildSweepEffects(...).escalate`), never a hand-rolled
// class literal, with a recording `IssueGateway` in place of `gh` — the same substitution
// test/post-review-stall-escalation.test.ts's own `recorder()` uses to keep every assertion here
// off the network.

/** An `IssueGateway` that records `create()` calls instead of reaching GitHub. */
function recordingGateway() {
  const opened: Array<{ title: string; body: string; labels: string[] }> = [];
  const gw: IssueGateway = {
    create: (title: string, body: string, labels: string[]) => {
      opened.push({ title, body, labels });
      return `https://github.com/acme/remudero/issues/${opened.length}`;
    },
    listOpen: () => [],
  } as unknown as IssueGateway;
  return { opened, gw };
}

/** A full {@link OpenPrView}, overridable per test — the shared shape both closure-level tests key off. */
function fullPr(overrides: Partial<OpenPrView>): OpenPrView {
  return {
    prNumber: 2097,
    prUrl: "https://github.com/acme/remudero/pull/2097",
    taskId: "W1-CAP",
    headSha: CURRENT,
    mergeState: "clean",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-08-18T00:00:00.000Z",
    autoMergeArmed: false,
    isDependabot: false,
    ...overrides,
  } as OpenPrView;
}

/** A minimal {@link ClarificationQuestion}-shaped fixture — the closure only reads its own two fields. */
function question() {
  return {
    taskId: "W1-CAP",
    prNumber: 2097,
    prUrl: "https://github.com/acme/remudero/pull/2097",
    question: "what should happen to this PR?",
    criterion: "",
    reviewerRequirement: "",
    specText: "",
    strikeHistory: [],
    resolutions: [
      { label: "override", detail: "override the cap and merge by hand" },
      { label: "close", detail: "close the PR" },
    ],
  } as never;
}

/** Build a `buildSweepEffects` instance wired to `gw`, with every optional dep left at its default
 *  apart from the recording issue gateway (the 12th positional param — the same seam
 *  test/post-review-stall-escalation.test.ts's own fixture uses). */
function effectsWith(gw: IssueGateway, ledgerPath: string, runId: string) {
  return buildSweepEffects(
    "acme",
    "remudero",
    { root: "/nonexistent-w1-t983-root" } as never,
    ledgerPath,
    runId,
    { tasks: [] } as never,
    () => {},
    DEFAULT_SWEEP_POLICY,
    undefined, // reviewRunner
    undefined, // spawnImpl
    undefined, // pushEmptyCommit
    gw, // issuesImpl — the recording gateway, never real `gh`
  );
}

test("W1-T983: a capped green review-orphaned PR escalates at the reaching class", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t983-"));
  try {
    const { opened, gw } = recordingGateway();
    const pr = fullPr({
      reviewState: "none",
      checksState: "green",
      reviewOrphanedByPush: true,
      priorReviewOrphans: DEFAULT_SWEEP_POLICY.reviewOrphanCap,
    });
    // Sanity: this fixture really is the shape the predicate keys on — otherwise the assertion
    // below would pass for the wrong reason.
    assert.equal(isCappedReviewOrphanEscalation(pr, DEFAULT_SWEEP_POLICY), true);

    const effects = effectsWith(gw, join(dir, "ledger.ndjson"), "SWEEP-W1-T983-A");
    effects.escalate(pr, "review orphaned by a push, again — cap reached", question());

    assert.equal(opened.length, 1, "exactly one issue opened, no dedup interference");
    assert.match(opened[0]!.title, /^\[MANUAL\]/, "the capped-green-orphan disposition reaches MANUAL, not BLOCKED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T983: an ordinary blocked-ambiguous escalation keeps its class", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t983-"));
  try {
    const { opened, gw } = recordingGateway();
    // The PAIRED CONTROL (design clause v, "in the SAME run" as the positive case above): checks
    // are RED, never green, and the review was never orphaned by a push — an ordinary
    // blocked_ci-shaped ambiguity that must NOT trip the new predicate.
    const pr = fullPr({
      reviewState: "none",
      checksState: "red",
      reviewOrphanedByPush: false,
      priorReviewOrphans: 0,
    });
    assert.equal(isCappedReviewOrphanEscalation(pr, DEFAULT_SWEEP_POLICY), false);

    const effects = effectsWith(gw, join(dir, "ledger.ndjson"), "SWEEP-W1-T983-B");
    effects.escalate(pr, "checks are red with no single nameable unmet criterion", question());

    assert.equal(opened.length, 1);
    assert.match(opened[0]!.title, /^\[BLOCKED\]/, "an ordinary blocked-ambiguous escalation is UNCHANGED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T983: the class decision is pure and callable without a spawn", () => {
  // No filesystem, no gh, no IssueGateway, no `buildSweepEffects` — a bare in-memory OpenPrView
  // and SweepPolicy, proving the predicate is a total, synchronous, side-effect-free function.
  const capped = fullPr({
    reviewState: "none",
    checksState: "green",
    reviewOrphanedByPush: true,
    priorReviewOrphans: DEFAULT_SWEEP_POLICY.reviewOrphanCap,
  });
  assert.equal(isCappedReviewOrphanEscalation(capped, DEFAULT_SWEEP_POLICY), true);

  // Below the cap — the SAME shape one push earlier — must not match yet.
  const belowCap = fullPr({
    reviewState: "none",
    checksState: "green",
    reviewOrphanedByPush: true,
    priorReviewOrphans: DEFAULT_SWEEP_POLICY.reviewOrphanCap - 1,
  });
  assert.equal(isCappedReviewOrphanEscalation(belowCap, DEFAULT_SWEEP_POLICY), false);

  // Awaiting its FIRST review ever (never orphaned) — the cap row's own false-positive lock,
  // mirrored here on the class predicate.
  const neverReviewed = fullPr({
    reviewState: "none",
    checksState: "green",
    reviewOrphanedByPush: false,
    priorReviewOrphans: 0,
  });
  assert.equal(isCappedReviewOrphanEscalation(neverReviewed, DEFAULT_SWEEP_POLICY), false);
});

test("W1-T983: inverting the predicate fails the paired control", () => {
  const sweepUrl = new URL("../src/lib/sweep.ts", import.meta.url);
  const src = readFileSync(sweepUrl, "utf8");
  const target =
    'export function isCappedReviewOrphanEscalation(pr: OpenPrView, policy: SweepPolicy): boolean {\n' +
    '  return (\n';
  const occurrences = src.split(target).length - 1;
  assert.equal(occurrences, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  // File-sha bracketed (design clause vi): read the sha256 BEFORE the mutation.
  const originalSha = createHash("sha256").update(src).digest("hex");

  const inverted =
    'export function isCappedReviewOrphanEscalation(pr: OpenPrView, policy: SweepPolicy): boolean {\n' +
    '  return !(\n';
  const mutatedSrc = src.replace(target, inverted);
  const mutatedSha = createHash("sha256").update(mutatedSrc).digest("hex");
  assert.notEqual(mutatedSha, originalSha, "the mutation must actually change the file content");

  const mutantPath = writeMutantModule("sweep.ts", mutatedSrc);
  return (async () => {
    const mutant = (await import(mutantPath)) as typeof import("../src/lib/sweep.js");

    const capped = fullPr({
      reviewState: "none",
      checksState: "green",
      reviewOrphanedByPush: true,
      priorReviewOrphans: DEFAULT_SWEEP_POLICY.reviewOrphanCap,
    });
    const ordinary = fullPr({
      reviewState: "none",
      checksState: "red",
      reviewOrphanedByPush: false,
      priorReviewOrphans: 0,
    });

    // THE PAIRED CONTROL FAILS BOTH WAYS under the inverted predicate: the capped-green PR that
    // must escalate at the reaching class now reads false, and the ordinary blocked-ambiguous PR
    // that must keep its class now reads true — proving both positive tests above are genuinely
    // carried by this predicate's polarity, not by some neighbouring accident.
    assert.equal(
      mutant.isCappedReviewOrphanEscalation(capped, DEFAULT_SWEEP_POLICY),
      false,
      "the mutant must fail the positive-control case — otherwise this proves nothing",
    );
    assert.equal(
      mutant.isCappedReviewOrphanEscalation(ordinary, DEFAULT_SWEEP_POLICY),
      true,
      "the mutant must fail the negative-control case too — otherwise this proves nothing",
    );

    // The real, on-disk file was never touched by the mutant copy.
    const shaAfter = createHash("sha256").update(readFileSync(sweepUrl, "utf8")).digest("hex");
    assert.equal(shaAfter, originalSha, "the real file must read unchanged either side of the mutation check");

    // And the real, unmutated predicate still decides both directions correctly.
    assert.equal(isCappedReviewOrphanEscalation(capped, DEFAULT_SWEEP_POLICY), true);
    assert.equal(isCappedReviewOrphanEscalation(ordinary, DEFAULT_SWEEP_POLICY), false);
  })();
});
