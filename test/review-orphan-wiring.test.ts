import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenPrViews, buildSweepEffects, reviewAttemptsForInput, reviewOrphansFor } from "../src/run-task.js";
import { reviewInputDigest } from "../src/lib/review.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  isCappedReviewOrphanEscalation,
  reviewInputBackoffElapsed,
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

test("reviewOrphansFor diagnostic counts DISTINCT prior heads, not posted lines", () => {
  // This historical diagnostic asks whether a push orphaned an earlier review. A head reviewed
  // twice is one prior head; the exact-input retry cap is computed separately.
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

test("buildOpenPrViews keeps prior-head detection separate from the exact-input retry count", async () => {
  // THE END-TO-END DRIVE. This exercises the producer literal itself — not a fixture — which is
  // what makes the falsifier below land on a test that proves population rather than fabrication.
  const dir = mkdtempSync(join(tmpdir(), "rmd-orphan-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const prUrl = "https://github.com/craigoley/remudero/pull/477";
  const body = "Remudero-Task: W1-T225";
  const inputDigest = reviewInputDigest(CURRENT, body);
  writeFileSync(
    ledgerPath,
    [
      JSON.stringify(ledgerLine("review.posted", "W1-T225", PRIOR_A)),
      JSON.stringify({
        ts: "2026-08-01T17:58:00.000Z",
        step: "review.posted",
        task_id: "W1-T225",
        head_sha: CURRENT,
        pr_url: prUrl,
        review_input_digest: inputDigest,
      }),
      JSON.stringify({
        ts: "2026-08-01T17:59:00.000Z",
        step: "review.posted",
        task_id: "W1-T225",
        head_sha: CURRENT,
        pr_url: prUrl,
        review_input_digest: inputDigest,
      }),
    ].join("\n") + "\n",
  );

  const fetch = (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) {
      return [
        {
          number: 477,
          html_url: prUrl,
          head: { ref: "feat/x", sha: CURRENT },
          updated_at: "2026-08-01T18:00:00.000Z",
          body,
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
  assert.equal(views[0].priorReviewAttemptsForInput, 2, "only the two completed judgments of this exact input spend its cap");
  assert.equal(views[0].reviewInputLastAttemptAt, "2026-08-01T17:59:00.000Z");
  assert.equal(views[0].reviewInputDigest, inputDigest, "the sweep's outcome dedup receives the same exact-input key");
});

test("the retry counter resets on either a new commit or a PR-body edit and ignores refusals", () => {
  const taskId = "W1-T225";
  const prUrl = "https://github.com/craigoley/remudero/pull/477";
  const oldBody = "old acceptance";
  const oldDigest = reviewInputDigest(CURRENT, oldBody);
  const ledger = [
    { ts: "2026-08-01T17:00:00Z", step: "review.posted", task_id: taskId, head_sha: CURRENT, pr_url: prUrl, review_input_digest: oldDigest },
    { ts: "2026-08-01T17:01:00Z", step: "review.posted", task_id: taskId, head_sha: CURRENT, pr_url: prUrl, review_input_digest: oldDigest },
    { ts: "2026-08-01T17:02:00Z", step: "review.post_refused", task_id: taskId, head_sha: CURRENT, pr_url: prUrl, review_input_digest: oldDigest },
  ];

  assert.equal(reviewAttemptsForInput(ledger, taskId, prUrl, CURRENT, oldDigest).attempts, 2, "unchanged input reaches the cap");
  assert.equal(
    reviewAttemptsForInput(ledger, taskId, prUrl, CURRENT, reviewInputDigest(CURRENT, "corrected acceptance")).attempts,
    0,
    "a body edit resets immediately on the same head",
  );
  assert.equal(
    reviewAttemptsForInput(ledger, taskId, prUrl, PRIOR_B, reviewInputDigest(PRIOR_B, oldBody)).attempts,
    0,
    "a new commit resets immediately",
  );
});

test("legacy rows without an input identity and infrastructure refusals never consume the content-review cap", () => {
  const taskId = "W1-T225";
  const prUrl = "https://github.com/craigoley/remudero/pull/477";
  const digest = reviewInputDigest(CURRENT, "body");
  const ledger = [
    { step: "review.posted", task_id: taskId, head_sha: CURRENT },
    { step: "review.post_refused", task_id: taskId, head_sha: CURRENT, pr_url: prUrl, review_input_digest: digest },
    { step: "review.posted", task_id: "OTHER", head_sha: CURRENT, pr_url: prUrl, review_input_digest: digest },
  ];
  assert.deepEqual(reviewAttemptsForInput(ledger, taskId, prUrl, CURRENT, digest), { attempts: 0 });
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
    { ...base, reviewOrphanedByPush: facts.orphanedByPush, priorReviewAttemptsForInput: facts.priorOrphans },
    DEFAULT_SWEEP_POLICY,
    Date.parse("2026-08-01T18:05:00.000Z"),
  );
  assert.equal(d.disposition, "post-review", "the dispatch is unchanged — only the stated reason differs");
  assert.match(d.reason, /orphaned by a push/, "the arm that had fired 0 times now renders");

  // And the never-reviewed PR still gets the original sentence.
  const none = reviewOrphansFor([], "W1-T225", CURRENT);
  const d2 = deriveDisposition(
    { ...base, reviewOrphanedByPush: none.orphanedByPush, priorReviewAttemptsForInput: none.priorOrphans },
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
  return { reviewOrphanedByPush: f.orphanedByPush, priorReviewAttemptsForInput: f.priorOrphans };
}

// ── W1-T983: THE ESCALATION-TIER RECLASSIFICATION ──────────────────────────────────────────
//
// The cap row above (`priorReviewAttemptsForInput` at `policy.reviewOrphanCap`) is correct — it stops the
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
      priorReviewAttemptsForInput: DEFAULT_SWEEP_POLICY.reviewOrphanCap,
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
      priorReviewAttemptsForInput: 0,
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
    priorReviewAttemptsForInput: DEFAULT_SWEEP_POLICY.reviewOrphanCap,
  });
  assert.equal(isCappedReviewOrphanEscalation(capped, DEFAULT_SWEEP_POLICY), true);

  // Below the cap — the SAME shape one push earlier — must not match yet.
  const belowCap = fullPr({
    reviewState: "none",
    checksState: "green",
    reviewOrphanedByPush: true,
    priorReviewAttemptsForInput: DEFAULT_SWEEP_POLICY.reviewOrphanCap - 1,
  });
  assert.equal(isCappedReviewOrphanEscalation(belowCap, DEFAULT_SWEEP_POLICY), false);

  // Awaiting its FIRST review ever (never orphaned) — the cap row's own false-positive lock,
  // mirrored here on the class predicate.
  const neverReviewed = fullPr({
    reviewState: "none",
    checksState: "green",
    reviewOrphanedByPush: false,
    priorReviewAttemptsForInput: 0,
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
      priorReviewAttemptsForInput: DEFAULT_SWEEP_POLICY.reviewOrphanCap,
    });
    const ordinary = fullPr({
      reviewState: "none",
      checksState: "red",
      reviewOrphanedByPush: false,
      priorReviewAttemptsForInput: 0,
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

// ── W1-T1018: BACKOFF, NOT A BUDGET ─────────────────────────────────────────────────────────
//
// Operator ruling, 2026-08-19: "I don't really like the idea of a review budget. We just need
// back off." The historical `reviewOrphansFor` diagnostic counts DISTINCT PUSHED HEADS — so a base-repair merge
// (the remedy this system itself prescribes on a base-recovered notice) spent the SAME budget a
// genuine failing retry did, and reaching `policy.reviewOrphanCap` was a PERMANENT wall (rationale
// (1)-(4), PR #2159). Two independent changes, both required:
//   (iv) `reviewOrphansFor` (run-task.ts) now counts DISTINCT REVIEWABLE DIFFS, not distinct
//        heads, when a `diffDigestForHead` fetcher is supplied — two heads with a byte-identical
//        PR-own diff are ONE orphan, never two.
//   (i)/(ii)/(iii) `reviewInputBackoffElapsed` (lib/sweep.ts) replaces the cap's old PERMANENT
//        cessation with an ELAPSED-TIME backoff — the cap row still escalates for visibility, but
//        yields back to post-review once enough wall-clock time has passed since the lane's last
//        real attempt, so the lane never stops trying outright.

const DIGEST_D1 = "d1-unchanged-diff";
const DIGEST_D2 = "d2-genuinely-different-diff";

test("W1-T1018: a push that changes nothing reviewable does not count an orphan", () => {
  // PRIOR_A and PRIOR_B both carry the SAME digest — a base-repair merge that left the PR's own
  // diff byte-identical (rationale (2)'s #2159 base merges: "own diff: 2 files +212/-8" on both).
  const ledger = [ledgerLine("review.posted", "W1-A", PRIOR_A), ledgerLine("review.posted", "W1-A", PRIOR_B)];
  const digestForHead = (sha: string): string | undefined => (sha === PRIOR_A || sha === PRIOR_B ? DIGEST_D1 : undefined);

  const facts = reviewOrphansFor(ledger, "W1-A", CURRENT, digestForHead);
  assert.equal(facts.orphanedByPush, true, "the PR was still reviewed on a now-superseded head");
  assert.equal(facts.priorOrphans, 1, "two identical-diff heads are ONE orphan, not two — housekeeping is free");
});

test("W1-T1018: a diff-changing push still counts an orphan", () => {
  // The housekeeping shape from the test above, immediately contrasted — in the SAME test run —
  // with a genuinely diff-changing push, so the two directions cannot be satisfied by an
  // implementation that just never counts (or always counts) anything.
  const housekeepingLedger = [ledgerLine("review.posted", "W1-A", PRIOR_A), ledgerLine("review.posted", "W1-A", PRIOR_B)];
  const sameDigest = (): string => DIGEST_D1;
  const housekeeping = reviewOrphansFor(housekeepingLedger, "W1-A", CURRENT, sameDigest);
  assert.equal(housekeeping.priorOrphans, 1, "sanity: the identical-diff pair still reads as one");

  // Now PRIOR_B's push genuinely changed the PR's own diff — a real retry, not housekeeping.
  const changingLedger = [ledgerLine("review.posted", "W1-A", PRIOR_A), ledgerLine("review.posted", "W1-A", PRIOR_B)];
  const differentDigest = (sha: string): string => (sha === PRIOR_A ? DIGEST_D1 : DIGEST_D2);
  const changing = reviewOrphansFor(changingLedger, "W1-A", CURRENT, differentDigest);
  assert.equal(changing.priorOrphans, 2, "a genuinely diff-changing push still counts — never silently discounted");
});

test("W1-T1018: an unreadable digest counts its head on its own, never merging with anything", () => {
  // FALSE-POSITIVE LOCK: an unreadable compare (a throw, a rate limit) must never manufacture a
  // false "unchanged" reading by collapsing two genuinely-distinct heads together.
  const ledger = [ledgerLine("review.posted", "W1-A", PRIOR_A), ledgerLine("review.posted", "W1-A", PRIOR_B)];
  const alwaysUnreadable = (): undefined => undefined;
  const facts = reviewOrphansFor(ledger, "W1-A", CURRENT, alwaysUnreadable);
  assert.equal(facts.priorOrphans, 2, "missing information must never silently discount a possibly-genuine retry");
});

test("W1-T1018: reviewOrphansFor without a digest fetcher counts every distinct head, exactly as before", () => {
  // Byte-identical to the pre-W1-T1018 behaviour when no 4th argument is passed at all — the
  // SCOPE-lag default `buildOpenPrViews` currently relies on (see that function's own comment).
  const ledger = [ledgerLine("review.posted", "W1-A", PRIOR_A), ledgerLine("review.posted", "W1-A", PRIOR_B)];
  const facts = reviewOrphansFor(ledger, "W1-A", CURRENT);
  assert.equal(facts.priorOrphans, 2);
});

/** A minimal green, review-none, orphaned {@link OpenPrView} — the shared shape the backoff tests key off. */
function backoffPr(overrides: Partial<OpenPrView>): OpenPrView {
  return {
    prNumber: 2159,
    prUrl: "https://github.com/craigoley/remudero/pull/2159",
    taskId: "W1-CAP",
    headSha: CURRENT,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-08-01T18:00:00.000Z",
    autoMergeArmed: false,
    isDependabot: false,
    reviewOrphanedByPush: true,
    priorReviewAttemptsForInput: DEFAULT_SWEEP_POLICY.reviewOrphanCap,
    ...overrides,
  } as OpenPrView;
}

const BACKOFF_NOW = Date.parse("2026-08-01T18:05:00.000Z");

test("W1-T1018: the escalation still fires at the threshold", () => {
  // No prior attempt on record yet (undefined) — byte-identical to the pre-W1-T1018 permanent
  // cap: the FIRST time the threshold is reached, it escalates for visibility.
  const firstReach = backoffPr({ reviewInputLastAttemptAt: undefined });
  const d1 = deriveDisposition(firstReach, DEFAULT_SWEEP_POLICY, BACKOFF_NOW);
  assert.equal(d1.disposition, "blocked-ambiguous", "the cap is met — escalate for visibility");
  assert.match(d1.reason, /orphaned by a push, again/);
  assert.match(d1.reason, new RegExp(`${DEFAULT_SWEEP_POLICY.reviewOrphanCap} cap`));

  // A RECENT attempt (5 minutes ago, well inside the 120m backoff window) — still escalates;
  // hammering the lane again this soon would be the exact loop this task exists to prevent.
  const recentAttempt = backoffPr({ reviewInputLastAttemptAt: "2026-08-01T18:00:00.000Z" });
  const d2 = deriveDisposition(recentAttempt, DEFAULT_SWEEP_POLICY, BACKOFF_NOW);
  assert.equal(d2.disposition, "blocked-ambiguous", "still within the backoff window — escalate, not retry");
});

test("W1-T1018: a PR past the threshold is re-reviewed after the interval", () => {
  // The SAME capped PR as above, but its last real attempt was 8 hours ago — well past the
  // 120-minute default backoff. Design (ii): "escalate AND keep going" — the lane resumes.
  const pastBackoff = backoffPr({ reviewInputLastAttemptAt: "2026-08-01T10:00:00.000Z" });
  assert.equal(
    reviewInputBackoffElapsed(pastBackoff, DEFAULT_SWEEP_POLICY, BACKOFF_NOW),
    true,
    "sanity: this fixture really is past the backoff window",
  );
  const derived = deriveDisposition(pastBackoff, DEFAULT_SWEEP_POLICY, BACKOFF_NOW);
  assert.equal(
    derived.disposition,
    "post-review",
    "past the interval, the sweep re-reviews rather than silencing the PR forever",
  );
  assert.match(derived.reason, /orphaned by a push/, "the SAME post-review dispatch every orphaned PR gets");
});

test("W1-T1018: removing the backoff reset fails the re-review test", () => {
  const sweepUrl = new URL("../src/lib/sweep.ts", import.meta.url);
  const src = readFileSync(sweepUrl, "utf8");
  const target =
    "export function reviewInputBackoffElapsed(pr: OpenPrView, policy: SweepPolicy, now: number): boolean {\n" +
    "  if (!pr.reviewInputLastAttemptAt) return false;\n" +
    "  const last = Date.parse(pr.reviewInputLastAttemptAt);\n" +
    "  if (Number.isNaN(last)) return false;\n" +
    "  return now - last >= policy.reviewOrphanBackoffMinutes * 60_000;\n" +
    "}";
  const occurrences = src.split(target).length - 1;
  assert.equal(occurrences, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  // File-sha bracketed (design clause vi): read the sha256 BEFORE the mutation.
  const originalSha = createHash("sha256").update(src).digest("hex");

  // THE MUTATION: remove the backoff reset entirely — the function never reports elapsed, which
  // is exactly the pre-W1-T1018 permanent cap this task's own risk note names as the dangerous
  // direction to regress toward, so a falsifier that catches it is load-bearing, not decorative.
  const removed =
    "export function reviewInputBackoffElapsed(pr: OpenPrView, policy: SweepPolicy, now: number): boolean {\n" +
    "  return false;\n" +
    "}";
  const mutatedSrc = src.replace(target, removed);
  const mutatedSha = createHash("sha256").update(mutatedSrc).digest("hex");
  assert.notEqual(mutatedSha, originalSha, "the mutation must actually change the file content");

  const mutantPath = writeMutantModule("sweep.ts", mutatedSrc);
  return (async () => {
    const mutant = (await import(mutantPath)) as typeof import("../src/lib/sweep.js");

    const pastBackoff = backoffPr({ reviewInputLastAttemptAt: "2026-08-01T10:00:00.000Z" });
    const derived = mutant.deriveDisposition(pastBackoff, DEFAULT_SWEEP_POLICY, BACKOFF_NOW);
    assert.equal(
      derived.disposition,
      "blocked-ambiguous",
      "the mutant must fail the re-review test — with no reset it walls the PR off exactly like the old cap",
    );
    assert.notEqual(derived.disposition, "post-review", "the mutant must NOT reproduce the fixed behaviour");

    // The real, on-disk file was never touched by the mutant copy.
    const shaAfter = createHash("sha256").update(readFileSync(sweepUrl, "utf8")).digest("hex");
    assert.equal(shaAfter, originalSha, "the real file must read unchanged either side of the mutation check");

    // And the real, unmutated behaviour still resumes retrying past the interval.
    const realDerived = deriveDisposition(pastBackoff, DEFAULT_SWEEP_POLICY, BACKOFF_NOW);
    assert.equal(realDerived.disposition, "post-review");
  })();
});
