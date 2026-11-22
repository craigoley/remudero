/**
 * W1-T14241 (invariant capped-is-not-green) — a CAPPED verdict (zero proofs executed) on a diff that is not plan-only
 * never publishes remudero-review success while no capped override is recorded for its head. It posts pending — never
 * success, and never failure (CAPPED IS NOT FAIL) — under the CAPPED description, and the status restore, verdict
 * reuse and cut-post settlement paths follow the same rule. The operator's recorded override releases the pass to
 * success, and a plan-only capped verdict is unchanged.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { reviewCommand, runReview, type ReviewCommandHost } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import {
  UNCERTIFIED_PASS_HELD, cappedCertificationRefusal, drainReviewOutbox, postReviewStatusGuarded, reviewOutboxEntryPath,
  type ReviewVerdict,
} from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { REVIEW_STATUS_RESTORED_STEP, type OpenPrView, type ReviewReuseInputs } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { buildSweepEffects } from "#test/helpers/run-task-test.js";

const SHA = "1424100c0de000000000000000000000000000ab";
const PR_NUMBER = 19741;
const PR_URL = `https://github.com/acme/remudero/pull/${PR_NUMBER}`;
const TASK = "W1-T14241";
const DIGEST = "v2:t14241";
const CODE_SHA = "c".repeat(40);
const CAPPED_DESCRIPTION = "remudero-review: CAPPED — 0/1 proofs executed; not certified";
const CRITERIA = [{ claim: "the change ships", proof: "grep: ships in src/x.ts", met: true, floorMet: true,
  reason: "matched on the keyword floor", proof_exec: "exec_error" }] as ReviewVerdict["criteria"];
const CAPPED: ReviewVerdict = { state: "success", criteria: CRITERIA, testTheater: false, floorDegraded: false, capped: true,
  keywordOnly: false, planOnly: false, summary: CAPPED_DESCRIPTION };
const PLAN_CAPPED: ReviewVerdict = { ...CAPPED, planOnly: true, planLint: { ran: true, label: "fixture", checked: 1, violations: [] },
  summary: "remudero-review: PASS — plan-only PR (1 criteria)" } as ReviewVerdict;

const override = (headSha = SHA) => ({ run_id: "operator", task_id: TASK, step: "automerge.capped_override_granted",
  by: "operator", reason: "reviewed by hand", pr_url: PR_URL, head_sha: headSha });

type Posted = { state: string; description?: string };

/** The head the review under test reads over REST; each run fixture names its own. */
let reviewedHead = SHA;
function unexpected(): never { throw new Error("unexpected review fixture dependency"); }
/** The review command's host, with every dependency these fixtures never reach refusing loudly. */
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


function tmp(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14241-${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The guarded poster with every GitHub read injected, over a ledger seeded with `priorRows`. */
async function guardedPost(t: TestContext, verdict: ReviewVerdict, priorRows: Array<Record<string, unknown>> = []) {
  const ledgerPath = join(tmp(t, "post"), "ledger.ndjson");
  for (const row of priorRows) appendLedger(ledgerPath, row as Parameters<typeof appendLedger>[1]);
  const posts: Posted[] = [];
  const result = await postReviewStatusGuarded({
    owner: "acme", repo: "remudero", sha: SHA, state: "success", verdict, description: verdict.summary,
    taskId: TASK, evidence: "no_evidence", ledgerPath, runId: "t14241", prUrl: PR_URL, reviewInputDigest: DIGEST,
    fetchLifecycle: () => ({ merged: false, closed: false }),
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchCurrentStatusEntry: () => undefined,
    post: (status) => { posts.push({ state: status.state, description: status.description }); },
    semanticJudgement: { planOnly: verdict.planOnly, reviewerOutcome: "success" },
  });
  return { result, posts, rows: readLedgerLines(ledgerPath) };
}

test("W1-T14241 criterion 1: a capped code verdict with no override posts pending with the CAPPED description", async (t) => {
  for (const [label, verdict, prior] of [
    ["no override", CAPPED, []],
    ["a missing plan-only fact is not plan-only", { ...CAPPED, planOnly: undefined } as unknown as ReviewVerdict, []],
    ["an override bound to another head", CAPPED, [override("f".repeat(40))]],
    ["an override for another PR", CAPPED, [{ ...override(), pr_url: "https://github.com/acme/remudero/pull/1" }]],
  ] as const) {
    const { result, posts, rows } = await guardedPost(t, verdict, [...prior]);
    assert.deepEqual(posts.map((p) => p.state), ["pending"], `${label}: only pending is posted, never success or failure`);
    assert.ok(posts[0]!.description?.startsWith(CAPPED_DESCRIPTION), `${label}: the CAPPED description: ${posts[0]!.description}`);
    assert.equal(result.effectiveState, "pending");
    assert.equal(result.effectiveVerdict?.state, "pending");
    assert.match(result.cappedHold ?? "", new RegExp(`^${UNCERTIFIED_PASS_HELD}: `));
    const held = rows.find((row) => row.step === "review.capped_pass_held");
    assert.equal(held?.outcome, "pending", `${label}: the hold is ledgered`);
    assert.equal(held?.attempted_state, "success");
  }
});

// ── the run's own review, end to end ─────────────────────────────────────────────────────────────────────────────

const REPORT = "REPORT\n- widget frobnicate implemented and verified.";

async function cappedRunReview(t: TestContext, withOverride: boolean) {
  const root = tmp(t, "run");
  const head = gitRepo({ scope: t, kind: "t14241-head" });
  writeFileSync(join(head.dir, "x.ts"), "export const x = 1;\n");
  head.git("add", "x.ts");
  head.git("commit", "-qm", "x");
  const headSha = head.git("rev-parse", "HEAD");
  reviewedHead = headSha;
  t.after(() => { reviewedHead = SHA; });
  const prUrl = "https://github.com/acme/remudero/pull/14241";
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(join(root, "settings.json"), "{}");
  if (withOverride) appendLedger(ledgerPath, { ...override(headSha), pr_url: prUrl });
  // The PR body is the report the review judged, so the head+body subject is unchanged at publication.
  const pull = { number: 14241, html_url: prUrl, updated_at: "t", body: REPORT, state: "open", merged: false,
    head: { ref: "run-t14241", sha: headSha } };
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/reviews?", stdout: "[]" },
    { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: "/pulls/", stdout: JSON.stringify(pull) },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "pr diff", stdout: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n@@\n+export const x = 1;\n" },
    { when: "api ", stdout: "{}" },
  ], { kind: "t14241-run" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const effects: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  try {
    const verdict = await withLiveWritesAllowed(() => runReview(host, {
      owner: "acme", repo: "remudero", prUrl,
      // A prose proof never executes, so this code review is CAPPED.
      task: { id: TASK, acceptance: [{ claim: "the change is safe", proof: "widget frobnicate implemented" }] },
      report: REPORT,
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as Config,
      log: (step: string, extra: Record<string, unknown> = {}) => {
        lines.push({ step, extra });
        appendLedger(ledgerPath, { run_id: "t14241-run", task_id: TASK, step, ...extra });
      },
      say: () => {},
      account: (r: WorkerResult) => r,
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 },
      // The semantic judgement runs and passes, so only the capped rule is under test.
      reviewerSpawnWorker: async () => ({ sessionId: "t14241-reviewer", text: "REVIEW_VERDICT 1: PASS", blocks: [],
        stderr: "", exit: { kind: "exit", code: 0 }, costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
        model: "sonnet", effort: "medium", provider: "claude", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {}, compactionEvents: [], qualitySuspect: false, subtype: "success", isError: false, apiError: false }) as WorkerResult,
      headCheckoutDir: head.dir,
      ledgerPath,
      runId: "t14241-run",
      arm: () => { effects.push("arm"); return "armed" as const; },
      disarm: () => { effects.push("disarm"); return "not-armed" as const; },
    }));
    const statusPosts = shim.calls().filter((call) => call.includes("context=remudero-review"));
    return { verdict, effects, lines, statusPosts };
  } finally {
    process.env.PATH = oldPath;
  }
}

test("W1-T14241 criterion 1: the run's own capped code review posts pending, arms nothing and withdraws an open arm", async (t) => {
  const { verdict, effects, lines, statusPosts } = await cappedRunReview(t, false);
  assert.equal(verdict.capped, true, "fixture assumption: the review is capped");
  assert.equal(verdict.planOnly, false, "fixture assumption: a code diff");
  assert.ok(!statusPosts.some((call) => call.includes("state=success")), `no success is posted: ${statusPosts.join(" | ")}`);
  assert.ok(!statusPosts.some((call) => call.includes("state=failure")), "never failure: CAPPED IS NOT FAIL");
  assert.ok(statusPosts.some((call) => call.includes("state=pending") && call.includes("CAPPED")),
    `a pending carrying the CAPPED description is posted: ${statusPosts.join(" | ")}`);
  assert.equal(verdict.state, "pending");
  assert.match(verdict.verdictWithheld ?? "", new RegExp(`^${UNCERTIFIED_PASS_HELD}: `));
  assert.ok(!effects.includes("arm"), "nothing is armed");
  assert.ok(effects.includes("disarm"), "an arm taken at open is withdrawn");
  assert.ok(!lines.some((l) => l.step === "review.posted" && l.extra.state === "success"), "no success row is recorded");
});

// ── re-publication: status restore, verdict reuse and cut-post settlement ──────────────────────────────────────────

const REVIEW_KEY = `input:${JSON.stringify([TASK, PR_URL, SHA, DIGEST])}`;
const PENDING_SINCE = "2026-11-21T02:54:08.000Z";

async function sweepRepublish(t: TestContext, mode: "restore" | "reuse", decision: ReviewVerdict,
  extraRows: Array<Record<string, unknown>> = []) {
  const root = tmp(t, `sweep-${mode}`);
  const ledgerPath = join(root, "ledger.ndjson");
  const shim = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "/commits/", stdout: '{"statuses":[]}' },
    { when: `pulls/${PR_NUMBER}`, stdout: '{"state":"open","merged":false}' },
  ], { kind: "t14241-sweep" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
  const steps: Array<{ step: string; fields: Record<string, unknown> }> = [];
  try {
    appendLedger(ledgerPath, { run_id: "capped-run", task_id: TASK, step: "review.posted", ts: "2026-11-21T02:52:00.000Z",
      state: "success", head_sha: SHA, pr_url: PR_URL, review_input_digest: DIGEST, reviewer_code_sha: CODE_SHA,
      decision_verdict: decision, capped: decision.capped, plan_only: decision.planOnly, reviewer_outcome: "success" });
    appendLedger(ledgerPath, { run_id: "takeover", task_id: TASK, step: "review.pending_posted", ts: PENDING_SINCE,
      pr_url: PR_URL, head_sha: SHA, review_input_digest: DIGEST });
    for (const row of extraRows) appendLedger(ledgerPath, row as Parameters<typeof appendLedger>[1]);
    const effects = buildSweepEffects({
      owner: "acme", repo: "remudero", localRepoName: "not-remudero", config: { root } as never, ledgerPath, runId: "t14241-sweep",
      plan: { tasks: [], byId: new Map() } as never,
      log: (step, fields) => steps.push({ step, fields: (fields ?? {}) as Record<string, unknown> }),
      reviewerCodeFreshnessImpl: () => ({ status: "fresh" as const, codeSha: CODE_SHA, originMainSha: CODE_SHA, advance: "none" as const }),
      reviewRunner: async () => { steps.push({ step: "full-review", fields: {} }); return 0; },
      worktreeRemoveImpl: () => {},
    });
    const pr = {
      prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK, headSha: SHA, reviewInputDigest: DIGEST,
      reviewState: mode === "restore" ? "pending" : "none", reviewPendingSince: mode === "restore" ? PENDING_SINCE : undefined,
      reviewPendingOwnerDead: mode === "restore" ? true : undefined, checksState: "green", unmetCriteria: [], priorStrikes: 0,
      lastActivityAt: "2026-11-21T02:00:00Z", autoMergeArmed: false, body: `Remudero-Task: ${TASK}`,
    } as OpenPrView & Partial<ReviewReuseInputs>;
    const dispatched = mode === "restore"
      ? { kind: "restore" as const, judgedHeadSha: SHA, regressionKey: `${REVIEW_KEY}|${PENDING_SINCE}` }
      : { kind: mode, judgedHeadSha: SHA };
    const exit = await withLiveWritesAllowed(() => effects.postReview!(pr, dispatched));
    const rows = readLedgerLines(ledgerPath);
    const statusPosts = shim.calls().filter((call) => call.includes("context=remudero-review"));
    return {
      exit, steps, statusPosts, fullReviews: steps.filter((s) => s.step === "full-review").length,
      restored: rows.filter((r) => r.step === REVIEW_STATUS_RESTORED_STEP),
      reused: rows.filter((r) => r.step === "review.posted" && r.effective_review_mode === "verdict-reuse"),
      held: rows.filter((r) => r.step === "review.capped_pass_held"),
    };
  } finally {
    process.env.PATH = priorPath;
  }
}

test("W1-T14241 criterion 1: status restore restores a delivered capped code pass as pending, never success", async (t) => {
  const out = await sweepRepublish(t, "restore", CAPPED);
  assert.ok(!out.statusPosts.some((call) => call.includes("state=success")), `no success is restored: ${out.statusPosts.join(" | ")}`);
  assert.ok(!out.statusPosts.some((call) => call.includes("state=failure")));
  assert.ok(out.statusPosts.some((call) => call.includes("state=pending") && call.includes("CAPPED")),
    `the restore posts pending under the CAPPED description: ${out.statusPosts.join(" | ")}`);
  assert.equal(out.restored.length, 1, JSON.stringify(out.steps));
  assert.equal(out.restored[0]!.new_state, "pending");
  assert.equal(out.held.length, 1);
  assert.notEqual(out.exit, 0, "a held restore is not reported as a delivered pass");
});

test("W1-T14241 criterion 1: verdict reuse re-posts a capped code pass as pending and records no reused pass", async (t) => {
  const out = await sweepRepublish(t, "reuse", CAPPED);
  assert.ok(!out.statusPosts.some((call) => call.includes("state=success")), `no success is reused: ${out.statusPosts.join(" | ")}`);
  assert.ok(out.statusPosts.some((call) => call.includes("state=pending") && call.includes("CAPPED")));
  assert.equal(out.reused.length, 0, "a hold is no terminal decision, so no reused review.posted row is written");
  assert.equal(out.held.length, 1);
  assert.notEqual(out.exit, 0);
});

/** A cut post: its outbox entry says `posting`, its capped pass already stands on GitHub, and no review.posted row followed. */
async function settleCutCappedPass(t: TestContext, decision: ReviewVerdict, priorRows: Array<Record<string, unknown>> = []) {
  const ledgerPath = join(tmp(t, "outbox"), "state", "ledger.ndjson");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  for (const row of priorRows) appendLedger(ledgerPath, row as Parameters<typeof appendLedger>[1]);
  const entryPath = reviewOutboxEntryPath(ledgerPath, PR_URL, DIGEST);
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, JSON.stringify({
    version: 1, input_key: DIGEST, head_sha: SHA, state: "success", description: decision.summary, owner: "acme", repo: "remudero",
    task_id: TASK, pr_url: PR_URL, run_id: "cut-run", evidence: "no_evidence", review_decision_digest: "d".repeat(64),
    decision_verdict: decision, reviewer_code_sha: CODE_SHA, reviewer_outcome: "success",
    written_at: "2026-11-21T02:52:00.000Z", posting: true,
  }));
  const posts: Posted[] = [];
  const drained = await drainReviewOutbox({
    owner: "acme", repo: "remudero", sha: SHA, taskId: TASK, runId: "drain", ledgerPath, prUrl: PR_URL,
    reviewInputDigest: DIGEST, fetchLifecycle: () => ({ merged: false, closed: false }),
    post: (status) => { posts.push({ state: status.state, description: status.description }); },
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    liveStatus: { state: "success", description: decision.summary },
    judgeReviewerCode: async () => ({ status: "fresh", codeSha: CODE_SHA, originMainSha: CODE_SHA, advance: "none" }),
  });
  return { drained, posts, rows: readLedgerLines(ledgerPath), entryLeft: existsSync(entryPath) };
}

test("W1-T14241 criterion 1: cut-post settlement settles no capped code pass and replaces it with pending", async (t) => {
  const out = await settleCutCappedPass(t, CAPPED);
  assert.notEqual(out.drained.outcome, "posted", "the cut capped pass is not settled as posted");
  assert.deepEqual(out.posts.map((p) => p.state), ["pending"], "the standing capped pass is replaced by pending");
  assert.ok(out.posts[0]!.description?.startsWith(CAPPED_DESCRIPTION));
  assert.ok(!out.rows.some((r) => r.step === "review.posted" && r.state === "success"), "no success row is recorded");
  assert.equal(out.entryLeft, false, "the entry is discarded");
});

// ── released: a recorded override for that head, and a plan-only capped verdict ─────────────────────────────────────

test("W1-T14241 criterion 2: a recorded override for that head and a plan-only capped verdict still post success", async (t) => {
  const overridden = await guardedPost(t, CAPPED, [override()]);
  assert.deepEqual(overridden.posts.map((p) => p.state), ["success"], "the override releases the capped pass");
  assert.equal(overridden.result.cappedHold, undefined);
  assert.ok(!overridden.rows.some((row) => row.step === "review.capped_pass_held"));
  const planOnly = await guardedPost(t, PLAN_CAPPED);
  assert.deepEqual(planOnly.posts.map((p) => p.state), ["success"], "a plan-only capped verdict is unchanged");
  assert.ok(!planOnly.rows.some((row) => row.step === "review.capped_pass_held"));
  // An uncapped code pass is untouched, and a capped failure still publishes as failure.
  const uncapped = await guardedPost(t, { ...CAPPED, capped: false, summary: "remudero-review: PASS — 1/1 criteria met" });
  assert.deepEqual(uncapped.posts.map((p) => p.state), ["success"]);
  assert.equal(cappedCertificationRefusal({ capped: true, planOnly: false }, { by: "operator", reason: "r", headSha: SHA }), undefined);
  assert.equal(cappedCertificationRefusal({ capped: true, planOnly: true }, undefined), undefined);
  assert.equal(cappedCertificationRefusal({ capped: false, planOnly: false }, undefined), undefined);
});

test("W1-T14241 criterion 2: with the override the run's own capped code review posts success and may arm", async (t) => {
  const { verdict, effects, statusPosts } = await cappedRunReview(t, true);
  assert.equal(verdict.capped, true, "fixture assumption: the review is capped");
  assert.ok(statusPosts.some((call) => call.includes("state=success")), `the released pass is posted: ${statusPosts.join(" | ")}`);
  assert.equal(verdict.state, "success");
  assert.equal(verdict.verdictWithheld, undefined);
  assert.ok(!effects.includes("disarm"), "the override keeps the arm");
  assert.ok(effects.includes("arm"), `the released pass arms: ${effects.join(",")}`);
});

test("W1-T14241 criterion 2: restore, reuse and settlement re-publish an overridden or plan-only capped pass as success", async (t) => {
  const restore = await sweepRepublish(t, "restore", CAPPED, [override()]);
  assert.equal(restore.restored.length, 1, JSON.stringify(restore.steps));
  assert.equal(restore.restored[0]!.new_state, "success");
  assert.ok(restore.statusPosts.some((call) => call.includes("state=success")));
  const reuse = await sweepRepublish(t, "reuse", CAPPED, [override()]);
  assert.equal(reuse.reused.length, 1, JSON.stringify(reuse.steps));
  assert.equal(reuse.reused[0]!.state, "success");
  const planOnlyReuse = await sweepRepublish(t, "reuse", PLAN_CAPPED);
  assert.equal(planOnlyReuse.reused.length, 1, JSON.stringify(planOnlyReuse.steps));
  assert.equal(planOnlyReuse.held.length, 0);
  const settled = await settleCutCappedPass(t, CAPPED, [override()]);
  assert.equal(settled.drained.outcome, "posted", "an overridden cut capped pass is settled as posted");
  assert.ok(settled.rows.some((r) => r.step === "review.posted" && r.state === "success"));
});

test("W1-T14241 criterion 2: the hand review records the operator's override before the review runs, so it releases the pass", async (t) => {
  const root = tmp(t, "hand");
  const shim = ghShim([{ when: "", stdout: "{}" }], { kind: "t14241-hand" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const readRows = () => existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  const savedPath = process.env.PATH;
  const savedGitConfig = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) {
      savedGitConfig.set(key, process.env[key] as string);
      delete process.env[key];
    }
  }
  const savedLog = console.log;
  const savedErr = console.error;
  const out: string[] = [];
  let seenAtReview: Array<Record<string, unknown>> | undefined;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    await reviewCommand(host, "a-branch-name",
      ["--override-capped-by", "operator", "--override-capped-reason", "reviewed by hand"],
      {
        fetchView: () => ({ headRefOid: SHA, headRefName: "a-branch-name", body: `Remudero-Task: ${TASK}`, url: PR_URL, number: PR_NUMBER }),
        loadConfig: () => ({ claudeBin: "/bin/true", root }) as never,
        materialize: (() => ({ worktreePath: undefined, failure: { errorClass: "test", message: "deliberate" } })) as never,
        runReview: (async () => {
          seenAtReview = readRows();
          return { ...CAPPED, headSha: SHA, reviewerOutcome: "success" };
        }) as never,
        postReviewPending: (() => {}) as never,
      });
  } finally {
    console.log = savedLog;
    console.error = savedErr;
    for (const [key, value] of savedGitConfig) process.env[key] = value;
    process.env.PATH = savedPath;
  }
  const granted = seenAtReview?.filter((row) => row.step === "automerge.capped_override_granted") ?? [];
  assert.equal(granted.length, 1, `the override is in the ledger when the review posts: ${out.join(" | ")}`);
  assert.equal(granted[0]!.head_sha, SHA, "bound to the reviewed head");
  assert.equal(granted[0]!.pr_url, PR_URL);
  assert.equal(readRows().filter((row) => row.step === "automerge.capped_override_granted").length, 1, "recorded once");
});
