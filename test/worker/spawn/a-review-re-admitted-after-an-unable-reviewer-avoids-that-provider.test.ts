import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects as buildCliSweepEffects, type SweepCommandHost } from "#src/cli/commands/sweep.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { ProviderCapacity } from "#src/lib/worker-provider.js";
import type { EffectiveProviderRoutingPolicy } from "#src/lib/provider-routing-policy.js";
import { buildSweepEffects, reviewerUnavailableProvidersForReadmission, REVIEW_REQUEUED_STEP, runSweep, type OpenPrView, type ReviewDispatchPr } from "#src/lib/sweep.js";
import { createDetachedWorkHost, runDetachedReview, type DetachedWorkSpec, type spawnRunChild } from "#src/lib/run-child.js";
import { selectWorkerProviderWithExclusions, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { buildReviewerCodeFreshnessGate, reviewOptionFlags, reviewOptionsFromFlags, runReview } from "#test/helpers/run-task-test.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const NOW = Date.parse("2026-11-06T00:00:00.000Z");
const policy: EffectiveProviderRoutingPolicy = {
  provenance: "default",
  committed: { enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5,
    parks: [], codexModelPreference: null },
  enabledProviders: ["claude", "codex"], routableProviders: ["claude", "codex"],
  preference: "automatic", reservePercent: 5, parks: [],
};

function capacity(provider: "claude" | "codex", usedPercent: number): ProviderCapacity {
  return { provider, readable: true,
    windows: [{ name: `${provider} weekly`, usedPercent, resetsAt: NOW / 1000 + 3600 }] };
}

test("W1-T11432 criterion 1: the provider auction excludes an eligible provider when another is eligible", () => {
  const routed = selectWorkerProviderWithExclusions(
    [capacity("claude", 15), capacity("codex", 25)], policy, 0.5, ["claude"],
  );
  assert.equal(routed.selection.provider, "codex");
  assert.equal(routed.exclusion_unhonoured, undefined);
  assert.deepEqual(routed.excludeProviders, ["claude"]);
});

test("W1-T11432 criterion 1: with no eligible alternative the auction keeps the provider and records the unhonoured exclusion", () => {
  const routed = selectWorkerProviderWithExclusions([capacity("claude", 15)], policy, 0.5, ["claude"]);
  assert.equal(routed.selection.provider, "claude");
  assert.deepEqual(routed.exclusion_unhonoured, {
    reason: "no-eligible-alternative", excludedProviders: ["claude"],
  });
});

test("W1-T11432 criterion 2: only the provider from the matching cannot-evaluate review is excluded on re-admission", () => {
  const pr = { prNumber: 16758, prUrl: "https://github.com/acme/remudero/pull/16758",
    headSha: "a".repeat(40), taskId: "W1-T9716", reviewState: "pending" } as Pick<OpenPrView,
      "prNumber" | "prUrl" | "headSha" | "taskId" | "reviewState" | "reviewInputDigest">;
  const rows = [
    { run_id: "review-PR16758-old", task_id: "W1-T9716", step: "review.reviewer", provider: "claude", unable: 1 },
    { run_id: "review-PR16758-current", task_id: "W1-T9716", step: "review.reviewer", provider: "codex", unable: 1 },
    { run_id: "review-PR16758-current", task_id: "W1-T9716", step: "review.posted", pr_url: pr.prUrl,
      head_sha: pr.headSha, state: "pending", decision_verdict: { cannotEvaluate: true,
        criteria: [{ reviewerUnavailable: "sandbox launcher failed" }] } },
  ];
  assert.deepEqual(reviewerUnavailableProvidersForReadmission(pr, rows), ["codex"]);
  assert.equal(reviewerUnavailableProvidersForReadmission(pr, [
    ...rows.slice(0, 2), { ...rows[2]!, decision_verdict: { cannotEvaluate: true, criteria: [] } },
  ]), undefined, "missing reviewer-unavailable evidence does not exclude a provider");
  assert.equal(reviewerUnavailableProvidersForReadmission(pr, [
    ...rows.slice(0, 1), { ...rows[2]!, run_id: "review-PR16758-current" },
  ]), undefined, "a reviewer row from another attempt cannot choose the exclusion");
});

test("W1-T11432 criterion 2: the CLI sweep fallback carries exclusions into reviewCommandImpl", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11432-sweep-exclusion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { root, claudeBin: "/bin/true" } as Config;
  const host = {
    freshTreeGit: () => "",
    readyDraftViaGh: () => async () => 0,
    realDeps: () => ({ reviewWorktree: { addWorktree: () => "" } }),
    buildFreshTreeReviewRunner: () => async () => 0,
    buildRequiredFixReviewRunner: () => async () => 0,
    spawnRmdReviewForFreshTree: async () => 0,
    buildReviewerCodeFreshnessGate: () => ({ call: async () => 0, staleThisPass: () => undefined }),
    buildReviewerHealthRoute: () => async (_pr: string, _rest: string[], _opts: unknown, run: () => Promise<number>) => run(),
    buildBaseReproductionProbe: () => () => ({ reproduced: false }),
    buildImportClosureRead: () => () => [],
    reviewCommandHost: () => ({}),
  } as unknown as SweepCommandHost & Required<Pick<SweepCommandHost, "freshTreeGit">>;
  let received: { excludeProviders?: readonly string[] } | undefined;
  const effects = buildCliSweepEffects(host, {
    owner: "acme", repo: "fixture", localRepoName: "fixture", config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-T11432", plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {}, reviewerCodeFreshnessImpl: () => ({ status: "unreadable", reason: "fixture" }) as never,
    instanceRegistryTextImpl: () => undefined,
    reviewerHealthRouteImpl: ((_pr: string, _rest: string[], _opts: unknown, run: () => Promise<number>) => run()) as never,
    reviewCommandImpl: async (_pr, _args, opts) => { received = opts; return 0; },
  });
  const pr = {
    prNumber: 16758, prUrl: "https://github.com/acme/fixture/pull/16758", headSha: "a".repeat(40),
    headRefName: "run-W1-T9716-1", taskId: "W1-T9716", reviewState: "pending", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date().toISOString(),
    excludeProviders: ["claude"],
  } as ReviewDispatchPr;
  await effects.postReview!(pr, { kind: "discriminate-only", judgedHeadSha: "b".repeat(40) });
  assert.deepEqual(received?.excludeProviders, ["claude"]);
});

test("W1-T11432 criterion 2: review spawn receives and records the unavailable provider exclusion", async (t) => {
  const repoFixture = gitRepo({ seedCommit: false, kind: "t11432-review-exclusion" });
  t.after(() => repoFixture.cleanup());
  const repo = repoFixture.dir;
  const previousPath = process.env.PATH;
  const ledgerPath = join(repo, "ledger.ndjson");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "marker.ts"), "export const READY = true;\n");
  writeFileSync(join(repo, "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  repoFixture.git("add", "src/marker.ts", "settings.json");
  repoFixture.git("commit", "--quiet", "-m", "review fixture");
  const headSha = repoFixture.git("rev-parse", "HEAD");
  // W1-T11443: a SUCCESS reads the head's status history first; this head has no prior FAILURE.
  const shim = ghShim([{ when: "/statuses?", stdout: "[[]]" }, { when: "pulls/16758", stdout: JSON.stringify({ number: 16758, state: "open", body: "review body",
    head: { ref: "run-W1-T9716-1", sha: headSha }, html_url: "https://github.com/acme/remudero/pull/16758" }) },
    { when: "pr diff", stdout: "" }, { when: "pr view", stdout: JSON.stringify({ state: "OPEN" }) }, { when: "", stdout: "{}" }]);
  const spawned: SpawnWorkerArgs[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const workerResult = {
    sessionId: "t11432-review-exclusion", text: "REVIEW_VERDICT 1: PASS", blocks: [], stderr: "", subtype: "success",
    exit: { kind: "exit", code: 0 }, isError: false, apiError: false, costUsd: 0, numTurns: 1,
    permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium", provider: "claude",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  } as WorkerResult;
  try {
    process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
    const result = await runReview({
      owner: "acme", repo: "remudero", prUrl: "https://github.com/acme/remudero/pull/16758",
      task: { id: "W1-T9716", files: ["src/marker.ts"], acceptance: [{ claim: "the marker is present", proof: "grep: READY in src/marker.ts" }], risk: "high", budget_usd: 0.5 },
      report: "The marker is present.", reviewInputBody: "The actual body snapshot.", settingsFile: join(repo, "settings.json"),
      config: { root: repo, claudeBin: "/bin/true" } as Config, requireSemanticReview: true, spawnReviewer: true,
      reviewerMount: { model: "sonnet", provider: "claude", effort: "medium", maxTurns: 10, contextBudget: 120000 },
      ...reviewOptionsFromFlags(reviewOptionFlags({ excludeProviders: ["claude"] })),
      headCheckoutDir: repo, ledgerPath, runId: "REVIEW-T11432",
      log: (step: string, extra?: Record<string, unknown>) => {
        rows.push({ step, extra }); appendLedger(ledgerPath, { run_id: "REVIEW-T11432", task_id: "W1-T9716", step, ...extra });
      },
      say: () => {}, account: (value: WorkerResult) => value, disarm: () => {}, arm: () => "not-armed",
      reviewerSpawnWorker: async (args: SpawnWorkerArgs) => { spawned.push(args); return workerResult; },
    } as never);
    assert.notEqual(result.reviewerOutcome, "not_attempted", "the reviewer spawn seam must be reached");
    assert.ok(spawned.length >= 1, `expected the primary reviewer spawn; ledger rows: ${JSON.stringify(rows)}`);
    assert.deepEqual(spawned[0]?.excludeProviders, ["claude"],
      "the primary reviewer spawn excludes the provider that was previously unable");
    assert.deepEqual(rows.find((row) => row.step === "review.reviewer")?.extra?.exclude_providers, ["claude"]);
  } finally {
    process.env.PATH = previousPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T11432 criterion 2: a re-admission forwards its exclusion through the production fresh-tree gate", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11432-readmission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pr: OpenPrView = {
    prNumber: 16758, prUrl: "https://github.com/acme/fixture/pull/16758", headSha: "a".repeat(40),
    headRefName: "run-W1-T9716-1", taskId: "W1-T9716", reviewState: "pending", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW - 3600000).toISOString(),
    reviewPendingOwnerDead: true,
  };
  const rows: Array<Record<string, unknown>> = [
    { run_id: "unable-review", task_id: pr.taskId, step: "review.reviewer", provider: "claude", unable: 1 },
    { run_id: "unable-review", task_id: pr.taskId, step: "review.posted", pr_url: pr.prUrl,
      head_sha: pr.headSha, state: "pending", decision_verdict: { cannotEvaluate: true,
        criteria: [{ reviewerUnavailable: "sandbox launcher failed" }] } },
    // Re-admission releases the prior delivered key; the matching UNABLE review stays in the ledger.
    { run_id: "re-admission", task_id: pr.taskId, step: REVIEW_REQUEUED_STEP,
      pr_url: pr.prUrl, head_sha: pr.headSha, review_key: `${pr.taskId}@${pr.headSha}` },
  ];
  const forwarded: ReturnType<typeof reviewOptionsFromFlags>[] = [];
  const gate = buildReviewerCodeFreshnessGate(
    () => ({ status: "stale", codeSha: "old", originMainSha: "fresh", changedPaths: ["src/run-task.ts"] }),
    () => {}, async () => assert.fail("the re-review must use fresh reviewer code"),
    async (_pr, flags) => { forwarded.push(reviewOptionsFromFlags(flags)); return 0; },
  );
  const effects = buildSweepEffects({
    owner: "acme", repo: "fixture", localRepoName: "fixture", repoRoot: root,
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-T11432", plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {},
    reviewCommandImpl: (number, rest, opts) => gate.call(number, rest, opts),
  });
  const summary = await runSweep([pr], {
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-T11432", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); }, postReview: effects.postReview,
    dispatchFix: () => assert.fail("an unavailable reviewer cannot request a code repair"),
    arm: () => assert.fail("an unavailable reviewer cannot authorize a merge"), close: () => {}, escalate: () => {},
  });
  assert.equal(forwarded.length, 1, `the pending review was re-admitted and ran from the fresh tree: ${JSON.stringify({ summary, rows })}`);
  assert.deepEqual(forwarded[0]?.excludeProviders, ["claude"]);
  assert.equal(forwarded[0]?.executionMode, "semantic");
  assert.equal(forwarded[0]?.judgeAtOwnStart, true);
  const routed = selectWorkerProviderWithExclusions(
    [capacity("claude", 15), capacity("codex", 25)], policy, 0.5, forwarded[0]?.excludeProviders,
  );
  assert.equal(routed.selection.provider, "codex");
});

test("W1-T11432 criterion 2: detached review specs retain exclusions across JSON and fresh-tree flags", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11432-detached-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let work: DetachedWorkSpec | undefined;
  const host = createDetachedWorkHost({
    stateRoot: root, repoDir: root, root, repo: "fixture", log: () => {}, readMode: () => "on", readUnion: () => ({ rows: [], unread: [] }),
    readLedger: () => [{ step: "daemon.freshness_drain.completed", duration_ms: 1000,
      waited_on: [{ what: "review", kind: "review", settled_after_ms: 1000 }] }],
    spawn: (async (input) => {
      work = JSON.parse(JSON.stringify(input.work));
      return { started: true, runId: "detached-review", dir: root, pid: 1,
        settled: Promise.resolve({}), abort: async () => ({}) };
    }) as typeof spawnRunChild,
  });
  await host.spawnReview({
    pr: { prNumber: 16758, headSha: "a".repeat(40), excludeProviders: ["claude", "codex"] },
    reviewKey: "key", reviewAttemptId: undefined,
  });
  assert.ok(work, "the review must move to a detached child");
  assert.deepEqual(work.inputs?.excludeProviders, ["claude", "codex"]);
  let received: ReturnType<typeof reviewOptionsFromFlags> | undefined;
  await runDetachedReview(work, { runId: "detached-review", taskId: "W1-T9716" }, async (_pr, _rest, opts) => {
    received = reviewOptionsFromFlags(reviewOptionFlags(opts));
    return 0;
  });
  assert.deepEqual(received?.excludeProviders, ["claude", "codex"]);
  assert.equal(received?.executionMode, "semantic");
});

test("W1-T11432 criterion 2: review CLI exclusions round-trip as a set and reject invalid providers", () => {
  assert.deepEqual(reviewOptionsFromFlags(reviewOptionFlags({ excludeProviders: ["claude", "codex", "claude"] })).excludeProviders,
    ["claude", "codex"]);
  assert.deepEqual(reviewOptionsFromFlags(["--exclude-providers", "claude,not-a-provider,codex"]).excludeProviders,
    ["claude", "codex"]);
  assert.equal(reviewOptionsFromFlags(["--exclude-providers"]).excludeProviders, undefined);
  assert.deepEqual(reviewOptionsFromFlags([]), {});
});

test("W1-T11432 criterion 2: a detached child consumes only valid provider exclusions", async () => {
  let received: readonly string[] | undefined;
  await runDetachedReview({ kind: "review", prNumber: 16758,
    inputs: { excludeProviders: ["claude", "not-a-provider", null, "codex"] } },
  { runId: "detached-review", taskId: "W1-T9716" }, async (_pr, _rest, opts) => {
    received = opts.excludeProviders;
    return 0;
  });
  assert.deepEqual(received, ["claude", "codex"]);
});
