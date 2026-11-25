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
import {
  classifyReviewerToolCall, ReviewerToolCallCounter, type RecordedProofCommand,
} from "#src/lib/reviewer-tool-kinds.js";
import { CLAUDE_BIN_ENV_OVERRIDE, spawnWorker } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const RECORDED: RecordedProofCommand[] = [
  { command: "grep", args: ["-arn", "--", "export async function reviewCommand(", "src/cli/commands/review.ts"] },
  { command: "node", args: ["--test", "--import", "tsx", "--test-name-pattern", "a named proof", "test/review/x.test.ts"] },
];

test("W1-T14037: a reviewer shell call that re-runs a recorded grep proof classifies as proof_rerun", () => {
  const grep = classifyReviewerToolCall("Bash",
    { command: "grep -rn -- 'export async function reviewCommand(' src/cli/commands/review.ts" }, RECORDED);
  assert.equal(grep, "proof_rerun");
  const test = classifyReviewerToolCall("Bash",
    { command: "node --test --import tsx --test-concurrency=1 test/review/x.test.ts --test-name-pattern 'a named proof'" }, RECORDED);
  assert.equal(test, "proof_rerun");
});

test("W1-T14037: a reviewer shell call that is not a recorded proof stays bash, and each other tool keeps its own kind", () => {
  assert.equal(classifyReviewerToolCall("Bash", { command: "git rev-parse HEAD" }, RECORDED), "bash");
  assert.equal(classifyReviewerToolCall("Bash", { command: "grep -rn foo src/other.ts" }, RECORDED), "bash");
  assert.equal(classifyReviewerToolCall("Bash", { command: "grep -rn -- 'export async function reviewCommand(' src/lib/x.ts" }, RECORDED),
    "bash", "the same pattern over another path is a different check");
  assert.equal(classifyReviewerToolCall("Bash", { command: "grep -rn x ." }, []), "bash", "no recorded proof means nothing is a re-run");
  assert.equal(classifyReviewerToolCall("Bash", undefined, RECORDED), "bash");
  assert.equal(classifyReviewerToolCall("Read", { file_path: "a" }, RECORDED), "read");
  assert.equal(classifyReviewerToolCall("Grep", { pattern: "a" }, RECORDED), "grep");
  assert.equal(classifyReviewerToolCall("Glob", { pattern: "a" }, RECORDED), "glob");
  assert.equal(classifyReviewerToolCall("WebFetch", {}, RECORDED), "other");
  assert.equal(classifyReviewerToolCall(undefined, {}, RECORDED), "other");
});

test("W1-T14037: the counter counts each kind once per tool_use and ignores events that are not tool calls", () => {
  const counter = new ReviewerToolCallCounter(() => RECORDED);
  const proof = { command: "grep -rn -- 'export async function reviewCommand(' src/cli/commands/review.ts" };
  counter.observe({ kind: "tool-executing", toolName: "Bash", toolUseId: "a", toolInput: proof });
  counter.observe({ kind: "tool-executing", toolName: "Bash", toolUseId: "a", toolInput: proof });
  counter.observe({ kind: "tool-executing", toolName: "Bash", toolUseId: "b", toolInput: { command: "ls" } });
  counter.observe({ kind: "tool-executing", toolName: "Read", toolUseId: "c" });
  counter.observe({ kind: "tool-executing", toolName: "Read" });
  counter.observe({ kind: "message", toolName: "Read", toolUseId: "d" });
  assert.deepEqual(counter.snapshot(), { proof_rerun: 1, bash: 1, read: 2, grep: 0, glob: 0, other: 0 });
});

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const PR_URL = "https://github.com/craigoley/remudero/pull/9997";
const BODY = [
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

test("W1-T14037: the review.reviewer row counts each kind of tool call the reviewer made", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t14037-reviewer-tools-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-t14037-reviewer-tools-bin-"));
  const oldPath = process.env.PATH;
  const oldClaude = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const branch = "codex/t14037-reviewer-tools";
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: "/pulls/", stdout: JSON.stringify({ number: 9997, html_url: PR_URL, updated_at: "t", body: BODY, state: "open",
      merged: false, head: { ref: branch, sha: HEAD } }) },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "pr diff", stdout: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n" },
    { when: "api ", stdout: "{}" },
  ]);
  const oldLog = console.log;
  let queried = 0;
  const use = (id: string, name: string, input: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const reviewerQueryFn = (() => (async function* () {
    queried++;
    yield use("t1", "Bash", { command: "grep -arn -- 'export async function reviewCommand(' src/cli/commands/review.ts" });
    yield use("t2", "Bash", { command: "git rev-parse HEAD" });
    yield use("t3", "Read", { file_path: "src/cli/commands/review.ts" });
    yield { type: "result", subtype: "success", is_error: false, result: "REVIEW_VERDICT 1: PASS", session_id: "s-14037", total_cost_usd: 0.01, num_turns: 3 };
  })()) as unknown as Parameters<typeof runReview>[1]["reviewerQueryFn"];
  const reviewerSpawnWorker = (args: Parameters<typeof spawnWorker>[0]) =>
    spawnWorker({ ...args, keychain: { platform: "linux", readCredentialFile: () => "{}" } });
  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-never-sent";
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;
    process.env.PATH = `${shim.dir}:${binDir}:${oldPath}`;
    console.log = () => {};
    const deps: ReviewCommandDeps = {
      fetchView: (viewArgs) => viewArgs.join(" ").endsWith("/pulls/9997")
        ? { number: 9997, html_url: PR_URL, updated_at: "t", body: BODY, state: "open", merged: false, head: { ref: branch, sha: HEAD } }
        : { headRefOid: HEAD, headRefName: branch, body: BODY, url: PR_URL, number: 9997 },
      fetchHead: () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true", enabledProviders: ["claude"] }) as Config,
      postReviewPending: async () => ({ posted: true }),
      materialize: () => ({ worktreePath: REPO_ROOT }),
      withMaterialized: async (_path, _repo, run) => run(),
      buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set<string>(), baseIsCheckout: false, addedTestFiles: new Set<string>() }),
      runReview: (args) => runReview(host, { ...args, arm: () => "armed", disarm: () => "not-armed", reviewerQueryFn, reviewerSpawnWorker }),
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
    } satisfies ReviewCommandDeps;
    await reviewCommand(host, "9997", operatorReviewArgs(["--repo", "craigoley/remudero"]), deps);
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    assert.equal(queried, 1, "the reviewer's query must really be reached");
    const row = ledger.find((r) => r.step === "review.reviewer");
    assert.ok(row, `a review.reviewer row is written; steps: ${ledger.map((r) => r.step).join(",")}`);
    assert.deepEqual(row.tool_calls, { proof_rerun: 1, bash: 1, read: 1, grep: 0, glob: 0, other: 0 });
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
});
