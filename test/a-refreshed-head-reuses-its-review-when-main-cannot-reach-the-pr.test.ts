/**
 * test/a-refreshed-head-reuses-its-review-when-main-cannot-reach-the-pr.test.ts — W1-T9047.
 *
 * THE DEFECT: the exact-input review digest carries no base, and branch protection is non-strict,
 * so a fleet refresh (a merge of main into a reviewed head) needs no new LLM judgment unless main's
 * change can reach what the review judged. Three leaks sent every refreshed head to a full review:
 *  (1) the reuse rows match only on GREEN checks, and a refreshed head's CI is pending, so the
 *      pending-CI `post-review` row fired first and `runSweep` mapped it to `full-review`;
 *  (2) the own-diff digest hashed each file's blob sha, which a main edit to the same file moves;
 *  (3) reuse facts were hydrated for only the first 25 orphaned PRs.
 *
 * Each test below drives the real `runSweep`, the real digest producer or the real effect builder;
 * the only fakes are GitHub reads and the import-closure read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import {
  fetchReviewReuseFacts,
  fetchReviewReuseReachFacts,
  hunksWithoutLineNumbers,
  hydrateReviewReuseFacts,
  ownDiffDigestDetail,
  ownDiffDigestFromCompareFiles,
} from "#src/lib/open-prs-rest.js";
import {
  buildSweepEffects,
  DEFAULT_SWEEP_POLICY,
  mainDeltaReachingReview,
  reviewDispatchModeFor,
  reviewModeAfterReach,
  reviewReuseReachReader,
  runSweep,
  type BuildSweepEffectsDeps,
  type OpenPrView,
  type ReviewReuseReach,
  type SweepDeps,
} from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const CI_REGISTERED = "2026-10-13T11:55:00Z"; // five minutes of pending CI: past the 1m floor, under the ceiling
const TASK = "W1-T9047F";
const HEAD = "beadbeadbeadbeadbeadbeadbeadbeadbeadbead";
const JUDGED_HEAD = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";
const REVIEWED_BASE = "0ldbase00ldbase00ldbase00ldbase00ldbase0";
const CURRENT_BASE = "newbase1newbase1newbase1newbase1newbase1";
const OWN_DIFF = "own-diff:unchanged";
const CONTRACT = "contract-v1:unchanged";

/** A reviewed head that then took main: the review was orphaned by the refresh push, its own diff
 *  and contract are unchanged, and the merge base moved. CI on the new head is still pending. */
function refreshedPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9047,
    prUrl: "https://github.com/craigoley/remudero/pull/9047",
    taskId: TASK,
    headRefName: "run-W1-T9047F-1791927909075",
    reviewState: "none",
    checksState: "pending",
    checksPendingSince: CI_REGISTERED,
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: CI_REGISTERED,
    headSha: HEAD,
    autoMergeArmed: false,
    reviewOrphanedByPush: true,
    priorReviewAttemptsForInput: 0,
    reviewedOwnDiffDigest: OWN_DIFF,
    currentOwnDiffDigest: OWN_DIFF,
    reviewedContractDigest: CONTRACT,
    currentContractDigest: CONTRACT,
    reviewedMergeBaseSha: REVIEWED_BASE,
    currentMergeBaseSha: CURRENT_BASE,
    reviewedHeadSha: JUDGED_HEAD,
    ...over,
  } as OpenPrView;
}

const PR_FILES = ["src/lib/feature.ts", "test/feature.test.ts"];
const CLOSURE = new Map<string, ReadonlySet<string>>([
  ["test/feature.test.ts", new Set(["test/feature.test.ts", "src/lib/feature.ts", "src/lib/helper.ts"])],
]);

function reach(mainChangedFiles: string[], over: Partial<ReviewReuseReach> = {}): ReviewReuseReach {
  return {
    mainChangedFiles,
    prFiles: PR_FILES,
    proofTargetPaths: ["test/feature.test.ts"],
    proofTestFiles: ["test/feature.test.ts"],
    closure: CLOSURE,
    ...over,
  };
}

function sweepDeps(readReviewReuseReach?: SweepDeps["readReviewReuseReach"]): SweepDeps & { modes: string[]; reads: string[] } {
  const modes: string[] = [];
  const reads: string[] = [];
  return {
    modes,
    reads,
    arm: () => assert.fail("a review disposition never arms"),
    close: () => assert.fail("a review disposition never closes"),
    dispatchFix: () => assert.fail("a review disposition never dispatches a fix"),
    escalate: () => assert.fail("a review disposition never escalates"),
    postReview: async (_pr, mode) => {
      modes.push(mode?.kind ?? "full-review");
    },
    ...(readReviewReuseReach === undefined
      ? {}
      : {
          readReviewReuseReach: async (pr, from, to) => {
            reads.push(`${from}...${to}`);
            return readReviewReuseReach(pr, from, to);
          },
        }),
    ledgerPath: writeLedger().path,
    runId: "W1-T9047",
    now: () => NOW,
  };
}

function reachRows(ledgerPath: string): Record<string, unknown>[] {
  return readLedgerLines(ledgerPath).filter((line) => line.step === "sweep.review_reuse_reach");
}

test("W1-T9047: a base-merge head with pending CI is reviewed by reuse, not a full review", async () => {
  // (a) The fleet-refresh shape: pending CI, merge base moved, and main touched nothing the review
  // judged. At origin/main the pending-CI post-review row dispatched `full-review` here.
  const unreached = sweepDeps(async () => reach(["docs/unrelated.md", "src/lib/elsewhere.ts"]));
  const summary = await runSweep([refreshedPr()], unreached);
  assert.deepEqual(unreached.modes, ["reuse"], "a refreshed head whose own diff is unchanged reuses its verdict");
  assert.deepEqual(unreached.reads, [`${REVIEWED_BASE}...${CURRENT_BASE}`], "main's delta is read between the two merge bases");
  assert.equal(summary.byDisposition["post-review"], 1, "the pending-CI row still claims the PR");
  const [row] = reachRows(unreached.ledgerPath);
  assert.equal(row?.requested_review_mode, "discriminate-only");
  assert.equal(row?.effective_review_mode, "reuse");
  assert.deepEqual(row?.counted_paths, []);
  assert.equal(row?.reach_complete, true);
  const disposed = readLedgerLines(unreached.ledgerPath).find((line) => line.step === "sweep.disposed");
  assert.equal(disposed?.disposition, "review-reused", "the disposed row records the reuse, not a post-review");
  assert.match(String(disposed?.reason), /the head only took main since the verdict on d00dfee; reusing that verdict \(W1-T9047\)/);

  // (b) Merge base unchanged (a no-op force-push while CI runs): reuse outright, no reach read.
  const sameBase = sweepDeps(async () => assert.fail("an unmoved merge base needs no reach read"));
  await runSweep([refreshedPr({ currentMergeBaseSha: REVIEWED_BASE })], sameBase);
  assert.deepEqual(sameBase.modes, ["reuse"]);

  // (c) No reach reader wired: the pending-CI head still gets discrimination alone, not a full
  // LLM review, and the disposed row names the cheaper path.
  const unwired = sweepDeps();
  await runSweep([refreshedPr()], unwired);
  assert.deepEqual(unwired.modes, ["discriminate-only"]);
  assert.deepEqual(reachRows(unwired.ledgerPath), [], "no reader, no reach row");
  const unwiredDisposed = readLedgerLines(unwired.ledgerPath).find((line) => line.step === "sweep.disposed");
  assert.match(String(unwiredDisposed?.reason), /re-running discrimination alone \(W1-T9047\)/);

  // (d) The pending-CI row on a head that orphaned NO review, or whose own diff changed, is still
  // an ordinary full review.
  assert.deepEqual(reviewDispatchModeFor(refreshedPr({ reviewOrphanedByPush: false }), "post-review"), { kind: "full-review" });
  assert.deepEqual(reviewDispatchModeFor(refreshedPr({ currentOwnDiffDigest: "own-diff:changed" }), "post-review"), { kind: "full-review" });
  assert.deepEqual(
    reviewDispatchModeFor(refreshedPr({ checksState: "green" }), "post-review"),
    { kind: "full-review" },
    "a green post-review is reached only once the reuse rows refused, so it stays a full review",
  );
});

test("W1-T9047: a main change inside the PR's proof import closure forces a full review", async () => {
  // (a) Main changed a module the proof test imports (not a PR file): full review.
  const closureHit = sweepDeps(async () => reach(["src/lib/helper.ts", "docs/unrelated.md"]));
  await runSweep([refreshedPr()], closureHit);
  assert.deepEqual(closureHit.modes, ["full-review"]);
  const [row] = reachRows(closureHit.ledgerPath);
  assert.equal(row?.effective_review_mode, "full-review");
  assert.deepEqual(row?.counted_paths, ["src/lib/helper.ts"]);
  assert.match(String(row?.reason), /main changed 1 path\(s\) the review judged \(src\/lib\/helper\.ts\)/);

  // (b) Main changed one of the PR's own files: full review, on the GREEN discrimination row too,
  // which at origin/main ran discrimination alone without asking.
  const fileHit = sweepDeps(async () => reach(["src/lib/feature.ts"]));
  await runSweep([refreshedPr({ checksState: "green" })], fileHit);
  assert.deepEqual(fileHit.modes, ["full-review"]);

  // (c) A proof target path the PR does not change (a `grep:` target) also counts.
  assert.deepEqual(
    mainDeltaReachingReview(reach(["src/lib/target.ts"], { proofTargetPaths: ["src/lib/target.ts"] })).counted,
    ["src/lib/target.ts"],
  );

  // (d) Evidence that cannot prove "unreached" keeps discrimination; it never upgrades to reuse.
  const judged = { kind: "discriminate-only" as const, judgedHeadSha: JUDGED_HEAD };
  const unknownClosure = mainDeltaReachingReview(reach(["docs/x.md"], { closure: undefined }));
  assert.equal(unknownClosure.complete, false);
  assert.deepEqual(reviewModeAfterReach(judged, unknownClosure).mode, judged);
  const truncated = mainDeltaReachingReview(reach(Array.from({ length: 300 }, (_, i) => `docs/${i}.md`)));
  assert.equal(truncated.complete, false, "a 300-file compare may be truncated");
  assert.deepEqual(reviewModeAfterReach(judged, truncated).mode, judged);
  assert.deepEqual(reviewModeAfterReach(judged, undefined).mode, judged);
  assert.deepEqual(reviewModeAfterReach({ kind: "full-review" }, { counted: [], complete: true }).mode, { kind: "full-review" });

  // (e) A reach read that throws is ledgered with its reason, and keeps discrimination.
  const failing = sweepDeps(async () => {
    throw new Error("compare 502");
  });
  await runSweep([refreshedPr()], failing);
  assert.deepEqual(failing.modes, ["discriminate-only"]);
  const [failedRow] = reachRows(failing.ledgerPath);
  assert.match(String(failedRow?.reason), /unread: compare 502$/);

  // (f) The production reader: proof paths come from the plan task, proof tests from those paths
  // and the PR's own suites, and the closure is read at the current merge base.
  const closureAsks: Array<{ files: readonly string[]; mainSha: string }> = [];
  const plan = {
    tasks: [{ id: TASK, acceptance: [
      { claim: "c1", proof: "grep: needle in src/lib/target.ts" },
      { claim: "c2", proof: "unit test: W1-T9047F: the feature works" },
    ] }],
  } as unknown as Plan;
  const read = reviewReuseReachReader({
    plan,
    readFacts: (from, to, head) => {
      assert.deepEqual([from, to, head], [REVIEWED_BASE, CURRENT_BASE, HEAD]);
      return { mainChangedFiles: ["src/lib/helper.ts"], prFiles: PR_FILES, blobFallbackPaths: [] };
    },
    readTestImportClosure: async (_pr, files, mainSha) => {
      closureAsks.push({ files, mainSha });
      return CLOSURE;
    },
  });
  const viaReader = sweepDeps(read);
  await runSweep([refreshedPr()], viaReader);
  assert.deepEqual(viaReader.modes, ["full-review"], "the real reader finds the closure hit");
  assert.deepEqual(closureAsks, [{ files: ["test/feature.test.ts"], mainSha: CURRENT_BASE }]);
  const built = await read(refreshedPr(), REVIEWED_BASE, CURRENT_BASE);
  assert.deepEqual(built?.proofTargetPaths, ["src/lib/target.ts"]);

  // (g) The effect builder wires that reader to two paced compares over its own `ghJsonImpl`.
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9047-"));
  try {
    const asked: string[] = [];
    const effects = buildSweepEffects({
      owner: "o",
      repo: "r",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "W1-T9047",
      plan,
      log: () => {},
      policy: DEFAULT_SWEEP_POLICY,
      ghJsonImpl: ((args: string[]) => {
        asked.push(args[1]);
        return args[1].endsWith(`${REVIEWED_BASE}...${CURRENT_BASE}`)
          ? { files: [{ filename: "docs/unrelated.md" }] }
          : { files: [{ filename: "src/lib/feature.ts", patch: "@@ -1 +1 @@\n-a\n+b" }, { filename: "bin.png", sha: "b1" }] };
      }) as never,
      readTestImportClosureImpl: async () => assert.fail("this PR changes no test suite, so no closure is read"),
    } as unknown as BuildSweepEffectsDeps);
    const wired = await effects.readReviewReuseReach!(refreshedPr({ taskId: undefined, body: "" }), REVIEWED_BASE, CURRENT_BASE);
    assert.deepEqual(asked, [`repos/o/r/compare/${REVIEWED_BASE}...${CURRENT_BASE}`, `repos/o/r/compare/${CURRENT_BASE}...${HEAD}`]);
    assert.deepEqual(wired?.mainChangedFiles, ["docs/unrelated.md"]);
    assert.deepEqual(wired?.blobFallbackPaths, ["bin.png"]);
    assert.deepEqual(mainDeltaReachingReview(wired!), { counted: [], complete: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9047: the own-diff digest ignores line shifts from main", () => {
  // The PR's one hunk, before and after main inserted 30 lines above it in the same file. The blob
  // sha differs (main edited the file); the hunk header's line numbers and function text differ.
  const before = [
    { filename: "src/lib/sweep.ts", status: "modified", sha: "blob-before", patch: "@@ -10,3 +10,4 @@ function a() {\n ctx1\n+added line\n ctx2" },
    { filename: "test/x.test.ts", status: "added", sha: "blob-test", patch: "@@ -0,0 +1,2 @@\n+line 1\n+line 2" },
  ];
  const shifted = [
    { ...before[0], sha: "blob-after-main", patch: "@@ -40,3 +40,4 @@ function moved() {\n ctx1\n+added line\n ctx2" },
    before[1],
  ];
  assert.equal(ownDiffDigestFromCompareFiles(shifted), ownDiffDigestFromCompareFiles(before), "line shifts and blob moves are not the PR's change");
  assert.equal(hunksWithoutLineNumbers(shifted[0].patch), "@@\n ctx1\n+added line\n ctx2");

  // A change to the PR's own hunk still moves the digest.
  const edited = [{ ...before[0], patch: "@@ -10,3 +10,4 @@ function a() {\n ctx1\n+a different line\n ctx2" }, before[1]];
  assert.notEqual(ownDiffDigestFromCompareFiles(edited), ownDiffDigestFromCompareFiles(before));

  // No patch from GitHub (binary or too large): the blob sha stands in, and the detail says so.
  const binary = { filename: "assets/logo.png", status: "modified", sha: "blob-png-1" };
  const detail = ownDiffDigestDetail([...before, binary]);
  assert.deepEqual(detail.blobFallbackPaths, ["assets/logo.png"]);
  assert.notEqual(ownDiffDigestDetail([...before, { ...binary, sha: "blob-png-2" }]).digest, detail.digest);
  assert.deepEqual(ownDiffDigestDetail(before).blobFallbackPaths, []);

  // Both sides of the reuse comparison go through the compare producer, which uses the same digest.
  const facts = fetchReviewReuseFacts("o", "r", "main", HEAD, (() => ({ merge_base_commit: { sha: CURRENT_BASE }, files: shifted })) as never);
  assert.equal(facts.ownDiffDigest, ownDiffDigestFromCompareFiles(before));

  // The reach compare refuses a response with no files list rather than reading it as "nothing changed".
  assert.throws(() => fetchReviewReuseReachFacts("o", "r", REVIEWED_BASE, CURRENT_BASE, HEAD, (() => ({})) as never), /no files list/);
});

test("W1-T9047: reuse facts reach every orphaned PR, fleet heads first under a cap, and the overflow is reported", () => {
  const fetch = ((args: string[]) => ({ merge_base_commit: { sha: CURRENT_BASE }, files: [], asked: args[1] })) as never;
  const prs = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, headRefOid: `h${i + 1}` }));
  assert.equal(hydrateReviewReuseFacts("o", "r", "main", prs, fetch).size, 30, "the 26th orphaned PR is no longer dropped");

  const asked: string[] = [];
  const pastCap: Array<[number, number]> = [];
  const out = hydrateReviewReuseFacts(
    "o", "r", "main",
    [
      { number: 1, headRefOid: "hand1", headRefName: "feature/by-hand" },
      { number: 2, headRefOid: "fleet2", headRefName: "run-W1-T1-1" },
      { number: 3, headRefOid: "hand3" },
    ],
    ((args: string[]) => {
      asked.push(args[1]);
      return { merge_base_commit: { sha: CURRENT_BASE }, files: [] };
    }) as never,
    2,
    undefined,
    (prNumber, cap) => pastCap.push([prNumber, cap]),
  );
  assert.deepEqual([...out.keys()], [2, 1], "the fleet head is hydrated first");
  assert.deepEqual(asked, ["repos/o/r/compare/main...fleet2", "repos/o/r/compare/main...hand1"]);
  assert.deepEqual(pastCap, [[3, 2]], "a PR past the cap is reported, never silently left to a full review");
});
