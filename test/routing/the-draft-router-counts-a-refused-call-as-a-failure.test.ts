import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { chooseDraftDeployment, createDraftStatsSession, draftStatsFromRows, readDraftStats } from "#src/lib/draft-routing.js";
import { seededRandom } from "#src/lib/knowledge-value.js";
import { withTempDir } from "#src/lib/tmp.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const lane = "inbox-draft";
const arms = [{ deployment: "gpt-oss-120b", estimatedCostUsd: 0.4 },
  { deployment: "gpt-5-nano", estimatedCostUsd: 0.2 }];
const now = Date.now();
const hour = 60 * 60 * 1000;
function row(outcome: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "draft.routing.outcome", lane, deployment: arms[0].deployment,
    outcome, clean: outcome === "clean", contract_failed: outcome === "contract-failed",
    draft_cost_usd: 0, ts: new Date(now).toISOString(), ...overrides };
}
function refusals(count = 10): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => row(i % 2 ? "failed" : "refused",
    { ts: new Date(now - (count - 1 - i) * 1000).toISOString() }));
}
function budgetRefusals(): Record<string, unknown>[] {
  return refusals().map((r) => ({ ...r, outcome: "refused", quality_sample: "not-invoked-budget-refusal" }));
}
function choice(rows: Record<string, unknown>[], at = now) {
  return chooseDraftDeployment(draftStatsFromRows(rows, lane), arms, seededRandom(7), at);
}
function result(model: string, changed: Partial<WorkerResult> = {}): WorkerResult {
  return { text: "fixture", blocks: [], model, routedModel: model, provider: "cash", isError: false,
    costUsd: 0.01, sessionId: model, subtype: "success", numTurns: 1, stderr: "", apiError: false,
    permissionDenials: [], childEnvKeys: [], effort: "low", tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], compactionFailures: [], compactionConfigured: false, qualitySuspect: false, ...changed };
}
async function workerFixture(changed: Partial<WorkerResult> = {},
  evaluated = { clean: true, contractFailed: false }, history: Record<string, unknown>[] = [],
  deployments = arms.map((arm) => arm.deployment), throwContract = false) {
  return withTempDir("rmd-refused-draft-", async (root) => {
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
    const config = { root, workerHomeRoot: join(root, "worker-homes"), claudeBin: "/unused",
      dailyCapUsd: { normal: 10, squeezed: 10 },
      workerProviders: { enabled: ["cash"], cashEndpoint: "https://fixture.invalid/" } } as Config;
    const rows: Record<string, unknown>[] = [];
    const attempted: string[] = [];
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await spawnWorker({ cwd: REPO_ROOT, permissionMode: "bypassPermissions", settingsFile, config,
        prompt: "Draft fixture only.", model: "haiku", effort: "low", mountProvider: "cash", maxTurns: 1, tools: [],
        routingTrial: { id: "refusal-fixture", arm: "cash", reason: "fixture", models: deployments },
        draftRouting: { lane, proposalId: "P1", readStats: () => draftStatsFromRows(history, lane), random: seededRandom(3),
          log: (step, extra = {}) => rows.push({ step, ...extra }),
          evaluate: () => { if (throwContract) throw new Error("invalid fragment"); return evaluated; } },
        providerRouting: { spawnOpenWeight: async (_args, _cfg, selection) => {
          attempted.push(selection.model);
          return result(selection.model, changed);
        } },
      });
      return { rows, attempted, outcomes: rows.filter((r) => r.step === "draft.routing.outcome") };
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
}

test("W1-T12147 criterion 1: only positive-cost attempts set the measured price", () => {
  const paid = row("clean", { draft_cost_usd: 0.12 });
  const history = [paid, ...refusals(9)];
  const selected = choice(history).arms.find((arm) => arm.deployment === arms[0].deployment)!;
  assert.equal(selected.costPerAttemptUsd, 0.12);
  assert.equal(selected.beta, 10);
  assert.equal(choice([paid]).arms[0].costPerAttemptUsd, selected.costPerAttemptUsd);
  for (const value of [0, -1, undefined, NaN, Infinity, "0.1"]) {
    assert.equal(choice([row("refused", { draft_cost_usd: value })]).arms[0].costPerAttemptUsd, arms[0].estimatedCostUsd);
  }
  const legacy = [{ step: "inbox.draft_synthesized", run_id: "old", proposal_id: "P1", model: arms[0].deployment, cost_usd: 0.12 },
    { step: "inbox.draft_synthesized", run_id: "old", proposal_id: "P2", model: arms[0].deployment, cost_usd: 0 }];
  assert.equal(choice(legacy).arms[0].costPerAttemptUsd, 0.12);
});

test("W1-T12147 criterion 1: the shared snapshot learns the positive-cost denominator", () => {
  const session = createDraftStatsSession("unused", lane, () => {}, () => draftStatsFromRows([row("clean", { draft_cost_usd: 0.12 })], lane));
  session.readStats();
  session.log("draft.routing.outcome", row("refused"));
  session.log("draft.routing.outcome", row("not-clean", { draft_cost_usd: 0.04 }));
  const selected = chooseDraftDeployment(session.readStats(), arms, seededRandom(7), now);
  assert.equal(selected.arms[0].costPerAttemptUsd, 0.08);
  assert.equal(selected.arms[0].beta, 3);
});

test("W1-T12147 criterion 2: the worker classifies every returned draft outcome", async (t) => {
  const cases: Array<[string, Partial<WorkerResult>, { clean: boolean; contractFailed: boolean }, boolean?]> = [
    ["clean", {}, { clean: true, contractFailed: false }],
    ["not-clean", {}, { clean: false, contractFailed: false }],
    ["contract-failed", {}, { clean: false, contractFailed: true }],
    ["contract-failed", {}, { clean: true, contractFailed: false }, true],
    ["refused", { isError: true, usageRefusal: { matched: "account limit" }, costUsd: 0 }, { clean: true, contractFailed: false }],
    ["refused", { isError: true, budgetRefused: true }, { clean: true, contractFailed: false }],
    ["failed", { isError: true, costUsd: 0 }, { clean: true, contractFailed: false }],
  ];
  for (const [expected, changed, evaluated, throws] of cases) await t.test(expected, async () => {
    const { outcomes } = await workerFixture(changed, evaluated, [], [arms[0].deployment], throws);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, expected);
    const measured = draftStatsFromRows(outcomes, lane)[arms[0].deployment];
    assert.equal(measured.attempts, 1);
    assert.equal(measured.clean, expected === "clean" ? 1 : 0);
  });
  const stats = draftStatsFromRows([row("refused", { clean: true }), row("failed", { clean: true })], lane);
  assert.equal(stats[arms[0].deployment].attempts, 2);
  assert.equal(stats[arms[0].deployment].clean, 0);
});

test("W1-T12147 criterion 3: ten refused or failed calls cause a sixty-minute skip", () => {
  const history = refusals();
  const skipped = choice(history);
  assert.equal(skipped.deployment, arms[1].deployment);
  assert.deepEqual(skipped.arms.map((arm) => arm.deployment), [arms[1].deployment]);
  assert.deepEqual(skipped.skipped, [{ deployment: arms[0].deployment, count: 10, until: new Date(now + hour).toISOString() }]);
  assert.equal(choice(history, now + hour - 1).arms.length, 1);
  assert.equal(choice(history, now + hour).arms.length, 2);
  assert.equal(choice(refusals(9)).arms.length, 2);
  for (const outcome of ["clean", "not-clean", "contract-failed", undefined]) {
    assert.equal(choice([...history, row("", { outcome })]).arms.length, 2);
  }
  assert.equal(choice([...history, row("refused", { ts: "invalid" })]).arms.length, 2);
  assert.equal(choice(history.map((r) => ({ ...r, lane: "another-lane" }))).arms.length, 2);
  const both = [...history, ...history.map((r) => ({ ...r, deployment: arms[1].deployment }))];
  assert.ok(arms.some((arm) => arm.deployment === choice(both).deployment));
});

test("W1-T12147 criterion 3: the worker records one skip and keeps it out of fallback", async () => {
  const { rows, attempted } = await workerFixture({ isError: true, usageRefusal: { matched: "account limit" } },
    { clean: false, contractFailed: false }, refusals());
  assert.deepEqual(attempted, [arms[1].deployment]);
  const skips = rows.filter((r) => r.step === "draft.routing.skip");
  assert.equal(skips.length, 1);
  assert.equal(skips[0].deployment, arms[0].deployment);
  assert.equal(skips[0].count, 10);
  assert.equal(skips[0].reason, "refused-or-failed");
});

test("W1-T12147 criterion 3: uninvoked budget refusals affect availability without sampling quality", () => {
  const history = budgetRefusals();
  assert.deepEqual(draftStatsFromRows(history, lane), {});
  assert.deepEqual(choice(history).skipped, [{ deployment: arms[0].deployment, count: 10, until: new Date(now + hour).toISOString() }]);
  assert.equal(choice(history, now + hour - 1).arms.length, 1);
  assert.equal(choice(history, now + hour).arms.length, 2);
  assert.equal(choice(history.slice(1)).arms.length, 2);
  assert.equal(choice([...history, row("clean")]).arms.length, 2);
  const paid = row("clean", { draft_cost_usd: 0.12 });
  assert.deepEqual(draftStatsFromRows([paid, ...history], lane), draftStatsFromRows([paid], lane));
  const sole = chooseDraftDeployment(draftStatsFromRows(history, lane), arms.slice(0, 1), seededRandom(7), now);
  assert.equal(sole.deployment, arms[0].deployment);
  assert.equal(sole.posterior.beta, 1);
  assert.equal(sole.posterior.costPerAttemptUsd, arms[0].estimatedCostUsd);
  const legacy = { step: "inbox.draft_synthesized", run_id: "old", proposal_id: "P1", model: arms[0].deployment };
  assert.equal(choice([...history.slice(0, 9), legacy, history[9]!]).arms.length, 1);
});

test("W1-T12147 criterion 3: production-marked budget refusals produce one logged skip", async () => {
  const { outcomes } = await workerFixture({ isError: true, budgetRefused: true, budgetReservedUsd: 0,
    budgetSettledUsd: 0, costUsd: 0, servedModel: null, sessionId: "", text: "", blocks: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } },
  { clean: false, contractFailed: false }, [], [arms[0].deployment]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, "refused");
  assert.equal(outcomes[0].quality_sample, "not-invoked-budget-refusal");
  const history = refusals().map((r, i) => ({ ...outcomes[0], ts: r.ts, selection_assignment_id: `refusal-${i}` }));
  const { rows, attempted } = await workerFixture({}, { clean: true, contractFailed: false }, history);
  assert.deepEqual(attempted, [arms[1].deployment]);
  const skips = rows.filter((r) => r.step === "draft.routing.skip");
  assert.equal(skips.length, 1);
  assert.equal(skips[0].deployment, arms[0].deployment);
  assert.equal(skips[0].count, 10);
  assert.equal(skips[0].reason, "refused-or-failed");
  assert.equal(skips[0].until, new Date(now + hour).toISOString());
});

test("W1-T12147 criterion 3: disk and session snapshots retain the latest ten calls", async () => {
  for (const history of [refusals(), budgetRefusals()]) {
    await withTempDir("rmd-refused-stats-", async (root) => {
      writeFileSync(join(root, "ledger.ndjson"), history.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const stats = readDraftStats(root, lane);
      assert.equal(chooseDraftDeployment(stats, arms, seededRandom(7), now).arms.length, 1);
    });
    const session = createDraftStatsSession("unused", lane, () => {}, () => draftStatsFromRows(history.slice(0, 9), lane));
    session.readStats();
    session.log("draft.routing.outcome", history[9]!);
    assert.equal(chooseDraftDeployment(session.readStats(), arms, seededRandom(7), now).arms.length, 1);
    session.log("draft.routing.outcome", row("clean"));
    assert.equal(chooseDraftDeployment(session.readStats(), arms, seededRandom(7), now).arms.length, 2);
  }
  const live = createDraftStatsSession("unused", lane, () => {}, () => ({}));
  live.readStats();
  for (const refusal of budgetRefusals()) live.log("draft.routing.outcome", refusal);
  assert.deepEqual(live.readStats(), {});
  assert.equal(chooseDraftDeployment(live.readStats(), arms, seededRandom(7), now).arms.length, 1);
});

test("W1-T12147 criterion 4: a sole eligible deployment is picked despite its refusal streak", async () => {
  const { rows, attempted, outcomes } = await workerFixture({}, { clean: true, contractFailed: false }, refusals(), [arms[0].deployment]);
  assert.deepEqual(attempted, [arms[0].deployment]);
  assert.equal(rows.filter((r) => r.step === "draft.routing.skip").length, 0);
  assert.equal(outcomes[0].outcome, "clean");
  const selected = chooseDraftDeployment(draftStatsFromRows(refusals(), lane), arms.slice(0, 1), seededRandom(7), now);
  assert.equal(selected.deployment, arms[0].deployment);
  assert.equal(selected.posterior.beta, 11);
});
