/**
 * W1-T3704 (completed here) — THE REVIEW-REUSE MECHANISM HAD NO PRODUCER, FOR ANY OF ITS FIVE INPUTS.
 *
 * W1-T3704 shipped all of it: `reviewReuseVerdict`, the `review-reused` and `discriminate-only`
 * disposition rows that call it, `ReviewVerdict.ownDiffDigest`/`mergeBaseSha`, the
 * `own_diff_digest`/`merge_base_sha` ledger fields, and `priorReviewVerdictFromLedger` reading
 * them back. Every piece tested. And nothing, anywhere in `src/`, ever wrote a single one of the
 * five values it compares — the function's own comment said so ("Not yet populated by the real
 * gateway"), so its absence guard returned `full-review` on every call the fleet ever made.
 *
 * Measured on #5941: green, re-reviewed after an unrelated merge moved its base, and the operator
 * asked why it needed another review. The machinery to answer "nothing you judged changed" was
 * already in the tree and had never once been fed.
 *
 * WHAT EACH TEST BELOW REDDENS ON:
 *   1/2. the digest folding a field that makes it unstable, or ignoring one that must change it —
 *        an unstable digest reads as "the diff changed" forever (a silent return to the old
 *        behaviour), a too-coarse one reuses a verdict over work nobody judged.
 *   3.   the compare producer accepting a half-answer as authoritative.
 *   4.   the bounded hydrator losing its bound, or its best-effort failure direction inverting.
 *   5.   THE END-TO-END SHAPE: record a pair, push, ask again — and get `reuse`, not `full-review`.
 *   6.   the ONE-REPRESENTATION rule, which is the whole correctness argument.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ownDiffDigestFromCompareFiles,
  fetchReviewReuseFacts,
  tryFetchReviewReuseFacts,
  hydrateReviewReuseFacts,
} from "../src/lib/open-prs-rest.js";
import { reviewReuseVerdict } from "../src/lib/sweep.js";
import { priorReviewVerdictFromLedger, reviewLedgerLegibilityFields } from "../src/lib/review.js";

const FILES_A = [
  { filename: "src/lib/a.ts", status: "modified", sha: "blob1111" },
  { filename: "test/a.test.ts", status: "added", sha: "blob2222" },
];
const CONTRACT_DIGEST = "contract-v1:producer-fixture";

test("review-reuse-producer: the own-diff digest is stable under reordering, and blind to commit history", () => {
  // THE FALSE-NEGATIVE GUARD. The compare endpoint promises no file order. An order-sensitive
  // digest would differ between two passes over an unchanged PR, so the reuse path would read
  // "changed" forever — indistinguishable, in production, from the no-producer bug being fixed.
  const forward = ownDiffDigestFromCompareFiles(FILES_A);
  const reversed = ownDiffDigestFromCompareFiles([...FILES_A].reverse());
  assert.equal(forward, reversed);

  // A rebase or a force-push of identical bytes changes commit shas and nothing else. The digest
  // reads only path/status/blob, so it must not move.
  assert.equal(ownDiffDigestFromCompareFiles([{ ...FILES_A[0] }, { ...FILES_A[1] }]), forward);
});

test("review-reuse-producer: the own-diff digest moves when the PR's own content moves", () => {
  // THE FALSE-POSITIVE GUARD, and the one that actually matters: a digest too coarse to notice a
  // change would reuse a verdict over a diff nobody judged. Each field is varied on its own.
  const base = ownDiffDigestFromCompareFiles(FILES_A);
  const changedBlob = [{ ...FILES_A[0], sha: "blob9999" }, FILES_A[1]];
  const changedPath = [{ ...FILES_A[0], filename: "src/lib/b.ts" }, FILES_A[1]];
  const changedStatus = [{ ...FILES_A[0], status: "removed" }, FILES_A[1]];
  const extraFile = [...FILES_A, { filename: "src/lib/c.ts", status: "added", sha: "blob3333" }];
  const renamed = [{ ...FILES_A[0], status: "renamed", previous_filename: "src/lib/old.ts" }, FILES_A[1]];

  for (const [label, files] of [
    ["blob", changedBlob], ["path", changedPath], ["status", changedStatus],
    ["an added file", extraFile], ["a rename's source", renamed],
  ] as const) {
    assert.notEqual(ownDiffDigestFromCompareFiles(files), base, `${label} must move the digest`);
  }

  // An empty diff is a real state, and must not collide with anything.
  assert.notEqual(ownDiffDigestFromCompareFiles([]), base);
  assert.equal(ownDiffDigestFromCompareFiles([]), ownDiffDigestFromCompareFiles(undefined));
});

test("review-reuse-producer: a malformed file entry degrades toward DIFFERENT, never toward same", () => {
  // The safety asymmetry the whole feature rests on: a false "changed" wastes a review, a false
  // "unchanged" ships an unjudged diff. A nameless entry therefore contributes a marker rather
  // than being skipped — skipping it would let two genuinely different diffs digest identically.
  const withNameless = ownDiffDigestFromCompareFiles([FILES_A[0], { status: "modified", sha: "blobX" }]);
  assert.notEqual(withNameless, ownDiffDigestFromCompareFiles([FILES_A[0]]));
});

test("review-reuse-producer: the compare producer refuses a half-answer, and the try-variant swallows it", () => {
  const good = fetchReviewReuseFacts("o", "r", "main", "head1", (() => ({
    merge_base_commit: { sha: "base777" },
    files: FILES_A,
  })) as never);
  assert.equal(good.mergeBaseSha, "base777");
  assert.equal(good.ownDiffDigest, ownDiffDigestFromCompareFiles(FILES_A));

  // A compare with no merge base must THROW rather than hand back a digest alone: the reuse
  // decision needs both, and a half-answer recorded as authoritative is how "unreadable" quietly
  // becomes "unchanged".
  assert.throws(
    () => fetchReviewReuseFacts("o", "r", "main", "head1", (() => ({ files: FILES_A })) as never),
    /merge_base_commit/,
  );
  // The best-effort wrapper is what both call sites use: `undefined`, never a throw.
  assert.equal(tryFetchReviewReuseFacts("o", "r", "main", "head1", (() => ({ files: FILES_A })) as never), undefined);
  assert.equal(
    tryFetchReviewReuseFacts("o", "r", "main", "head1", (() => { throw new Error("rate limited"); }) as never),
    undefined,
  );
});

test("review-reuse-producer: the hydrator is BOUNDED, and an unreadable PR simply stays absent", () => {
  // The bound is the cost argument, not an optimisation: GitHub's secondary limit counts request
  // CADENCE, so an unbounded per-pass fan-out is exactly the shape that trips it.
  const asked: string[] = [];
  const fetch = ((args: string[]) => {
    asked.push(args[1]);
    if (args[1].includes("bad")) throw new Error("404");
    return { merge_base_commit: { sha: "base777" }, files: FILES_A };
  }) as never;

  const out = hydrateReviewReuseFacts(
    "o", "r", "main",
    [{ number: 1, headRefOid: "good1" }, { number: 2, headRefOid: "bad2" }, { number: 3, headRefOid: "good3" }],
    fetch,
    2,
  );
  assert.equal(asked.length, 2, "the cap must bound the requests actually issued");
  assert.equal(out.has(1), true);
  assert.equal(out.has(2), false, "an unreadable PR is ABSENT — which every reader reads as re-review");
  assert.equal(out.has(3), false, "beyond the cap is likewise absent, never guessed");

  // An empty orphan set costs ZERO requests. On a healthy board that is every pass.
  asked.length = 0;
  hydrateReviewReuseFacts("o", "r", "main", [], fetch);
  assert.equal(asked.length, 0);
});

test("review-reuse-producer: END TO END — a recorded verdict plus an unchanged diff yields reuse, not full-review", () => {
  // This is the test that would have failed every day since W1-T3704 shipped.
  const facts = fetchReviewReuseFacts("o", "r", "main", "OLDHEAD", (() => ({
    merge_base_commit: { sha: "base777" },
    files: FILES_A,
  })) as never);

  // (1) the review records the pair on its `review.posted` line ...
  const fields = reviewLedgerLegibilityFields({
    capped: false, keywordOnly: false, planOnly: false,
    ownDiffDigest: facts.ownDiffDigest, mergeBaseSha: facts.mergeBaseSha,
    reviewContractDigest: CONTRACT_DIGEST,
  } as never);
  const ledger = [{ step: "review.posted", task_id: "W1-T1", head_sha: "OLDHEAD", state: "success", ...fields }];

  // (2) ... a later pass reads it back and asks the current head the same question ...
  const prior = priorReviewVerdictFromLedger(ledger, "W1-T1");
  assert.equal(prior?.ownDiffDigest, facts.ownDiffDigest, "the write side must survive the ledger round trip");
  const current = fetchReviewReuseFacts("o", "r", "main", "NEWHEAD", (() => ({
    merge_base_commit: { sha: "base777" },
    files: [...FILES_A].reverse(), // same diff, different order — the realistic shape
  })) as never);

  // (3) ... and the decision reuses instead of re-reviewing, naming the head it judged.
  const verdict = reviewReuseVerdict({
    reviewedOwnDiffDigest: prior?.ownDiffDigest,
    currentOwnDiffDigest: current.ownDiffDigest,
    reviewedMergeBaseSha: prior?.mergeBaseSha,
    currentMergeBaseSha: current.mergeBaseSha,
    reviewedHeadSha: prior?.headSha,
    reviewedContractDigest: prior?.reviewContractDigest,
    currentContractDigest: CONTRACT_DIGEST,
  });
  assert.deepEqual(verdict, { kind: "reuse", judgedHeadSha: "OLDHEAD" });

  // The "update branch" shape — same own diff, moved base — must grade DOWN to discrimination
  // only, never all the way to reuse. This is the #5941 case exactly.
  const movedBase = reviewReuseVerdict({
    reviewedOwnDiffDigest: prior?.ownDiffDigest,
    currentOwnDiffDigest: current.ownDiffDigest,
    reviewedMergeBaseSha: prior?.mergeBaseSha,
    currentMergeBaseSha: "base888",
    reviewedHeadSha: prior?.headSha,
    reviewedContractDigest: prior?.reviewContractDigest,
    currentContractDigest: CONTRACT_DIGEST,
  });
  assert.deepEqual(movedBase, { kind: "discriminate-only", judgedHeadSha: "OLDHEAD" });

  // And real new work still earns a real review.
  const realChange = reviewReuseVerdict({
    reviewedOwnDiffDigest: prior?.ownDiffDigest,
    currentOwnDiffDigest: ownDiffDigestFromCompareFiles([...FILES_A, { filename: "x.ts", status: "added", sha: "b9" }]),
    reviewedMergeBaseSha: prior?.mergeBaseSha,
    currentMergeBaseSha: current.mergeBaseSha,
    reviewedHeadSha: prior?.headSha,
    reviewedContractDigest: prior?.reviewContractDigest,
    currentContractDigest: CONTRACT_DIGEST,
  });
  assert.deepEqual(realChange, { kind: "full-review" });
});

test("review-reuse-producer: ONE REPRESENTATION — both sides of the comparison fold through the same function", () => {
  // THE CORRECTNESS ARGUMENT, asserted rather than assumed. The recorded side is computed during a
  // review and the current side during a later sweep pass, in different modules. If those two ever
  // folded a digest differently — local git on one side, this compare on the other — the equality
  // test would silently answer a question about code paths instead of about the pull request, and
  // every reuse would be refused forever with no error anywhere.
  const files = FILES_A;
  const viaFetch = fetchReviewReuseFacts("o", "r", "main", "h", (() => ({
    merge_base_commit: { sha: "b" }, files,
  })) as never).ownDiffDigest;
  const viaHydrate = hydrateReviewReuseFacts("o", "r", "main", [{ number: 1, headRefOid: "h" }], (() => ({
    merge_base_commit: { sha: "b" }, files,
  })) as never).get(1)!.ownDiffDigest;
  assert.equal(viaFetch, viaHydrate);
  assert.equal(viaFetch, ownDiffDigestFromCompareFiles(files));
});
