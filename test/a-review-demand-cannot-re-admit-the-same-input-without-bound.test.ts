import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  REVIEW_INPUT_ADMISSION_BACKSTOP,
  deriveDisposition,
  reviewInputLoopFacts,
  runSweep,
  type ClarificationQuestion,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { appendLedger } from "../src/lib/ledger.js";
import { reviewAttemptsForInput } from "../src/run-task.js";

// W1-T5863 — the live #9305 shape: the sweep keys the review `PR-9305`, but the posts were written
// under `unfiled` with an input digest the count cannot match, so it reads zero while review.posted
// SUCCESS rows pile up (W1-T5839 closed the key mismatch itself; the next mismatch is the target).
const NOW = Date.parse("2026-10-05T12:30:00Z");
const PR_URL = "https://github.com/o/r/pull/9305";
const HEAD = "a".repeat(40);
const DIGEST = "v1:looping-input";
const KEY = "PR-9305";

type Row = Record<string, unknown>;

function admitted(ts: string, over: Row = {}): Row {
  return { ts, step: "sweep.review_admitted", task_id: "SWEEP", pr_number: 9305, pr_url: PR_URL, head_sha: HEAD,
    review_key: KEY, review_input_digest: DIGEST, ...over };
}
function posted(ts: string, over: Row = {}): Row {
  return { ts, step: "review.posted", task_id: "unfiled", pr_url: PR_URL, head_sha: HEAD, review_input_digest: "v1:digest-the-sweep-cannot-match", ...over };
}

/** The view the real producer builds: facts from the ledger, count from the keyed attempt reader. */
function viewFor(ledger: Row[], over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9305,
    prUrl: PR_URL,
    taskId: undefined,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-05T11:00:00Z",
    headSha: HEAD,
    autoMergeArmed: false,
    reviewInputDigest: DIGEST,
    priorReviewAttemptsForInput: reviewAttemptsForInput(ledger, KEY, PR_URL, HEAD, DIGEST).attempts,
    reviewInputLoop: reviewInputLoopFacts(ledger, PR_URL, HEAD, DIGEST, KEY),
    ...over,
  };
}

const TWO_LOOPS: Row[] = [
  admitted("2026-10-05T11:56:00Z"), posted("2026-10-05T11:57:00Z"),
  admitted("2026-10-05T11:58:00Z"), posted("2026-10-05T11:59:00Z"),
];

function deps(ledgerPath: string, over: Partial<SweepDeps> = {}): SweepDeps & {
  escalated: Array<{ reason: string; question: ClarificationQuestion }>;
  reviewed: number[];
} {
  const escalated: Array<{ reason: string; question: ClarificationQuestion }> = [];
  const reviewed: number[] = [];
  return {
    escalated,
    reviewed,
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: (_p, reason, question) => { escalated.push({ reason, question }); },
    postReview: (p) => { reviewed.push(p.prNumber); },
    ledgerPath,
    runId: "SWEEP-1",
    now: () => NOW,
    ...over,
  } as SweepDeps & { escalated: typeof escalated; reviewed: number[] };
}

test("unit test: test/a-review-demand-cannot-re-admit-the-same-input-without-bound.test.ts", async () => {
  // The fixture really is the mismatch: the keyed count cannot see the four posts under `unfiled`.
  assert.equal(reviewAttemptsForInput(TWO_LOOPS, KEY, PR_URL, HEAD, DIGEST).attempts, 0);
  const facts = reviewInputLoopFacts(TWO_LOOPS, PR_URL, HEAD, DIGEST, KEY);
  assert.deepEqual(facts, { admissions: 2, postsSinceLastAdmission: 1, posts: 2, lookedUpKey: KEY });
  assert.equal(REVIEW_INPUT_ADMISSION_BACKSTOP, 2);

  // First and second admissions still proceed: nothing admitted yet, then one admission + one post.
  assert.equal(deriveDisposition(viewFor([]), DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  const afterFirst = TWO_LOOPS.slice(0, 2);
  assert.equal(deriveDisposition(viewFor(afterFirst), DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  // A second admission whose post has not completed yet is still in flight, not a loop.
  const secondInFlight = [...afterFirst, admitted("2026-10-05T11:58:00Z")];
  assert.equal(deriveDisposition(viewFor(secondInFlight), DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");

  // Two admissions with completed posts the count cannot see: the third pass is not admitted.
  const looped = deriveDisposition(viewFor(TWO_LOOPS), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(looped.disposition, "blocked-ambiguous");
  assert.match(looped.reason, /^post-review-loop:/);
  assert.match(looped.reason, /#9305/);
  assert.match(looped.reason, /admitted for review 2 time\(s\)/);
  assert.match(looped.reason, /2 review\.posted row\(s\)/);
  assert.match(looped.reason, /key PR-9305/);

  // A new head starts a fresh count.
  const NEW_HEAD = "b".repeat(40);
  const fresh = viewFor(TWO_LOOPS, {
    headSha: NEW_HEAD,
    priorReviewAttemptsForInput: 0,
    reviewInputLoop: reviewInputLoopFacts(TWO_LOOPS, PR_URL, NEW_HEAD, DIGEST, KEY),
  });
  assert.equal(deriveDisposition(fresh, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
  // So does a new input digest on the same head.
  const newDigest = viewFor(TWO_LOOPS, {
    reviewInputDigest: "v1:edited-body",
    priorReviewAttemptsForInput: 0,
    reviewInputLoop: reviewInputLoopFacts(TWO_LOOPS, PR_URL, HEAD, "v1:edited-body", KEY),
  });
  assert.equal(deriveDisposition(newDigest, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");

  // A count that CAN see the posts keeps its ordinary behaviour; the backstop never overrides it.
  const seen = viewFor(TWO_LOOPS, { priorReviewAttemptsForInput: 2 });
  assert.equal(deriveDisposition(seen, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");

  // End to end through runSweep: no review is admitted, one escalation names the PR and both counts.
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-t5863-")), "ledger.ndjson");
  for (const row of TWO_LOOPS) appendLedger(ledgerPath, row as never);
  const d = deps(ledgerPath);
  const summary = await runSweep([viewFor(TWO_LOOPS)], d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(d.reviewed, [], "the third pass must not re-run the reviewer");
  assert.equal(summary.byDisposition["post-review"], 0);
  assert.equal(d.escalated.length, 1);
  assert.match(d.escalated[0]!.reason, /post-review-loop/);
  assert.match(d.escalated[0]!.reason, /#9305/);
  assert.match(d.escalated[0]!.reason, /admitted for review 2 time/);
  assert.match(d.escalated[0]!.reason, /2 review\.posted row/);

  // The next pass over the unchanged input does not raise a second escalation.
  const d2 = deps(ledgerPath);
  await runSweep([viewFor(TWO_LOOPS)], d2, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(d2.reviewed, []);
  assert.equal(d2.escalated.length, 0, "one escalation per input, not one per pass");
});
