import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  operatorReviewArgs, reviewCommand, runReview, type ReviewCommandDeps, type ReviewCommandHost,
} from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import type { Mount } from "#src/lib/mounts.js";
import { loadPlan } from "#src/lib/plan.js";
import { observeReviewFlow } from "#src/lib/review-flow-observation.js";
import { CLAUDE_BIN_ENV_OVERRIDE, spawnWorker, type SpawnWorkerArgs } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const BRANCH = "codex/hand-review-test";
const PR_URL = "https://github.com/craigoley/remudero/pull/9998";
// W1-T2593 is risk: high with budget_usd 15 at this head, so the reviewer cap is observable.
const TASKED_BODY = "A hand review fixture.\n\nRemudero-Task: W1-T2593";
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

interface Captured {
  spawnReviewer?: boolean;
  requireSemanticReview?: boolean;
  reviewerMount?: Mount;
  budgetUsd?: number;
}

type RunReviewArgs = Parameters<typeof runReview>[1];

/** Runs the review command offline: a gh shim answers every GitHub call, nothing is posted anywhere. */
async function handReview(body: string, rest: string[], runReviewWith: (args: RunReviewArgs) => ReturnType<typeof runReview>,
  prArg = "9998") {
  const root = mkdtempSync(join(tmpdir(), "rmd-t14156-hand-review-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-t14156-hand-review-bin-"));
  const oldPath = process.env.PATH;
  const oldClaude = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: "/pulls/", stdout: JSON.stringify({ number: 9998, html_url: PR_URL, updated_at: "t", body, state: "open",
      merged: false, head: { ref: BRANCH, sha: HEAD } }) },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "pr diff", stdout: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n" },
    { when: "api ", stdout: "{}" },
  ]);
  const lines: string[] = [];
  const oldLog = console.log;
  const effects: string[] = [];
  try {
    // Never a real secret: the injected query function means nothing is spawned or sent.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-never-sent";
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;
    process.env.PATH = `${shim.dir}:${binDir}:${oldPath}`;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
    const deps: ReviewCommandDeps = {
      // The numeric arm is addressed by REST: the single-pull endpoint answers a raw pull row that reviewCommand maps
      // itself (mapRestPr). Every other read (statuses, combined status) keeps the already-mapped view shape.
      fetchView: (viewArgs) => viewArgs.join(" ").endsWith("/pulls/9998")
        ? { number: 9998, html_url: PR_URL, updated_at: "t", body, state: "open", merged: false, head: { ref: BRANCH, sha: HEAD } }
        : { headRefOid: HEAD, headRefName: BRANCH, body, url: PR_URL, number: 9998 },
      fetchHead: () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true", enabledProviders: ["claude"] }) as Config,
      postReviewPending: async () => { effects.push("pending"); return { posted: true }; },
      // The proofs run on this checkout itself; the fakes below never create or remove a worktree.
      materialize: () => ({ worktreePath: REPO_ROOT }),
      withMaterialized: async (_path, _repo, run) => run(),
      buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set<string>(), baseIsCheckout: false, addedTestFiles: new Set<string>() }),
      runReview: runReviewWith,
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
    } satisfies ReviewCommandDeps;
    const code = await reviewCommand(host, prArg, rest, deps);
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return { code, ledger, lines, effects, ghCalls: shim.calls() };
  } finally {
    console.log = oldLog;
    process.env.PATH = oldPath;
    if (oldClaude === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
    else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldClaude;
    if (oldToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldToken;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

function capture(into: { args?: Captured }) {
  return async (args: RunReviewArgs) => {
    into.args = { spawnReviewer: args.spawnReviewer, requireSemanticReview: args.requireSemanticReview,
      reviewerMount: args.reviewerMount, budgetUsd: args.budgetUsd };
    return { state: "success", headSha: HEAD, reviewerOutcome: "success", criteria: [] } as never;
  };
}

/** The real runReview, with the arm and disarm effects observed instead of reaching `gh pr merge`. */
function realReview(effects: string[], overrides: Partial<RunReviewArgs> = {}) {
  return (args: RunReviewArgs) => runReview(host, {
    ...args,
    arm: () => { effects.push("arm"); return "armed"; },
    disarm: () => { effects.push("disarm"); return "not-armed"; },
    ...overrides,
  });
}

const REPO_ARGS = ["--repo", "craigoley/remudero"];

test("W1-T14156 criterion 1: a hand review with no --execution-mode flag reaches runReview in semantic mode", async () => {
  const seen: { args?: Captured } = {};
  const { code } = await handReview(TASKED_BODY, operatorReviewArgs([...REPO_ARGS]), capture(seen));
  assert.equal(code, 0);
  assert.ok(seen.args, "the hand review must reach runReview");
  assert.equal(seen.args.spawnReviewer, true);
  assert.equal(seen.args.requireSemanticReview, true);
  assert.ok(seen.args.reviewerMount, "semantic mode resolves a reviewer mount");
  const budget = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml")).byId.get("W1-T2593")?.budget_usd;
  assert.equal(typeof budget, "number");
  assert.equal(seen.args.budgetUsd, budget, "the reviewer cap is the head task's budget_usd");
});

test("W1-T14156 criterion 2: a hand review whose reviewer worker throws posts no success and arms nothing", async () => {
  const effects: string[] = [];
  let queried = 0;
  // The worker's query rejects before it yields any result.
  const reviewerQueryFn = (() => (async function* () {
    queried++;
    throw new Error("reviewer worker unavailable fixture");
  })()) as unknown as RunReviewArgs["reviewerQueryFn"];
  // Synthetic credential file read, so the spawn reaches the query on every platform and never the host keychain.
  const reviewerSpawnWorker = (args: SpawnWorkerArgs) => spawnWorker({ ...args, keychain: { platform: "linux", readCredentialFile: () => "{}" } });
  const { code, ledger, ghCalls } = await handReview(PASSING_BODY, operatorReviewArgs([...REPO_ARGS]),
    realReview(effects, { reviewerQueryFn, reviewerSpawnWorker }));
  assert.equal(queried, 1, "the reviewer worker's query must really be reached");
  assert.notEqual(code, 0);
  assert.ok(!ghCalls.some((call) => call.includes("context=remudero-review") && call.includes("state=success")),
    "no remudero-review=success may be posted without a reviewer verdict");
  assert.ok(!effects.includes("arm"), "no automerge may be armed");
  assert.ok(!ledger.some((row) => row.step === "automerge.armed"));
  const incomplete = ledger.find((row) => row.step === "review.semantic_incomplete");
  assert.ok(incomplete, `a review.semantic_incomplete row is written; steps: ${ledger.map((row) => row.step).join(",")}`);
  assert.equal(incomplete.head_sha, HEAD);
});

test("W1-T14156 criterion 3: an explicit deterministic run says not_attempted_deterministic_mode", async () => {
  const seen: { args?: Captured } = {};
  const effects: string[] = [];
  const real = realReview(effects);
  const { lines, ledger } = await handReview(PASSING_BODY, operatorReviewArgs([...REPO_ARGS, "--execution-mode", "deterministic"]),
    async (args) => { seen.args = { spawnReviewer: args.spawnReviewer }; return real(args); });
  assert.equal(seen.args?.spawnReviewer, false);
  const posted = ledger.find((row) => row.step === "review.posted");
  assert.ok(posted, `a review.posted row is written; steps: ${ledger.map((row) => row.step).join(",")}`);
  assert.equal(posted.state, "success", "the passing grep proof gives a deterministic PASS");
  assert.equal(posted.reviewer_outcome, "not_attempted_deterministic_mode");
  const line = lines.find((text) => text.includes("reviewer_outcome:"));
  assert.ok(line, "the console line names the reviewer outcome");
  assert.match(line, /reviewer_outcome: not_attempted_deterministic_mode;/);
  assert.ok(!lines.some((text) => /reviewer_outcome: not_attempted;/.test(text)));
});

test("W1-T14156 criterion 3: a deterministic run with no criteria keeps the bare not_attempted outcome", async () => {
  const effects: string[] = [];
  const { lines, ledger } = await handReview("A code change with no task trailer and no Acceptance block.",
    operatorReviewArgs([...REPO_ARGS, "--execution-mode", "deterministic"]), realReview(effects));
  const posted = ledger.find((row) => row.step === "review.posted");
  assert.ok(posted, `a review.posted row is written; steps: ${ledger.map((row) => row.step).join(",")}`);
  assert.equal(posted.reviewer_outcome, "not_attempted");
  assert.ok(!lines.some((text) => /reviewer_outcome: not_attempted_deterministic_mode/.test(text)));
});

test("W1-T14156 criterion 4: an internal reviewCommand call with no flags stays deterministic", async () => {
  const seen: { args?: Captured } = {};
  await handReview(TASKED_BODY, [], capture(seen));
  assert.ok(seen.args, "the internal call must reach runReview");
  assert.equal(seen.args.spawnReviewer, false);
  assert.equal(seen.args.requireSemanticReview, false);
  assert.deepEqual(operatorReviewArgs(["--execution-mode", "deterministic"]), ["--execution-mode", "deterministic"]);
});

test("W1-T14156 criterion 5: every not_attempted outcome counts as not attempted, none as failed", () => {
  const asOf = "2026-11-21T12:00:00Z", start = "2026-11-20T12:00:00Z";
  const rows = ["not_attempted", "not_attempted_plan_only", "not_attempted_deterministic_mode", "spawn_error"].flatMap((outcome, i) => {
    const id = { pr_url: `https://github.com/a/b/pull/${i + 1}`, head_sha: "a".repeat(40), review_input_digest: "d".repeat(64) };
    return [
      { ...id, step: "sweep.review_eligible", ts: `2026-11-21T10:0${i}:00Z` },
      { ...id, step: "review.posted", ts: `2026-11-21T10:0${i}:30Z`, state: "success", reviewer_outcome: outcome },
    ];
  });
  const report = observeReviewFlow(rows, asOf, start);
  assert.equal(report.semantic.notAttempted, 3);
  assert.equal(report.semantic.failed, 1);
});
