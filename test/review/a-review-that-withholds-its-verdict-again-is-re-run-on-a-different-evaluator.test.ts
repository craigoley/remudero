import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { judgeReview, type ReviewEvidence, type ReviewVerdict } from "#src/lib/review.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { appendLedger } from "#src/lib/ledger.js";
import {
  DEFAULT_SWEEP_POLICY,
  REVIEW_WITHHELD_EXHAUSTED_STEP,
  deriveDisposition,
  reviewWithheldLadder,
  runSweep,
  withheldEvaluatorsForInput,
  type ClarificationQuestion,
  type OpenPrView,
  type ReviewDispatchPr,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

type Row = Record<string, unknown>;

const NOW = Date.parse("2026-11-20T12:30:00Z");
const PR_URL = "https://github.com/o/r/pull/19673";
const HEAD = "d5c1e619".padEnd(40, "0");
const DIGEST = "v1:input-a";
const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13945-`));
after(() => rmSync(tmp, { recursive: true, force: true }));

function routing(eligible: string[], over: Row = {}): Row {
  return { ...over, execution_evidence: { assignment: { value: { routing: { decision: {
    considered: ["claude", "codex"].map((provider) => ({ provider, eligible: eligible.includes(provider), selected: false })),
  } } } } } };
}
/** One withheld review attempt, shaped like the 2026-11-20 rows: a pending claim, the reviewer row, the withheld verdict. */
function attempt(n: number, over: { onRow?: boolean; provider?: string; eligible?: string[]; unhonoured?: boolean; head?: string; digest?: string } = {}): Row[] {
  const runId = `review-PR19673-${n}`;
  const provider = over.provider ?? "codex";
  const head = over.head ?? HEAD;
  const digest = over.digest ?? DIGEST;
  const at = (s: number) => new Date(NOW - (10 - n) * 60_000 + s * 1000).toISOString();
  return [
    { ts: at(0), run_id: runId, task_id: "W1-T12936", step: "review.pending_posted", pr_url: PR_URL, head_sha: head },
    { ts: at(1), run_id: runId, task_id: "W1-T12936", step: "review.reviewer", provider, routed_model: "gpt-6.2-sol",
      ...routing(over.eligible ?? ["codex"]),
      ...(over.unhonoured ? { exclusion_unhonoured: { reason: "no-eligible-alternative", excludedProviders: [provider] } } : {}) },
    { ts: at(2), run_id: runId, task_id: "W1-T12936", step: "review.semantic_incomplete", pr_url: PR_URL, head_sha: head,
      review_input_digest: digest, reason: "reviewer output incomplete", reviewer_outcome: "error_incomplete_output",
      ...(over.onRow ? { provider, routed_model: "gpt-6.2-sol" } : {}) },
  ];
}

function viewFor(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 19673, prUrl: PR_URL, taskId: "W1-T12936", reviewState: "pending", reviewPendingOwnerDead: true,
    reviewPendingSince: new Date(NOW - 20 * 60_000).toISOString(), checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-11-20T11:00:00Z", headSha: HEAD, autoMergeArmed: false, reviewInputDigest: DIGEST, ...over,
  } as OpenPrView;
}

let ledgerSeq = 0;
function sweepDeps(rows: Row[]): SweepDeps & { escalated: Array<{ reason: string; question: ClarificationQuestion }>;
  reviewed: ReviewDispatchPr[]; ledgerPath: string } {
  const dir = join(tmp, `ledger-${ledgerSeq++}`);
  mkdirSync(dir, { recursive: true });
  const ledgerPath = join(dir, "ledger.ndjson");
  for (const row of rows) appendLedger(ledgerPath, row as never);
  const escalated: Array<{ reason: string; question: ClarificationQuestion }> = [];
  const reviewed: ReviewDispatchPr[] = [];
  return { escalated, reviewed, ledgerPath, arm: () => {}, close: () => {}, dispatchFix: () => {},
    escalate: (_p: unknown, reason: string, question: ClarificationQuestion) => { escalated.push({ reason, question }); },
    postReview: (p: unknown) => { reviewed.push(p as ReviewDispatchPr); }, runId: "SWEEP-1", now: () => NOW } as never;
}
const rowsAt = (path: string): Row[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);

test("W1-T13945 criterion 1: two withheld attempts on codex re-admit with codex excluded and name both attempts", async () => {
  const rows = [...attempt(1), ...attempt(2, { onRow: true, eligible: ["claude", "codex"] })];
  // The evaluator comes from the row when it carries one, else from the same run's review.reviewer row.
  const withheld = withheldEvaluatorsForInput(viewFor(), rows);
  assert.deepEqual(withheld.attempts.map((a) => [a.runId, a.provider, a.routedModel]),
    [["review-PR19673-1", "codex", "gpt-6.2-sol"], ["review-PR19673-2", "codex", "gpt-6.2-sol"]]);
  assert.deepEqual(withheld.eligible, ["claude", "codex"]);
  const ladder = reviewWithheldLadder(viewFor(), rows);
  assert.equal(ladder?.rung, 2);
  assert.deepEqual(ladder?.excludeProviders, ["codex"]);

  const view = viewFor({ reviewWithheld: ladder });
  const derived = deriveDisposition({ ...view, reviewPendingOwnerGone: "owner-pid-dead" } as OpenPrView, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(derived.disposition, "post-review");
  for (const text of ["review-PR19673-1", "review-PR19673-2", "codex", "gpt-6.2-sol", "reviewer output incomplete"]) {
    assert.ok(derived.reason.includes(text), `${text} is named in: ${derived.reason}`);
  }
  // At base the same pending view re-admits through the plain owner-proven-dead reason, with no exclusion.
  const base = deriveDisposition({ ...viewFor(), reviewPendingOwnerGone: "owner-pid-dead" } as OpenPrView, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(base.reason, "checks green, remudero-review owner proven dead — re-running the review lane on #19673");

  const d = sweepDeps(rows);
  await runSweep([viewFor()], d, DEFAULT_SWEEP_POLICY);
  assert.equal(d.reviewed.length, 1);
  assert.deepEqual(d.reviewed[0]!.excludeProviders, ["codex"]);
  const disposed = rowsAt(d.ledgerPath).findLast((r) => r.step === "sweep.disposed");
  assert.equal(disposed?.disposition, "post-review");
  assert.match(String(disposed?.reason), /review-PR19673-1.*review-PR19673-2/);
});

test("W1-T13945 criterion 2: a proof that could not complete twice at no higher load grades failed", () => {
  const PROOF_FILE = "test/load-shaped.test.ts";
  const checkout = mkdtempSync(join(tmp, "checkout-"));
  mkdirSync(join(checkout, "test"), { recursive: true });
  writeFileSync(join(checkout, PROOF_FILE), "import { test } from 'node:test'; test('x', () => {});\n");
  const criteria = [{ claim: "the behaviour holds", proof: `unit test: ${PROOF_FILE}` }];
  const timeout = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
  const sample = (load1: number) => () => ({ load1, cpuPsiSomeAvg10Pct: 10 });
  const judge = (startLoad: number, prior: number | undefined): ReviewVerdict => judgeReview(criteria, {
    diff: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
    report: `the behaviour holds ${PROOF_FILE}`, headCheckoutDir: checkout, sampleLoad: sample(startLoad),
    execProof: () => { throw timeout; },
    ...(prior === undefined ? {} : { priorInconclusiveStartLoads: new Map([[criteria[0]!.proof, prior]]) }),
  } as ReviewEvidence);

  const twice = judge(12, 15.77);
  assert.equal(twice.criteria[0]!.proof_exec, "exec_error");
  assert.equal(twice.criteria[0]!.met, false);
  assert.equal(twice.state, "failure", "the review posts failure, so the PR goes to the fix lane");
  assert.match(twice.criteria[0]!.reason, new RegExp(PROOF_FILE.replace(/[.]/g, "\\.")));
  assert.match(twice.criteria[0]!.reason, /load1 15\.77/);
  assert.match(twice.criteria[0]!.reason, /load1 12\b/);
  assert.equal(judge(15.77, 15.77).criteria[0]!.proof_exec, "exec_error", "at the prior start load counts as no higher");
  // A second attempt that starts above the prior load stays inconclusive, as does a first attempt with no prior load.
  assert.equal(judge(20, 15.77).criteria[0]!.proof_exec, "inconclusive_load");
  assert.equal(judge(20, 15.77).state, "pending");
  assert.equal(judge(12, undefined).criteria[0]!.proof_exec, "inconclusive_load");
  assert.equal(judge(12, undefined).state, "pending");
});

test("W1-T13945 criterion 3: every eligible evaluator withheld holds the input and escalates once", async () => {
  // Only codex was eligible and it withheld twice: no alternative is left, so the input is held.
  const exhaustedRows = [...attempt(1), ...attempt(2)];
  assert.equal(reviewWithheldLadder(viewFor(), exhaustedRows)?.rung, 4);
  // The latest attempt's own exclusion found no eligible alternative: held even with an unknown eligible set.
  const unhonoured = [...attempt(1, { eligible: [] }), ...attempt(2, { eligible: [], unhonoured: true })];
  assert.equal(withheldEvaluatorsForInput(viewFor(), unhonoured).eligible, undefined);
  assert.equal(reviewWithheldLadder(viewFor(), unhonoured)?.rung, 4);
  // An unknown eligible set alone never holds: rung 2 runs.
  assert.equal(reviewWithheldLadder(viewFor(), [...attempt(1, { eligible: [] }), ...attempt(2, { eligible: [] })])?.rung, 2);
  // An eligible provider that has not withheld is still to be tried.
  assert.equal(reviewWithheldLadder(viewFor(), [...attempt(1, { eligible: ["claude", "codex"] }),
    ...attempt(2, { eligible: ["claude", "codex"] })])?.rung, 2);
  // It is tried, and once it withheld too nothing is left.
  assert.equal(reviewWithheldLadder(viewFor(), [...attempt(1, { eligible: ["claude", "codex"] }),
    ...attempt(2, { eligible: ["claude", "codex"] }), ...attempt(3, { provider: "claude", eligible: ["claude", "codex"] })])?.rung, 4);

  const d = sweepDeps(exhaustedRows);
  await runSweep([viewFor()], d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(d.reviewed, [], "no review is admitted");
  assert.equal(d.escalated.length, 1);
  assert.match(d.escalated[0]!.reason, /review-PR19673-1/);
  const holds = rowsAt(d.ledgerPath).filter((r) => r.step === REVIEW_WITHHELD_EXHAUSTED_STEP);
  assert.equal(holds.length, 1);
  assert.deepEqual((holds[0]!.attempts as Row[]).map((a) => [a.run_id, a.provider, a.cause]),
    [["review-PR19673-1", "codex", "reviewer output incomplete"], ["review-PR19673-2", "codex", "reviewer output incomplete"]]);

  // A later pass at the same input neither re-admits nor escalates again.
  const again = sweepDeps(rowsAt(d.ledgerPath));
  await runSweep([viewFor()], again, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(again.reviewed, []);
  assert.equal(again.escalated.length, 0);
  assert.equal(rowsAt(again.ledgerPath).filter((r) => r.step === REVIEW_WITHHELD_EXHAUSTED_STEP).length, 1);
  // A new head starts the ladder again.
  const newHead = "e".repeat(40);
  const fresh = sweepDeps(rowsAt(d.ledgerPath));
  await runSweep([viewFor({ headSha: newHead })], fresh, DEFAULT_SWEEP_POLICY);
  assert.equal(fresh.reviewed.length, 1);
  assert.equal(fresh.reviewed[0]!.excludeProviders, undefined);
});

test("W1-T13945 criterion 4: a first withheld verdict is re-reviewed once exactly as before", async () => {
  const rows = attempt(1);
  assert.equal(reviewWithheldLadder(viewFor(), rows), undefined);
  const derived = deriveDisposition({ ...viewFor(), reviewPendingOwnerGone: "owner-pid-dead" } as OpenPrView, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(derived.reason, "checks green, remudero-review owner proven dead — re-running the review lane on #19673");
  const d = sweepDeps(rows);
  await runSweep([viewFor()], d, DEFAULT_SWEEP_POLICY);
  assert.equal(d.reviewed.length, 1);
  assert.equal(d.reviewed[0]!.excludeProviders, undefined, "no provider exclusion on the first withhold");
  // Attempts at another head, or another review input digest, are another input and do not count.
  assert.equal(reviewWithheldLadder(viewFor(), [...attempt(1, { head: "f".repeat(40) }), ...attempt(2)]), undefined);
  assert.equal(reviewWithheldLadder(viewFor(), [...attempt(1, { digest: "v1:input-b" }), ...attempt(2)]), undefined);
  assert.equal(reviewWithheldLadder(viewFor({ reviewInputDigest: "v1:input-b" }), [...attempt(1), ...attempt(2)]), undefined);
  // A terminal verdict at the input ends the count.
  const settled = [...attempt(1), { ts: new Date(NOW).toISOString(), step: "review.posted", pr_url: PR_URL, head_sha: HEAD,
    review_input_digest: DIGEST, state: "failure", decision_verdict: { state: "failure", criteria: [] } }, ...attempt(2)];
  assert.equal(reviewWithheldLadder(viewFor(), settled), undefined);
});
