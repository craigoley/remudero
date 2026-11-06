import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { reviewerUnavailableProvidersForReadmission, type OpenPrView } from "#src/lib/sweep.js";
import { selectWorkerProviderWithExclusions, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { runReview } from "#test/helpers/run-task-test.js";
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
  } as OpenPrView;
  await effects.postReview!(pr, { kind: "discriminate-only", judgedHeadSha: "b".repeat(40) });
  assert.deepEqual(received?.excludeProviders, ["claude"]);
});

test("W1-T11432 criterion 2: review spawn receives and records the unavailable provider exclusion", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "rmd-t11432-review-exclusion-"));
  const previousPath = process.env.PATH;
  const ledgerPath = join(repo, "ledger.ndjson");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "marker.ts"), "export const READY = true;\n");
  writeFileSync(join(repo, "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  const sterileGitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["init", "--quiet", repo], { env: sterileGitEnv });
  execFileSync("git", ["-C", repo, "config", "user.name", "T11432 fixture"], { env: sterileGitEnv });
  execFileSync("git", ["-C", repo, "config", "user.email", "t11432-fixture@example.invalid"], { env: sterileGitEnv });
  execFileSync("git", ["-C", repo, "add", "src/marker.ts", "settings.json"], { env: sterileGitEnv });
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "review fixture"], { env: sterileGitEnv });
  const headSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", env: sterileGitEnv }).trim();
  const shim = ghShim([{ when: "pulls/16758", stdout: JSON.stringify({ number: 16758, state: "open", body: "review body",
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
      excludeProviders: ["claude"], headCheckoutDir: repo, ledgerPath, runId: "REVIEW-T11432",
      log: (step: string, extra?: Record<string, unknown>) => {
        rows.push({ step, extra }); appendLedger(ledgerPath, { run_id: "REVIEW-T11432", task_id: "W1-T9716", step, ...extra });
      },
      say: () => {}, account: (value: WorkerResult) => value, disarm: () => {}, arm: () => "not-armed",
      reviewerSpawnWorker: async (args: SpawnWorkerArgs) => { spawned.push(args); return workerResult; },
    } as never);
    assert.notEqual(result.reviewerOutcome, "not_attempted", "the reviewer spawn seam must be reached");
    assert.equal(spawned.length, 1, `expected one reviewer spawn; ledger rows: ${JSON.stringify(rows)}`);
    assert.deepEqual(spawned[0]?.excludeProviders, ["claude"]);
    assert.deepEqual(rows.find((row) => row.step === "review.reviewer")?.extra?.exclude_providers, ["claude"]);
  } finally {
    process.env.PATH = previousPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
