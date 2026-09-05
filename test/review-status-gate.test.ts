import assert from "node:assert/strict";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import {
  acquireReviewStatusLock,
  decideReviewStatusPost,
  execGhStatusPost,
  fetchPrLifecycle,
  lastPostedReviewStatusFromLedger,
  postReviewStatus,
  postReviewStatusGuarded,
  POST_REVIEW_STATUS_MAX_ATTEMPTS,
  reviewEvidenceStrength,
  reviewInputDigest,
  ReviewStatusLockTimeoutError,
  type PostedReviewStatusRecord,
  type PrLifecycleState,
} from "../src/lib/review.js";
import { type GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { ghLiveStateByNumber } from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

/**
 * W1-T228 — "the review status channel is last-write-wins across
 * uncoordinated posters". Fixtures below mirror the OBSERVED incident
 * (plan/tasks.yaml W1-T228): PR 449 head 833561d took SEVEN
 * `remudero-review` writes in one day — an executed FAILURE verdict was
 * overwritten by a keyword-only CAPPED success on the SAME sha, and a third
 * write landed ~85s AFTER the PR merged.
 */

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-review-status-"));
}

const NOT_MERGED: PrLifecycleState = { merged: false, closed: false };
const MERGED: PrLifecycleState = { merged: true, closed: false };
const CLOSED: PrLifecycleState = { merged: false, closed: true };

// ── reviewEvidenceStrength ──────────────────────────────────────────────────

test("reviewEvidenceStrength: any executed_pass criterion counts as 'executed'", () => {
  assert.equal(reviewEvidenceStrength([{ proof_exec: "executed_pass" }, { proof_exec: "not_executable" }]), "executed");
});

test("reviewEvidenceStrength: any executed_fail criterion counts as 'executed' too — a FAILED observation is still evidence", () => {
  assert.equal(reviewEvidenceStrength([{ proof_exec: "executed_fail" }]), "executed");
});

test("reviewEvidenceStrength: all not_executable/exec_error (nothing ran) is 'no_evidence' — this is the CAPPED/keyword-only tier", () => {
  assert.equal(reviewEvidenceStrength([{ proof_exec: "not_executable" }, { proof_exec: "exec_error" }]), "no_evidence");
});

test("reviewEvidenceStrength: an empty criteria list is 'no_evidence' (nothing to have executed)", () => {
  assert.equal(reviewEvidenceStrength([]), "no_evidence");
});

// ── lastPostedReviewStatusFromLedger ─────────────────────────────────────────

test("lastPostedReviewStatusFromLedger: recovers the MOST RECENT review.posted line for the task, deriving evidence from proof_exec ('last one wins')", () => {
  const lines = [
    { step: "review.posted", task_id: "W1-T1", head_sha: "aaa", state: "failure", proof_exec: ["executed_fail"] },
    { step: "review.posted", task_id: "W1-T1", head_sha: "bbb", state: "success", proof_exec: ["not_executable"] },
    { step: "review.posted", task_id: "W1-T2", head_sha: "ccc", state: "failure", proof_exec: ["executed_fail"] }, // different task
  ];
  assert.deepEqual(lastPostedReviewStatusFromLedger(lines, "W1-T1"), {
    headSha: "bbb",
    state: "success",
    evidence: "no_evidence",
  });
});

test("lastPostedReviewStatusFromLedger: a proof_exec containing an executed outcome derives evidence 'executed'", () => {
  const lines = [
    { step: "review.posted", task_id: "W1-T1", head_sha: "aaa", state: "failure", proof_exec: ["not_executable", "executed_fail"] },
  ];
  assert.deepEqual(lastPostedReviewStatusFromLedger(lines, "W1-T1"), {
    headSha: "aaa",
    state: "failure",
    evidence: "executed",
  });
});

test("lastPostedReviewStatusFromLedger: a missing proof_exec field (e.g. the dep-review ledger line) derives 'no_evidence', never throws", () => {
  const lines = [{ step: "review.posted", task_id: "dep-review-PR9", head_sha: "aaa", state: "success" }];
  assert.deepEqual(lastPostedReviewStatusFromLedger(lines, "dep-review-PR9"), {
    headSha: "aaa",
    state: "success",
    evidence: "no_evidence",
  });
});

test("lastPostedReviewStatusFromLedger: no review.posted line for the task yields undefined", () => {
  assert.equal(lastPostedReviewStatusFromLedger([{ step: "review.posted", task_id: "OTHER" }], "W1-T1"), undefined);
});

// ── decideReviewStatusPost — THE PURE GATE ──────────────────────────────────

test("decideReviewStatusPost: ACCEPTANCE 1 — a CAPPED/keyword-only (no_evidence) verdict never overwrites an executed-evidence verdict on the SAME sha", () => {
  const prior: PostedReviewStatusRecord = { headSha: "833561d", state: "failure", evidence: "executed" };
  const decision = decideReviewStatusPost(
    { headSha: "833561d", state: "success", evidence: "no_evidence" },
    prior,
    NOT_MERGED,
  );
  assert.equal(decision.post, false);
  assert.match((decision as { reason: string }).reason, /executed-evidence/);
  assert.match((decision as { reason: string }).reason, /833561d/);
});

test("decideReviewStatusPost: an EXECUTED verdict MAY overwrite an executed verdict on the same sha — a later real run supersedes an earlier one", () => {
  const prior: PostedReviewStatusRecord = { headSha: "sha1", state: "failure", evidence: "executed" };
  const decision = decideReviewStatusPost({ headSha: "sha1", state: "success", evidence: "executed" }, prior, NOT_MERGED);
  assert.equal(decision.post, true);
});

test("decideReviewStatusPost: an EXECUTED verdict MAY overwrite a no_evidence (CAPPED/keyword) prior — evidence upgrading is always fine", () => {
  const prior: PostedReviewStatusRecord = { headSha: "sha1", state: "success", evidence: "no_evidence" };
  const decision = decideReviewStatusPost({ headSha: "sha1", state: "failure", evidence: "executed" }, prior, NOT_MERGED);
  assert.equal(decision.post, true);
});

test("decideReviewStatusPost: a no_evidence verdict over a no_evidence prior on the same sha is allowed — neither ever observed the repo state, so there is no precedence to violate", () => {
  const prior: PostedReviewStatusRecord = { headSha: "sha1", state: "success", evidence: "no_evidence" };
  const decision = decideReviewStatusPost({ headSha: "sha1", state: "success", evidence: "no_evidence" }, prior, NOT_MERGED);
  assert.equal(decision.post, true);
});

test("decideReviewStatusPost: a prior verdict for a DIFFERENT sha never blocks — a new push invalidates the old review entirely", () => {
  const prior: PostedReviewStatusRecord = { headSha: "old-sha", state: "failure", evidence: "executed" };
  const decision = decideReviewStatusPost(
    { headSha: "new-sha-after-push", state: "success", evidence: "no_evidence" },
    prior,
    NOT_MERGED,
  );
  assert.equal(decision.post, true);
});

test("decideReviewStatusPost: no prior at all always allows the first post, regardless of evidence tier", () => {
  const decision = decideReviewStatusPost({ headSha: "sha1", state: "success", evidence: "no_evidence" }, undefined, NOT_MERGED);
  assert.equal(decision.post, true);
});

test("decideReviewStatusPost: ACCEPTANCE 2 — a post to an already-MERGED PR is refused", () => {
  const decision = decideReviewStatusPost({ headSha: "sha1", state: "success", evidence: "executed" }, undefined, MERGED);
  assert.equal(decision.post, false);
  assert.match((decision as { reason: string }).reason, /merged/);
});

test("decideReviewStatusPost: a post to an already-CLOSED (unmerged) PR is refused", () => {
  const decision = decideReviewStatusPost({ headSha: "sha1", state: "failure", evidence: "executed" }, undefined, CLOSED);
  assert.equal(decision.post, false);
  assert.match((decision as { reason: string }).reason, /closed/);
});

test("decideReviewStatusPost: LIFECYCLE is checked BEFORE precedence — a merged PR refuses even a same-evidence-tier post that precedence alone would allow", () => {
  const prior: PostedReviewStatusRecord = { headSha: "sha1", state: "success", evidence: "executed" };
  const decision = decideReviewStatusPost({ headSha: "sha1", state: "success", evidence: "executed" }, prior, MERGED);
  assert.equal(decision.post, false);
  assert.match((decision as { reason: string }).reason, /merged/);
});

// ── acquireReviewStatusLock — a MUTEX (waits), not a singleton guard (throws) ─

test("acquireReviewStatusLock: a lock held by a LIVE holder is WAITED ON, not refused — this is a mutex for a short critical section, not a run-singleton guard", async () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, "task.lock");
    const first = await acquireReviewStatusLock(lockPath, { info: { pid: 999999 }, isPidAlive: () => true });
    let secondAcquired = false;
    const secondPromise = acquireReviewStatusLock(lockPath, { retryMs: 10, timeoutMs: 2000, isPidAlive: () => true }).then(
      (h) => {
        secondAcquired = true;
        return h;
      },
    );
    // Give the retry loop a couple of cycles to prove it is genuinely waiting,
    // not throwing synchronously.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(secondAcquired, false, "must still be waiting while the first holder is live");
    first.release();
    const second = await secondPromise;
    assert.equal(secondAcquired, true, "acquires once the holder releases");
    second.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireReviewStatusLock: a STALE (dead-pid) lock is reclaimed immediately, not waited on", async () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, "task.lock");
    await acquireReviewStatusLock(lockPath, { info: { pid: 424242 }, isPidAlive: () => true });
    const started = Date.now();
    const handle = await acquireReviewStatusLock(lockPath, { isPidAlive: () => false, retryMs: 5000, timeoutMs: 5000 });
    assertWallClockBound(Date.now() - started, 1000, "a stale lock must be reclaimed without waiting a full retry cycle");
    handle.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireReviewStatusLock: gives up with ReviewStatusLockTimeoutError rather than hanging forever on a live holder", async () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, "task.lock");
    await acquireReviewStatusLock(lockPath, { info: { pid: 999999 }, isPidAlive: () => true });
    await assert.rejects(
      acquireReviewStatusLock(lockPath, { retryMs: 10, timeoutMs: 40, isPidAlive: () => true }),
      ReviewStatusLockTimeoutError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T522 — the two remaining live PR-state reads move off the exhausted GraphQL budget ───
//
// `fetchPrLifecycle` (this module) was `gh pr view <url> --json state` — the ONE site the
// 2026-08-15 recon actually caught failing (36/36 `sweep.post_review.failed` rows that day carry
// `Command failed: gh pr view` + `GraphQL: API rate limit already exceeded`). `ghLiveStateByNumber`
// (run-task.ts) reads the same three-valued token by number+repo and was folded into this same
// task as a budget cost, not a correctness bug. Both now compose `liveStateFromRest` — the SAME
// REST mapping `ghLiveState` (W1-T511) already uses — so there is exactly one place REST's
// `state`/`merged` fold happens.

/** A fake `GhApiFetcher`: routes by REST path, records every call, throws on an unrouted path —
 *  mirrors `test/open-prs-rest.test.ts`'s own `fakeFetcher`, kept local since that helper is not
 *  exported. */
function fakeGhApiFetcher(routes: Record<string, unknown>): GhApiFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((args: string[]) => {
    const call = args.join(" ");
    calls.push(call);
    const path = args[1];
    if (path === undefined || !(path in routes)) throw new Error(`unrouted gh call: ${call}`);
    return routes[path];
  }) as GhApiFetcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const PR_URL = "https://github.com/craigoley/remudero/pull/1900";
const REST_PATH = "repos/craigoley/remudero/pulls/1900";

test("W1-T522: the review lifecycle read is served from the REST budget", () => {
  const fetch = fakeGhApiFetcher({
    [REST_PATH]: { number: 1900, html_url: PR_URL, state: "open", merged: false, updated_at: "t", head: {} },
  });
  const lifecycle = fetchPrLifecycle(PR_URL, fetch);
  assert.deepEqual(lifecycle, { merged: false, closed: false });
  // The whole point: the argv is the REST `api repos/.../pulls/N` call, never
  // `pr view <url> --json state` (GraphQL, the exhausted budget).
  assert.deepEqual(fetch.calls, ["api " + REST_PATH]);
});

test("W1-T522: a merged pull request is not reported as merely closed", () => {
  const fetch = fakeGhApiFetcher({
    [REST_PATH]: { number: 1900, html_url: PR_URL, state: "closed", merged: true, updated_at: "t", head: {} },
  });
  // REST reports a merged PR as {state:"closed", merged:true} — a naive `.state`-only read would
  // mislabel it CLOSED. `merged` must win: `merged:true, closed:false`, exactly as `decideReviewStatusPost`
  // expects (it already refuses on either, but the DISTINCTION is what `terminalStateReason`
  // elsewhere depends on, and this pins the composition against silently collapsing it).
  assert.deepEqual(fetchPrLifecycle(PR_URL, fetch), { merged: true, closed: false });
});

test("W1-T522: the by-number state read no longer spends the graph budget", () => {
  const fetch = fakeGhApiFetcher({
    [REST_PATH]: { number: 1900, html_url: PR_URL, state: "closed", merged: true, updated_at: "t", head: {} },
  });
  const state = ghLiveStateByNumber("craigoley", "remudero", 1900, fetch);
  assert.equal(state, "MERGED");
  // Same falsifier as the URL-keyed read above: the argv must be REST's `api` form, never
  // `pr view <n> --repo <o>/<r> --json state` (GraphQL).
  assert.deepEqual(fetch.calls, ["api " + REST_PATH]);
});

test("W1-T522: a non-PR URL refuses rather than falling back to the exhausted GraphQL budget", () => {
  // `prLifecycleUrlTarget` returns `undefined` for anything that is not `.../pull/<n>` (an
  // issue URL, a commit URL, a bare string, …). `fetchPrLifecycle` must throw immediately in
  // that case — never call `fetch` at all, and never fall back to `gh pr view --json state`,
  // the GraphQL call whose budget exhaustion this whole task exists to route around.
  const fetch = fakeGhApiFetcher({ [REST_PATH]: { number: 1900, html_url: PR_URL, state: "open", merged: false, updated_at: "t", head: {} } });
  assert.throws(() => fetchPrLifecycle("https://github.com/craigoley/remudero/issues/1900", fetch), /cannot resolve owner\/repo\/number/);
  assert.deepEqual(fetch.calls, []);
});

test("W1-T522: an indeterminate read stays indeterminate and never reads terminal", () => {
  // A throwing fetch (rate limit, network, auth) must propagate as indeterminate — NEVER resolve
  // to a value that reads as merged/closed/terminal. `fetchPrLifecycle` never catches (same as
  // the `gh pr view` shell-out it replaces: a failure aborts the caller's `sweep.post_review`
  // attempt whole, exactly the 36 observed 2026-08-15 failures, rather than silently reporting a
  // false lifecycle that would stand review-posting down forever).
  const throwingFetch: GhApiFetcher = () => {
    throw new Error("GraphQL: API rate limit already exceeded");
  };
  assert.throws(() => fetchPrLifecycle(PR_URL, throwingFetch));

  // `ghLiveStateByNumber` keeps its OWN pre-existing contract: a failed/indeterminate read is
  // `undefined`, never a state string a caller could mistake for terminal.
  assert.equal(ghLiveStateByNumber("craigoley", "remudero", 1900, throwingFetch), undefined);

  // An UNKNOWN REST row (missing both `state` and `merged`) folds to neither merged nor closed —
  // the fail-open direction `prStateFromRest`'s "UNKNOWN" fallback is designed to produce.
  const unknownFetch = fakeGhApiFetcher({ [REST_PATH]: { number: 1900, html_url: PR_URL, updated_at: "t", head: {} } });
  assert.deepEqual(fetchPrLifecycle(PR_URL, unknownFetch), { merged: false, closed: false });
});

// ── postReviewStatusGuarded — THE single guarded post site ──────────────────

function seedPosted(
  ledgerPath: string,
  taskId: string,
  headSha: string,
  state: "success" | "failure",
  proofExec: string[],
  input?: { prUrl: string; digest: string },
) {
  appendLedger(ledgerPath, {
    run_id: "seed",
    task_id: taskId,
    step: "review.posted",
    head_sha: headSha,
    state,
    proof_exec: proofExec,
    ...(input ? { pr_url: input.prUrl, review_input_digest: input.digest } : {}),
  });
}

test("postReviewStatusGuarded: ACCEPTANCE 1 — a CAPPED success posted over an executed_fail on the SAME sha is refused, and the prior status is left intact", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const prUrl = "https://github.com/o/r/pull/449";
    const digest = reviewInputDigest("833561d", "corrected body");
    seedPosted(ledgerPath, "W1-T449", "833561d", "failure", ["executed_fail", "not_executable"], {
      prUrl,
      digest,
    });

    const posts: Array<{ state: string }> = [];
    const result = await postReviewStatusGuarded({
      owner: "o",
      repo: "r",
      sha: "833561d",
      state: "success",
      description: "CAPPED — 0/6 executed",
      taskId: "W1-T449",
      evidence: "no_evidence",
      ledgerPath,
      runId: "run-2",
      prUrl,
      reviewInputDigest: digest,
      fetchLifecycle: () => NOT_MERGED,
      post: (o) => {
        posts.push(o);
      },
    });

    assert.equal(result.posted, false);
    assert.match(result.reason ?? "", /executed-evidence/);
    assert.equal(posts.length, 0, "the raw poster must never be called — the live channel is left exactly as it was");

    const lines = readLedgerLines(ledgerPath);
    const refusal = lines.find((l) => l.step === "review.post_refused");
    assert.ok(refusal, "the refusal itself must be ledgered — a refused write must leave a trace");
    assert.equal(refusal?.head_sha, "833561d");
    assert.equal(refusal?.attempted_state, "success");
    assert.equal(refusal?.evidence, "no_evidence");
    assert.equal(refusal?.pr_url, prUrl);
    assert.equal(refusal?.review_input_digest, digest);

    // "prior status intact": the seeded executed failure is still the most
    // recent review.posted verdict — nothing overwrote it.
    const prior = lastPostedReviewStatusFromLedger(lines, "W1-T449");
    assert.deepEqual(prior, { headSha: "833561d", state: "failure", evidence: "executed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postReviewStatusGuarded: a body edit on the same sha resets prior-evidence precedence", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const prUrl = "https://github.com/o/r/pull/449";
    seedPosted(ledgerPath, "W1-T449", "833561d", "failure", ["executed_fail"], {
      prUrl,
      digest: reviewInputDigest("833561d", "old body"),
    });
    const posts: unknown[] = [];

    const result = await postReviewStatusGuarded({
      owner: "o",
      repo: "r",
      sha: "833561d",
      state: "success",
      taskId: "W1-T449",
      evidence: "no_evidence",
      ledgerPath,
      runId: "run-after-edit",
      prUrl,
      reviewInputDigest: reviewInputDigest("833561d", "corrected body"),
      fetchLifecycle: () => NOT_MERGED,
      post: (o) => {
        posts.push(o);
      },
    });

    assert.equal(result.posted, true);
    assert.equal(posts.length, 1, "the prior executed verdict belongs to the old body, not this input");
    assert.equal(readLedgerLines(ledgerPath).some((line) => line.step === "review.post_refused"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postReviewStatusGuarded: ACCEPTANCE 2 — a post to a merged PR is refused and the refusal is ledgered", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const posts: unknown[] = [];
    const result = await postReviewStatusGuarded({
      owner: "o",
      repo: "r",
      sha: "deadbeef",
      state: "success",
      taskId: "W1-T449",
      evidence: "executed",
      ledgerPath,
      runId: "run-3",
      fetchLifecycle: () => MERGED,
      post: (o) => {
        posts.push(o);
      },
    });

    assert.equal(result.posted, false);
    assert.match(result.reason ?? "", /merged/);
    assert.equal(posts.length, 0);

    const refusal = readLedgerLines(ledgerPath).find((l) => l.step === "review.post_refused");
    assert.ok(refusal, "a post-merge write must be ledgered, not silently dropped");
    assert.equal(refusal?.head_sha, "deadbeef");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postReviewStatusGuarded: a post to a CLOSED (unmerged) PR is refused too", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const result = await postReviewStatusGuarded({
      owner: "o",
      repo: "r",
      sha: "deadbeef",
      state: "failure",
      taskId: "W1-T449",
      evidence: "no_evidence",
      ledgerPath,
      runId: "run-4",
      fetchLifecycle: () => CLOSED,
      post: () => {
        throw new Error("must never be called");
      },
    });
    assert.equal(result.posted, false);
    assert.match(result.reason ?? "", /closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postReviewStatusGuarded: an ordinary post with no prior and an open PR succeeds and is NOT ledgered as a refusal", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const posts: Array<{ sha: string; state: string }> = [];
    const result = await postReviewStatusGuarded({
      owner: "o",
      repo: "r",
      sha: "sha1",
      state: "success",
      taskId: "W1-T1",
      evidence: "executed",
      ledgerPath,
      runId: "run-1",
      fetchLifecycle: () => NOT_MERGED,
      post: (o) => {
        posts.push(o);
      },
    });
    assert.equal(result.posted, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].sha, "sha1");
    assert.equal(readLedgerLines(ledgerPath).some((l) => l.step === "review.post_refused"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postReviewStatusGuarded: ACCEPTANCE 3 — N concurrent posters on one PR serialize to a precedence-consistent final state, with every attempt ledgered including the losers", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-T449";
    const sha = "833561d";
    const posted: Array<{ state: string }> = [];

    // Each "poster" simulates a real caller: on a successful guarded post, it
    // ALSO appends the rich `review.posted` ledger line (exactly what
    // run-task.ts's runReview/depReviewCommand do), so the next racer's
    // read-decide-write sees an up-to-date prior — precedence enforcement
    // across concurrent posters depends on this, not just on the lock.
    function makeAttempt(state: "success" | "failure", evidence: "executed" | "no_evidence", runId: string) {
      return postReviewStatusGuarded({
        owner: "o",
        repo: "r",
        sha,
        state,
        taskId,
        evidence,
        ledgerPath,
        runId,
        fetchLifecycle: () => NOT_MERGED,
        post: (o) => {
          posted.push(o);
          appendLedger(ledgerPath, {
            run_id: runId,
            task_id: taskId,
            step: "review.posted",
            head_sha: sha,
            state: o.state,
            proof_exec: evidence === "executed" ? ["executed_pass"] : ["not_executable"],
          });
        },
      });
    }

    // The FIRST attempt invoked wins the lock first (lock acquisition is a
    // synchronous O_EXCL create, so calling these in this order deterministically
    // orders them): an EXECUTED failure lands with no prior at all. Two
    // subsequent CAPPED/keyword-only successes race in behind it — precedence
    // must refuse BOTH against the executed failure the first attempt just posted.
    const results = await Promise.all([
      makeAttempt("failure", "executed", "run-a"),
      makeAttempt("success", "no_evidence", "run-b"),
      makeAttempt("success", "no_evidence", "run-c"),
    ]);

    assert.equal(results[0].posted, true, "the executed verdict (first in) posts — nothing to refuse it yet");
    assert.equal(results[1].posted, false, "a CAPPED/keyword success must not overwrite the executed failure");
    assert.equal(results[2].posted, false, "same — every later no_evidence attempt stays refused too");

    assert.equal(posted.length, 1, "the raw channel was written to exactly once — the winner");
    assert.equal(posted[0].state, "failure");

    const lines = readLedgerLines(ledgerPath);
    const refusals = lines.filter((l) => l.step === "review.post_refused");
    assert.equal(refusals.length, 2, "EVERY losing attempt is ledgered — losers leave a trace, not silence");

    // Final state is precedence-consistent: the most recent review.posted
    // verdict is still the executed failure the winner posted.
    const finalPrior = lastPostedReviewStatusFromLedger(lines, taskId);
    assert.deepEqual(finalPrior, { headSha: sha, state: "failure", evidence: "executed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── postReviewStatus — W1-T135 retry-with-backoff on a transient gh 5xx ─────
//
// LIVE INCIDENT (plan/tasks.yaml W1-T135): a bare execFileSync("gh", ...) with
// no error handling meant a single transient 503 posting the status threw and
// CRASHED run W1-T132-1784508142857 mid-fix-rung (escalation #283). These
// fixtures drive `exec`/`sleep` — postReviewStatus's own injection points —
// never a real `gh` spawn, mirroring every other DI test in this file.

/** Shapes a fake execFileSync failure the way `gh api` actually reports HTTP
 * errors — the message lands on stderr, exactly what {@link ghErrorText}
 * (review.ts) extracts from a real thrown error. */
function ghHttpError(message: string): Error & { stderr: string; status: number } {
  // Real execFileSync/execSync failures fold stderr into the thrown Error's
  // own `.message` (Node's documented behavior) as well as exposing it via
  // `.stderr` — mirrored here so assertions against either field hold.
  const e = new Error(`Command failed: gh api ...\n${message}`) as Error & { stderr: string; status: number };
  e.stderr = message;
  e.status = 1;
  return e;
}

test("postReviewStatus: ACCEPTANCE 1 — a transient 503 returned twice then a 200 posts on the third attempt", async () => {
  let attempt = 0;
  const sleeps: number[] = [];
  await postReviewStatus(
    { owner: "o", repo: "r", sha: "sha1", state: "success" },
    {
      exec: () => {
        attempt++;
        if (attempt < 3) throw ghHttpError("gh: Service Unavailable (HTTP 503)");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(attempt, 3, "the gateway was retried until the third attempt's 200 succeeded");
  assert.equal(sleeps.length, 2, "backoff waited before EACH retry, never after the eventual success");
});

test("postReviewStatus: ACCEPTANCE 2 — a 503 on every attempt exhausts retries and throws (never a silent hang or retry storm)", async () => {
  let attempt = 0;
  await assert.rejects(
    () =>
      postReviewStatus(
        { owner: "o", repo: "r", sha: "sha1", state: "success" },
        {
          exec: () => {
            attempt++;
            throw ghHttpError("gh: Service Unavailable (HTTP 503)");
          },
          sleep: async () => {},
        },
      ),
    /503/,
  );
  assert.equal(
    attempt,
    POST_REVIEW_STATUS_MAX_ATTEMPTS,
    `gives up after exactly POST_REVIEW_STATUS_MAX_ATTEMPTS (${POST_REVIEW_STATUS_MAX_ATTEMPTS}) attempts`,
  );
});

test("postReviewStatus: ACCEPTANCE 3 — a permanent 404 is classified non-transient and is NEVER retried (surfaced on the first attempt)", async () => {
  let attempt = 0;
  let slept = false;
  await assert.rejects(
    () =>
      postReviewStatus(
        { owner: "o", repo: "r", sha: "sha1", state: "success" },
        {
          exec: () => {
            attempt++;
            throw ghHttpError("gh: Not Found (HTTP 404)");
          },
          sleep: async () => {
            slept = true;
          },
        },
      ),
    /404/,
  );
  assert.equal(attempt, 1, "a permanent 4xx must not trigger a retry storm");
  assert.equal(slept, false, "no backoff wait ever happens for a non-transient error");
});

test("postReviewStatus: a permanent 422 is classified non-transient and is not retried either", async () => {
  let attempt = 0;
  await assert.rejects(() =>
    postReviewStatus(
      { owner: "o", repo: "r", sha: "sha1", state: "failure" },
      {
        exec: () => {
          attempt++;
          throw ghHttpError("gh: Unprocessable Entity (HTTP 422)");
        },
        sleep: async () => {},
      },
    ),
  );
  assert.equal(attempt, 1);
});

// ── execGhStatusPost — the real (uninjected) `gh` wrapper postReviewStatus's
// `exec` defaults to. PATH-stubbed exactly like run-task.test.ts's
// `realArmDeps` coverage probe, so this one-line real invocation earns its
// own DA: hit instead of only ever running behind the injectable `exec`
// every other test above supplies (W1-T135, diff-coverage ratchet).

test("execGhStatusPost: the real execFileSync(\"gh\", ...) wrapper runs against a PATH-stubbed gh and returns normally on success", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-status-stub-ok-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    assert.doesNotThrow(() => execGhStatusPost(["api", "-X", "POST", "repos/o/r/statuses/sha1"], process.env));
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("execGhStatusPost: a failing gh stub throws with the stub's stderr surfaced", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-status-stub-fail-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "gh: Service Unavailable (HTTP 503)" >&2\nexit 1\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    assert.throws(
      () => execGhStatusPost(["api", "-X", "POST", "repos/o/r/statuses/sha1"], process.env),
      /HTTP 503/,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

// ── postReviewStatusGuarded — W1-T135 ledger-and-continue on post failure ───

test("postReviewStatusGuarded: ACCEPTANCE 2 — a post that throws after exhausting retries is ledgered as review.post_failed (carrying the verdict) and the call returns {posted:false} WITHOUT throwing", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const result = await postReviewStatusGuarded({
      owner: "o",
      repo: "r",
      sha: "sha1",
      state: "success",
      description: "remudero-review: PASS — 3/3 criteria met",
      taskId: "W1-T135X",
      evidence: "executed",
      ledgerPath,
      runId: "run-9",
      fetchLifecycle: () => NOT_MERGED,
      post: () => {
        throw ghHttpError("gh: Service Unavailable (HTTP 503)");
      },
    });

    assert.equal(result.posted, false, "the run continues instead of crashing on the unhandled throw");
    assert.match(result.reason ?? "", /review\.post_failed/);

    const failed = readLedgerLines(ledgerPath).find((l) => l.step === "review.post_failed");
    assert.ok(failed, "the unposted verdict must be ledgered — recoverable, never silently dropped");
    assert.equal(failed?.head_sha, "sha1");
    assert.equal(failed?.attempted_state, "success");
    assert.equal(failed?.evidence, "executed");
    assert.equal(failed?.description, "remudero-review: PASS — 3/3 criteria met");
    assert.match(String(failed?.error ?? ""), /503/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postReviewStatusGuarded: ACCEPTANCE 3 — a permanent-error post failure is ALSO ledgered as review.post_failed and does not throw", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const result = await postReviewStatusGuarded({
      owner: "o",
      repo: "r",
      sha: "sha2",
      state: "failure",
      taskId: "W1-T135Y",
      evidence: "no_evidence",
      ledgerPath,
      runId: "run-10",
      fetchLifecycle: () => NOT_MERGED,
      post: () => {
        throw ghHttpError("gh: Not Found (HTTP 404)");
      },
    });

    assert.equal(result.posted, false);
    const failed = readLedgerLines(ledgerPath).find((l) => l.step === "review.post_failed");
    assert.ok(failed);
    assert.equal(failed?.head_sha, "sha2");
    assert.match(String(failed?.error ?? ""), /404/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T473 acceptance 1 — REAL mutual exclusion for concurrent reviews ─────
//
// `runSweep` (sweep.ts) used to walk every open PR strictly one at a time, so
// its `postReviewed` dedup — a `Set` read ONCE from the ledger before the
// walk starts (see `PriorActions.postReviewed`'s own doc) — was safe only
// because no second PR's `postReview` call could ever be in flight when a
// later PR's dedup check ran. W1-T473 gives `runSweep` its own concurrency
// budget for the review lane, which removes that free safety: two open PRs
// that happen to share the exact same `${taskId}@${headSha}` (the rationale's
// own falsifier — e.g. a duplicate/retry PR pointing at an identical push)
// could now both be scheduled for a concurrent `postReview` call at once,
// unless `runSweep` supplies REAL mutual exclusion of its own. This proves it
// does: only the FIRST PR to claim the key ever invokes `postReview`; the
// second stands down instead of racing it.

function greenPrAwaitingReview(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(0).toISOString(),
    headSha: "sha1",
    autoMergeArmed: false,
    ...over,
  };
}

test("W1-T473 acceptance 1 — two PRs sharing the SAME task+head key can never both invoke postReview concurrently: only the first claims the lane, the second stands down", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const started: number[] = [];
    const deps: SweepDeps = {
      arm: () => {},
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      // A slow, "genuinely running" review (like a real reviewer-worker spawn)
      // — long enough that a broken implementation letting BOTH PRs through
      // would have both calls overlapping in time, not just both eventually
      // firing one after another.
      postReview: async (p) => {
        started.push(p.prNumber);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      ledgerPath,
      runId: "SWEEP-MUTEX",
      now: () => 0,
    };

    // Two DISTINCT PRs — different pr numbers/URLs, same task id AND head sha.
    const a = greenPrAwaitingReview({ prNumber: 11, prUrl: "url/11", taskId: "W1-DUP", headSha: "shaDUP" });
    const b = greenPrAwaitingReview({ prNumber: 12, prUrl: "url/12", taskId: "W1-DUP", headSha: "shaDUP" });

    const summary = await runSweep([a, b], deps, DEFAULT_SWEEP_POLICY);

    assert.deepEqual(started, [11], "only the PR that claimed the key first ever reaches postReview — the duplicate never races it");

    const aAction = summary.actions.find((act) => act.prNumber === 11);
    const bAction = summary.actions.find((act) => act.prNumber === 12);
    assert.equal(aAction?.acted, true, "the claimant's review still runs normally");
    assert.equal(bAction?.acted, false, "the duplicate stands down rather than crashing or silently double-posting");

    const disposed = readLedgerLines(ledgerPath).filter((l) => l.step === "sweep.disposed");
    const dupLine = disposed.find((l) => l.pr_number === 12);
    assert.equal(dupLine?.acted, false);
    assert.match(String(dupLine?.stand_down_reason ?? ""), /already claimed this pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
