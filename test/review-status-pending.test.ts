import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { CLAUDE_BIN_ENV_OVERRIDE } from "../src/lib/worker.js";
import { buildOpenPrViews, runReview } from "../src/run-task.js";
import {
  assessPendingReviewOwner,
  decideAutoMergeArmAtSha,
  lastPendingReviewStatusFromLedger,
  lastPostedReviewStatusFromLedger,
  postReviewPending,
  postReviewStatusGuarded,
  reviewInputDigest,
  resolveReviewProvenance,
  type PrLifecycleState,
} from "../src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";

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

// ── criterion 1 — EVERY DETECTOR POSTS PENDING FIRST (these three functions shell out to `gh`
// and/or spawn a worker, so their ordering is proven over source text — exactly like
// test/review.test.ts's own W1-T359 wiring check on the same functions — EXCEPT where a seam
// exists to drive it for real: the run lane's pending-before-the-reviewer-spawn half is asserted
// end-to-end below, over what `gh` observes, because #2714 made that spawn injectable and a
// source-text lock on its call site had already red-lined a PR that only moved it) ────────────

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

  // The TERMINAL post still replaces it on completion — the SAME single guarded site, unchanged.
  const terminalPostIdx = body.indexOf("const posted = await postReviewStatusGuarded({");
  assert.ok(terminalPostIdx > judgeIdx, "the terminal post must still run, after judging, exactly as before this task");
});

// The pending-post-BEFORE-the-advisory-reviewer-spawn half of criterion 1 used to live in the
// source-text test above as `body.indexOf("await spawnWorker(")`. That was a lock on a CALL SITE,
// not on the behaviour: #2717 replaced that call site and red-lined on this assertion alone, and
// #2714 (9b279dd8) has since made the very same spawn injectable via `reviewerQueryFn` — so the
// literal is one refactor from failing again over a property that never moved.
//
// Asserted BEHAVIOURALLY below instead, against what `gh` itself observes. The fake `gh` on PATH
// appends every argv it is called with to a log file, and that log is SNAPSHOTTED at the moment
// the advisory reviewer spawn is reached; the `remudero-review`/`state=pending` POST for this
// head must already be in the snapshot. Two things make it a real assertion rather than a
// tautology (W1-T1051's warning — never an assertion a comment could satisfy):
//
//  - it matches that ONE POST specifically, not "some gh call happened first", so moving the
//    pending post below the reviewer block fails it; and
//  - `runReview`'s own returned `reviewerOutcome` must not be `not_attempted`, so a green that
//    survives the expensive work never being reached — the exact defect criterion 1 exists to
//    catch — is impossible. `spawnReviewer: false` reproduces that shape and fails here.
//
// WHY THE SNAPSHOT HAS TWO OBSERVERS. `runReview`'s `spawnWorker` call takes no keychain seam, so
// on darwin it runs the REAL `ensureWorkerKeychain` rung and refuses headlessly (measured on this
// repo's own mini: `provision-failed` reading the login keychain), while on a linux CI runner the
// injected `reviewerQueryFn` is reached and returns. BOTH mean control got to the spawn — the
// property under test — so both snapshot, and the run's `reviewerOutcome` distinguishes them
// (`success` vs `spawn_error`) without either becoming a skip. The end-to-end harness (fake `gh`,
// env-override `claude` binary for the executable preflight, `CLAUDE_CODE_OAUTH_TOKEN` for the
// non-darwin credential preflight, injected `reviewerQueryFn` so nothing is spawned or spent)
// mirrors test/worker.test.ts's own W1-T2205 `runReview` end-to-end test, where it was measured.

test("W1-T913 criterion 1 (run lane, behavioural): the remudero-review=pending POST has ALREADY happened by the time runReview reaches the advisory reviewer spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-pending-e2e-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-review-pending-e2e-gh-"));
  const oldPath = process.env.PATH;
  const oldClaudeBinOverride = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
    const ledgerPath = join(root, "ledger.ndjson");
    const ghLog = join(root, "gh-calls.log");

    // Never a real secret — the injected `reviewerQueryFn` means it is never sent anywhere. Present
    // so the non-darwin credential preflight is deterministic on a CI runner with no credential
    // file, exactly as test/worker.test.ts's own end-to-end test documents.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-never-sent-reviewerQueryFn-intercepts-the-spawn";

    // `--version` must exit 0 for `defaultCanExecute` to accept it; never actually run as a worker.
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;

    // Records its own argv FIRST, then answers only what runReview's plumbing needs before the
    // reviewer spawn: readHeadShaRest, postReviewPending's lifecycle read and status POST, and
    // `gh pr diff`.
    writeFileSync(
      join(binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"cafebabe0002"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"cafebabe0002"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") echo "" ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${oldPath}`;

    let ghCallsAtReviewerSpawn: string | undefined;
    const snapshotGhCalls = () => {
      if (ghCallsAtReviewerSpawn === undefined) ghCallsAtReviewerSpawn = readFileSync(ghLog, "utf8");
    };

    const reviewerQueryFn = (() => {
      snapshotGhCalls();
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "REVIEW_VERDICT 1: PASS",
          session_id: "s-reviewer-pending-order",
          total_cost_usd: 0.01,
          num_turns: 1,
        };
      })();
    }) as unknown as Parameters<typeof runReview>[0]["reviewerQueryFn"];

    const reviewEvents: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const verdict = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T913", acceptance: [{ claim: "a claim the report never substantiates", proof: "unit test: no-such-test-title-xyzzy" }] },
      report: "This report deliberately substantiates nothing.",
      reviewInputBody: "The actual PR body snapshot used only for retry identity.",
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as never,
      // The spawn's OWN outcome line, whichever way it went — the second observer.
      log: (step: string, extra?: Record<string, unknown>) => {
        reviewEvents.push({ step, extra });
        if (step === "review.reviewer" || step === "review.reviewer.error") snapshotGhCalls();
      },
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: true,
      reviewerQueryFn,
      // Injected so the post-verdict withdrawal never reaches the real `gh pr merge` boundary.
      // Without it the run trips `live-write-guard`'s REFUSED gh-pr-merge (the guard checks the
      // CALL, not the destination, so the PATH-stubbed `gh` above is deliberately not enough) —
      // nothing live happens either way, but the boundary is not this test's business at all.
      disarm: () => {},
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 },
      ledgerPath,
      runId: "REVIEW-PENDING-ORDER-1",
    } as never);

    assert.notEqual(
      verdict.reviewerOutcome,
      "not_attempted",
      "the advisory reviewer spawn must actually be reached — an ordering assertion that passes when the expensive work never runs is the defect, not the proof",
    );
    assert.ok(ghCallsAtReviewerSpawn !== undefined, "the reviewer spawn was reached but nothing snapshotted the gh log at that point");
    assert.match(
      ghCallsAtReviewerSpawn!,
      /statuses\/cafebabe0002 -f context=remudero-review -f state=pending/,
      "the remudero-review=pending POST for THIS head must already have been made by the time the advisory reviewer is spawned",
    );

    // The same fact from the run's own ledger, at the SAME head: the pending post really went
    // through the one guarded site rather than merely reaching `gh` by some other route.
    const pending = readLedgerLines(ledgerPath).filter((l) => l.step === "review.pending_posted");
    assert.equal(pending.length, 1, "exactly one review.pending_posted line for this head");
    assert.equal(pending[0]?.head_sha, "cafebabe0002");
    assert.equal(pending[0]?.pr_url, "https://github.com/acme/remudero/pull/1");
    assert.equal(
      pending[0]?.review_input_digest,
      reviewInputDigest("cafebabe0002", "The actual PR body snapshot used only for retry identity."),
    );
    const terminal = reviewEvents.find((event) => event.step === "review.posted");
    assert.equal(terminal?.extra?.pr_url, "https://github.com/acme/remudero/pull/1");
    assert.equal(
      terminal?.extra?.review_input_digest,
      reviewInputDigest("cafebabe0002", "The actual PR body snapshot used only for retry identity."),
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldClaudeBinOverride === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
    else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldClaudeBinOverride;
    if (oldOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldOauthToken;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
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
    const prUrl = "https://github.com/o/r/pull/913";
    const inputDigest = reviewInputDigest("abc1234", "acceptance body");
    const ownerStartedAt = "2026-09-04T20:30:00.000Z";
    const posts: Array<{ owner: string; repo: string; sha: string; state: string; description?: string }> = [];

    const result = await postReviewPending({
      owner: "o",
      repo: "r",
      sha: "abc1234",
      taskId: "W1-T913",
      runId: "run-913-a",
      ledgerPath,
      prUrl,
      reviewInputDigest: inputDigest,
      ownerIdentity: { pid: 4242, startedAt: ownerStartedAt },
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
    assert.equal(pendingLine?.host, hostname(), "appendLedger's durable writer host is the owner host");
    assert.equal(pendingLine?.owner_pid, 4242);
    assert.equal(pendingLine?.owner_started_at, ownerStartedAt);
    assert.equal(pendingLine?.pr_url, prUrl);
    assert.equal(pendingLine?.review_input_digest, inputDigest);

    const record = lastPendingReviewStatusFromLedger(lines, "W1-T913");
    assert.deepEqual(record, {
      headSha: "abc1234",
      runId: "run-913-a",
      postedAt: pendingLine?.ts,
      ownerPid: 4242,
      ownerHost: hostname(),
      ownerStartedAt,
    });
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

test("W1-T913: a pending post for a NEW head (a push landed) is NOT a no-op — exact-input idempotency resets", async () => {
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

test("a PR-body edit on the same head is a new pending-review input, not a deduped repeat", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const sha = "abc1234";
    const prUrl = "https://github.com/o/r/pull/913";
    const posts: unknown[] = [];
    const post = (o: unknown) => {
      posts.push(o);
    };

    await postReviewPending({
      owner: "o",
      repo: "r",
      sha,
      taskId: "W1-T913",
      runId: "run-before-edit",
      ledgerPath,
      prUrl,
      reviewInputDigest: reviewInputDigest(sha, "old body"),
      fetchLifecycle: () => NOT_MERGED,
      post,
    });
    appendLedger(ledgerPath, {
      run_id: "run-before-edit",
      task_id: "W1-T913",
      step: "review.posted",
      head_sha: sha,
      pr_url: prUrl,
      review_input_digest: reviewInputDigest(sha, "old body"),
      state: "failure",
      proof_exec: ["executed_fail"],
    });
    const afterEdit = await postReviewPending({
      owner: "o",
      repo: "r",
      sha,
      taskId: "W1-T913",
      runId: "run-after-edit",
      ledgerPath,
      prUrl,
      reviewInputDigest: reviewInputDigest(sha, "corrected body"),
      fetchLifecycle: () => NOT_MERGED,
      post,
    });

    assert.equal(afterEdit.posted, true);
    assert.equal(posts.length, 2, "even an executed terminal verdict for the old body cannot suppress the changed input");
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

test("W1-T2844: a FRESH pending review with a positively dead owner is re-offered immediately", () => {
  const now = Date.parse("2026-09-04T20:35:00.000Z");
  const freshSince = new Date(now - 5 * 60_000).toISOString();
  const pr = basePr({
    reviewState: "pending",
    reviewPendingSince: freshSince,
    lastActivityAt: freshSince,
    reviewPendingOwnerDead: true,
  });

  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, now);
  assert.equal(result.disposition, "post-review");
  assert.match(result.reason, /owner proven dead/i);
});

test("W1-T2844: pending-owner assessment delegates the complete holder identity to isHolderStale", () => {
  const record = {
    headSha: "abc1234",
    runId: "run-owner",
    postedAt: "2026-09-04T20:30:00.000Z",
    ownerPid: 41,
    ownerHost: "current-host",
    ownerStartedAt: "2026-09-04T20:29:00.000Z",
  };
  let observedHolder: unknown;
  const assessment = assessPendingReviewOwner(record, {
    isPidAlive: () => true,
    hostname: () => "current-host",
    getProcessStartTime: () => null,
    inContainer: () => false,
    isStale: (holder) => {
      observedHolder = holder;
      return true;
    },
  });

  assert.equal(assessment, "dead");
  assert.deepEqual(observedHolder, {
    pid: 41,
    host: "current-host",
    startedAt: "2026-09-04T20:29:00.000Z",
  });
});

test("W1-T2844: live, legacy, incomplete and foreign-indeterminate owners never manufacture a dead fact", () => {
  const complete = {
    headSha: "abc1234",
    runId: "run-owner",
    postedAt: "2026-09-04T20:30:00.000Z",
    ownerPid: 41,
    ownerHost: "current-host",
    ownerStartedAt: "2026-09-04T20:29:00.000Z",
  };
  let staleCalls = 0;
  const common = {
    isPidAlive: () => true,
    hostname: () => "current-host",
    getProcessStartTime: () => null,
    inContainer: () => false,
    isStale: () => {
      staleCalls++;
      return false;
    },
  };

  assert.equal(assessPendingReviewOwner(complete, common), "active");
  assert.equal(assessPendingReviewOwner({ ...complete, ownerPid: undefined }, common), "unknown");
  assert.equal(assessPendingReviewOwner({ ...complete, ownerStartedAt: undefined }, common), "unknown");
  assert.equal(assessPendingReviewOwner({ ...complete, ownerHost: "foreign-host" }, common), "unknown");
  assert.equal(staleCalls, 2, "only complete identities reach the shared primitive; a foreign non-stale result remains unknown");
});

test("W1-T2844: buildOpenPrViews carries a dead-owner fact only for the current pending head", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const headSha = "cccc3333cccc3333cccc3333cccc3333cccc3333";
    const taskId = "W1-T2844";
    const prUrl = "https://github.com/o/r/pull/2844";
    const body = `Remudero-Task: ${taskId}`;
    const pendingLine = {
      ts: "2026-09-04T20:30:00.000Z",
      host: "deadbeefcafe",
      run_id: "run-owner",
      task_id: taskId,
      step: "review.pending_posted",
      head_sha: headSha,
      pr_url: prUrl,
      review_input_digest: reviewInputDigest(headSha, body),
      owner_pid: 41,
      owner_started_at: "2026-09-04T20:29:00.000Z",
    };
    writeFileSync(ledgerPath, `${JSON.stringify(pendingLine)}\n`);

    const fetch = (args: string[]): unknown => {
      const path = args[args.length - 1] ?? "";
      if (/state=open/.test(path)) {
        return [{
          number: 2844,
          html_url: prUrl,
          head: { ref: "run-W1-T2844-1", sha: headSha },
          updated_at: "2026-09-04T20:31:00.000Z",
          body,
          auto_merge: null,
          state: "open",
        }];
      }
      if (/check-runs/.test(path)) {
        return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-09-04T20:25:00.000Z" }] };
      }
      if (/commits\/.+\/status/.test(path)) {
        return { statuses: [{ context: "remudero-review", state: "pending", created_at: "2026-09-04T20:30:00.000Z" }] };
      }
      if (/\/pulls\/2844$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
      return [];
    };
    let assessed = 0;
    const deps = {
      fetch,
      requiredContexts: () => ["ci-gate"],
      assessPendingOwner: () => {
        assessed++;
        return "dead" as const;
      },
    };
    const [current] = buildOpenPrViews("o", "r", ledgerPath, deps);
    assert.equal(assessed, 1);
    assert.equal(current?.reviewPendingOwnerDead, true);

    writeFileSync(ledgerPath, `${JSON.stringify({ ...pendingLine, head_sha: "old-head" })}\n`);
    assessed = 0;
    const [old] = buildOpenPrViews("o", "r", ledgerPath, deps);
    assert.equal(assessed, 0, "an old-head owner is never assessed as if it owned the current review");
    assert.equal(old?.reviewPendingOwnerDead, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T913: a checksState=green, reviewState=none head (the pre-existing shape) is UNCHANGED — still routes to post-review", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const pr = basePr({ reviewState: "none" });
  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, now);
  assert.equal(result.disposition, "post-review");
});
