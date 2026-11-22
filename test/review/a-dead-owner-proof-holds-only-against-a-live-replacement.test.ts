/**
 * W1-T14177 — a dead review owner's proof is superseded only by a live replacement, and the act-time re-check reads
 * GitHub's live review status before another review is admitted (INVARIANT one-live-review-owner).
 *
 * OBSERVED in #19922's round-11 review: deadOwnerProofSuperseded counted a COMPLETED pending hold, recorded under another
 * run id after a claim no-op, as a live replacement, so the green-CI promise-harvest retry kept waiting; and the act-time
 * re-check read only the ledger, so a takeover GitHub accepted before its ledger append was missed.
 */
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { reviewCommand, type ReviewCommandDeps, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { sweepCommand } from "#src/cli/commands/sweep.js";
import { configPath, type Config } from "#src/lib/config.js";
import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { postReviewPending, reviewInputDigest } from "#src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deadOwnerProofSuperseded, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-21T19:30:00.000Z");
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const SHA = "f".repeat(40);
const PR_URL = "https://github.com/o/r/pull/20065";
const BODY = "Remudero-Task: W1-T14177";
const OWNER = "review-PR20065-owner";
const NOOP = "review-PR20065-noop";
const LIVE = "review-PR20065-live";
const PREDECESSOR = "review-PR20065-predecessor";

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

/** One sweep pass over `pr` with `rows` in its ledger; the act-time re-read answers `reread` (the view itself by default;
 *  null passes no re-reader at all). */
async function sweepOnce(t: TestContext, pr: OpenPrView, rows: LedgerLine[],
  reread: SweepDeps["rereadPrAtAct"] | null = (view) => view) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14177-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  for (const row of rows) appendLedger(ledgerPath, row);
  const posted: OpenPrView[] = [];
  await runSweep([pr], {
    ledgerPath, runId: "sweep-t14177", now: () => NOW, ...(reread === null ? {} : { rereadPrAtAct: reread }),
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

/** The real view producer over the owner's claim row, with `description` as GitHub's live `remudero-review` status (id
 *  7001). The status history's newest post is that same status unless `newerPost` says GitHub accepted a newer one. */
async function producedView(dir: string, description: string, createdAt: string,
  over: { newerPost?: { id: number; description: string }; checks?: "green" | "pending" } = {}): Promise<OpenPrView> {
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
      if (path.includes("check-runs")) return { check_runs: [over.checks === "green"
        ? { name: "ci-gate", status: "completed", conclusion: "success", started_at: ago(30), completed_at: ago(25) }
        : { name: "ci-gate", status: "in_progress", started_at: ago(30) }] };
      if (path.includes("/statuses")) return [
        ...(over.newerPost ? [{ context: "remudero-review", state: "pending", ...over.newerPost, created_at: ago(1) }] : []),
        { context: "remudero-review", state: "pending", id: 7001, description, created_at: createdAt },
      ];
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

test("W1-T14177 criterion 1: a run the dead owner took over is retired, so an aged harvest retry re-runs the review", async (t) => {
  // The owner's claim took over an earlier claim (took_over_run_id); that predecessor wrote no settled row of its own.
  const predecessor: LedgerLine = { run_id: PREDECESSOR, task_id: "W1-T14177", step: "review.pending_posted", head_sha: SHA,
    pr_url: PR_URL, ts: ago(40), host: hostname(), owner_pid: 40, owner_started_at: ago(40),
    review_input_digest: reviewInputDigest(SHA, BODY) };
  const [ownerClaim, hold] = ownerAndHoldRows();
  const rows = [predecessor, { ...ownerClaim!, took_over_run_id: PREDECESSOR }, hold!];
  for (const checks of ["green", "pending"] as const) {
    const pr = ownerDeadView(checks === "green" ? { checksState: "green", checksPendingSince: undefined } : {});
    assert.equal(deadOwnerProofSuperseded(pr, rows), undefined, `${checks}: the taken-over predecessor holds nothing`);
    const r = await sweepOnce(t, pr, rows);
    assert.equal(r.row.disposition, "post-review", `${checks}: the harvest retry re-runs the review instead of waiting`);
    assert.equal(r.posted.length, 1, checks);
  }
  // Positive control: the same predecessor claim, not taken over, is still a live replacement.
  assert.equal(deadOwnerProofSuperseded(ownerDeadView(), [predecessor, ownerClaim!, hold!]), PREDECESSOR);
});

/** The ops-redaction hold the dead owner published after its claim; its writer is read only from GitHub's status history. */
const OPS_HOLD = "remudero-review: pending — detailed evidence retained on host";

/** The real view producer over the owner's claim and hold rows: GitHub's live status is the hold, posted as `liveId`, and
 *  the status history's newest entry carries `historyNewestId`. */
async function producedHoldView(dir: string, liveId: number, historyNewestId: number): Promise<OpenPrView> {
  const ledgerPath = join(dir, "ledger.ndjson");
  rmSync(ledgerPath, { force: true });
  for (const row of ownerHoldRows()) appendLedger(ledgerPath, row);
  const row = { number: 20065, html_url: PR_URL, head: { ref: "run-W1-T14177-1795288835761", sha: SHA },
    updated_at: ago(30), created_at: ago(45), body: BODY, auto_merge: null, state: "open" };
  const postedAt = ago(15).replace(/\.\d{3}Z$/, "Z");
  const [pr] = await buildOpenPrViewsAsync("o", "r", ledgerPath, {
    requiredContexts: () => ["ci-gate"],
    assessPendingOwner: (record) => record.runId === OWNER ? "dead" : "active",
    fetchAsync: async (args) => {
      const path = args.at(-1)!;
      if (path.includes("state=open")) return [row];
      if (path.includes("check-runs")) return { check_runs: [{ name: "ci-gate", status: "in_progress", started_at: ago(30) }] };
      if (path.includes("/statuses")) return [
        { context: "remudero-review", state: "pending", id: historyNewestId, description: OPS_HOLD, created_at: postedAt },
        { context: "remudero-review", state: "pending", id: 6999, created_at: ago(20).replace(/\.\d{3}Z$/, "Z"),
          description: `remudero-review: review in progress (owned by run ${OWNER})` },
      ];
      if (path.includes("/status")) return { statuses: [{ context: "remudero-review", state: "pending", id: liveId,
        description: OPS_HOLD, created_at: postedAt }] };
      if (path.endsWith("/pulls/20065")) return { ...row, mergeable: true, mergeable_state: "blocked" };
      return [];
    },
  });
  assert.ok(pr);
  return pr;
}

/** The dead owner's claim row and the ops-redaction hold it published under its own run id. */
function ownerHoldRows(): LedgerLine[] {
  const [claim] = ownerAndHoldRows();
  return [claim!, { run_id: OWNER, task_id: "W1-T14177", step: "review.posted", state: "pending", head_sha: SHA, pr_url: PR_URL,
    ts: ago(15), decision_verdict: { state: "pending", criteria: [],
      summary: OPS_HOLD } }];
}

test("W1-T14177 criterion 2: a live status id that is not the history's newest id waits at act time", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14177-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const view = await producedHoldView(dir, 7001, 7001);
  assert.equal(view.reviewPendingStatusRunId, OWNER, "positive control: the history binds the live hold to the dead owner");
  assert.equal(view.reviewPendingOwnerDead, true, "the board read proved the owner of the live hold dead");
  // GitHub now serves a newer post, 7002, with the same text; the history's newest entry is still 7001.
  const mismatch = await sweepOnce(t, view, ownerHoldRows(), async () => producedHoldView(dir, 7002, 7001));
  assert.equal(mismatch.row.disposition, "wait", "a status id the history does not name as newest binds no writer");
  assert.equal(mismatch.row.acted, false);
  assert.match(String(mismatch.row.reason), /owner proof superseded/);
  assert.equal(mismatch.admitted, false, "no second review is admitted");
  assert.equal(mismatch.posted.length, 0);
  const same = await sweepOnce(t, view, ownerHoldRows(), async () => producedHoldView(dir, 7001, 7001));
  assert.equal(same.row.disposition, "post-review", "control: the same post, still the history's newest, admits the re-run");
});

function unexpectedReviewDependency(): never { throw new Error("unexpected review fixture dependency"); }
const REVIEW_HOST: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: unexpectedReviewDependency,
  ledgeredNonDispatchSpawn: unexpectedReviewDependency,
  lintPlanForReview: unexpectedReviewDependency,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpectedReviewDependency,
  readHeadShaRest: unexpectedReviewDependency,
  readMainPlanTreeSha: unexpectedReviewDependency,
  realDeps: () => ({ reviewWorktree: { fetch: unexpectedReviewDependency } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: unexpectedReviewDependency,
  reviewSubjectGit: unexpectedReviewDependency,
};

/** A commit the review's plan read resolves: the checkout's own HEAD. */
const REVIEWED_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

/** `rmd review` on an untasked placeholder head whose claim post answers `refusal`; records every effect it reaches. */
async function reviewAgainstClaim(refusal: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t14177-review-"));
  const effects: string[] = [];
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => { printed.push(parts.map(String).join(" ")); };
  try {
    const code = await reviewCommand(REVIEW_HOST, "run-PR-pending-1795288835761", ["--repo", "craigoley/remudero"], {
      resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
      fetchView: () => ({ headRefOid: REVIEWED_HEAD, headRefName: "run-PR-pending-1795288835761", number: 20070,
        url: "https://github.com/craigoley/remudero/pull/20070",
        body: "## Acceptance\n- the change works | grep: review in src/lib/review.ts\n\nRemudero-Task: PR-pending" }),
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      executionMode: "semantic",
      fetchHead: () => {},
      postReviewPending: async () => { effects.push("pending"); return { posted: false, reason: refusal }; },
      postStatus: async () => { effects.push("status"); return { posted: true }; },
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: REVIEWED_HEAD, originMainSha: REVIEWED_HEAD, advance: "none" }),
      materialize: () => {
        effects.push("materialize");
        return { worktreePath: undefined, failure: { errorClass: "other", message: "fixture" } };
      },
      runReview: async () => {
        effects.push("review");
        return { state: "success", headSha: REVIEWED_HEAD, reviewerOutcome: "success", criteria: [], testTheater: false,
          summary: "fixture review complete", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false };
      },
    } satisfies ReviewCommandDeps);
    const rows: Array<Record<string, unknown>> = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    return { code, effects, rows, printed };
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T14177 criterion 2: rmd review returns another reviewer's claim refusal instead of reviewing or posting", async () => {
  const held = await reviewAgainstClaim(
    "remudero-review is already pending (owned by run review-PR20070-1795288900000) — host-independent claim; no-op");
  assert.equal(held.code, 2, "the refusal is the command's result");
  assert.deepEqual(held.effects, ["pending"], "no worktree, no reviewer, no status post");
  assert.equal(held.rows.find((row) => row.step === "review.stood_down")?.reason,
    "another reviewer run (review-PR20070-1795288900000) holds this head's remudero-review claim");
  // The holder id is read from GitHub: a control character in it never splits or colours the printed line.
  const injected = await reviewAgainstClaim(
    "remudero-review is already pending (owned by run review-PR20070-17952\u001b[31m\r\nFORGED: ok) — no-op");
  assert.deepEqual(injected.effects, ["pending"]);
  const line = injected.printed.find((text) => text.includes("not reviewed"));
  assert.equal(line, "rmd review: PR #20070 not reviewed — another reviewer run (review-PR20070-1795231mFORGED:ok) holds this head's " +
    "remudero-review claim", "one printed line, control characters stripped");
  assert.ok(!injected.printed.some((text) => /[\u0000-\u001f]/.test(text) && text.includes("not reviewed")));
  // Controls: a dispatching sweep's own claim (handed to this review) and a drained no-op still review as before.
  for (const reason of ["remudero-review is already pending for 0000000 (owned by run SWEEP-1795288900000) — no-op (W1-T913 idempotent-per-input)",
    "a terminal success verdict is already posted for 0000000 — never regressing it to pending (W1-T913)"]) {
    const handed = await reviewAgainstClaim(reason);
    assert.deepEqual(handed.effects, ["pending", "materialize", "review"], reason);
  }
});

test("W1-T14177 criterion 2: the one-shot rmd sweep passes the act-time re-reader to its sweep, as the daemon's passes do", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t14177-oneshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { root, claudeBin: "/bin/true" } as Config;
  // The real config reader and owner parser run against a private home and a fixed origin, with no git history.
  t.mock.method(os, "homedir", () => root);
  t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
    assert.equal(file, "git");
    if (args.includes("remote.origin.url")) return "https://github.com/acme/fixture.git\n";
    throw new Error("fixture has no git history");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  mkdirSync(join(configPath(), ".."), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config));
  t.mock.method(console, "log", () => {});
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, result?: unknown) => (...args: unknown[]) => { calls.push({ name, args }); return result; };
  const reread = async (pr: OpenPrView) => pr;
  const host = {
    USAGE: "sweep fixture usage", DEFAULT_WORKER_STALL_MS: 1,
    buildSweepEffects: record("effects", { readLedger: () => [], appendLine: () => {}, readOpenEscalations: () => [],
      reviewerCodeStaleThisPass: () => undefined }),
    createPlanFilingClassificationTelemetry: () => record("classification"),
    buildEscalationTriageRuntime: record("triageRuntime"), refreshEscalationTriageEvidence: record("refreshEvidence"),
    sweepPostFixReverification: record("reverify", { results: [], total: 0, redriven: 0 }),
    updatedForWorkflowFromLedger: record("workflow", () => false),
    buildRereadPrAtAct: record("reread", reread),
    handedOffHeadRiskJudge: record("judge", undefined), codeScanningJudgeDeps: record("codeScanning", {}),
    sweepEscalationReconcile: record("reconcile", {}), sweepEscalationTriage: record("triage"),
    sweepPrTerminalRung: record("terminal"), runAutomaticBranchReapRung: record("branchReap"),
    runTmpSweepRung: record("tmp"), runWorkerTailSweepRung: record("tails"), runInflightLockSweepRung: record("locks"),
    runWorkerStallDetectorRung: record("stalls"), runMountRecommenderRung: record("mounts"),
    renderEscalationReconcileSummary: () => "escalations: none",
    commandViews: () => [],
    runOneShotSweep: async (run: (pool: undefined) => Promise<unknown>) => run(undefined),
  } as unknown as Parameters<typeof sweepCommand>[0];
  assert.equal(await sweepCommand(host, ["--repo", "other", "--dry-run"]), 0);
  const built = calls.filter((call) => call.name === "reread");
  assert.equal(built.length, 1, "the one-shot pass builds one act-time re-reader");
  assert.deepEqual(built[0]!.args.slice(0, 3), ["acme", "other", join(root, "state", "ledger.ndjson")]);
});

test("W1-T14177 criterion 2: a claim the combined status still serves proves nothing once the history has a newer post", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14177-newer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const postedAt = ago(20).replace(/\.\d{3}Z$/, "Z");
  const claim = `remudero-review: review in progress (owned by run ${OWNER})`;
  const takeover = { id: 7002, description: `pending (owned by run ${LIVE}) — took over run ${OWNER}: owner proven dead` };
  for (const checks of ["pending", "green"] as const) {
    const bound = await producedView(dir, claim, postedAt, { checks });
    assert.equal(bound.reviewPendingOwnerDead, true, `${checks}: positive control, the history's newest post is the claim`);
    assert.equal(bound.reviewPendingStatusRunId, OWNER, checks);
    // GitHub accepted the takeover (7002); /status still serves the dead owner's claim (7001).
    const stale = await producedView(dir, claim, postedAt, { checks, newerPost: takeover });
    assert.equal(stale.reviewPendingStatusRunId, undefined, `${checks}: the claim names no writer behind a newer post`);
    assert.notEqual(stale.reviewPendingOwnerDead, true, `${checks}: the board read proves no owner dead`);
    // The act-time re-read meets the same lag after the board read proved the owner dead: the head waits.
    const r = await sweepOnce(t, bound, [ownerAndHoldRows()[0]!], async () =>
      producedView(dir, claim, postedAt, { checks, newerPost: takeover }));
    assert.equal(r.row.disposition, "wait", checks);
    assert.equal(r.admitted, false, checks);
    assert.equal(r.posted.length, 0, checks);
  }
});

/** `rmd review` retrying a dead owner's head through the REAL postReviewPending, over a ledger seeded with `rows`, while
 *  GitHub's live status is `live`. Returns the claim it answered and every effect the command reached. */
async function retryThroughRealClaim(rows: LedgerLine[], live: { description: string; created_at: string }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t14177-retry-"));
  const effects: string[] = [];
  const claims: Array<{ posted: boolean; reason?: string }> = [];
  const originalLog = console.log;
  console.log = () => {};
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    for (const row of rows) appendLedger(ledgerPath, row);
    const code = await reviewCommand(REVIEW_HOST, "run-PR-pending-1795288835761", ["--repo", "craigoley/remudero"], {
      resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
      fetchView: () => ({ headRefOid: REVIEWED_HEAD, headRefName: "run-PR-pending-1795288835761", number: 20070,
        url: "https://github.com/craigoley/remudero/pull/20070",
        body: "## Acceptance\n- the change works | grep: review in src/lib/review.ts\n\nRemudero-Task: PR-pending" }),
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      executionMode: "semantic",
      fetchHead: () => {},
      postReviewPending: async (opts) => {
        effects.push("pending");
        const claim = await postReviewPending({ ...opts, fetchLifecycle: () => ({ merged: false, closed: false }),
          fetchStatus: () => ({ statuses: [{ context: "remudero-review", state: "pending", ...live }] }),
          assessPendingOwner: (record) => record.runId === OWNER ? "dead" : "active",
          post: () => { effects.push("claim-posted"); } });
        claims.push(claim);
        return claim;
      },
      postStatus: async () => { effects.push("status"); return { posted: true }; },
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: REVIEWED_HEAD, originMainSha: REVIEWED_HEAD, advance: "none" }),
      materialize: () => {
        effects.push("materialize");
        return { worktreePath: undefined, failure: { errorClass: "other", message: "fixture" } };
      },
      runReview: async () => {
        effects.push("review");
        return { state: "success", headSha: REVIEWED_HEAD, reviewerOutcome: "success", criteria: [], testTheater: false,
          summary: "fixture review complete", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false };
      },
    } satisfies ReviewCommandDeps);
    return { code, effects, claims };
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T14177 criterion 1: a completed hold from another reviewer never stops rmd review's retry of a dead claim", async () => {
  const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
  const holder = "review-PR20070-1795288900000";
  const deadClaim: LedgerLine = { run_id: OWNER, task_id: "PR-pending", step: "review.pending_posted", head_sha: REVIEWED_HEAD,
    pr_url: "https://github.com/craigoley/remudero/pull/20070", ts: minutesAgo(65), host: hostname(), owner_pid: 41,
    owner_started_at: minutesAgo(65) };
  const completedHold: LedgerLine = { run_id: holder, task_id: "PR-pending", step: "review.posted", state: "pending",
    head_sha: REVIEWED_HEAD, pr_url: "https://github.com/craigoley/remudero/pull/20070", ts: minutesAgo(25),
    decision_verdict: { state: "pending", criteria: [], summary: "promise harvest unavailable" } };
  const live = { description: `remudero-review: promise-harvest-incomplete — promise harvest unavailable (owned by run ${holder})`,
    created_at: minutesAgo(25).replace(/\.\d{3}Z$/, "Z") };
  const retry = await retryThroughRealClaim([deadClaim, completedHold], live);
  assert.equal(retry.claims[0]?.posted, false, "postReviewPending holds on the young status it cannot prove dead");
  assert.match(String(retry.claims[0]?.reason), new RegExp(`owned by run ${holder}`));
  assert.deepEqual(retry.effects, ["pending", "materialize", "review"], "the settled holder holds nothing: the retry reviews");
  // Control: the same live status from a run with no settled row (a takeover GitHub accepted before its ledger append)
  // is a live rival, and the retry stops.
  const rival = await retryThroughRealClaim([deadClaim], live);
  assert.equal(rival.code, 2);
  assert.deepEqual(rival.effects, ["pending"]);
});
