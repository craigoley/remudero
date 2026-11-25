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
import { CLAUDE_BIN_ENV_OVERRIDE, collectWorkerResult, spawnWorker } from "#src/lib/worker.js";
import {
  classifyReviewerCommand, createWorkerToolLineage, REDIRECT_RE, REDIRECT_WITH_TARGET_RE, type RecordedProofCommand,
  type WorkerToolReceipt,
} from "#src/lib/worker-tool-lineage.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ORCHESTRATOR_HEAD = "/orchestrator/head";
const REVIEWER_CWD = "/reviewer/snapshot";
const RECORDED: RecordedProofCommand[] = [
  { command: "grep", args: ["-arn", "--", "W1-T14037 criterion 1", "test/x.test.ts"], cwd: ORCHESTRATOR_HEAD },
  { command: "node", args: ["--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts",
    "test/y.test.ts"], cwd: ORCHESTRATOR_HEAD },
];

test("W1-T14037 criterion 1: a command whose argv is a recorded proof execution is proof-rerun, modulo the reviewer's cwd", () => {
  const rerun = [
    "grep -arn -- 'W1-T14037 criterion 1' test/x.test.ts",
    `grep -arn -- "W1-T14037 criterion 1" ${REVIEWER_CWD}/test/x.test.ts`,
    `cd ${REVIEWER_CWD} && grep -arn -- 'W1-T14037 criterion 1' ./test/x.test.ts 2>/dev/null`,
    "GREP_COLORS= grep -arn -- W1-T14037\\ criterion\\ 1 test/x.test.ts | head -5",
    `/bin/bash -lc "cd ${REVIEWER_CWD} && node --test --test-reporter=tap --import tsx --import ./test/setup/tmp-hygiene.ts test/y.test.ts"`,
    "node --test --test-reporter=tap --import tsx --import test/setup/tmp-hygiene.ts test/y.test.ts 2>&1 | tail -20",
  ];
  for (const command of rerun) assert.equal(classifyReviewerCommand(command, RECORDED, REVIEWER_CWD), "proof-rerun", command);
});

test("W1-T14037 criterion 1: another node --test or vitest run is test-run, and every other command is read", () => {
  const testRuns = [
    "node --test test/y.test.ts",
    "node --test --test-name-pattern 'W1-T14037' test/x.test.ts",
    "npx vitest run packages/api-client/test/a.test.ts",
    "node node_modules/vitest/vitest.mjs run --reporter=tap",
    "timeout 60 node --import tsx --test test/z.test.ts",
  ];
  for (const command of testRuns) assert.equal(classifyReviewerCommand(command, RECORDED, REVIEWER_CWD), "test-run", command);
  const reads = [
    "grep -arn -- 'W1-T14037 criterion 1' test/other.test.ts",
    "grep -rn -- 'W1-T14037 criterion 1' test/x.test.ts",
    "grep -arn -- 'W1-T14037 criterion 2' test/x.test.ts",
    "git rev-parse HEAD",
    "cat test/x.test.ts",
    "echo 'node --test x'",
    "",
  ];
  for (const command of reads) assert.equal(classifyReviewerCommand(command, RECORDED, REVIEWER_CWD), "read", JSON.stringify(command));
  assert.equal(classifyReviewerCommand("grep -arn -- 'W1-T14037 criterion 1' test/x.test.ts", [], REVIEWER_CWD), "read",
    "with no recorded proof nothing is a re-run");
});

test("W1-T14037: a bare redirection operator takes the next word as its target, and one that carries its target stands alone", () => {
  for (const word of [">", ">>", "<", "2>", "&>"]) assert.equal(REDIRECT_RE.test(word), true, word);
  for (const word of ["2>&1", ">/dev/null", "a>", "->", ""]) assert.equal(REDIRECT_RE.test(word), false, word);
  for (const word of ["2>&1", ">/dev/null", "2>>err.log", "<input"]) assert.equal(REDIRECT_WITH_TARGET_RE.test(word), true, word);
  for (const word of [">", "2>", "x>y", "--out=>"]) assert.equal(REDIRECT_WITH_TARGET_RE.test(word), false, word);
  assert.equal(classifyReviewerCommand("grep -arn -- 'W1-T14037 criterion 1' test/x.test.ts 2> /dev/null", RECORDED, REVIEWER_CWD),
    "proof-rerun", "a bare redirection drops its target word, so the argv is still the recorded proof");
});

type Lineage = ReturnType<typeof createWorkerToolLineage>;
function drive(provider: "claude" | "codex", events: unknown[], reviewer?: { recordedProofCommands: RecordedProofCommand[]; cwd?: string }) {
  const receipts: WorkerToolReceipt[] = [];
  const lineage: Lineage = createWorkerToolLineage({ provider, runId: "run-14037", taskId: "W1-T14037",
    sink: (receipt) => { receipts.push(receipt); }, ...(reviewer ? { reviewer } : {}) });
  for (const event of events) lineage.observe(event);
  lineage.finish("stream-ended");
  return { receipts, counts: lineage.commandKinds() };
}
/** A receipt less its per-stream uuid and its kind: what a reviewer and a non-reviewer run must agree on. */
const withoutStream = (receipts: WorkerToolReceipt[]) => receipts.map((receipt) => {
  const rest: Partial<WorkerToolReceipt> = { ...receipt };
  delete rest.streamId;
  delete rest.commandKind;
  return rest;
});

const CLAUDE_STREAM = [
  { type: "assistant", message: { id: "m1", content: [
    { type: "tool_use", id: "u1", name: "Bash", input: { command: `cd ${REVIEWER_CWD} && grep -arn -- 'W1-T14037 criterion 1' test/x.test.ts` } },
    { type: "tool_use", id: "u2", name: "Read", input: { file_path: "test/x.test.ts" } },
  ] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: false },
    { type: "tool_result", tool_use_id: "u2", is_error: false }] } },
  { type: "assistant", message: { id: "m2", content: [
    { type: "tool_use", id: "u3", name: "Bash", input: { command: "node --test test/other.test.ts" } },
    { type: "tool_use", id: "u4", name: "Bash", input: { command: "git diff --stat origin/main" } },
  ] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u3", is_error: true }] } },
];

test("W1-T14037 criterion 1: a Claude reviewer's Bash receipts carry the kind, never the command text, and the lineage counts each", () => {
  const reviewer = drive("claude", CLAUDE_STREAM, { recordedProofCommands: RECORDED, cwd: REVIEWER_CWD });
  const kindOf = (state: string, tool: string) => reviewer.receipts.filter((r) => r.state === state && r.tool === tool).map((r) => r.commandKind);
  assert.deepEqual(kindOf("attempt", "Bash"), ["proof-rerun", "test-run", "read"]);
  assert.deepEqual(kindOf("joined", "Bash"), ["proof-rerun", "test-run"]);
  assert.deepEqual(kindOf("unfinished", "Bash"), ["read"]);
  assert.ok(reviewer.receipts.filter((r) => r.tool === "Read").every((r) => !("commandKind" in r)), "a Read is not a command call");
  assert.deepEqual(reviewer.counts, { "proof-rerun": 1, "test-run": 1, read: 1 });
  const text = JSON.stringify(reviewer.receipts);
  for (const fragment of ["grep", "criterion", "x.test.ts", "git diff", "other.test"]) assert.ok(!text.includes(fragment), fragment);

  const plain = drive("claude", CLAUDE_STREAM);
  assert.equal(plain.counts, undefined, "a run that is not a reviewer keeps no counts");
  assert.ok(plain.receipts.every((r) => !("commandKind" in r)), "a run that is not a reviewer carries no kind");
  assert.deepEqual(withoutStream(reviewer.receipts), withoutStream(plain.receipts), "the kind is the only field a reviewer adds");
});

const CODEX_STREAM = [
  { type: "thread.started", thread_id: "th-1" },
  { type: "turn.started" },
  { type: "item.started", item: { id: "i1", type: "command_execution", status: "in_progress",
    command: `/bin/bash -lc "cd ${REVIEWER_CWD} && grep -arn -- 'W1-T14037 criterion 1' test/x.test.ts"` } },
  { type: "item.completed", item: { id: "i1", type: "command_execution", status: "completed", exit_code: 0,
    command: `/bin/bash -lc "cd ${REVIEWER_CWD} && grep -arn -- 'W1-T14037 criterion 1' test/x.test.ts"`, aggregated_output: "x" } },
  { type: "item.started", item: { id: "i2", type: "command_execution", status: "in_progress",
    command: "/bin/bash -lc 'npx vitest run packages/a.test.ts'" } },
  { type: "item.completed", item: { id: "i2", type: "command_execution", status: "failed", exit_code: 1,
    command: "/bin/bash -lc 'npx vitest run packages/a.test.ts'" } },
  { type: "item.started", item: { id: "i3", type: "command_execution", status: "in_progress", command: ["sed", "-n", "1,40p", "src/a.ts"] } },
  { type: "item.completed", item: { id: "i3", type: "command_execution", status: "completed", exit_code: 0, command: ["sed", "-n", "1,40p", "src/a.ts"] } },
  { type: "item.completed", item: { id: "i4", type: "agent_message", text: "REVIEW_VERDICT 1: PASS" } },
  { type: "turn.completed" },
];

test("W1-T14037 criterion 1: a Codex reviewer's command_execution receipts carry the kind from item.command and the lineage counts each", () => {
  const reviewer = drive("codex", CODEX_STREAM, { recordedProofCommands: RECORDED, cwd: REVIEWER_CWD });
  const attempts = reviewer.receipts.filter((r) => r.state === "attempt").map((r) => r.commandKind);
  const joined = reviewer.receipts.filter((r) => r.state === "joined").map((r) => [r.commandKind, r.result]);
  assert.deepEqual(attempts, ["proof-rerun", "test-run", "read"]);
  assert.deepEqual(joined, [["proof-rerun", "success"], ["test-run", "error"], ["read", "success"]]);
  assert.deepEqual(reviewer.counts, { "proof-rerun": 1, "test-run": 1, read: 1 });
  const text = JSON.stringify(reviewer.receipts);
  for (const fragment of ["grep", "vitest", "sed", "src/a.ts", "criterion"]) assert.ok(!text.includes(fragment), fragment);

  const plain = drive("codex", CODEX_STREAM);
  assert.equal(plain.counts, undefined);
  assert.ok(plain.receipts.every((r) => !("commandKind" in r)));
  assert.deepEqual(withoutStream(reviewer.receipts), withoutStream(plain.receipts));
});

test("W1-T14037 criterion 1: collectWorkerResult carries the counts only for a spawn that names a reviewer", async () => {
  const stream = () => (async function* () {
    yield* CLAUDE_STREAM;
    yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s-1", total_cost_usd: 0, num_turns: 2 };
  })();
  const reviewer = await collectWorkerResult(stream(), { childEnvKeys: [], runId: "run-14037", taskId: "W1-T14037",
    reviewer: { recordedProofCommands: RECORDED, cwd: REVIEWER_CWD } });
  assert.deepEqual(reviewer.reviewerCommandKinds, { "proof-rerun": 1, "test-run": 1, read: 1 });
  const plain = await collectWorkerResult(stream(), { childEnvKeys: [], runId: "run-14037", taskId: "W1-T14037" });
  assert.ok(!("reviewerCommandKinds" in plain), "a spawn without the reviewer field is unchanged");
});

// ── the review flow: the reviewer spawn is handed this head's recorded proofs and the review.reviewer row counts each kind ──

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const PR_URL = "https://github.com/craigoley/remudero/pull/9996";
const PROOF_PATTERN = "export async function reviewCommand(";
const BODY = [
  "## Acceptance",
  `- the review command module defines the review command | grep: ${PROOF_PATTERN} in src/cli/commands/review.ts`,
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

type SpawnArgs = Parameters<typeof spawnWorker>[0];
interface ReviewRun {
  ledger: Record<string, unknown>[];
  spawns: SpawnArgs[];
  prompt: string;
  proofEvidence: unknown;
  queried: number;
}

/** One `rmd review` of a fixture PR whose reviewer re-runs the recorded grep, runs another test, and reads. `keepReviewer`
 *  false strips the reviewer field before the spawn, so the two runs differ ONLY in that field. */
async function reviewOnce(keepReviewer: boolean): Promise<ReviewRun> {
  const root = mkdtempSync(join(tmpdir(), "rmd-t14037-review-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-t14037-review-bin-"));
  const oldPath = process.env.PATH;
  const oldClaude = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const branch = "codex/t14037-review";
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: "/pulls/", stdout: JSON.stringify({ number: 9996, html_url: PR_URL, updated_at: "t", body: BODY, state: "open",
      merged: false, head: { ref: branch, sha: HEAD } }) },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "pr diff", stdout: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n" },
    { when: "api ", stdout: "{}" },
  ]);
  const oldLog = console.log;
  let queried = 0;
  const use = (id: string, name: string, input: unknown) =>
    ({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });
  const reviewerQueryFn = (() => (async function* () {
    queried++;
    yield use("t1", "Bash", { command: `grep -arn -- '${PROOF_PATTERN}' src/cli/commands/review.ts` });
    yield use("t2", "Bash", { command: "node --test test/some-other.test.ts" });
    yield use("t3", "Bash", { command: "git rev-parse HEAD" });
    yield use("t4", "Read", { file_path: "src/cli/commands/review.ts" });
    yield { type: "result", subtype: "success", is_error: false, result: "REVIEW_VERDICT 1: PASS", session_id: "s-14037",
      total_cost_usd: 0.01, num_turns: 4 };
  })()) as unknown as Parameters<typeof runReview>[1]["reviewerQueryFn"];
  const spawns: SpawnArgs[] = [];
  let prompt = "";
  let proofEvidence: unknown;
  const reviewerSpawnWorker = (args: SpawnArgs) => {
    if (spawns.length === 0) {
      prompt = args.prompt.split(args.cwd).join("<cwd>");
      const evidence = JSON.parse(readFileSync(join(args.cwd, ".git", "rmd-review-proofs.json"), "utf8")) as
        { executions: Record<string, unknown>[] } & Record<string, unknown>;
      // The host-load samples differ run to run whatever the reviewer field is; everything else must be identical.
      proofEvidence = { ...evidence, executions: evidence.executions.map((execution) => {
        const stable = { ...execution };
        delete stable.load;
        return stable;
      }) };
    }
    spawns.push(args);
    const forwarded: SpawnArgs = { ...args, keychain: { platform: "linux", readCredentialFile: () => "{}" } };
    if (!keepReviewer) delete forwarded.reviewer;
    return spawnWorker(forwarded);
  };
  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-never-sent";
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;
    process.env.PATH = `${shim.dir}:${binDir}:${oldPath}`;
    console.log = () => {};
    const deps: ReviewCommandDeps = {
      fetchView: (viewArgs) => viewArgs.join(" ").endsWith("/pulls/9996")
        ? { number: 9996, html_url: PR_URL, updated_at: "t", body: BODY, state: "open", merged: false, head: { ref: branch, sha: HEAD } }
        : { headRefOid: HEAD, headRefName: branch, body: BODY, url: PR_URL, number: 9996 },
      fetchHead: () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true", enabledProviders: ["claude"] }) as Config,
      postReviewPending: async () => ({ posted: true }),
      materialize: () => ({ worktreePath: REPO_ROOT }),
      withMaterialized: async (_path, _repo, run) => run(),
      buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set<string>(), baseIsCheckout: false,
        addedTestFiles: new Set<string>() }),
      runReview: (args) => runReview(host, { ...args, arm: () => "armed", disarm: () => "not-armed", reviewerQueryFn, reviewerSpawnWorker }),
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
    } satisfies ReviewCommandDeps;
    await reviewCommand(host, "9996", operatorReviewArgs(["--repo", "craigoley/remudero"]), deps);
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return { ledger, spawns, prompt, proofEvidence, queried };
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

const rowOf = (run: ReviewRun, step: string) => run.ledger.filter((row) => row.step === step).at(-1);
const lineageRows = (run: ReviewRun) => run.ledger.filter((row) => row.step === "worker.tool_lineage")
  .map((row) => row.tool_lineage as WorkerToolReceipt);

test("W1-T14037 criterion 1: the review.reviewer row counts each kind of reviewer command call, from the recorded proofs of this head", async () => {
  const run = await reviewOnce(true);
  assert.equal(run.queried, 1, "the reviewer's query must really be reached");
  const recorded = run.spawns[0]?.reviewer?.recordedProofCommands ?? [];
  assert.ok(recorded.some((proof) => proof.command === "grep" && proof.args.includes(PROOF_PATTERN) && proof.cwd === REPO_ROOT),
    `the reviewer spawn is handed the head's recorded grep proof: ${JSON.stringify(recorded)}`);
  assert.ok(run.spawns.slice(1).every((spawn) => spawn.reviewer === undefined), "the shadow judge spawn carries no reviewer field");
  const row = rowOf(run, "review.reviewer");
  assert.ok(row, `a review.reviewer row is written; steps: ${run.ledger.map((r) => r.step).join(",")}`);
  assert.deepEqual(row.command_kinds, { "proof-rerun": 1, "test-run": 1, read: 1 });
  const kinds = lineageRows(run).filter((receipt) => receipt.commandKind !== undefined).map((receipt) => receipt.commandKind);
  assert.ok(kinds.includes("proof-rerun") && kinds.includes("test-run") && kinds.includes("read"),
    `worker.tool_lineage receipts carry the kinds: ${JSON.stringify(kinds)}`);
  const lineageText = JSON.stringify(lineageRows(run));
  for (const fragment of [PROOF_PATTERN, "rev-parse", "some-other.test"]) assert.ok(!lineageText.includes(fragment), fragment);
});

test("W1-T14037 criterion 2: with and without the reviewer field the verdict, floor, prompt and rmd-review-proofs.json are the same", async () => {
  const withKinds = await reviewOnce(true);
  const without = await reviewOnce(false);
  assert.equal(withKinds.queried, 1);
  assert.equal(without.queried, 1);
  assert.equal(withKinds.prompt, without.prompt, "the reviewer prompt is unchanged");
  assert.ok(withKinds.prompt.length > 0);
  assert.deepEqual(withKinds.proofEvidence, without.proofEvidence, "rmd-review-proofs.json is unchanged");
  const decision = (run: ReviewRun) => {
    const posted = rowOf(run, "review.posted");
    assert.ok(posted, `a review.posted row is written; steps: ${run.ledger.map((r) => r.step).join(",")}`);
    const reviewer = rowOf(run, "review.reviewer")!;
    const verdict = posted.decision_verdict as { state?: unknown; criteria?: { met?: unknown; proof_exec?: unknown }[] };
    return {
      state: posted.state, review_decision_digest: posted.review_decision_digest, proof_exec: posted.proof_exec,
      unmet_criteria: posted.unmet_criteria, reviewer_outcome: posted.reviewer_outcome, test_theater: posted.test_theater,
      verdict_state: verdict.state, criteria: verdict.criteria?.map((criterion) => [criterion.met, criterion.proof_exec]),
      downgrades: reviewer.downgrades, unable: reviewer.unable, subtype: reviewer.subtype,
    };
  };
  assert.deepEqual(decision(withKinds), decision(without), "verdicts, review state and the deterministic floor are unchanged");
  assert.equal(decision(withKinds).criteria?.length, 1, "the fixture's one criterion is judged");
  assert.deepEqual(rowOf(withKinds, "review.reviewer")!.command_kinds, { "proof-rerun": 1, "test-run": 1, read: 1 });
  assert.equal("command_kinds" in rowOf(without, "review.reviewer")!, false, "without the field the row gains nothing");
  assert.ok(lineageRows(without).every((receipt) => !("commandKind" in receipt)), "without the field no receipt carries a kind");
  // Only worker.tool_lineage receipts and the review.reviewer row gain fields: the same steps are written either way.
  const steps = (run: ReviewRun) => [...new Set(run.ledger.map((row) => String(row.step)))].sort();
  assert.deepEqual(steps(withKinds), steps(without));
});
