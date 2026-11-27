/**
 * W1-T15077: a failed review of an ops-catalog task kept its criterion reasons and findings only on the host
 * (OBSERVED 2026-11-27 on #21034, #21054, #21045, #21071, #21047), so every builder had to ask the host for them. A failed
 * or capped verdict now lands them in the private plan repository, and the public status and comment stay as before.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  catalogReviewPoster, runReview, type ReviewCommandHost, opsReviewCommentBody, opsReviewFindingsMarkdown, publishOpsReviewFindings, type OpsReviewRecord,
} from "#src/cli/commands/review.js";
import { isLandingRef, landingIdentity, landReviewFindingsAsync, reviewFindingsRelPath } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import { makeTempDir } from "#src/lib/tmp.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo, originWithClone } from "#test/helpers/git-repo.js";

const OPS = { owner: "fixture", repo: "remudero-ops" };
const HEAD = "ab".repeat(20);
const PR = 15077;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const REASON = "the retry reuses the refused token: ensureFresh answers fresh while the timer is not due";
const MECHANISM = "a forced renewal with an armed loop never mints";
const REMEDY = "mint for a refused token in the held-token loop";

function record(state: string): OpsReviewRecord {
  return {
    version: 1, task_id: "W1-T15077X", pr_url: `https://github.com/fixture/remudero/pull/${PR}`, head_sha: HEAD, state,
    review_decision_digest: "d",
    criteria: [
      { index: 1, claim: "a renewed token posts", met: true, proof_exec: "executed_pass", proof: "unit test: c1", reason: "proof ran green" },
      { index: 2, claim: "a 401 retries once", met: false, proof_exec: "executed_pass", proof: "unit test: c2", reason: REASON },
    ],
    reasons: [REASON],
    findings: [{ criterion_index: 2, category: "correctness", severity: "high", mechanism: MECHANISM, remedy: REMEDY,
      anchor: { path: "src/lib/review.ts", line: 8118, kind: "changed", status: "verified", evidenceDigest: "e" } as OpsReviewRecord["findings"][number]["anchor"] }],
  };
}

/** One instance: `<root>/state` naming the private repository, whose checkout and origin sit under `<root>/repos`. */
function instance(t: TestContext) {
  const root = makeTempDir("w15077-instance");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "repos"), { recursive: true });
  const publicOrigin = originWithClone(join(root, "repos", "remudero"), { scope: t, seed: { "scripts/README": "harness\n" } }).origin.dir;
  const opsOrigin = originWithClone(join(root, "repos", OPS.repo), { scope: t }).origin.dir;
  return { stateDir, publicOrigin, opsOrigin };
}

function fakeGh() {
  const calls: string[][] = [];
  const answer = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/fixture/remudero-ops/pull/7\n";
    if (args[0] === "api") return "{}";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, gh: answer, ghAsync: async (args: string[]) => answer(args) };
}

const branches = (bare: string): string[] => git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();

test("W1-T15077 criterion 1: a failed ops-task verdict writes its findings file to remudero-ops", async (t) => {
  const f = instance(t);
  writeFileSync(planDestinationPath(f.stateDir), JSON.stringify({ repository: `${OPS.owner}/${OPS.repo}`, kinds: ["decision"] }));
  const branch = landingIdentity({ family: "review-findings", targetRepository: OPS, sourceRepository: OPS }).branch;
  assert.ok(isLandingRef(branch), "the findings landing branch is a landing ref, so the reaper keeps it");
  for (const [state, capped] of [["failure", false], ["success", true]] as const) {
    const gh = fakeGh();
    const rows: Array<Record<string, unknown>> = [];
    const head = capped ? "cd".repeat(20) : HEAD;
    const outcome = await withLiveWritesAllowed(() => publishOpsReviewFindings(f.stateDir, { ...record(state), head_sha: head },
      { prNumber: PR, capped }, (step, extra) => rows.push({ step, ...extra }),
      (dir, input) => landReviewFindingsAsync(dir, input, { gh: gh.gh, ghAsync: gh.ghAsync })));
    assert.equal(outcome, "landed", JSON.stringify(rows));
    const rel = reviewFindingsRelPath(PR, head);
    assert.equal(rel, `plan/review-findings/pr-${PR}/${head}.md`);
    const page = git(f.opsOrigin, "show", `${branch}:${rel}`);
    for (const text of [REASON, MECHANISM, REMEDY, "src/lib/review.ts:8118", "verified", "FAIL"]) {
      assert.ok(page.includes(text), `THE CLAIM: the private page carries ${text}: ${page}`);
    }
    const create = gh.calls.find((args) => args[0] === "pr" && args[1] === "create");
    assert.equal(create?.[create.indexOf("--repo") + 1], `${OPS.owner}/${OPS.repo}`, "the landing pull request opens in the private repository");
  }
  assert.deepEqual(branches(f.publicOrigin), ["main"], "THE CLAIM: nothing reaches the public repository");
  // A passing verdict lands nothing.
  const quiet = await publishOpsReviewFindings(f.stateDir, record("success"), { prNumber: PR, capped: false },
    () => assert.fail("no row"), async () => assert.fail("no landing"));
  assert.equal(quiet, "not_failed");
});

test("W1-T15077 criterion 1: a host with no private destination lands nothing anywhere and records why", async (t) => {
  const f = instance(t);
  const rows: Array<Record<string, unknown>> = [];
  const outcome = await withLiveWritesAllowed(() => publishOpsReviewFindings(f.stateDir, record("failure"), { prNumber: PR, capped: false },
    (step, extra) => rows.push({ step, ...extra })));
  assert.equal(outcome, "refused");
  assert.deepEqual(rows.map((row) => [row.step, row.destination, row.head_sha]), [["review.record_write_failed", "plan_destination", HEAD]]);
  assert.match(String(rows[0]!.reason), /no private plan destination/);
  assert.deepEqual(branches(f.publicOrigin), ["main"], "the findings never fall back to the public repository");
  assert.deepEqual(branches(f.opsOrigin), ["main"]);
  // A lander that throws is a recorded refusal too.
  const thrown: Array<Record<string, unknown>> = [];
  assert.equal(await publishOpsReviewFindings(f.stateDir, record("failure"), { prNumber: PR, capped: false },
    (step, extra) => thrown.push({ step, ...extra }), async () => { throw new Error("push refused"); }), "refused");
  assert.match(String(thrown[0]!.reason), /push refused/);
});

test("W1-T15077 criterion 1: refusal of this head is recorded even when an older file landed", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const expected = reviewFindingsRelPath(PR, HEAD);
  const outcome = await publishOpsReviewFindings("/unused", record("failure"), { prNumber: PR, capped: false },
    (step, extra) => rows.push({ step, ...extra }), async () => ({ landed: true, files: ["plan/review-findings/pr-1/older.md"],
      refused: [{ path: expected, reason: "head file conflicts with the destination" }] }));
  assert.equal(outcome, "refused");
  assert.equal(rows[0]?.step, "review.record_write_failed");
  assert.equal(rows[0]?.reason, "head file conflicts with the destination");
});

test("W1-T15077 criterion 2: the public status and comment carry no claim or finding text", async () => {
  const posted: Array<{ state: string; description?: string }> = [];
  const post = catalogReviewPoster("ops", async (options) => { posted.push({ state: options.state, description: options.description }); });
  await post({ owner: "fixture", repo: "remudero", sha: HEAD, state: "failure", description: `remudero-review: failure — ${REASON}` });
  assert.deepEqual(posted, [{ state: "failure", description: "remudero-review: failure — detailed evidence retained on host" }],
    "THE CLAIM: the public status is today's, byte for byte");
  const page = opsReviewFindingsMarkdown(record("failure"));
  assert.ok(page.includes(REASON) && page.includes(MECHANISM), "positive control: the private page carries the text");
  const comment = opsReviewCommentBody("failure", [{ claim: "a renewed token posts", proof: "unit test: c1" },
    { claim: "a 401 retries once", proof: "unit test: c2" }] as never, record("failure").criteria as never);
  assert.equal(comment, "**remudero-review=failure** — detailed evidence retained on host\n\n- PASS: a renewed token posts\n- FAIL: a 401 retries once",
    "THE CLAIM: the public comment is today's, byte for byte");
  for (const text of [REASON, MECHANISM, REMEDY, "8118"]) {
    assert.ok(!posted[0]!.description!.includes(text) && !comment.includes(text), `THE CLAIM: no public text carries ${text}`);
  }
});

// ── the real runReview, end to end ──────────────────────────────────────────────────────────────────────────────────

const RUN_REPORT = "REPORT\n- widget frobnicate implemented and verified.";
/** The review command's host, with every dependency these fixtures never reach refusing loudly. */
let reviewedHead = HEAD;
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
  readHeadShaRest: () => reviewedHead,
  readMainPlanTreeSha: unexpected,
  realDeps: () => ({ reviewWorktree: { fetch: () => {} } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: () => 60_000,
  reviewSubjectGit: unexpected,
};

type RunCase = { catalog: "ops" | "public"; reviewer: "PASS" | "FAIL"; proof: string; statusPostThrows?: boolean };
/** The real runReview of one code PR, its state dir naming the private repository, every GitHub read shimmed. */
async function runOpsReview(t: TestContext, c: RunCase) {
  const f = instance(t);
  writeFileSync(planDestinationPath(f.stateDir), JSON.stringify({ repository: `${OPS.owner}/${OPS.repo}`, kinds: ["decision"] }));
  const root = dirname(f.stateDir);
  const head = gitRepo({ scope: t, kind: "t15077-head" });
  writeFileSync(join(head.dir, "x.ts"), "export const x = 1;\n");
  head.git("add", "x.ts");
  head.git("commit", "-qm", "x");
  const headSha = head.git("rev-parse", "HEAD");
  reviewedHead = headSha;
  t.after(() => { reviewedHead = HEAD; });
  const prUrl = `https://github.com/acme/remudero/pull/${PR}`;
  const ledgerPath = join(f.stateDir, "ledger.ndjson");
  writeFileSync(join(root, "settings.json"), "{}");
  const pull = { number: PR, html_url: prUrl, updated_at: "t", body: RUN_REPORT, state: "open", merged: false, head: { ref: "run-t15077", sha: headSha } };
  const shim = ghShim([
    ...(c.statusPostThrows ? [{ when: `statuses/${headSha} -f context=remudero-review -f state=failure`, stderr: "HTTP 422 invalid status", exit: 1 }] : []),
    { when: "/statuses?", stdout: "[[]]" }, { when: "/reviews?", stdout: "[]" }, { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: "/pulls/", stdout: JSON.stringify(pull) }, { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "pr diff", stdout: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n@@\n+export const x = 1;\n" }, { when: "api ", stdout: "{}" },
  ], { kind: "t15077-run" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const gh = fakeGh();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  try {
    const verdict = await withLiveWritesAllowed(() => runReview(host, {
      owner: "acme", repo: "remudero", prUrl,
      task: { id: "W1-T15077X", ...(c.catalog === "ops" ? { catalog: "ops" as const } : {}), acceptance: [{ claim: "the change ships", proof: c.proof }] },
      report: RUN_REPORT, settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as Config,
      log: (step: string, extra: Record<string, unknown> = {}) => {
        lines.push({ step, extra });
        appendLedger(ledgerPath, { run_id: "t15077-run", task_id: "W1-T15077X", step, ...extra });
      },
      say: () => {}, account: (r: WorkerResult) => r,
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 },
      reviewerSpawnWorker: async () => ({ sessionId: "t15077-reviewer", text: `REVIEW_VERDICT 1: ${c.reviewer}${c.reviewer === "FAIL" ? ` — ${REASON}` : ""}`,
        blocks: [], stderr: "", exit: { kind: "exit", code: 0 }, costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
        model: "sonnet", effort: "medium", provider: "claude", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {}, compactionEvents: [], qualitySuspect: false, subtype: "success", isError: false, apiError: false }) as WorkerResult,
      headCheckoutDir: head.dir, ledgerPath, runId: "t15077-run",
      arm: () => "armed" as const, disarm: () => "not-armed" as const,
      landReviewFindings: (dir, input) => landReviewFindingsAsync(dir, input, { gh: gh.gh, ghAsync: gh.ghAsync }),
    }));
    const branch = landingIdentity({ family: "review-findings", targetRepository: OPS, sourceRepository: OPS }).branch;
    const page = branches(f.opsOrigin).includes(branch) ? git(f.opsOrigin, "show", `${branch}:${reviewFindingsRelPath(PR, headSha)}`) : undefined;
    const statusPosts = shim.calls().filter((call) => call.includes("context=remudero-review"));
    const ledgerRows = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    return { verdict, page, lines, statusPosts, publicBranches: branches(f.publicOrigin), ledgerRows };
  } finally {
    process.env.PATH = oldPath;
  }
}

test("W1-T15077 criterion 1: the real runReview of an ops task lands the findings of a failed verdict and of a capped hold", async (t) => {
  const failed = await runOpsReview(t, { catalog: "ops", reviewer: "FAIL", proof: "grep: export const y in x.ts" });
  assert.equal(failed.verdict.state, "failure", "fixture assumption: the review fails");
  assert.ok(failed.page?.includes("FAIL"), `THE CLAIM: the failed verdict's page lands in the private repository: ${failed.page}`);
  // A prose proof never executes, so the code review is CAPPED and held pending (publishCappedHold): runReview
  // returns on posted.cappedHold, before the posted terminal path.
  const capped = await runOpsReview(t, { catalog: "ops", reviewer: "PASS", proof: "widget frobnicate implemented" });
  assert.equal(capped.verdict.capped, true, "fixture assumption: the review is capped");
  assert.equal(capped.verdict.state, "pending", "fixture assumption: the capped pass is held pending");
  assert.ok(capped.page?.includes("State: pending"), `THE CLAIM: the capped hold's page lands in the private repository: ${capped.page}`);
  for (const run of [failed, capped]) {
    assert.deepEqual(run.publicBranches, ["main"], "nothing reaches the public repository");
    assert.ok(!run.lines.some((l) => l.step === "review.record_write_failed"), JSON.stringify(run.lines.filter((l) => l.step === "review.record_write_failed")));
  }
});

test("W1-T15077 criterion 1: an outboxed failed status still lands this head's private findings", async (t) => {
  const failed = await runOpsReview(t, { catalog: "ops", reviewer: "FAIL", proof: "grep: export const y in x.ts", statusPostThrows: true });
  assert.equal(failed.verdict.state, "failure", "fixture assumption: the review fails");
  assert.ok(failed.ledgerRows.some((line) => line.step === "review.post_failed" && line.outboxed === true),
    `fixture assumption: the failed status post was retained in the outbox: ${JSON.stringify(failed.ledgerRows)}; posts=${failed.statusPosts.join(" | ")}`);
  assert.ok(failed.page?.includes("State: failure"), `the failed verdict lands despite the status error: ${failed.page}`);
  assert.deepEqual(failed.publicBranches, ["main"], "the recovery evidence remains private");
});

test("W1-T15077 criterion 1: a passing ops verdict and a failed public-catalog verdict land no findings", async (t) => {
  const passed = await runOpsReview(t, { catalog: "ops", reviewer: "PASS", proof: "grep: export const x in x.ts" });
  assert.equal(passed.verdict.state, "success", "fixture assumption: the review passes");
  assert.equal(passed.page, undefined, "a passing verdict writes nothing");
  const publicFailed = await runOpsReview(t, { catalog: "public", reviewer: "FAIL", proof: "grep: export const y in x.ts" });
  assert.equal(publicFailed.verdict.state, "failure", "fixture assumption: the public review fails");
  assert.equal(publicFailed.page, undefined, "a public-catalog task writes nothing");
});
