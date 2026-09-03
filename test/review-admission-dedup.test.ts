import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweepLightPass,
  selectReviewAdmissions,
  type OpenPrView,
  type ReviewAdmissionOutcomes,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.parse("2026-09-01T20:00:00Z");
const CLOSED_LIFECYCLE_REFUSAL_REASON =
  "PR is already closed — refusing to post remudero-review against a closed lifecycle (W1-T228 lifecycle rule)";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-review-admission-dedup-")), "ledger.ndjson");
}

function reviewPr(n: number, createdAt: string, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n,
    prUrl: `https://github.com/o/r/pull/${n}`,
    taskId: `W1-T${n}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: createdAt,
    createdAt,
    headSha: `sha-${n}`,
    autoMergeArmed: false,
    ...over,
  };
}

function deps(path: string, posted: number[], over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (pr) => {
      posted.push(pr.prNumber);
    },
    ledgerPath: path,
    runId: "SWEEP-W1-T2583",
    now: () => NOW,
    ...over,
  };
}

test("W1-T2583: a delivered oldest head cannot spend the spawning admission", async () => {
  const path = ledgerPath();
  const delivered = reviewPr(10, "2026-08-25T00:00:00Z");
  const unreviewed = reviewPr(20, "2026-08-26T00:00:00Z");
  appendLedger(path, {
    run_id: "REVIEW-OLD",
    task_id: delivered.taskId ?? "",
    step: "review.posted",
    head_sha: delivered.headSha,
    state: "failure",
  });

  const posted: number[] = [];
  await runSweepLightPass([delivered, unreviewed], deps(path, posted));

  assert.deepEqual(posted, [20], "the genuinely unreviewed PR wins without the delivered head spending semantic capacity");
  const disposed = readLedgerLines(path).filter((line) => line.step === "sweep.disposed");
  const deliveredRow = disposed.find((line) => line.pr_number === 10);
  assert.match(String(deliveredRow?.stand_down_reason), /verdict was already DELIVERED/,
    "the excluded key still reaches the action-time dedup and names that fact, never a fake admission loss");
});

test("W1-T2583: an ordinary refusal is excluded but a reopened closed-lifecycle refusal stays eligible", async () => {
  const path = ledgerPath();
  const ordinary = reviewPr(10, "2026-08-25T00:00:00Z");
  const reopened = reviewPr(20, "2026-08-26T00:00:00Z");
  const younger = reviewPr(30, "2026-08-27T00:00:00Z");
  appendLedger(path, {
    run_id: "REVIEW-ORDINARY",
    task_id: ordinary.taskId ?? "",
    step: "review.post_refused",
    head_sha: ordinary.headSha,
    reason: "operator precedence refusal",
  });
  appendLedger(path, {
    run_id: "REVIEW-CLOSED",
    task_id: reopened.taskId ?? "",
    step: "review.post_refused",
    head_sha: reopened.headSha,
    reason: CLOSED_LIFECYCLE_REFUSAL_REASON,
  });

  const posted: number[] = [];
  await runSweepLightPass([ordinary, reopened, younger], deps(path, posted));

  assert.deepEqual(posted.sort((a, b) => a - b), [20, 30],
    "the ordinary refusal cannot win; the reopened refusal and next eligible head fill the two semantic lanes");
});

test("W1-T2583: a pass containing only delivered or refused heads dispatches no review and invents no admission loser", async () => {
  const path = ledgerPath();
  const delivered = reviewPr(10, "2026-08-25T00:00:00Z");
  const refused = reviewPr(20, "2026-08-26T00:00:00Z");
  appendLedger(path, {
    run_id: "REVIEW-DELIVERED",
    task_id: delivered.taskId ?? "",
    step: "review.posted",
    head_sha: delivered.headSha,
    state: "success",
  });
  appendLedger(path, {
    run_id: "REVIEW-REFUSED",
    task_id: refused.taskId ?? "",
    step: "review.post_refused",
    head_sha: refused.headSha,
    reason: "ordinary refusal",
  });

  const posted: number[] = [];
  await runSweepLightPass([delivered, refused], deps(path, posted));

  assert.deepEqual(posted, []);
  const reasons = readLedgerLines(path)
    .filter((line) => line.step === "sweep.disposed")
    .map((line) => String(line.stand_down_reason));
  assert.equal(reasons.length, 2);
  assert.ok(reasons.every((reason) => /DELIVERED|REFUSED/.test(reason)), "each head names its real outcome dedup");
  assert.ok(reasons.every((reason) => !/not admitted this pass/.test(reason)),
    "no head is reported as losing an admission when no actionable candidate existed");
});

test("W1-T2583: dedup filtering preserves both bounds and immutable oldest-first ordering", () => {
  const delivered = reviewPr(1, "2026-08-20T00:00:00Z");
  const builds = [
    delivered,
    reviewPr(2, "2026-08-21T00:00:00Z"),
    reviewPr(3, "2026-08-22T00:00:00Z"),
  ];
  const filings = [4, 5, 6, 7].map((n) => reviewPr(n, `2026-08-${20 + n}T00:00:00Z`, { isPlanFiling: true }));
  const outcomes: ReviewAdmissionOutcomes = {
    delivered: new Set([`${delivered.taskId}@${delivered.headSha}`]),
    refused: new Set(),
  };

  const selected = selectReviewAdmissions([...filings].reverse().concat([...builds].reverse()), DEFAULT_SWEEP_POLICY, NOW, outcomes);

  assert.deepEqual(selected.spawning.map((pr) => pr.prNumber), [2, 3],
    "both spawning slots go to the oldest non-deduped builds");
  assert.deepEqual(selected.planFilings.map((pr) => pr.prNumber), [4, 5, 6],
    "the plan-filing bound remains three and ordering remains immutable oldest-first");
});

test("W1-T2792: after the first pair delivers, the next pass admits the next pair", async () => {
  const path = ledgerPath();
  const prs = [1, 2, 3, 4].map((n) => reviewPr(n, `2026-08-2${n}T00:00:00Z`));
  const firstPosted: number[] = [];
  await runSweepLightPass(
    [...prs].reverse(),
    deps(path, firstPosted, {
      postReview: (pr) => {
        firstPosted.push(pr.prNumber);
        appendLedger(path, {
          run_id: "REVIEW-FIRST-PAIR",
          task_id: pr.taskId ?? "",
          step: "review.posted",
          head_sha: pr.headSha,
          state: "success",
        });
      },
    }),
  );
  assert.deepEqual(firstPosted.sort((a, b) => a - b), [1, 2]);

  const secondPosted: number[] = [];
  await runSweepLightPass([...prs].reverse(), deps(path, secondPosted, { runId: "REVIEW-SECOND-PAIR" }));
  assert.deepEqual(secondPosted.sort((a, b) => a - b), [3, 4],
    "delivered outcomes are excluded before ranking and spend no slot on the next pass");
});

test("W1-T2583/W1-T2771: selection reads once, per-PR guards re-read, and an admitted review re-reads at claim time", async () => {
  const path = ledgerPath();
  const prs = [reviewPr(10, "2026-08-25T00:00:00Z"), reviewPr(20, "2026-08-26T00:00:00Z")];
  appendLedger(path, {
    run_id: "REVIEW-DELIVERED",
    task_id: prs[0].taskId ?? "",
    step: "review.posted",
    head_sha: prs[0].headSha,
    state: "success",
  });
  let reads = 0;
  const posted: number[] = [];
  await runSweepLightPass(prs, deps(path, posted, {
    readLedger: (ledger) => {
      reads += 1;
      return readLedgerLines(ledger);
    },
  }));

  assert.equal(reads, prs.length + 2,
    "one selection read, one guard read per scoped runSweep call, and one fresh action-time read for the admitted review");
  assert.deepEqual(posted, [20]);
});

test("W1-T2583: the action-time review dedup remains the race-safe boundary", () => {
  const source = readFileSync(new URL("../src/lib/sweep.ts", import.meta.url), "utf8");
  assert.match(source, /prior\.reviewDelivered\.has\(reviewKey\)/);
  assert.match(source, /prior\.reviewRefused\.has\(reviewKey\)/);
});
