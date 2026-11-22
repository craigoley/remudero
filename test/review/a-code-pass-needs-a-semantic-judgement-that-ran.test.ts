/**
 * W1-T14235 (invariant no-semantic-no-code-pass) — a code pull request's remudero-review success comes only from a
 * review whose semantic judgement ran. A deterministic-only review (reviewer_outcome not_attempted_deterministic_mode,
 * or any outcome but success) posts pending or leaves a standing failure standing, arms nothing, and no restore, reuse
 * or cut-post settlement re-publishes such a pass. A plan-only diff keeps its deterministic path.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { operatorReviewArgs, reviewCommand, runReview, type ReviewCommandDeps, type ReviewCommandHost } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import {
  drainReviewOutbox, postReviewStatusGuarded, reviewOutboxEntryPath, semanticJudgementRefusal,
  type PostReviewStatusGuardedOpts, type ReviewVerdict,
} from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { REVIEW_STATUS_RESTORED_STEP, type OpenPrView, type ReviewReuseInputs } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { CLAUDE_BIN_ENV_OVERRIDE, spawnWorker } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildSweepEffects } from "#test/helpers/run-task-test.js";

const SHA = "1435a0c0de0000000000000000000000000000ab";
const PR_NUMBER = 19721;
const PR_URL = `https://github.com/acme/remudero/pull/${PR_NUMBER}`;
const DIGEST = "v2:t14235";
const CODE_SHA = "c".repeat(40);
const CRITERIA = [{ claim: "the change ships", proof: "grep: ships in src/x.ts", met: true, floorMet: true,
  reason: "proof passed", proof_exec: "executed_pass" }] as ReviewVerdict["criteria"];
const PASS: ReviewVerdict = { state: "success", criteria: CRITERIA, testTheater: false, floorDegraded: false, capped: false,
  keywordOnly: false, planOnly: false, summary: "remudero-review: PASS — 1/1 criteria met" };
const PLAN_PASS: ReviewVerdict = { ...PASS, planOnly: true, planLint: { ran: true, label: "fixture", checked: 1, violations: [] },
  summary: "remudero-review: PASS — plan-only" } as ReviewVerdict;

type Posted = { state: string; description?: string };

function tmp(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14235-${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The guarded poster with every GitHub read injected; `live` is the remudero-review state on the head. */
async function guardedPost(t: TestContext, verdict: ReviewVerdict, judgement: PostReviewStatusGuardedOpts["semanticJudgement"],
  live?: "success" | "failure" | "pending" | "throws", priorRows: Array<Record<string, unknown>> = []) {
  const ledgerPath = join(tmp(t, "post"), "ledger.ndjson");
  for (const row of priorRows) appendLedger(ledgerPath, row as Parameters<typeof appendLedger>[1]);
  const posts: Posted[] = [];
  const result = await postReviewStatusGuarded({
    owner: "acme", repo: "remudero", sha: SHA, state: verdict.state as "success", verdict, description: verdict.summary,
    taskId: "W1-T14235", evidence: "executed", ledgerPath, runId: "t14235", prUrl: PR_URL, reviewInputDigest: DIGEST,
    fetchLifecycle: () => ({ merged: false, closed: false }),
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchCurrentStatusEntry: () => {
      if (live === "throws") throw new Error("status read failed");
      return live === undefined ? undefined : { state: live };
    },
    post: (status) => { posts.push({ state: status.state, description: status.description }); },
    ...(judgement === undefined ? {} : { semanticJudgement: judgement }),
  });
  return { result, posts, rows: readLedgerLines(ledgerPath) };
}

test("W1-T14235 criterion 1: a code pass with no successful semantic judgement posts pending naming the outcome", async (t) => {
  for (const [outcome, named] of [
    ["not_attempted_deterministic_mode", "not_attempted_deterministic_mode"], ["not_attempted", "not_attempted"],
    ["spawn_error", "spawn_error"], ["unknown", "unknown"], ["error_max_turns", "error_max_turns"],
    [undefined, "unrecorded"], ["", "unrecorded"],
  ] as const) {
    const { result, posts, rows } = await guardedPost(t, PASS, { planOnly: false, reviewerOutcome: outcome }, "success");
    assert.deepEqual(posts.map((p) => p.state), ["pending"], `${String(outcome)}: only pending is posted`);
    assert.match(posts[0]!.description ?? "", new RegExp(`semantic-review-not-run: ${named}`));
    assert.equal(result.effectiveState, "pending");
    assert.equal(result.semanticHold, `semantic-review-not-run: ${named}`);
    const refused = rows.find((row) => row.step === "review.semantic_pass_refused");
    assert.ok(refused, `${String(outcome)}: the hold is ledgered`);
    assert.equal(refused.outcome, "pending");
  }
  // A missing plan-only fact is not plan-only.
  const { posts } = await guardedPost(t, { ...PASS, planOnly: undefined } as unknown as ReviewVerdict,
    { planOnly: undefined, reviewerOutcome: "not_attempted_deterministic_mode" });
  assert.deepEqual(posts.map((p) => p.state), ["pending"]);
});

test("W1-T14235 criterion 1: over a standing FAIL a deterministic pass posts nothing and the failure stands", async (t) => {
  const { result, posts, rows } = await guardedPost(t, PASS,
    { planOnly: false, reviewerOutcome: "not_attempted_deterministic_mode" }, "failure");
  assert.deepEqual(posts, [], "neither success nor pending replaces the standing failure");
  assert.equal(result.posted, false);
  assert.equal(result.effectiveState, "failure");
  assert.match(result.reason ?? "", /semantic-review-not-run: not_attempted_deterministic_mode; the standing remudero-review failure stands/);
  assert.equal(rows.find((row) => row.step === "review.semantic_pass_refused")?.outcome, "failure_stands");
  const unreadable = await guardedPost(t, PASS, { planOnly: false, reviewerOutcome: "not_attempted" }, "throws");
  assert.deepEqual(unreadable.posts, [], "an unreadable live status posts nothing");
  assert.equal(unreadable.result.effectiveState, "pending");
});

const posted = (state: string, reviewerOutcome: string, over: Record<string, unknown> = {}) => ({ run_id: `prior-${state}`,
  task_id: "W1-T14235", step: "review.posted", state, head_sha: SHA, pr_url: PR_URL, review_input_digest: DIGEST,
  decision_verdict: { ...PASS, state }, reviewer_outcome: reviewerOutcome, ...over });

test("W1-T14235 criterion 1: a refused pass posts nothing over a semantic pass the ledger records for the same head", async (t) => {
  // The landing review's deterministic re-review of a head the semantic review already passed.
  for (const live of ["success", "pending"] as const) {
    const { result, posts, rows } = await guardedPost(t, PASS,
      { planOnly: false, reviewerOutcome: "not_attempted_deterministic_mode" }, live, [posted("success", "success")]);
    assert.deepEqual(posts, [], `${live}: the semantic pass is not downgraded`);
    assert.equal(result.posted, false);
    assert.equal(result.semanticHold, "semantic-review-not-run: not_attempted_deterministic_mode");
    const refused = rows.find((row) => row.step === "review.semantic_pass_refused");
    assert.equal(refused?.outcome, "semantic_success_stands", "the refusal row is still written");
    assert.equal(refused?.standing_run_id, "prior-success");
  }
  // CONTROLS: a deterministic pass, a semantic pass for another head, or a later failure on this head stands for nothing.
  for (const prior of [
    [posted("success", "not_attempted_deterministic_mode")],
    [posted("success", "success", { head_sha: "f".repeat(40) })],
    [posted("success", "success"), posted("failure", "success")],
    [posted("success", "success", { pr_url: "https://github.com/acme/remudero/pull/1" })],
  ]) {
    const { posts, rows } = await guardedPost(t, PASS, { planOnly: false, reviewerOutcome: "not_attempted" }, "success", prior);
    assert.deepEqual(posts.map((p) => p.state), ["pending"], JSON.stringify(prior.map((row) => [row.state, row.reviewer_outcome, row.head_sha])));
    assert.equal(rows.find((row) => row.step === "review.semantic_pass_refused")?.outcome, "pending");
  }
});

// ── the hand review, end to end, over a standing semantic FAIL ──────────────────────────────────────────────────────

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const HAND_URL = "https://github.com/craigoley/remudero/pull/9997";
// An untasked body whose one grep proof passes on this checkout, so the deterministic floor alone would PASS.
const PASSING_BODY = [
  "## Acceptance",
  "- the review command module defines the review command | grep: export async function reviewCommand( in src/cli/commands/review.ts",
  "",
].join("\n");
function unexpected(): never { throw new Error("unexpected review fixture dependency"); }
const host: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: (event) => event,
  ledgeredNonDispatchSpawn: (_lane, raw) => raw ?? spawnWorker,
  lintPlanForReview: unexpected,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpected,
  readHeadShaRest: () => HEAD,
  readMainPlanTreeSha: unexpected,
  realDeps: () => ({ reviewWorktree: { fetch: () => {} } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: () => 60_000,
  reviewSubjectGit: unexpected,
};

async function deterministicHandReview(t: TestContext, liveReview: "failure" | "none") {
  const root = tmp(t, "hand");
  const binDir = tmp(t, "hand-bin");
  const combined = liveReview === "failure"
    ? JSON.stringify({ statuses: [{ context: "remudero-review", state: "failure", description: "remudero-review: FAIL — semantic" }] })
    : '{"statuses":[]}';
  const pull = { number: 9997, html_url: HAND_URL, updated_at: "t", body: PASSING_BODY, state: "open", merged: false,
    head: { ref: "codex/t14235", sha: HEAD } };
  const shim = ghShim([
    { when: "/statuses?", stdout: liveReview === "failure"
      ? JSON.stringify([{ context: "remudero-review", state: "failure", description: "remudero-review: FAIL — semantic" }]) : "[[]]" },
    { when: "/reviews?", stdout: "[]" },
    { when: "/commits/", stdout: combined },
    { when: "/pulls/", stdout: JSON.stringify(pull) },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "pr diff", stdout: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n" },
    { when: "api ", stdout: "{}" },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  const oldClaude = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldLog = console.log;
  const effects: string[] = [];
  try {
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;
    process.env.PATH = `${shim.dir}:${binDir}:${oldPath}`;
    console.log = () => {};
    const deps: ReviewCommandDeps = {
      fetchView: (viewArgs) => viewArgs.join(" ").endsWith("/pulls/9997")
        ? pull : { headRefOid: HEAD, headRefName: "codex/t14235", body: PASSING_BODY, url: HAND_URL, number: 9997 },
      fetchHead: () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true", enabledProviders: ["claude"] }) as Config,
      postReviewPending: async () => ({ posted: true }),
      materialize: () => ({ worktreePath: REPO_ROOT }),
      withMaterialized: async (_path, _repo, run) => run(),
      buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set<string>(), baseIsCheckout: false, addedTestFiles: new Set<string>() }),
      runReview: (args) => runReview(host, { ...args,
        arm: () => { effects.push("arm"); return "armed"; },
        disarm: () => { effects.push("disarm"); return "not-armed"; } }),
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
    } satisfies ReviewCommandDeps;
    const code = await reviewCommand(host, "9997",
      operatorReviewArgs(["--repo", "craigoley/remudero", "--execution-mode", "deterministic"]), deps);
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return { code, ledger, effects, statusPosts: shim.calls().filter((call) => call.includes("context=remudero-review")) };
  } finally {
    console.log = oldLog;
    process.env.PATH = oldPath;
    if (oldClaude === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
    else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldClaude;
  }
}

test("W1-T14235 criterion 1: an explicit deterministic hand review never posts success over a standing FAIL and arms nothing", async (t) => {
  const { code, ledger, effects, statusPosts } = await deterministicHandReview(t, "failure");
  assert.ok(!statusPosts.some((call) => call.includes("state=success")), `no success is posted: ${statusPosts.join(" | ")}`);
  // The review's own in-progress claim is the only pending; the hold adds none over the live failure.
  assert.ok(!statusPosts.some((call) => call.includes("state=pending") && call.includes("semantic-review-not-run")),
    `the hold posts no pending over the standing failure: ${statusPosts.join(" | ")}`);
  assert.ok(!effects.includes("arm"), "nothing is armed");
  assert.ok(!ledger.some((row) => row.step === "automerge.armed"));
  assert.ok(!ledger.some((row) => row.step === "review.posted" && row.state === "success"), "no success row is recorded");
  const refused = ledger.find((row) => row.step === "review.semantic_pass_refused");
  assert.ok(refused, `the hold is ledgered; steps: ${ledger.map((row) => row.step).join(",")}`);
  assert.equal(refused.reason, "semantic-review-not-run: not_attempted_deterministic_mode");
  assert.equal(refused.outcome, "failure_stands");
  assert.notEqual(code, 0, "the review command reports the pass as not published");
});

test("W1-T14235 criterion 1: an explicit deterministic hand review on a clean head posts pending, never success", async (t) => {
  const { code, ledger, effects, statusPosts } = await deterministicHandReview(t, "none");
  assert.ok(!statusPosts.some((call) => call.includes("state=success")), `no success is posted: ${statusPosts.join(" | ")}`);
  assert.ok(statusPosts.some((call) => call.includes("state=pending") && call.includes("semantic-review-not-run")),
    `a pending naming the reason is posted: ${statusPosts.join(" | ")}`);
  assert.ok(!effects.includes("arm"));
  assert.ok(!ledger.some((row) => row.step === "review.posted" && row.state === "success"));
  assert.notEqual(code, 0);
});

// ── re-publication: status restore, verdict reuse and cut-post settlement ──────────────────────────────────────────

const REVIEW_KEY = `input:${JSON.stringify(["W1-T14235", PR_URL, SHA, DIGEST])}`;
const PENDING_SINCE = "2026-11-21T02:54:08.000Z";

async function sweepRepublish(t: TestContext, mode: "restore" | "reuse" | "discriminate-only", row: Record<string, unknown>) {
  const root = tmp(t, `sweep-${mode}`);
  const ledgerPath = join(root, "ledger.ndjson");
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: `pulls/${PR_NUMBER}`, stdout: '{"state":"open","merged":false}' },
    { when: "pr diff", stdout: "diff --git a/src/x.ts b/src/x.ts\n+ships\n" },
  ], { kind: "t14235-sweep" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
  const steps: Array<{ step: string; fields: Record<string, unknown> }> = [];
  try {
    appendLedger(ledgerPath, { run_id: "deterministic-hand-run", task_id: "W1-T14235", step: "review.posted", ts: "2026-11-21T02:52:00.000Z",
      state: "success", head_sha: SHA, pr_url: PR_URL, review_input_digest: DIGEST, reviewer_code_sha: CODE_SHA, ...row });
    appendLedger(ledgerPath, { run_id: "takeover", task_id: "W1-T14235", step: "review.pending_posted", ts: PENDING_SINCE,
      pr_url: PR_URL, head_sha: SHA, review_input_digest: DIGEST });
    const effects = buildSweepEffects({
      owner: "acme", repo: "remudero", localRepoName: "not-remudero", config: { root } as never, ledgerPath, runId: "t14235-sweep",
      plan: { tasks: [], byId: new Map() } as never,
      log: (step, fields) => steps.push({ step, fields: (fields ?? {}) as Record<string, unknown> }),
      reviewerCodeFreshnessImpl: () => ({ status: "fresh" as const, codeSha: CODE_SHA, originMainSha: CODE_SHA, advance: "none" as const }),
      reviewRunner: async () => { steps.push({ step: "full-review", fields: {} }); return 0; },
      materializeReviewWorktreeImpl: () => ({ worktreePath: "/head" }),
      buildBaseProofDirImpl: () => ({ baseCheckoutDir: "/base", baseUnreadablePaths: new Set<string>(), baseIsCheckout: true, addedTestFiles: new Set<string>() }),
      reviewReuseExecProofImpl: (_proof: string, cwd: string) => cwd === "/head" ? "pass" : "fail",
      worktreeRemoveImpl: () => {},
    });
    const pr = {
      prNumber: PR_NUMBER, prUrl: PR_URL, taskId: "W1-T14235", headSha: SHA, reviewInputDigest: DIGEST,
      reviewState: mode === "restore" ? "pending" : "none", reviewPendingSince: mode === "restore" ? PENDING_SINCE : undefined,
      reviewPendingOwnerDead: mode === "restore" ? true : undefined, checksState: "green", unmetCriteria: [], priorStrikes: 0,
      lastActivityAt: "2026-11-21T02:00:00Z", autoMergeArmed: false, body: "Remudero-Task: W1-T14235",
      currentOwnDiffDigest: "sha256:own", currentMergeBaseSha: "base-now",
    } as OpenPrView & Partial<ReviewReuseInputs>;
    const dispatched = mode === "restore"
      ? { kind: "restore" as const, judgedHeadSha: SHA, regressionKey: `${REVIEW_KEY}|${PENDING_SINCE}` }
      : { kind: mode, judgedHeadSha: SHA };
    await withLiveWritesAllowed(() => effects.postReview!(pr, dispatched));
    const rows = readLedgerLines(ledgerPath);
    return {
      steps, fullReviews: steps.filter((s) => s.step === "full-review").length,
      successPosts: shim.calls().filter((call) => call.includes("context=remudero-review") && call.includes("state=success")),
      restored: rows.filter((r) => r.step === REVIEW_STATUS_RESTORED_STEP),
      reused: rows.filter((r) => r.step === "review.posted" && r.effective_review_mode === "verdict-reuse"),
      discriminated: rows.filter((r) => r.step === "review.posted" && r.effective_review_mode === "proof-only-discrimination"),
    };
  } finally {
    process.env.PATH = priorPath;
  }
}

test("W1-T14235 criterion 2: status restore re-publishes no recorded deterministic PASS and runs a full review", async (t) => {
  const out = await sweepRepublish(t, "restore", { decision_verdict: PASS, reviewer_outcome: "not_attempted_deterministic_mode" });
  assert.deepEqual(out.successPosts, [], "the recorded deterministic PASS is not re-published");
  assert.equal(out.restored.length, 0);
  assert.equal(out.fullReviews, 1, "the head gets a full semantic review instead");
  const withheld = out.steps.find((s) => s.step === "sweep.review_restore_withheld");
  assert.equal(withheld?.fields.reason, "semantic-review-not-run: not_attempted_deterministic_mode");
  const missing = await sweepRepublish(t, "restore", { decision_verdict: PASS });
  assert.deepEqual(missing.successPosts, [], "a missing reviewer_outcome is not success");
  assert.equal(missing.restored.length, 0);
});

test("W1-T14235 criterion 2: verdict reuse re-publishes no recorded deterministic PASS and runs a full review", async (t) => {
  for (const row of [{ decision_verdict: PASS, reviewer_outcome: "not_attempted_deterministic_mode" }, { decision_verdict: PASS }]) {
    const out = await sweepRepublish(t, "reuse", row);
    assert.deepEqual(out.successPosts, []);
    assert.equal(out.reused.length, 0);
    assert.equal(out.fullReviews, 1);
    const fallback = out.steps.find((s) => s.step === "sweep.review_reuse_discrimination_fallback");
    assert.match(String(fallback?.fields.fallback_reason), /^semantic-review-not-run: /);
  }
});

/** A cut post: its outbox entry says `posting`, its pass already stands on GitHub, and no review.posted row followed. */
async function settleCutPass(t: TestContext, reviewerOutcome: string | undefined) {
  const ledgerPath = join(tmp(t, "outbox"), "state", "ledger.ndjson");
  const entryPath = reviewOutboxEntryPath(ledgerPath, PR_URL, DIGEST);
  mkdirSync(dirname(entryPath), { recursive: true });
  const description = "remudero-review: PASS — 1/1 criteria met";
  writeFileSync(entryPath, JSON.stringify({
    version: 1, input_key: DIGEST, head_sha: SHA, state: "success", description, owner: "acme", repo: "remudero",
    task_id: "W1-T14235", pr_url: PR_URL, run_id: "cut-run", evidence: "executed", review_decision_digest: "d".repeat(64),
    decision_verdict: PASS, reviewer_code_sha: CODE_SHA, written_at: "2026-11-21T02:52:00.000Z", posting: true,
    ...(reviewerOutcome === undefined ? {} : { reviewer_outcome: reviewerOutcome }),
  }));
  const posts: Posted[] = [];
  const drained = await drainReviewOutbox({
    owner: "acme", repo: "remudero", sha: SHA, taskId: "W1-T14235", runId: "drain", ledgerPath, prUrl: PR_URL,
    reviewInputDigest: DIGEST, fetchLifecycle: () => ({ merged: false, closed: false }),
    post: (status) => { posts.push({ state: status.state, description: status.description }); },
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    // The cut post's pass already stands on GitHub.
    liveStatus: { state: "success", description },
    judgeReviewerCode: async () => ({ status: "fresh", codeSha: CODE_SHA, originMainSha: CODE_SHA, advance: "none" }),
  });
  return { drained, posts, rows: readLedgerLines(ledgerPath), entryLeft: existsSync(entryPath) };
}

test("W1-T14235 criterion 2: a proof-only re-judgement carries no recorded deterministic PASS forward", async (t) => {
  for (const row of [{ decision_verdict: PASS, reviewer_outcome: "not_attempted_deterministic_mode" }, { decision_verdict: PASS }]) {
    const out = await sweepRepublish(t, "discriminate-only", row);
    assert.deepEqual(out.successPosts, []);
    assert.equal(out.discriminated.length, 0);
    assert.equal(out.fullReviews, 1);
    const fallback = out.steps.find((s) => s.step === "sweep.review_reuse_discrimination_fallback");
    assert.match(String(fallback?.fields.fallback_reason), /^semantic-review-not-run: /);
  }
});

test("W1-T14235 criterion 2: cut-post settlement settles no pass whose recorded reviewer_outcome is not success", async (t) => {
  for (const outcome of ["not_attempted_deterministic_mode", undefined]) {
    const out = await settleCutPass(t, outcome);
    assert.notEqual(out.drained.outcome, "posted", `${String(outcome)}: the cut pass is not settled as posted`);
    assert.ok(!out.posts.some((p) => p.state === "success"), "no success is re-published");
    assert.ok(!out.rows.some((r) => r.step === "review.posted" && r.state === "success"), "no success row is recorded");
    assert.equal(out.entryLeft, false, "the entry is discarded");
    assert.deepEqual(out.posts.map((p) => p.state), ["pending"], "the standing cut pass is replaced by pending");
  }
});

// ── unchanged: a semantic success and a plan-only deterministic review ───────────────────────────────────────────

test("W1-T14235 criterion 3: a successful semantic review and a plan-only deterministic review post success as today", async (t) => {
  const semantic = await guardedPost(t, PASS, { planOnly: false, reviewerOutcome: "success" }, "failure");
  assert.deepEqual(semantic.posts.map((p) => p.state), ["success"]);
  assert.equal(semantic.result.semanticHold, undefined);
  const planOnly = await guardedPost(t, PLAN_PASS, { planOnly: true, reviewerOutcome: "not_attempted_plan_only" });
  assert.deepEqual(planOnly.posts.map((p) => p.state), ["success"]);
  assert.ok(!planOnly.rows.some((row) => row.step === "review.semantic_pass_refused"));
  // A failure still publishes as failure, whatever the outcome.
  const failed = await guardedPost(t, { ...PASS, state: "failure", summary: "remudero-review: FAIL — 0/1" },
    { planOnly: false, reviewerOutcome: "not_attempted_deterministic_mode" });
  assert.deepEqual(failed.posts.map((p) => p.state), ["failure"]);
  assert.equal(semanticJudgementRefusal({ planOnly: false, reviewerOutcome: "success" }), undefined);
  assert.equal(semanticJudgementRefusal({ planOnly: true, reviewerOutcome: undefined }), undefined);
});

test("W1-T14235 criterion 3: restore, reuse and settlement still re-publish a pass whose recorded outcome is success", async (t) => {
  const restore = await sweepRepublish(t, "restore", { decision_verdict: PASS, reviewer_outcome: "success" });
  assert.equal(restore.fullReviews, 0);
  assert.equal(restore.restored.length, 1, JSON.stringify(restore.steps));
  assert.equal(restore.successPosts.length, 1);
  const reuse = await sweepRepublish(t, "reuse", { decision_verdict: PASS, reviewer_outcome: "success" });
  assert.equal(reuse.fullReviews, 0, JSON.stringify(reuse.steps));
  assert.equal(reuse.reused.length, 1);
  assert.equal(reuse.reused[0]!.reviewer_outcome, "success", "the reused row carries the judgement forward");
  const discriminated = await sweepRepublish(t, "discriminate-only", { decision_verdict: PASS, reviewer_outcome: "success" });
  assert.equal(discriminated.fullReviews, 0, JSON.stringify(discriminated.steps));
  assert.equal(discriminated.discriminated.length, 1);
  assert.equal(discriminated.discriminated[0]!.reviewer_outcome, "success", "the re-judged row carries the judgement forward");
  const settled = await settleCutPass(t, "success");
  assert.equal(settled.drained.outcome, "posted", "a cut semantic pass is settled as posted");
  assert.ok(settled.rows.some((r) => r.step === "review.posted" && r.state === "success"));
  const planOnly = await sweepRepublish(t, "reuse", { decision_verdict: PLAN_PASS, reviewer_outcome: "not_attempted_plan_only" });
  assert.equal(planOnly.reused.length, 1, "a plan-only deterministic pass is still reused");
});
