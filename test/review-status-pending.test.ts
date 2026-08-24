import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  decideAutoMergeArmAtSha,
  lastPendingReviewStatusFromLedger,
  lastPostedReviewStatusFromLedger,
  postReviewPending,
  postReviewStatusGuarded,
  resolveReviewProvenance,
  type PrLifecycleState,
} from "../src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";
import { runReview } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { WorkerResult, SpawnWorkerArgs } from "../src/lib/worker.js";

/**
 * W1-T913 (fb-1784901239119-1be356, PR #707): `remudero-review` was posted ONLY in a terminal
 * state, so between a new head appearing and its verdict landing the required context sat as
 * "Expected" among ~22 green checks — the PR read green-at-a-glance while the review had not run
 * at all. This suite is the NEW, standalone proof for the fix (deliberately not appended to
 * test/run-task.test.ts, which fails at FILE level under coverage, or test/sweep.test.ts's 216
 * tests, which would make a whole-file proof uninformative about this behaviour specifically —
 * see the task's own `note`).
 */

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-review-pending-"));
}

const NOT_MERGED: PrLifecycleState = { merged: false, closed: false };

// ── criterion 1 — EVERY DETECTOR POSTS PENDING FIRST (structural: these three functions shell
// out to `gh` and/or spawn a worker, so — exactly like test/review.test.ts's own W1-T359 wiring
// check on the same functions — their ordering is proven over source text, never by driving them
// end-to-end) ─────────────────────────────────────────────────────────────────────────────────

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

test("W1-T913 criterion 1 (run lane): runReview posts remudero-review=pending via postReviewPending BEFORE the diff fetch and judgeReview", () => {
  const start = runTaskSrc.indexOf("async function runReview(");
  const end = runTaskSrc.indexOf("// ── THE blocked_review FIX RUNG");
  assert.ok(start > -1 && end > start, "could not locate runReview's body in run-task.ts");
  const body = runTaskSrc.slice(start, end);

  const pendingIdx = body.indexOf("postReviewPending(");
  const diffIdx = body.indexOf('execFileSync("gh", ["pr", "diff"');
  const judgeIdx = body.indexOf("const computed = judgeReview(");

  assert.ok(pendingIdx > -1, "runReview must call postReviewPending");
  assert.ok(diffIdx > -1 && judgeIdx > -1, "could not locate runReview's expensive-work call sites");
  assert.ok(pendingIdx < diffIdx, "the pending post must precede the diff fetch");
  assert.ok(pendingIdx < judgeIdx, "the pending post must precede judgeReview");

  // THE REVIEWER SPAWN IS ASSERTED BEHAVIOURALLY INSTEAD, in the test directly below. It used to
  // be checked here as `body.indexOf("await spawnWorker(")`, but that call site is now the
  // injectable seam `(args.spawnReviewerWorker ?? spawnWorker)(...)`, and swapping one literal for
  // another would only move the same brittleness one refactor further out. The property this file
  // owns — the pending post PRECEDES the expensive reviewer spawn — is unchanged and is now proven
  // by RUNNING runReview and observing the real order of the two effects, which no comment and no
  // renamed identifier can satisfy (W1-T1051).

  // The TERMINAL post still replaces it on completion — the SAME single guarded site, unchanged.
  const terminalPostIdx = body.indexOf("const posted = await postReviewStatusGuarded({");
  assert.ok(terminalPostIdx > judgeIdx, "the terminal post must still run, after judging, exactly as before this task");
});

// The BEHAVIOURAL half of criterion 1's spawn arm. Until the reviewer spawn became injectable it
// could only be checked as source text (`body.indexOf("await spawnWorker(")`), because letting the
// block run meant a real LLM call. It is a seam now, so the ordering this file exists to protect is
// asserted by RUNNING runReview and recording the real sequence of two side effects: the pending
// status POST (observed at the `gh` boundary, where postReviewStatusGuarded actually emits it) and
// the reviewer spawn (observed at the seam). Both must happen, and in that order.

const SEAM_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

/** A COMPLETE WorkerResult — the reviewer block folds `workerLedgerFields(reviewer)` into its
 *  ledger row and that reads the usage fields, so a partial fixture throws into the block's own
 *  catch and the spawn would look like it never happened. */
function pendingOrderWorkerResult(): WorkerResult {
  return {
    sessionId: "sess-order-1",
    costUsd: 0,
    numTurns: 0,
    text: "REVIEW_VERDICT 1: PASS",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  } as WorkerResult;
}

/** A `gh` that APPENDS to `tracePath` when the pending review status is posted. The trace is taken
 *  at the process boundary rather than from the ledger so the two events share one clock and one
 *  file, which is what makes their order a fact rather than a comparison of timestamps. */
function writeTracingGhStub(binDir: string, tracePath: string): void {
  const script = `#!/bin/sh
case "$*" in
  *statuses/*state=pending*) printf 'pending\\n' >> '${tracePath}' ;;
esac
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"abc1234def5678"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"abc1234def5678"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") echo "diff --git a/README.md b/README.md" ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(join(binDir, "gh"), script, { mode: 0o755 });
}

test("W1-T913 criterion 1 (run lane, behavioural): the pending status POST really is emitted BEFORE the advisory reviewer spawn is called", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-pending-order-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const tracePath = join(root, "state", "order.trace");
  writeFileSync(tracePath, "");
  const binDir = mkdtempSync(join(tmpdir(), "rmd-gh-stub-order-"));
  writeTracingGhStub(binDir, tracePath);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;

  const acceptance: AcceptanceCriterion[] = [
    { claim: "PENDING-ORDER-TOKEN the observable surface behaves", proof: "unit test: never-matches-PENDING-ORDER" },
  ];
  let spawns = 0;

  try {
    await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T913-pending-order", acceptance },
      report: "",
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as Config,
      log: () => {},
      say: () => {},
      account: (r: WorkerResult) => r,
      // The block is allowed to RUN — `spawnReviewer: false` would skip the very effect being ordered.
      spawnReviewerWorker: async (_a: SpawnWorkerArgs): Promise<WorkerResult> => {
        spawns++;
        appendFileSync(tracePath, "spawn\n");
        return pendingOrderWorkerResult();
      },
      reviewerMount: SEAM_MOUNT,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "REVIEW-PENDING-ORDER-1",
    });
  } finally {
    process.env.PATH = oldPath;
  }

  const trace = readFileSync(tracePath, "utf8").split("\n").filter(Boolean);

  // THE EXPENSIVE WORK IS REACHED. This is the half the old source-text assertion carried: if the
  // spawn never runs, the ordering below is vacuously satisfiable and the test means nothing.
  assert.equal(spawns, 1, "the advisory reviewer spawn must actually be called");
  assert.ok(trace.includes("spawn"), "the spawn must be recorded in the shared trace");

  // AND THE PENDING POST REALLY HAPPENED, at the gh boundary — not merely attempted. A run whose
  // pending post threw would land in runReview's own catch and leave no trace entry at all.
  assert.ok(trace.includes("pending"), "remudero-review=pending must be POSTed, not just attempted");

  assert.equal(trace.indexOf("pending"), 0, "the pending post must be the FIRST of the two effects");
  assert.ok(
    trace.indexOf("pending") < trace.indexOf("spawn"),
    "the pending post must precede the advisory reviewer spawn — the whole point of W1-T913",
  );
});

test("W1-T913 criterion 1 (rmd review's own start): reviewCommand posts remudero-review=pending via postReviewPendingDep BEFORE materialize() and before runReviewDep()", () => {
  const start = runTaskSrc.indexOf("async function reviewCommand(");
  const end = runTaskSrc.indexOf("async function depReviewCommand(");
  assert.ok(start > -1 && end > start, "could not locate reviewCommand's body in run-task.ts");
  const body = runTaskSrc.slice(start, end);

  const pendingIdx = body.indexOf("await postReviewPendingDep({");
  const materializeIdx = body.indexOf("const materialized = materialize(");
  const runReviewIdx = body.indexOf("runReviewDep({");

  assert.ok(pendingIdx > -1, "reviewCommand must call postReviewPendingDep");
  assert.ok(materializeIdx > -1 && runReviewIdx > -1, "could not locate reviewCommand's own call sites");
  assert.ok(pendingIdx < materializeIdx, "the pending post must precede worktree materialization");
  assert.ok(pendingIdx < runReviewIdx, "the pending post must precede the runReview dispatch");
});

test("W1-T913 criterion 1 (light-sweep ticker): SweepDeps.postReview's default reviewRunner routes through reviewCommand, so its own pending post (the test above) covers the sweep's post-review dispatch too", () => {
  assert.match(
    runTaskSrc,
    /reviewRunner:\s*\(prNumber: number\) => Promise<number> = \(prNumber\) => reviewCommand\(/,
    "the sweep's post-review lane must dispatch through reviewCommand, never a second review entry point",
  );
});

// ── criterion 3 — IDEMPOTENT PER HEAD, AND IT CARRIES ITS OWNER ─────────────────────────────

test("W1-T913 criterion 3: postReviewPending posts state=pending through postReviewStatusGuarded (never a second raw poster), and the description names the posting run_id", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const posts: Array<{ owner: string; repo: string; sha: string; state: string; description?: string }> = [];

    const result = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "abc1234",
      taskId: "W1-T913",
      runId: "run-913-a",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post: (o) => {
        posts.push(o);
      },
    });

    assert.equal(result.posted, true);
    assert.equal(posts.length, 1, "exactly one post through the guarded site");
    assert.equal(posts[0].state, "pending");
    assert.equal(posts[0].sha, "abc1234");
    assert.match(posts[0].description ?? "", /run-913-a/, "the posted description must carry the posting run_id");

    const lines = readLedgerLines(ledgerPath);
    const pendingLine = lines.find((l) => l.step === "review.pending_posted");
    assert.ok(pendingLine, "a successful pending post must be ledgered");
    assert.equal(pendingLine?.head_sha, "abc1234");
    assert.equal(pendingLine?.run_id, "run-913-a");

    const record = lastPendingReviewStatusFromLedger(lines, "W1-T913");
    assert.deepEqual(record, { headSha: "abc1234", runId: "run-913-a", postedAt: pendingLine?.ts });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T913 criterion 3: a second pending post for the SAME head is a no-op — no status churn, no second gh call — even from a DIFFERENT run_id", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const posts: unknown[] = [];
    const post = (o: unknown) => {
      posts.push(o);
    };

    const first = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "abc1234",
      taskId: "W1-T913",
      runId: "run-913-a",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post,
    });
    assert.equal(first.posted, true);
    assert.equal(posts.length, 1);

    // Same head, a DIFFERENT run detecting it a second time (e.g. a re-tick of the light-sweep
    // ticker before the owning run's verdict has landed).
    const second = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "abc1234",
      taskId: "W1-T913",
      runId: "run-913-b",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post,
    });

    assert.equal(second.posted, false);
    assert.match(second.reason ?? "", /no-op/);
    assert.match(second.reason ?? "", /run-913-a/, "the no-op reason names the OWNING run, not the one that just asked");
    assert.equal(posts.length, 1, "the raw poster must not be called a second time");

    const pendingLines = readLedgerLines(ledgerPath).filter((l) => l.step === "review.pending_posted");
    assert.equal(pendingLines.length, 1, "exactly one review.pending_posted line for this head, ever");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T913: a pending post for a NEW head (a push landed) is NOT a no-op — idempotency is per-head, not per-task", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const posts: Array<{ sha: string }> = [];
    const post = (o: { sha: string }) => {
      posts.push(o);
    };

    await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "aaa1111",
      taskId: "W1-T913",
      runId: "run-913-a",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post,
    });
    const second = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "bbb2222",
      taskId: "W1-T913",
      runId: "run-913-a",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post,
    });

    assert.equal(second.posted, true);
    assert.deepEqual(
      posts.map((p) => p.sha),
      ["aaa1111", "bbb2222"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T913: postReviewPending never regresses an already-posted TERMINAL verdict for the SAME head back to pending — neither an executed nor a keyword-only/no-evidence one", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");

    // An executed verdict: decideReviewStatusPost's own precedence rule would already refuse
    // this (executed -> no_evidence), so this half is a belt-and-suspenders regression lock.
    appendLedger(ledgerPath, {
      run_id: "seed-1",
      task_id: "W1-T913-executed",
      step: "review.posted",
      head_sha: "sha-executed",
      state: "success",
      proof_exec: ["executed_pass"],
    });
    // A keyword-only/CAPPED terminal verdict: decideReviewStatusPost's own precedence rule does
    // NOT cover this shape (it only blocks executed -> no_evidence) — THIS is the gap
    // postReviewPending's own refusal exists to close.
    appendLedger(ledgerPath, {
      run_id: "seed-2",
      task_id: "W1-T913-keyword",
      step: "review.posted",
      head_sha: "sha-keyword",
      state: "success",
      proof_exec: ["not_executable"],
    });

    const posts: unknown[] = [];
    const post = (o: unknown) => {
      posts.push(o);
    };

    const executedResult = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "sha-executed",
      taskId: "W1-T913-executed",
      runId: "run-913",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post,
    });
    const keywordResult = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "sha-keyword",
      taskId: "W1-T913-keyword",
      runId: "run-913",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post,
    });

    assert.equal(executedResult.posted, false);
    assert.match(executedResult.reason ?? "", /never.*regressing|terminal/i);
    assert.equal(keywordResult.posted, false);
    assert.match(keywordResult.reason ?? "", /never.*regressing|terminal/i);
    assert.equal(posts.length, 0, "neither refusal may ever reach the raw poster");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T913: the terminal state REPLACES the pending on completion — postReviewStatusGuarded's own precedence never refuses a terminal post just because a pending preceded it", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const posts: Array<{ state: string }> = [];
    const post = (o: { state: string }) => {
      posts.push(o);
    };

    const pending = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "deadbeef",
      taskId: "W1-T913",
      runId: "run-913",
      ledgerPath,
      fetchLifecycle: () => NOT_MERGED,
      post,
    });
    assert.equal(pending.posted, true);

    const terminal = await postReviewStatusGuarded({
      owner: "o",
      repo: "r",
      sha: "deadbeef",
      state: "success",
      taskId: "W1-T913",
      evidence: "executed",
      ledgerPath,
      runId: "run-913",
      fetchLifecycle: () => NOT_MERGED,
      post,
    });
    assert.equal(terminal.posted, true);
    // postReviewStatusGuarded itself never ledgers `review.posted` on a SUCCESSFUL post — every
    // real caller (runReview/reviewCommand) writes that line itself, right after this call
    // returns (see run-task.ts's own `log("review.posted", ...)` immediately below its
    // postReviewStatusGuarded call). Mirrored here rather than re-deriving a second convention.
    appendLedger(ledgerPath, {
      run_id: "run-913",
      task_id: "W1-T913",
      step: "review.posted",
      head_sha: "deadbeef",
      state: "success",
      proof_exec: ["executed_pass"],
    });

    assert.deepEqual(
      posts.map((p) => p.state),
      ["pending", "success"],
    );
    const finalVerdict = lastPostedReviewStatusFromLedger(readLedgerLines(ledgerPath), "W1-T913");
    assert.equal(finalVerdict?.state, "success", "the terminal verdict is what the ledger's own reader reports now");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── criterion 4 — A PENDING NEVER ARMS, AND IS NEVER READ AS A VERDICT ──────────────────────

test("W1-T913 criterion 4: resolveReviewProvenance passes a TRUSTED pending status through as 'pending', unchanged — never coerced to 'absent'", () => {
  const resolved = resolveReviewProvenance({ state: "pending", posterLogin: "remudero-bot" }, "remudero-bot");
  assert.equal(resolved, "pending");
});

test("W1-T913 criterion 4: decideAutoMergeArmAtSha never arms on a trusted pending, and its reason names 'pending' — never worded as a failure and never as a forged/untrusted/absent poster", () => {
  const decision = decideAutoMergeArmAtSha({ state: "pending", posterLogin: "remudero-bot" }, "remudero-bot");
  assert.equal(decision.arm, false);
  assert.match(decision.reason, /pending/i);
  assert.doesNotMatch(decision.reason, /not success/, "must not reuse the genuine-failure wording");
  assert.doesNotMatch(decision.reason, /treated as absent/i, "must not reuse the forged/untrusted-poster wording");
});

test("W1-T913 criterion 4: an UNTRUSTED poster's pending still resolves to absent — provenance filtering is unaffected by this task", () => {
  const resolved = resolveReviewProvenance({ state: "pending", posterLogin: "some-other-bot" }, "remudero-bot");
  assert.equal(resolved, "absent");
  const decision = decideAutoMergeArmAtSha({ state: "pending", posterLogin: "some-other-bot" }, "remudero-bot");
  assert.equal(decision.arm, false);
});

// ── criterion 2 — THE STUCK-PENDING FALSIFIER ───────────────────────────────────────────────

function basePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date().toISOString(),
    headSha: "aaaa111",
    autoMergeArmed: false,
    requiredContextsUnreadable: false,
    ...over,
  };
}

test("W1-T913 criterion 2: a STALE remudero-review pending (posted well past the ceiling) is still offered to the post-review lane — a dead owner cannot strand it pending forever", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const staleSince = new Date(now - (DEFAULT_SWEEP_POLICY.pendingCeilingMinutes + 1) * 60_000).toISOString();
  const pr = basePr({ reviewState: "pending", reviewPendingSince: staleSince, lastActivityAt: staleSince });

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, now);
  assert.equal(result.disposition, "post-review");
  assert.match(result.reason, /pending/i);
});

test("W1-T913 criterion 2: an UNDATED remudero-review pending (no reviewPendingSince, no readable lastActivityAt) is ALSO offered — the fail-open direction, never silently stranded on state we cannot date", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const pr = basePr({ reviewState: "pending", reviewPendingSince: undefined, lastActivityAt: "not-a-date" });

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, now);
  assert.equal(result.disposition, "post-review");
});

test("W1-T913: a FRESH remudero-review pending (well inside the ceiling) is 'wait', not re-dispatched and not escalated — the anti-regression this task must not trade the silence for an escalation storm", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const freshSince = new Date(now - 5 * 60_000).toISOString();
  const pr = basePr({ reviewState: "pending", reviewPendingSince: freshSince, lastActivityAt: freshSince });

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, now);
  assert.equal(result.disposition, "wait");
  assert.doesNotMatch(result.reason, /escalat/i);
});

test("W1-T913: a checksState=green, reviewState=none head (the pre-existing shape) is UNCHANGED — still routes to post-review", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const pr = basePr({ reviewState: "none" });
  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, now);
  assert.equal(result.disposition, "post-review");
});
