/**
 * W1-T14177 — a dead review owner's proof is superseded only by a live replacement, and the act-time re-check reads
 * GitHub's live review status before another review is admitted (INVARIANT one-live-review-owner).
 *
 * OBSERVED in #19922's round-11 review: deadOwnerProofSuperseded counted a COMPLETED pending hold, recorded under another
 * run id after a claim no-op, as a live replacement, so the green-CI promise-harvest retry kept waiting; and the act-time
 * re-check read only the ledger, so a takeover GitHub accepted before its ledger append was missed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { postReviewPending, reviewInputDigest } from "#src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deadOwnerProofSuperseded, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";

const NOW = Date.parse("2026-11-21T19:30:00.000Z");
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const SHA = "f".repeat(40);
const PR_URL = "https://github.com/o/r/pull/20065";
const BODY = "Remudero-Task: W1-T14177";
const OWNER = "review-PR20065-owner";
const NOOP = "review-PR20065-noop";
const LIVE = "review-PR20065-live";

/** A pending review claim whose owner the producer proved dead, 30 minutes after CI started. */
function ownerDeadView(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 20065, prUrl: PR_URL, taskId: "W1-T14177", headRefName: "run-W1-T14177-1795288835761", headSha: SHA,
    mergeState: "blocked", mergeableState: "blocked", autoMergeArmed: false, priorStrikes: 0, unmetCriteria: [],
    checksState: "pending", checksPendingSince: ago(30), lastActivityAt: ago(30), createdAt: ago(45),
    reviewState: "pending", reviewPendingSince: ago(20), reviewPendingOwnerDead: true, reviewPendingOwnerGone: "owner-pid-dead",
    reviewVerdictPostedAt: ago(20).replace(/\.\d{3}Z$/, "Z"), reviewPendingOwnerRunId: OWNER, reviewPendingStatusRunId: OWNER,
    priorReviewAttemptsForInput: 0, reviewInputDigest: reviewInputDigest(SHA, BODY),
    ...over,
  } as OpenPrView;
}

/** The owner's claim row and a promise-harvest hold another run completed after its own claim was a no-op. */
function ownerAndHoldRows(over: Partial<LedgerLine> = {}): LedgerLine[] {
  return [
    { run_id: OWNER, task_id: "W1-T14177", step: "review.pending_posted", head_sha: SHA, pr_url: PR_URL, ts: ago(20),
      host: hostname(), owner_pid: 41, owner_started_at: ago(20), review_input_digest: reviewInputDigest(SHA, BODY) },
    { run_id: NOOP, task_id: "W1-T14177", step: "review.posted", state: "pending", head_sha: SHA, pr_url: PR_URL, ts: ago(5),
      decision_verdict: { state: "pending", criteria: [], promisedFollowUpObservation: {
        state: "unknown", cause: "promise-harvest-incomplete", reason: "promise harvest unavailable: AbortError" } },
      ...over },
  ];
}

/** One sweep pass over `pr` with `rows` in its ledger; the act-time re-read answers `reread` (the view itself by default). */
async function sweepOnce(t: TestContext, pr: OpenPrView, rows: LedgerLine[],
  reread: SweepDeps["rereadPrAtAct"] = (view) => view) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14177-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  for (const row of rows) appendLedger(ledgerPath, row);
  const posted: OpenPrView[] = [];
  await runSweep([pr], {
    ledgerPath, runId: "sweep-t14177", now: () => NOW, rereadPrAtAct: reread,
    arm: () => assert.fail("pending review cannot arm"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    postReview: (candidate) => { posted.push(candidate); },
    reviewerCodeRecovery: { loadedCodeSha: "fresh-code", isLoadedCodeAtOrAfter: () => true, freshTreeReviewAvailable: true,
      probeFreshness: async () => ({ status: "fresh", codeSha: "fresh-code", originMainSha: "fresh-code", advance: "none" }) },
  }, DEFAULT_SWEEP_POLICY);
  const lines = readLedgerLines(ledgerPath);
  const row = lines.findLast((r) => r.step === "sweep.disposed" && r.pr_number === 20065);
  assert.ok(row, "the sweep disposed the head");
  return { row, posted, admitted: lines.some((r) => r.step === "sweep.review_admitted" && r.pr_number === 20065) };
}

test("W1-T14177 criterion 1: a completed promise-harvest hold under another run id does not supersede the dead owner's proof", async (t) => {
  for (const checks of ["green", "pending"] as const) {
    const pr = ownerDeadView(checks === "green" ? { checksState: "green", checksPendingSince: undefined } : {});
    assert.equal(deadOwnerProofSuperseded(pr, ownerAndHoldRows()), undefined, `${checks}: a completed hold holds no claim`);
    const r = await sweepOnce(t, pr, ownerAndHoldRows());
    assert.equal(r.row.disposition, "post-review", `${checks}: the retry re-runs the review instead of waiting`);
    assert.equal(r.row.acted, true, checks);
    assert.equal(r.posted.length, 1, checks);
  }
});

test("W1-T14177 criterion 1: a claim another run settled is no live replacement, and an unsettled one still is", () => {
  const pr = ownerDeadView();
  const claim: LedgerLine = { run_id: LIVE, task_id: "W1-T14177", step: "review.pending_posted", head_sha: SHA, pr_url: PR_URL,
    ts: ago(4), host: hostname(), owner_pid: process.pid, owner_started_at: ago(4) };
  for (const step of ["review.posted", "review.stood_down", "review.post_refused", "review.replay_input"]) {
    const settled: LedgerLine = { run_id: LIVE, task_id: "W1-T14177", step, head_sha: SHA, pr_url: PR_URL, ts: ago(2), state: "pending" };
    assert.equal(deadOwnerProofSuperseded(pr, [...ownerAndHoldRows(), claim, settled]), undefined, `${step} settles the claim`);
  }
  assert.equal(deadOwnerProofSuperseded(pr, [...ownerAndHoldRows(), claim]), LIVE, "a claim with no settled row is live");
});

/** The real view producer over the owner's claim row, with `description` as GitHub's live `remudero-review` status. */
async function producedView(dir: string, description: string, createdAt: string): Promise<OpenPrView> {
  const ledgerPath = join(dir, "ledger.ndjson");
  rmSync(ledgerPath, { force: true });
  appendLedger(ledgerPath, ownerAndHoldRows()[0]!);
  const row = { number: 20065, html_url: PR_URL, head: { ref: "run-W1-T14177-1795288835761", sha: SHA },
    updated_at: ago(30), created_at: ago(45), body: BODY, auto_merge: null, state: "open" };
  const [pr] = await buildOpenPrViewsAsync("o", "r", ledgerPath, {
    requiredContexts: () => ["ci-gate"],
    assessPendingOwner: (record) => record.runId === OWNER ? "dead" : "active",
    fetchAsync: async (args) => {
      const path = args.at(-1)!;
      if (path.includes("state=open")) return [row];
      if (path.includes("check-runs")) return { check_runs: [{ name: "ci-gate", status: "in_progress", started_at: ago(30) }] };
      if (path.includes("/statuses")) throw new Error("no status history in this fixture");
      if (path.includes("/status")) return { statuses: [{ context: "remudero-review", state: "pending", id: 7001, description,
        created_at: createdAt }] };
      if (path.endsWith("/pulls/20065")) return { ...row, mergeable: true, mergeable_state: "blocked" };
      return [];
    },
  });
  assert.ok(pr);
  return pr;
}

test("W1-T14177 criterion 2: a takeover GitHub accepted before its ledger append blocks a second admission", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14177-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const postedAt = ago(20).replace(/\.\d{3}Z$/, "Z");
  const view = await producedView(dir, `remudero-review: review in progress (owned by run ${OWNER})`, postedAt);
  assert.equal(view.reviewPendingOwnerDead, true, "the board read proved the owner of the live claim dead");
  // After the board read, a live reviewer took the head over on GitHub; its ledger row is not appended yet.
  const takeover = await producedView(dir, `pending (owned by run ${LIVE}) — took over run ${OWNER}: owner proven dead`,
    ago(1).replace(/\.\d{3}Z$/, "Z"));
  const cases: Array<[string, SweepDeps["rereadPrAtAct"]]> = [
    ["GitHub's live status is the live takeover", () => takeover],
    ["the same writer's status was posted again", (pr) => ({ ...pr, reviewVerdictPostedAt: ago(1).replace(/\.\d{3}Z$/, "Z") })],
    ["the act-time re-read failed", () => { throw new Error("rate limited"); }],
    ["the PR is no longer open", () => undefined],
  ];
  for (const [label, reread] of cases) {
    const r = await sweepOnce(t, view, [ownerAndHoldRows()[0]!], reread);
    assert.equal(r.row.disposition, "wait", label);
    assert.equal(r.row.acted, false, label);
    assert.match(String(r.row.reason), /owner proof superseded/, label);
    assert.equal(r.admitted, false, label);
    assert.equal(r.posted.length, 0, label);
  }
  const unchanged = await sweepOnce(t, view, [ownerAndHoldRows()[0]!], async () =>
    producedView(dir, `remudero-review: review in progress (owned by run ${OWNER})`, postedAt));
  assert.equal(unchanged.row.disposition, "post-review", "GitHub still shows the dead owner's own claim: the re-run goes ahead");
  assert.equal(unchanged.posted.length, 1);
});

test("W1-T14177 criterion 2: a takeover landing after the act-time re-read is refused by the reviewer's publish guard", async (t) => {
  // Threat (3): the sweep admitted the re-run, then a live takeover reached GitHub before the admitted reviewer's claim, its
  // ledger row not visible yet. postReviewPending assesses only the live status's writer, cannot prove it dead, posts nothing.
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14177-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(ledgerPath, { ...ownerAndHoldRows()[0]!, ts: new Date(Date.now() - 20 * 60_000).toISOString() });
  const assessed: string[] = [];
  const posts: string[] = [];
  const result = await postReviewPending({
    owner: "o", repo: "r", sha: SHA, taskId: "W1-T14177", prUrl: PR_URL, runId: "review-PR20065-admitted", ledgerPath,
    reviewInputDigest: reviewInputDigest(SHA, `${BODY}\n\nedited body`),
    ownerIdentity: { pid: process.pid, startedAt: new Date().toISOString() },
    fetchLifecycle: () => ({ merged: false, closed: false }),
    fetchStatus: () => ({ statuses: [{ context: "remudero-review", state: "pending",
      description: `pending (owned by run ${LIVE}) — took over run ${OWNER}: owner proven dead`,
      created_at: new Date(Date.now() - 10_000).toISOString().replace(/\.\d{3}Z$/, "Z") }] }),
    assessPendingOwner: (record) => { assessed.push(record.runId); return record.runId === OWNER ? "dead" : "active"; },
    post: (status) => { posts.push(status.description ?? ""); },
  });
  assert.equal(result.posted, false, result.reason);
  assert.match(String(result.reason), new RegExp(`owned by run ${LIVE}`));
  assert.deepEqual(posts, [], "no second claim is published over the live takeover");
  assert.ok(!assessed.includes(OWNER), "the run the takeover replaced is never assessed as the live owner");
});
