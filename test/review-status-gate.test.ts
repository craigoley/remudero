import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import {
  acquireReviewStatusLock,
  decideReviewStatusPost,
  lastPostedReviewStatusFromLedger,
  postReviewStatusGuarded,
  reviewEvidenceStrength,
  ReviewStatusLockTimeoutError,
  type PostedReviewStatusRecord,
  type PrLifecycleState,
} from "../src/lib/review.js";
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
    assert.ok(Date.now() - started < 1000, "a stale lock must be reclaimed without waiting a full retry cycle");
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

// ── postReviewStatusGuarded — THE single guarded post site ──────────────────

function seedPosted(ledgerPath: string, taskId: string, headSha: string, state: "success" | "failure", proofExec: string[]) {
  appendLedger(ledgerPath, {
    run_id: "seed",
    task_id: taskId,
    step: "review.posted",
    head_sha: headSha,
    state,
    proof_exec: proofExec,
  });
}

test("postReviewStatusGuarded: ACCEPTANCE 1 — a CAPPED success posted over an executed_fail on the SAME sha is refused, and the prior status is left intact", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    seedPosted(ledgerPath, "W1-T449", "833561d", "failure", ["executed_fail", "not_executable"]);

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

    // "prior status intact": the seeded executed failure is still the most
    // recent review.posted verdict — nothing overwrote it.
    const prior = lastPostedReviewStatusFromLedger(lines, "W1-T449");
    assert.deepEqual(prior, { headSha: "833561d", state: "failure", evidence: "executed" });
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
