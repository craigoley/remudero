/**
 * W1-T14035 — a review claim whose owner is proven dead is re-run while the head's checks are still pending.
 *
 * OBSERVED 2026-11-20 on #19791: a review run claimed the head's pending status, died about five minutes in, and never
 * posted a verdict. At 15:38:37Z the sweep disposed the head wait, "checks pending 42m (< 60m ceiling)", because the
 * alongside-CI post-review row needed no review status and the dead-owner re-run row needed green checks. No review ran
 * again until an operator took the claim over by hand. Every stamp below is aged against the clock each case injects.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { judgeReview, postReviewStatusGuarded, recoverPromisedFollowUpReports, reviewInputDigest, reviewPendingDescriptionWithOwner,
  reviewStatusOwnerRun, type ReviewVerdict } from "#src/lib/review.js";
import { catalogReviewPoster } from "#src/cli/commands/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";

const NOW = Date.parse("2026-11-20T15:38:37.000Z");
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const DEAD_RUN = "review-PR19791-1795187698034";

/** #19791's shape at 15:38:37Z: checks pending 42m, the dead run's pending claim posted at 15:15:10Z. */
function deadClaimView(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 19791, prUrl: "https://github.com/o/r/pull/19791", taskId: "W1-T14035",
    headRefName: "run-W1-T14035-1795190000000", headSha: "d".repeat(40),
    mergeState: "blocked", mergeableState: "blocked", autoMergeArmed: false,
    checksState: "pending", checksPendingSince: minutesAgo(42), lastActivityAt: minutesAgo(42),
    createdAt: minutesAgo(60), priorStrikes: 0, unmetCriteria: [],
    reviewState: "pending", reviewPendingSince: minutesAgo(23), reviewPendingOwnerDead: true,
    reviewVerdictPostedAt: new Date(NOW - 23 * 60_000 - 400).toISOString(),
    // The live status and the dead ledger row name the same run, as the view producer reads them.
    reviewPendingOwnerRunId: DEAD_RUN, reviewPendingStatusRunId: DEAD_RUN,
    priorReviewAttemptsForInput: 0,
    ...over,
  } as OpenPrView;
}

test("W1-T14035 criterion 1: a dead pending review claim is disposed post-review alongside CI, not wait", () => {
  const r = deriveDisposition(deadClaimView(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "post-review");
  assert.equal(r.blocker, "awaiting-ci");
  assert.match(r.reason, /alongside CI/);
});

test("W1-T14035 criterion 2: the disposition reason names the dead owner", () => {
  const r = deriveDisposition(deadClaimView(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.reason, "checks pending 42m, remudero-review owner proven dead — re-running one exact-input " +
    "review alongside CI through the bounded post-review lane");
  const never = deriveDisposition(deadClaimView({ reviewState: "none", reviewPendingOwnerDead: undefined,
    reviewPendingSince: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.match(never.reason, /review never posted/, "a head with no review status keeps its own reason");
});

test("W1-T14035 criterion 3: an alive or merely old pending claim still waits while checks are pending", () => {
  const alive = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: false }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(alive.disposition, "wait");
  assert.match(alive.reason, /waiting/);
  const unproven = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(unproven.disposition, "wait");
  const old = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: undefined, reviewPendingSince: minutesAgo(59) }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(old.disposition, "wait", "a stale pending without proof of death is not taken over while CI runs");
});

test("W1-T14035: the bounds of the alongside-CI row still hold for a dead claim", () => {
  const judged = deriveDisposition(deadClaimView({ priorReviewAttemptsForInput: 1 }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(judged.disposition, "wait", "an input already judged is not reviewed again alongside CI");
  const refused = deriveDisposition(deadClaimView({ reviewPostRefused: true }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(refused.disposition, "wait");
  const unreadable = deriveDisposition(deadClaimView({ requiredContextsUnreadable: true }), DEFAULT_SWEEP_POLICY, NOW);
  assert.notEqual(unreadable.disposition, "post-review");
  const justRegistered = deriveDisposition(deadClaimView({ checksPendingSince: new Date(NOW - 30_000).toISOString() }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(justRegistered.disposition, "wait");
  const green = deriveDisposition(deadClaimView({ checksState: "green" }), DEFAULT_SWEEP_POLICY, NOW);
  assert.match(green.reason, /checks green, remudero-review owner proven dead/, "green checks keep the green row");
});

test("W1-T14035 criterion 1: a dead pending claim at a looping input escalates through the reviewInputLoop backstop", () => {
  const loop = { admissions: 2, postsSinceLastAdmission: 1, posts: 1, lookedUpKey: "W1-T14035" };
  const looped = { reviewInputDigest: "e".repeat(64), reviewInputLoop: loop };
  const none = deriveDisposition(deadClaimView({ ...looped, reviewState: "none", reviewPendingOwnerDead: undefined,
    reviewPendingSince: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(none.disposition, "blocked-ambiguous", "the no-status path escalates at the backstop");
  const dead = deriveDisposition(deadClaimView(looped), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(dead.disposition, "blocked-ambiguous", "a dead claim gets no third admission of the same input");
  assert.match(dead.reason, /^post-review-loop: #19791 has been admitted for review 2 time\(s\)/);
  const below = deriveDisposition(deadClaimView({ ...looped, reviewInputLoop: { ...loop, admissions: 1 } }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(below.disposition, "post-review", "one admission is below the backstop and still re-runs");
});

test("W1-T14035 criterion 2: a derived release cause is not producer proof of death and does not re-run alongside CI", () => {
  for (const gone of ["promise-harvest-incomplete", "refused-after-pending", "inconclusive-load"] as const) {
    const r = deriveDisposition(deadClaimView({ reviewPendingOwnerGone: gone }), DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(r.disposition, "wait", `${gone} waits while checks are pending`);
    assert.doesNotMatch(r.reason, /owner proven dead/);
  }
  const pid = deriveDisposition(deadClaimView({ reviewPendingOwnerGone: "owner-pid-dead" }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(pid.disposition, "post-review");
  assert.match(pid.reason, /remudero-review owner proven dead/);
});

test("W1-T14035 criterion 3: a stale-only pending claim past the ceiling still waits while checks are pending", () => {
  const stale = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: undefined, reviewPendingSince: minutesAgo(61) }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.ok(61 >= DEFAULT_SWEEP_POLICY.pendingCeilingMinutes, "the fixture is past the stale ceiling");
  assert.equal(stale.disposition, "wait", "a stale pending without proof of death is not taken over while CI runs");
  const undated = deriveDisposition(deadClaimView({ reviewPendingOwnerDead: undefined, reviewPendingSince: undefined,
    lastActivityAt: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(undated.disposition, "wait", "an undated pending reads stale and still waits");
});

test("W1-T14035 criterion 1: a dead claim at a looping input keeps the CI-age guard and the stale-CI reason", () => {
  const looped = { reviewInputDigest: "e".repeat(64),
    reviewInputLoop: { admissions: 2, postsSinceLastAdmission: 1, posts: 1, lookedUpKey: "W1-T14035" } };
  const justRegistered = deriveDisposition(deadClaimView({ ...looped, checksPendingSince: new Date(NOW - 30_000).toISOString() }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(justRegistered.disposition, "wait", "checks pending 30 s wait, as the alongside-CI row's age guard says");
  assert.doesNotMatch(justRegistered.reason, /post-review-loop/);
  const atCeiling = deriveDisposition(deadClaimView({ ...looped, checksPendingSince: minutesAgo(DEFAULT_SWEEP_POLICY.pendingCeilingMinutes) }),
    DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(atCeiling.disposition, "blocked-ambiguous");
  assert.doesNotMatch(atCeiling.reason, /post-review-loop/, "the stale-CI reason keeps its precedence at the ceiling");
  assert.match(atCeiling.reason, new RegExp(`checks pending ${DEFAULT_SWEEP_POLICY.pendingCeilingMinutes}m`));
});

/** A runSweep harness over one view, with the sweep's own ledger in a private directory. */
function sweepHarness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const posted: OpenPrView[] = [];
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-t14035", now: () => NOW,
    arm: () => assert.fail("pending review cannot arm"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
    postReview: (candidate) => { posted.push(candidate); },
    reviewerCodeRecovery: { loadedCodeSha: "fresh-code", isLoadedCodeAtOrAfter: () => true, freshTreeReviewAvailable: true,
      probeFreshness: async () => ({ status: "fresh", codeSha: "fresh-code", originMainSha: "fresh-code", advance: "none" }) },
  };
  return { ledgerPath, posted, deps };
}

test("W1-T14035 criterion 2: runSweep keeps the dead-owner reason beside an undigested promise-harvest hold", async (t) => {
  const h = sweepHarness(t);
  const pr = deadClaimView({ reviewInputDigest: "e".repeat(64) });
  appendLedger(h.ledgerPath, {
    run_id: "review-PR19791-1795187698034", task_id: pr.taskId!, step: "review.posted", state: "pending",
    pr_url: pr.prUrl, head_sha: pr.headSha, ts: minutesAgo(20),
    decision_verdict: { state: "pending", criteria: [], promisedFollowUpObservation: {
      state: "unknown", cause: "promise-harvest-incomplete", reason: "promise harvest unavailable: AbortError" } },
  });
  await runSweep([pr], h.deps, DEFAULT_SWEEP_POLICY);
  const row = readLedgerLines(h.ledgerPath).findLast((r) => r.step === "sweep.disposed" && r.pr_number === 19791);
  assert.ok(row, "the sweep disposed the head");
  assert.equal(row.disposition, "post-review");
  // The hold keeps its place as the cause, as on main; the producer's proof of death rides beside it.
  assert.equal(row.owner_gone_cause, "promise-harvest-incomplete");
  assert.equal(row.reason, "checks pending 42m, remudero-review owner proven dead (its promise harvest did not complete) — " +
    "re-running one exact-input review alongside CI through the bounded post-review lane");
  assert.equal(h.posted.length, 1);
});

/** #19791's head as the real view producer reads it: checks pending since 42m ago, the dead run's ledger row, and the
 *  live `remudero-review` status the fetch returns. */
async function producedView(
  dir: string,
  liveStatus: { runId: string; createdAt?: string; description?: string },
  /** Runs after the dead run's claim row is written; a returned string is the live status description. */
  afterClaim?: (ledgerPath: string) => Promise<string | undefined>,
): Promise<OpenPrView> {
  const ledgerPath = join(dir, "ledger.ndjson");
  const sha = "d".repeat(40);
  const prUrl = "https://github.com/o/r/pull/19791";
  const body = "Remudero-Task: W1-T14035";
  rmSync(ledgerPath, { force: true });
  appendLedger(ledgerPath, {
    run_id: "review-PR19791-dead", task_id: "W1-T14035", step: "review.pending_posted", ts: minutesAgo(23),
    head_sha: sha, pr_url: prUrl, review_input_digest: reviewInputDigest(sha, body),
    host: hostname(), owner_pid: 41, owner_started_at: minutesAgo(23),
  });
  const held = afterClaim === undefined ? undefined : await afterClaim(ledgerPath);
  if (held !== undefined) liveStatus = { ...liveStatus, description: held };
  const [pr] = await buildOpenPrViewsAsync("o", "r", ledgerPath, {
    requiredContexts: () => ["ci-gate"],
    assessPendingOwner: (record) => record.runId === "review-PR19791-dead" ? "dead" : "active",
    fetchAsync: async (args) => {
      const path = args.at(-1)!;
      if (path.includes("state=open")) return [{
        number: 19791, html_url: prUrl, head: { ref: "run-W1-T14035-1795190000000", sha },
        updated_at: minutesAgo(42), created_at: minutesAgo(60), body, auto_merge: null, state: "open",
      }];
      if (path.includes("check-runs")) return { check_runs: [{ name: "ci-gate", status: "in_progress", started_at: minutesAgo(42) }] };
      if (path.includes("/status")) return { statuses: [{
        context: "remudero-review", state: "pending",
        description: liveStatus.description ?? `remudero-review: review in progress (owned by run ${liveStatus.runId})`,
        ...(liveStatus.createdAt !== undefined ? { created_at: liveStatus.createdAt } : {}),
      }] };
      if (path.endsWith("/pulls/19791")) return { mergeable: true, mergeable_state: "blocked" };
      return [];
    },
  });
  assert.ok(pr);
  return pr;
}

test("W1-T14035 criterion 3: a newer live claim the ledger has not shown yet waits, replayed from the view producer", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const own = await producedView(dir, { runId: "review-PR19791-dead", createdAt: minutesAgo(23).replace(/\.\d{3}Z$/, "Z") });
  assert.equal(own.checksState, "pending");
  assert.equal(own.reviewPendingOwnerDead, true, "the producer read the dead run's row");
  assert.equal(deriveDisposition(own, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review",
    "the dead run's own status is released alongside CI");
  const newer = await producedView(dir, { runId: "review-PR19791-live", createdAt: minutesAgo(2).replace(/\.\d{3}Z$/, "Z") });
  assert.equal(newer.reviewPendingOwnerDead, true, "the producer still judges the older dead run's row");
  const live = deriveDisposition(newer, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(live.disposition, "wait", "the live status names a newer claim, so the active claim is not disposed");
  assert.doesNotMatch(live.reason, /owner proven dead/);
  const otherWording = await producedView(dir, { runId: "review-PR19791-dead", description: "remudero-review: pending" });
  assert.equal(deriveDisposition(otherWording, DEFAULT_SWEEP_POLICY, NOW).disposition, "wait",
    "a live status that names no run is an unknown run");
});

test("W1-T14035 criterion 1: the dead run's own status is released alongside CI when it is undated or stamped after its row", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const createdAt of [undefined, minutesAgo(22).replace(/\.\d{3}Z$/, "Z")]) {
    const pr = await producedView(dir, { runId: "review-PR19791-dead", createdAt });
    assert.equal(pr.reviewPendingOwnerDead, true, "the producer proved the run named in the status dead");
    assert.equal(pr.reviewPendingOwnerRunId, "review-PR19791-dead");
    assert.equal(pr.reviewPendingStatusRunId, "review-PR19791-dead");
    const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(r.disposition, "post-review", `status created_at ${createdAt ?? "absent"} is the dead run's own claim`);
    assert.match(r.reason, /^checks pending 42m, remudero-review owner proven dead — re-running one exact-input review alongside CI/);
  }
});

test("W1-T14035 criterion 3: a live replacement claim posted in the same second as the dead row waits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sameSecond = minutesAgo(23).replace(/\.\d{3}Z$/, "Z");
  const pr = await producedView(dir, { runId: "review-PR19791-live", createdAt: sameSecond });
  assert.equal(pr.reviewPendingOwnerDead, true, "the producer still reports death from the old row");
  assert.equal(pr.reviewVerdictPostedAt, sameSecond);
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "wait", "the live status is another run's claim");
  assert.doesNotMatch(r.reason, /owner proven dead/);
});

/** A `review.posted` pending row whose only unmet proof was inconclusive under a load of 41. */
function inconclusiveLoadRow(pr: OpenPrView): LedgerLine {
  return {
    run_id: DEAD_RUN, task_id: pr.taskId!, step: "review.posted", state: "pending",
    pr_url: pr.prUrl, head_sha: pr.headSha, review_input_digest: pr.reviewInputDigest, ts: minutesAgo(20),
    decision_verdict: { state: "pending", summary: "inconclusive-load", criteria: [{
      claim: "the behaviour holds", proof: "unit test: holds", met: false, reason: "timed out under load",
      proof_exec: "inconclusive_load", load: { start: { load1: 30 }, end: { load1: 41 } } }] },
  };
}

test("W1-T14035 criterion 2: green checks with an inconclusive-load hold and a dead owner keep the load cause", async (t) => {
  const h = sweepHarness(t);
  const pr = deadClaimView({ checksState: "green", checksPendingSince: undefined, reviewInputDigest: "e".repeat(64) });
  appendLedger(h.ledgerPath, inconclusiveLoadRow(pr));
  await runSweep([pr], { ...h.deps, sampleLoad: () => ({ load1: 5 }) }, DEFAULT_SWEEP_POLICY);
  const lines = readLedgerLines(h.ledgerPath);
  const row = lines.findLast((r) => r.step === "sweep.disposed" && r.pr_number === 19791);
  assert.ok(row, "the sweep disposed the head");
  assert.equal(row.disposition, "post-review");
  assert.equal(row.owner_gone_cause, "inconclusive-load");
  assert.equal(row.reason, "checks green, its proof was inconclusive under host load and the host is quieter now — " +
    "re-running the review lane on #19791");
  const admitted = lines.findLast((r) => r.step === "sweep.review_admitted" && r.pr_number === 19791);
  assert.ok(admitted, "the review was admitted");
  assert.equal(admitted.prior_cause, "inconclusive-load");
  assert.equal(h.posted.length, 1);
});

const DEAD = "review-PR19791-dead";
const OPS_HOLD = "remudero-review: pending — detailed evidence retained on host";

/** A production hold, published by `run` through the real review code path: the harvest fails on a ledger that is not the
 *  union's live file, judgeReview turns that into its pending summary, the guarded post publishes it through the catalog
 *  poster the review lane uses (the ops one redacts it), and the lane writes its `review.posted` pending row, undigested
 *  as a hold whose PR body was unread is. Returns the description GitHub received, or with `legacy` the summary a hold
 *  posted before every pending post named its run carried. */
async function publishHold(ledgerPath: string, run: string, opts: {
  verdictFor?: () => ReviewVerdict; catalog?: "ops"; codeSha?: string; legacy?: true;
} = {}): Promise<string> {
  const sha = "d".repeat(40);
  const prUrl = "https://github.com/o/r/pull/19791";
  const observation = await recoverPromisedFollowUpReports(
    { state: "complete", promised: [{ path: "docs/adr/0001-cache.md", text: "file a follow-up for the cache" }], planRecords: [] } as never,
    { ledgerPath: `${ledgerPath}.elsewhere`, taskId: "W1-T14035", prUrl, prCreatedAt: minutesAgo(60) });
  const verdict = opts.verdictFor?.() ?? judgeReview([], { diff: "", report: "", promisedFollowUpObservation: observation } as never);
  assert.equal(verdict.state, "pending");
  assert.equal(verdict.capped, false, "an uncapped verdict posts its summary as the description");
  let posted: string | undefined;
  const result = await postReviewStatusGuarded({
    owner: "o", repo: "r", sha, state: "pending", verdict, description: verdict.summary, taskId: "W1-T14035",
    evidence: "no_evidence", ledgerPath, runId: run, prUrl, fetchLifecycle: () => ({ merged: false, closed: false }),
    post: catalogReviewPoster(opts.catalog ?? "public", async (status) => { posted = status.description; }, opts.codeSha),
  });
  assert.equal(result.posted, true, result.reason);
  appendLedger(ledgerPath, {
    run_id: run, task_id: "W1-T14035", step: "review.posted", context: "remudero-review", state: verdict.state,
    head_sha: sha, pr_url: prUrl, decision_verdict: verdict, ts: minutesAgo(20),
  });
  assert.ok(posted);
  assert.ok(posted.length <= 140, `GitHub keeps the whole description: ${posted.length} characters`);
  assert.equal(reviewStatusOwnerRun(posted), run, "the posted hold names the run that published it");
  assert.ok(posted.endsWith(` (owned by run ${run})`), "the marker is never cut");
  return opts.legacy ? verdict.summary : posted;
}

test("W1-T14035 criterion 1: every pending post names its run within 140 characters, cutting the text and never the marker", () => {
  const long = `remudero-review: promise-harvest-incomplete — ${"x".repeat(200)}`;
  const named = reviewPendingDescriptionWithOwner(long, DEAD);
  assert.equal(named.length, 140);
  assert.ok(named.endsWith(` (owned by run ${DEAD})`));
  const claim = `remudero-review: review in progress (owned by run ${DEAD})`;
  assert.equal(reviewPendingDescriptionWithOwner(claim, DEAD), claim, "a claim that names its run is posted as it is");
  const quoting = reviewPendingDescriptionWithOwner("remudero-review: cannot-evaluate — quoted (owned by run review-old)", DEAD);
  assert.equal(reviewStatusOwnerRun(quoting), DEAD, "the publisher's own marker outranks a quoted one");
  assert.equal(reviewStatusOwnerRun(OPS_HOLD), undefined, "a description with no marker names no run");
});

test("W1-T14035 criterion 1: a production promise-harvest hold published by the dead run is released alongside CI", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let wording = "";
  const pr = await producedView(dir, { runId: DEAD }, async (ledgerPath) => (wording = await publishHold(ledgerPath, DEAD)));
  assert.match(wording, /^remudero-review: promise-harvest-incomplete — promise harvest unavailable: /);
  assert.equal(pr.reviewPendingOwnerDead, true, "the producer proved the claiming run dead");
  assert.equal(pr.priorReviewAttemptsForInput ?? 0, 0, "the hold judged no input of this head");
  assert.equal(pr.reviewPendingStatusRunId, DEAD, "the hold names the run that published it");
  const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "post-review");
  assert.equal(r.blocker, "awaiting-ci");
  assert.match(r.reason, /^checks pending 42m, remudero-review owner proven dead — re-running one exact-input review alongside CI/);
});

test("W1-T14035 criterion 1: a production cannot-evaluate hold published by the dead run is released alongside CI", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adrDiff = "diff --git a/docs/adr/0001-cache.md b/docs/adr/0001-cache.md\n--- a/docs/adr/0001-cache.md\n" +
    "+++ b/docs/adr/0001-cache.md\n@@ -1 +1,2 @@\n # Cache\n+We will file a follow-up.\n";
  let wording = "";
  const pr = await producedView(dir, { runId: DEAD }, async (ledgerPath) =>
    (wording = await publishHold(ledgerPath, DEAD, { verdictFor: () => judgeReview([], { diff: adrDiff, report: "" } as never) })));
  assert.match(wording, /^remudero-review: cannot-evaluate — /);
  assert.equal(pr.reviewPendingStatusRunId, DEAD);
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
});

test("W1-T14035 criterion 1: an ops hold the catalog poster redacted is released alongside CI by the run it names", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const codeSha of [undefined, "c".repeat(40)]) {
    let wording = "";
    const pr = await producedView(dir, { runId: DEAD }, async (ledgerPath) =>
      (wording = await publishHold(ledgerPath, DEAD, { catalog: "ops", codeSha })));
    assert.equal(wording, `${OPS_HOLD} (owned by run ${DEAD})`, "the redaction replaced the summary and kept the owner");
    assert.equal(pr.reviewPendingStatusRunId, DEAD);
    const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(r.disposition, "post-review", `code sha ${codeSha ?? "absent"}`);
    assert.match(r.reason, /remudero-review owner proven dead/);
  }
});

/** GitHub's created_at for a status posted `m` minutes ago: whole seconds, as REST returns it. */
const postedAgo = (m: number): string => minutesAgo(m).replace(/\.\d{3}Z$/, "Z");

test("W1-T14035 criterion 1: a hold posted before pending posts named their run is bound by its ledger row", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // publishHold writes the dead run's review.posted row at 20m ago; GitHub stamped the hold no later than that.
  const pr = await producedView(dir, { runId: DEAD, createdAt: postedAgo(20) },
    (ledgerPath) => publishHold(ledgerPath, DEAD, { legacy: true }));
  assert.equal(pr.reviewPendingStatusRunId, DEAD, "the dead run's newest pending row posted that summary");
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition, "post-review");
});

test("W1-T14035 criterion 2: runSweep records the dead-owner reason for a production promise-harvest hold", async (t) => {
  for (const catalog of [undefined, "ops"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pr = await producedView(dir, { runId: DEAD }, (ledgerPath) => publishHold(ledgerPath, DEAD, { catalog }));
    const h = sweepHarness(t);
    const ledgerPath = join(dir, "ledger.ndjson");
    await runSweep([pr], { ...h.deps, ledgerPath }, DEFAULT_SWEEP_POLICY);
    const row = readLedgerLines(ledgerPath).findLast((r) => r.step === "sweep.disposed" && r.pr_number === 19791);
    assert.ok(row, "the sweep disposed the head");
    assert.equal(row.disposition, "post-review", catalog ?? "public");
    assert.equal(row.owner_gone_cause, "promise-harvest-incomplete");
    assert.equal(row.reason, "checks pending 42m, remudero-review owner proven dead (its promise harvest did not complete) — " +
      "re-running one exact-input review alongside CI through the bounded post-review lane");
    assert.equal(h.posted.length, 1);
  }
});

test("W1-T14035 criterion 3: a hold the ledger does not bind to the dead run still waits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases: Array<[string, (ledgerPath: string) => Promise<string | undefined>]> = [
    ["no run's row published the live hold", async () =>
      "remudero-review: promise-harvest-incomplete — promise harvest unavailable: Error: a newer run's harvest"],
    ["another run published the hold after the dead claim", (ledgerPath) => publishHold(ledgerPath, "review-PR19791-other")],
    ["another run published an ops hold after the dead claim", (ledgerPath) =>
      publishHold(ledgerPath, "review-PR19791-other", { catalog: "ops" })],
    ["the live hold is not the dead run's posted wording", async (ledgerPath) => {
      await publishHold(ledgerPath, DEAD, { legacy: true });
      return "remudero-review: cannot-evaluate — promise harvest corpus is unreadable or malformed; a newer post";
    }],
    ["an undated redacted ops hold that names no run", async (ledgerPath) => {
      await publishHold(ledgerPath, DEAD, { catalog: "ops", legacy: true });
      return OPS_HOLD;
    }],
  ];
  for (const [label, afterClaim] of cases) {
    const pr = await producedView(dir, { runId: DEAD }, afterClaim);
    assert.equal(pr.reviewPendingOwnerDead, true, `${label}: the producer still proves the claiming run dead`);
    assert.notEqual(pr.reviewPendingStatusRunId, DEAD, `${label}: the live status is not bound to the dead run`);
    const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(r.disposition, "wait", label);
    assert.doesNotMatch(r.reason, /owner proven dead/, label);
  }
});

test("W1-T14035 criterion 1: a legacy ops hold the dead run posted before its own row is released alongside CI", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The reviewer deployed before every pending post named its run redacts a hold to the same text for every run, with or
  // without code provenance. Only its post time ties it to the dead run: posted no later than that run's review.posted row.
  for (const [wording, createdAt] of [[OPS_HOLD, postedAgo(20)], [`${OPS_HOLD} [review code ${"c".repeat(40)}]`, postedAgo(21)]]) {
    const pr = await producedView(dir, { runId: DEAD, createdAt }, async (ledgerPath) => {
      await publishHold(ledgerPath, DEAD, { catalog: "ops", legacy: true });
      return wording;
    });
    assert.equal(pr.reviewPendingOwnerDead, true, "the producer proved the claiming run dead");
    assert.equal(pr.reviewPendingStatusRunId, DEAD, `${wording}: the dead run posted the live hold before its row`);
    const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(r.disposition, "post-review", wording);
    assert.match(r.reason, /^checks pending 42m, remudero-review owner proven dead — re-running one exact-input review alongside CI/);
  }
});

test("W1-T14035 criterion 3: the same unmarked hold text posted after the dead run's last row waits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t14035-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A live legacy reviewer posts text identical to the dead run's hold before its own ledger row is visible: the text
  // cannot tell the two apart, the post time can. Posted after the dead run's last row, or undated, it is no proven owner.
  const cases: Array<[string, string | undefined, "ops" | undefined]> = [
    ["an ops hold posted 2m ago", postedAgo(2), "ops"],
    ["an ops hold posted one second after the dead row", new Date(NOW - 20 * 60_000 + 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), "ops"],
    ["a public hold with the dead run's own summary posted 2m ago", postedAgo(2), undefined],
    ["an undated public hold with the dead run's own summary", undefined, undefined],
  ];
  for (const [label, createdAt, catalog] of cases) {
    const pr = await producedView(dir, { runId: DEAD, createdAt }, async (ledgerPath) => {
      const summary = await publishHold(ledgerPath, DEAD, { catalog, legacy: true });
      return catalog === "ops" ? OPS_HOLD : summary;
    });
    assert.equal(pr.reviewPendingOwnerDead, true, `${label}: the producer still proves the older run dead`);
    assert.equal(pr.reviewPendingStatusRunId, undefined, `${label}: the live hold is bound to no run`);
    const r = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(r.disposition, "wait", label);
    assert.doesNotMatch(r.reason, /owner proven dead/, label);
  }
});
