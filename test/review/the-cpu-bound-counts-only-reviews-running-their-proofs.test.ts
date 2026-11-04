import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runReview as runReviewCommand, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { readOwnedChildPhase, runDetachedReview, type DetachedReviewCommand, type DetachedWorkSpec } from "#src/lib/run-child.js";
import { childIdentity, RUN_CHILD_SCHEMA, writeSpec, writeStatus } from "#src/lib/run-child-contract.js";
import { runChildMain } from "#src/run-child-main.js";
import { writeProviderRoutingStatus } from "#src/lib/provider-routing-status.js";
import { CLAUDE_BIN_ENV_OVERRIDE, spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import {
  buildSweepEffects, childReviewPhaseCounts, DEFAULT_SWEEP_POLICY, registerChildWork, reportReviewPhase,
  resetChildWork, resetReviewProviderBound, reviewAdmissionBound, reviewPhaseSplit, reviewProviderBound,
  seedReviewProviderBound, settleChildWork, sustainedReviewJudgeConcurrency,
} from "#src/lib/sweep.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function unexpected(): never { throw new Error("unexpected review fixture dependency"); }
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const reviewHost: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  // The reviewer spawn is injected below and no telemetry is wired, so neither run-task hook is reached.
  attributeWorkerStreamEvent: unexpected,
  ledgeredNonDispatchSpawn: unexpected,
  lintPlanForReview: unexpected,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpected,
  readHeadShaRest: () => HEAD,
  readMainPlanTreeSha: unexpected,
  realDeps: () => ({ reviewWorktree: { fetch: unexpected } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: () => 60_000,
  reviewSubjectGit: unexpected,
};
const runReview = runReviewCommand.bind(null, reviewHost);

/** A `review.reviewer` row: one judge call that ran `durationMs` and ended at `endMs`. */
function judgeCall(endMs: number, durationMs: number, subtype = "success"): Record<string, unknown> {
  return { step: "review.reviewer", ts: new Date(endMs).toISOString(), worker_duration_ms: durationMs, subtype };
}

function freshStatus(root: string, nowMs: number, state: "selected" | "blocked"): void {
  const capacity = { provider: "codex" as const, readable: true, windows: [{ name: "primary", usedPercent: 20, resetsAt: nowMs / 1000 + 3600 }] };
  if (state === "blocked") {
    writeProviderRoutingStatus(root, { state: "blocked", enabledProviders: ["codex"], reservePercent: 5, observedAtMs: nowMs, cacheValidMs: 60_000, capacities: [] });
    return;
  }
  writeProviderRoutingStatus(root, {
    state: "selected", enabledProviders: ["codex"], reservePercent: 5, observedAtMs: nowMs, cacheValidMs: 60_000,
    capacities: [capacity], selection: { provider: "codex", capacity, tightestRemainingPercent: 80 },
  });
}

function productionWidthSelector(root: string) {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const effects = buildSweepEffects({
    owner: "acme", repo: "cpu-bound-review-phases", config: { root } as never,
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "W1-T11149", plan: { tasks: [] } as never,
    log: (step, extra) => logs.push({ step, extra }), policy: DEFAULT_SWEEP_POLICY,
  });
  assert.equal(typeof effects.selectAdaptiveReviewWidth, "function");
  return { logs, select: (nowMs: number, ledgerLines: ReadonlyArray<Record<string, unknown>> = []) =>
    effects.selectAdaptiveReviewWidth!({ queueDepth: 4, nowMs, ledgerLines, activeWorkers: 0 }) };
}

test("W1-T11149 criterion 1: a real review reports setup, proofs, judge and posting, with judge current when its LLM reviewer spawns", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-phases-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-review-phases-gh-"));
  const oldPath = process.env.PATH;
  const oldClaude = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
    // Never a real secret: the injected query function means nothing is spawned or sent.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-never-sent";
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;
    writeFileSync(join(binDir, "gh"), `#!/bin/sh
case "$1 $2" in
  "api "*)
    case "$*" in
      *commits/*/status*) echo '{"statuses":[]}' ;;
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"${HEAD}"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view") case "$*" in *headRefOid*) echo '{"headRefOid":"${HEAD}"}' ;; *state*) echo '{"state":"OPEN"}' ;; *) echo '{}' ;; esac ;;
  "pr diff") echo "" ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    process.env.PATH = `${binDir}:${oldPath}`;
    const phases: string[] = [];
    let atSpawn: string[] | undefined;
    const reviewerQueryFn = (() => (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "REVIEW_VERDICT 1: PASS", session_id: "s-11149", total_cost_usd: 0.01, num_turns: 1 };
    })()) as unknown as Parameters<typeof runReview>[0]["reviewerQueryFn"];
    const reviewerSpawnWorker = async (spawnArgs: SpawnWorkerArgs): Promise<WorkerResult> => {
      atSpawn = [...phases];
      return spawnWorker(spawnArgs);
    };
    const verdict = await runReview({
      owner: "acme", repo: "remudero", prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T11149", acceptance: [{ claim: "a claim the report never substantiates", proof: "unit test: no-such-test-title-w1-t11149" }] },
      report: "This report deliberately substantiates nothing.",
      reviewInputBody: "body", settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as never,
      log: () => {}, say: () => {}, account: (r: never) => r, spawnReviewer: true, reviewerQueryFn, reviewerSpawnWorker,
      disarm: () => {},
      reviewerMount: { model: "sonnet", provider: "claude", effort: "medium", maxTurns: 10, contextBudget: 120000 },
      headCheckoutDir: REPO_ROOT, ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T11149-PHASES",
      onPhase: (phase: string) => phases.push(phase),
    } as never);
    assert.notEqual(verdict.reviewerOutcome, "not_attempted", "the LLM reviewer must really be reached, or the judge phase proves nothing");
    assert.deepEqual(atSpawn, ["setup", "proofs", "judge"], "the proofs ran and the judge phase is current when the reviewer spawns");
    assert.deepEqual(phases, ["setup", "proofs", "judge", "posting", "posted"]);
  } finally {
    process.env.PATH = oldPath;
    if (oldClaude === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
    else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldClaude;
    if (oldToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldToken;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("W1-T11149 criterion 1: a run child writes each review phase to its owned status.json, and the CPU bound counts only setup, proofs and unread reviews", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-child-review-phases-"));
  resetChildWork();
  resetReviewProviderBound();
  try {
    const runId = "child-review-11149";
    const dir = join(root, "runs", runId);
    writeSpec(dir, { schema: RUN_CHILD_SCHEMA, runId, taskId: "W1-T11149", instance: "fixture",
      engine: { sha: "abc", sourceHash: "hash" }, planSnapshotPath: join(root, "plan.json"), reservationId: "", options: {} });
    const work: DetachedWorkSpec = { kind: "review", prNumber: 9, headSha: "h".repeat(40), reviewKey: "review-key-9" };
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, `${JSON.stringify({ ...JSON.parse(readFileSync(specPath, "utf8")) as object, work })}\n`);
    writeStatus(dir, { schema: RUN_CHILD_SCHEMA, runId, identity: childIdentity(process.pid)!, engineSha: "abc",
      entryKind: "bundle", phase: "review", heartbeatAt: Date.now(), state: "running" });
    // The daemon's registry reads the child back through its owned status.json, exactly as the host wires it.
    registerChildWork({ runId, taskId: "W1-T11149", kind: "review", headSha: work.headSha, reviewKey: work.reviewKey,
      readPhase: () => readOwnedChildPhase(dir, runId) });
    // A second child whose phase has never been read counts against the CPU bound, as every review does today.
    registerChildWork({ runId: "unread-child", taskId: "W1-T11149", kind: "review", headSha: "u", reviewKey: "unread", readPhase: () => undefined });
    // Four judge calls once ran together without a refusal, so the provider bound has room beside the CPU width.
    seedReviewProviderBound([judgeCall(10_000, 9_000), judgeCall(10_500, 9_000), judgeCall(11_000, 9_000), judgeCall(11_500, 9_000)]);
    assert.equal(reviewProviderBound(2), 4);
    const seen: Array<{ status: string | undefined; cpu: number; judge: number; bound: number }> = [];
    const review: DetachedReviewCommand = async (_pr, _rest, opts) => {
      for (const phase of ["setup", "proofs", "judge", "posting"]) {
        (opts.onPhase ?? reportReviewPhase)(phase);
        const split = reviewPhaseSplit(2);
        seen.push({ status: readOwnedChildPhase(dir, runId), cpu: split.cpuPhaseInFlight, judge: split.judgePhaseInFlight,
          bound: reviewAdmissionBound(2).bound });
      }
      return 0;
    };
    const code = await runChildMain(["--run-dir", dir], { env: {}, stderr: () => {}, heartbeatMs: 60_000, loadRunPath: async () => ({}),
      signals: { on: () => undefined, off: () => undefined },
      runDetachedWork: (detached, ctx) => runDetachedReview(detached, ctx, review) });
    assert.equal(code, 0);
    assert.deepEqual(seen, [
      { status: "review:setup", cpu: 2, judge: 0, bound: 0 },
      { status: "review:proofs", cpu: 2, judge: 0, bound: 0 },
      { status: "review:judge", cpu: 1, judge: 1, bound: 1 },
      { status: "review:posting", cpu: 1, judge: 1, bound: 1 },
    ]);
    assert.deepEqual(childReviewPhaseCounts(), { cpu: 1, provider: 1 });
  } finally {
    resetChildWork();
    resetReviewProviderBound();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T11149 criterion 2: the provider bound is seeded from refusal-free judge concurrency, grows per refusal-free settlement, halves once per fresh refusal and holds while unreadable", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-provider-bound-"));
  resetChildWork();
  resetReviewProviderBound();
  try {
    // Three calls overlapped with no refusal; a fourth overlapped a refused call, so it never counts as sustained.
    const rows = [
      judgeCall(10_000, 5_000), judgeCall(10_500, 5_000), judgeCall(11_000, 5_000),
      judgeCall(40_000, 5_000), judgeCall(40_500, 5_000), judgeCall(41_000, 5_000), judgeCall(41_200, 5_000, "error_codex"),
    ];
    assert.equal(sustainedReviewJudgeConcurrency(rows), 3);
    assert.equal(sustainedReviewJudgeConcurrency([]), undefined);
    assert.equal(reviewProviderBound(2), 2, "with no history the provider bound is the width it replaces");
    const nowMs = Date.parse("2026-11-04T12:00:00Z");
    const { select } = productionWidthSelector(root);
    freshStatus(root, nowMs, "selected");
    select(nowMs, rows);
    assert.equal(reviewProviderBound(2), 3, "the production adapter seeds from the pass's ledger");

    // A review that posts with no refusal since it registered grows the bound by one at settlement.
    registerChildWork({ runId: "posted", taskId: "W1-T11149", kind: "review", headSha: "p", reviewKey: "p", readPhase: () => "review:posted" });
    settleChildWork("posted");
    assert.equal(reviewProviderBound(2), 4);
    // One that ends without posting holds the bound.
    registerChildWork({ runId: "lost", taskId: "W1-T11149", kind: "review", headSha: "l", reviewKey: "l", readPhase: () => "review:judge" });
    settleChildWork("lost");
    assert.equal(reviewProviderBound(2), 4);

    // A review in flight when a fresh refusal arrives does not grow the bound, even though it posts.
    registerChildWork({ runId: "during-refusal", taskId: "W1-T11149", kind: "review", headSha: "d", reviewKey: "d", readPhase: () => "review:posted" });
    freshStatus(root, nowMs + 1_000, "blocked");
    select(nowMs + 1_000);
    assert.equal(reviewProviderBound(2), 2, "a fresh refusal halves the bound");
    select(nowMs + 2_000);
    assert.equal(reviewProviderBound(2), 2, "the same standing refusal halves it once, not once per sample");
    settleChildWork("during-refusal");
    assert.equal(reviewProviderBound(2), 2);

    // An unreadable reading (two hours old) holds the bound; a fresh selected reading ends the refusal.
    writeProviderRoutingStatus(root, { state: "blocked", enabledProviders: ["codex"], reservePercent: 5, observedAtMs: nowMs - 7_200_000, cacheValidMs: 60_000, capacities: [] });
    select(nowMs + 3_000);
    assert.equal(reviewProviderBound(2), 2, "an unreadable reading holds the bound");
    freshStatus(root, nowMs + 4_000, "selected");
    select(nowMs + 4_000);
    freshStatus(root, nowMs + 5_000, "blocked");
    select(nowMs + 5_000);
    assert.equal(reviewProviderBound(2), 1, "a new refusal after the old one ended halves again");

    // Admission: a new review needs CPU room AND every review in flight under the provider bound.
    resetReviewProviderBound();
    seedReviewProviderBound([judgeCall(10_000, 5_000), judgeCall(10_500, 5_000)]);
    registerChildWork({ runId: "judge-a", taskId: "W1-T11149", kind: "review", headSha: "a", reviewKey: "a", readPhase: () => "review:judge" });
    assert.equal(reviewAdmissionBound(1).bound, 1, "a judge-phase review leaves the one CPU lane free");
    registerChildWork({ runId: "judge-b", taskId: "W1-T11149", kind: "review", headSha: "b", reviewKey: "b", readPhase: () => "review:judge" });
    assert.equal(reviewAdmissionBound(1).bound, 0, "two in flight fill a provider bound of two, so a third would wait in its judge phase");
  } finally {
    resetChildWork();
    resetReviewProviderBound();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T11149 criterion 3: each review.capacity row records the CPU-phase and judge-phase in-flight counts and the provider bound beside the width", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-split-"));
  resetChildWork();
  resetReviewProviderBound();
  try {
    registerChildWork({ runId: "cpu", taskId: "W1-T11149", kind: "review", headSha: "c", reviewKey: "c", readPhase: () => "review:proofs" });
    registerChildWork({ runId: "judge", taskId: "W1-T11149", kind: "review", headSha: "j", reviewKey: "j", readPhase: () => "review:judge" });
    const nowMs = Date.parse("2026-11-04T12:00:00Z");
    freshStatus(root, nowMs, "selected");
    const { logs, select } = productionWidthSelector(root);
    const width = select(nowMs, [judgeCall(nowMs - 60_000, 30_000), judgeCall(nowMs - 59_000, 30_000), judgeCall(nowMs - 58_000, 30_000)]);
    const row = logs.find((entry) => entry.step === "review.capacity")?.extra;
    assert.ok(row, "the first sample logs its capacity row");
    assert.equal(row.effective_width, width);
    assert.equal(row.cpu_phase_in_flight, 1);
    assert.equal(row.judge_phase_in_flight, 1);
    assert.equal(row.provider_bound, 3);
  } finally {
    resetChildWork();
    resetReviewProviderBound();
    rmSync(root, { recursive: true, force: true });
  }
});
