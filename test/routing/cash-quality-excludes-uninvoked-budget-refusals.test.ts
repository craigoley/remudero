import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { chooseDraftDeployment, createDraftStatsSession, draftStatsFromRows } from "#src/lib/draft-routing.js";
import { seededRandom } from "#src/lib/knowledge-value.js";
import { withTempDir } from "#src/lib/tmp.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
import { spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const lane = "inbox-draft", deployment = "gpt-oss-120b";
const marker = { quality_sample: "not-invoked-budget-refusal" };
const refusalRow = { step: "draft.routing.outcome", lane, deployment, selection_assignment_id: "uninvoked",
  session_id: "", draft_cost_usd: 0, clean: false, contract_failed: false, ...marker };

function uninvokedResult(): WorkerResult {
  return { provider: "cash", model: deployment, routedModel: deployment, servedModel: null,
    text: "", blocks: [], isError: true, apiError: false, subtype: "error_budget_refused", stderr: "",
    costUsd: 0, budgetReservedUsd: 0, budgetSettledUsd: 0, budgetRefused: true, sessionId: "", numTurns: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, permissionDenials: [], childEnvKeys: [],
    effort: "low", modelUsage: {}, compactionEvents: [], compactionFailures: [], compactionConfigured: false, qualitySuspect: false };
}

async function workerOutcome(result?: WorkerResult) {
  return withTempDir("cash-quality-refusal-", async (root) => {
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
    const config = { root, workerHomeRoot: join(root, "worker-homes"), claudeBin: "/unused",
      dailyCapUsd: { normal: 0.000000001, squeezed: 0.000000001 },
      workerProviders: { enabled: ["cash"], cashEndpoint: "https://fixture.invalid/" } } as Config;
    const rows: Record<string, unknown>[] = [];
    let transported = 0, evaluated = 0;
    // The real spawn's home materializer must not inspect the developer's subscription credentials.
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const worker = await spawnWorker({ cwd: REPO_ROOT, settingsFile, config, prompt: "Classify fixture only.",
        model: "haiku", effort: "low", mountProvider: "cash", maxTurns: 1, tools: [],
        onSelectionAssignment: (assignment) => rows.push({ step: "worker.selection.assigned", assignment }),
        routingTrial: { id: "quality-fixture", arm: "cash", reason: "fixture", models: [deployment] },
        draftRouting: { lane, proposalId: "P1", readStats: () => ({}), random: seededRandom(3),
          log: (step, extra = {}) => rows.push({ step, ...extra }),
          evaluate: () => { evaluated++; return { clean: true, contractFailed: false }; } },
        providerRouting: { spawnOpenWeight: async (args, cfg, selection) => result ?? spawnOpenWeightWorker({
          ...args, env: { RMD_OPENWEIGHT_API_KEY: "fixture-only-not-a-credential" }, clock: fixedClock(Date.now()),
          fetchImpl: async () => { transported++; throw new Error("uninvoked refusal must never reach transport"); },
        }, cfg, selection) },
      });
      assert.equal(rows.filter((row) => row.step === "draft.routing.outcome").length, 1);
      return { worker, row: rows.find((row) => row.step === "draft.routing.outcome")!, rows, transported, evaluated };
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
}

test("cash quality marks a real first-reservation refusal without invoking transport or grading output", async () => {
  const { worker, row, transported, evaluated } = await workerOutcome();
  assert.equal(worker.budgetRefused, true);
  assert.equal(worker.budgetReservedUsd, 0);
  assert.equal(worker.budgetSettledUsd, 0);
  assert.equal(transported, 0);
  assert.equal(evaluated, 0);
  assert.equal(row.quality_sample, marker.quality_sample);
  assert.equal(row.clean, false);
  assert.equal(row.contract_failed, false);
  assert.ok(typeof row.selection_assignment_id === "string" && row.selection_assignment_id.length > 0);
  assert.deepEqual(draftStatsFromRows([row], lane), {});
});

test("cash quality excludes only explicit uninvoked receipts and preserves the unchanged chooser prior", () => {
  const candidates = [{ deployment, estimatedCostUsd: 1 }]; // Unit control, not a provider price.
  const untouched = chooseDraftDeployment({}, candidates, seededRandom(7));
  const measured = chooseDraftDeployment(draftStatsFromRows([refusalRow], lane), candidates, seededRandom(7));
  assert.deepEqual(measured, untouched);
  assert.equal(measured.posterior.beta, 1);
});

test("cash quality preserves operational refusal rows while excluding them from live session learning", () => {
  const operational: Record<string, unknown>[] = [];
  const session = createDraftStatsSession("unused", lane, (step, extra = {}) => operational.push({ step, ...extra }), () => ({}));
  session.readStats();
  session.log("draft.routing.outcome", refusalRow);
  assert.deepEqual(operational, [refusalRow]);
  assert.deepEqual(session.readStats(), {});
  session.log("draft.routing.outcome", { lane, deployment, draft_cost_usd: 0.02, clean: true, contract_failed: false });
  session.log("draft.routing.outcome", { lane, deployment, draft_cost_usd: 0.03, clean: false, contract_failed: true });
  assert.deepEqual(session.readStats(), { [deployment]: { attempts: 2, clean: 1, contractFailures: 1, costUsd: 0.05 } });
});

test("cash quality never resurrects correlated legacy copies of an excluded refusal in either row order", () => {
  const legacy = { step: "inbox.draft_synthesized", run_id: "fixture", proposal_id: "P1", provider: "cash",
    selection_assignment_id: "uninvoked", routed_model: deployment, cost_usd: 0 };
  const terminal = { step: "inbox.drafted", run_id: "fixture", proposal_id: "P1", lint_clean: true };
  for (const rows of [[refusalRow, legacy, terminal], [legacy, terminal, refusalRow]]) {
    assert.deepEqual(draftStatsFromRows(rows, lane), {});
  }
});

test("cash quality leaves unmarked legacy refusals and real clean or dirty outputs unchanged", () => {
  const { quality_sample: _marker, ...legacy } = refusalRow;
  assert.deepEqual(draftStatsFromRows([legacy], lane), { [deployment]: { attempts: 1, clean: 0, contractFailures: 0, costUsd: 0 } });
  assert.deepEqual(draftStatsFromRows([{ ...legacy, clean: true }, { ...legacy, draft_cost_usd: 0.3, contract_failed: true }], lane),
    { [deployment]: { attempts: 2, clean: 1, contractFailures: 1, costUsd: 0.3 } });
  assert.deepEqual(draftStatsFromRows([{ step: "inbox.draft_synthesized", run_id: "old", proposal_id: "P1", model: deployment, cost_usd: 0 }], lane),
    { [deployment]: { attempts: 1, clean: 0, contractFailures: 0, costUsd: 0 } });
});

test("cash quality does not trust contradictory, incomplete or unknown exclusion markers", () => {
  for (const changed of [{ clean: true }, { contract_failed: true }, { draft_cost_usd: 0.2 },
    { clean: undefined }, { contract_failed: undefined }, { draft_cost_usd: undefined }, { quality_sample: "unknown" }]) {
    const stats = draftStatsFromRows([{ ...refusalRow, ...changed }], lane);
    assert.equal(stats[deployment].attempts, 1, JSON.stringify(changed));
  }
  assert.deepEqual(draftStatsFromRows([{ ...refusalRow, lane: "other" }], lane), {});
});

test("cash quality producer retains partial paid turns, attempted zero-cost requests and missing evidence", async (t) => {
  const changes: Array<[string, Partial<WorkerResult>]> = [
    ["missing refusal flag", { budgetRefused: undefined }], ["missing reserve receipt", { budgetReservedUsd: undefined }],
    ["missing settlement", { budgetSettledUsd: undefined }], ["attempted zero-settled request", { budgetReservedUsd: 0.1 }],
    ["paid settlement", { budgetSettledUsd: 0.1 }], ["paid cost", { costUsd: 0.1 }],
    ["input tokens", { tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 } }],
    ["output tokens", { tokens: { input: 0, output: 1, cacheRead: 0, cacheCreation: 0 } }],
    ["cache read", { tokens: { input: 0, output: 0, cacheRead: 1, cacheCreation: 0 } }],
    ["cache creation", { tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 1 } }],
    ["unreadable served model", { servedModel: undefined }], ["served model", { servedModel: deployment }],
    ["prior session", { sessionId: "paid-turn" }], ["prior text", { text: "previous turn" }],
    ["prior block", { blocks: ["previous turn"] }], ["successful zero-cost output", { isError: false, budgetRefused: false, text: "accepted" }],
    ["usage refusal alone", { budgetRefused: undefined, usageRefusal: { matched: "fixture" } }],
  ];
  for (const [name, changed] of changes) await t.test(name, async () => {
    const { row } = await workerOutcome({ ...uninvokedResult(), ...changed });
    assert.equal(Object.hasOwn(row, "quality_sample"), false);
    assert.equal(draftStatsFromRows([row], lane)[deployment].attempts, 1);
  });
});
