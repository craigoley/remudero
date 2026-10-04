import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { chooseDraftDeployment, createDraftStatsSession, draftStatsFromRows, readDraftStats, recordDraftRouting } from "../src/lib/draft-routing.js";
import { seededRandom } from "../src/lib/knowledge-value.js";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import { inboxDraftExampleFragmentYaml } from "../src/lib/inbox.js";
import { spawnWorker, type WorkerResult } from "../src/lib/worker.js";
import { selectOpenWeightModel, spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import { buildInboxDraftSpawnArgs } from "../src/run-task.js";
import { withTempDir } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";

const arms = [{ deployment: "gpt-5-nano", estimatedCostUsd: 0.01 },
  { deployment: "gpt-oss-120b", estimatedCostUsd: 0.01 }];
const good = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: - P1 (plan) — RATIFIED 2026-10-01 -> NEW-1.`;

test("W1-T4067: an arm with 2 clean of 200 loses traffic to an arm with 60 clean of 100", () => {
  const random = seededRandom(4067);
  const stats = { "gpt-5-nano": { attempts: 200, clean: 2, contractFailures: 198, costUsd: 2 },
    "gpt-oss-120b": { attempts: 100, clean: 60, contractFailures: 40, costUsd: 1 } };
  const counts: Record<string, number> = {};
  for (let i = 0; i < 2000; i++) {
    const choice = chooseDraftDeployment(stats, arms, random);
    counts[choice.deployment] = (counts[choice.deployment] ?? 0) + 1;
  }
  assert.ok((counts["gpt-oss-120b"] ?? 0) > 1900, JSON.stringify(counts));
});

test("W1-T4067: an untried arm that fits the context is sampled with positive probability", () => {
  const selection = selectOpenWeightModel(undefined, "sonnet", "low", 18_800 * 4, { ready: () => true });
  const candidates = [selection.model, ...selection.alternatives].map((deployment) => ({ deployment, estimatedCostUsd: 0.01 }));
  const random = seededRandom(7);
  const seen = new Set<string>();
  for (let i = 0; i < 4000; i++) seen.add(chooseDraftDeployment({}, candidates, random).deployment);
  assert.equal(seen.size, candidates.length);
  assert.ok(seen.has("gpt-oss-120b"));
  assert.ok(seen.has("gpt-5.6-luna"));
  const tooLarge = selectOpenWeightModel(undefined, "sonnet", "low", 200_000 * 4, { ready: () => true });
  assert.ok(![tooLarge.model, ...tooLarge.alternatives].includes("gpt-oss-120b"));
});

function result(text: string, model: string): WorkerResult {
  return { text, blocks: [], model, routedModel: model, provider: "cash", isError: false,
    costUsd: 0.01, sessionId: model, subtype: "success", numTurns: 1, stderr: "", apiError: false,
    permissionDenials: [], childEnvKeys: [], effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], compactionFailures: [], compactionConfigured: false, qualitySuspect: false };
}

async function draftFixture(run: (args: Parameters<typeof spawnWorker>[0], config: Config, selection: { model: string; effort: string }) => Promise<WorkerResult>,
  readStats: () => ReturnType<typeof draftStatsFromRows> = () => ({}), prompt = "draft P1", cap = 10) {
  return withTempDir("rmd-draft-routing-", async (root) => {
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
    const config = { root, workerHomeRoot: join(root, "worker-home"), claudeBin: "/unused", dailyCapUsd: { normal: cap, squeezed: cap },
      workerProviders: { enabled: ["cash"], cashEndpoint: "https://example.test/" } } as Config;
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const args = buildInboxDraftSpawnArgs({ cwd: process.cwd(), settingsFile, config, prompt,
      mount: { model: "haiku", effort: "high", provider: "cash", maxTurns: 400, contextBudget: 180000 },
      disallowedTools: [], proposalId: "P1", draftRoutingLog: (step, extra = {}) => rows.push({ step, extra }) });
    args.draftRouting!.readStats = readStats;
    args.draftRouting!.random = seededRandom(10);
    const attempts: string[] = [];
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const worker = await spawnWorker({ ...args, providerRouting: { spawnOpenWeight: async (spawnArgs, cfg, selection) => {
        attempts.push(selection.model);
        return run(spawnArgs, cfg, selection);
      } } });
      return { worker, attempts, rows };
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
}

test("W1-T4067: a prose-only output is retried on the next rung within one attempt", async () => {
  let n = 0;
  const { worker, attempts, rows } = await draftFixture(async (_args, _cfg, selection) => result(++n === 1 ? "Here is my advice." : good, selection.model));
  assert.equal(attempts.length, 2);
  assert.equal(worker.routedModel, attempts[1]);
  assert.equal(new Set(attempts).size, 2);
  const outcomes = rows.filter((r) => r.step === "draft.routing.outcome");
  assert.equal(outcomes[0].extra.contract_failed, true);
  assert.equal(outcomes[1].extra.clean, true);
  assert.equal(outcomes.reduce((n, r) => n + Number(r.extra.draft_cost_usd), 0), 0.02);
  assert.equal(rows.filter((r) => r.step === "draft.routing.choice").length, 2);
  assert.equal(rows.filter((r) => r.step === "draft.routing.choice")[1].extra.reason, "draft-contract");
});

test("W1-T4067: a stats read failure routes by row order and ledgers the error", async () => {
  const { worker, attempts, rows } = await draftFixture(async (_args, _cfg, selection) => result(good, selection.model), () => { throw new Error("unreadable corpus"); });
  const expected = selectOpenWeightModel(loadMounts(mountsPath(process.cwd())).capabilities, "haiku", "high", Buffer.byteLength("draft P1"));
  assert.deepEqual(attempts, [expected.model]);
  assert.equal(worker.routedModel, expected.model);
  assert.match(String(rows.find((r) => r.step === "draft.routing.error")?.extra.error), /unreadable corpus/);
  assert.equal(rows.find((r) => r.step === "draft.routing.choice")?.extra.reason, "stats-read-failed-row-order");
});

test("W1-T4067: measured dollars change the winner independently of clean rate", () => {
  const stats = { "gpt-5-nano": { attempts: 100, clean: 60, contractFailures: 0, costUsd: 100 },
    "gpt-oss-120b": { attempts: 100, clean: 60, contractFailures: 0, costUsd: 1 } };
  const random = seededRandom(8);
  for (let i = 0; i < 100; i++) assert.equal(chooseDraftDeployment(stats, arms, random).deployment, "gpt-oss-120b");
});

test("W1-T4067: the production worker uses measured posteriors and ledgers its draw", async () => {
  const selection = selectOpenWeightModel(loadMounts(mountsPath(process.cwd())).capabilities, "haiku", "high", 32);
  const stats = Object.fromEntries([selection.model, ...selection.alternatives].map((deployment) => [deployment,
    { attempts: 20_000, clean: 0, contractFailures: 20_000, costUsd: 200 }]));
  stats["gpt-5-nano"] = { attempts: 200, clean: 2, contractFailures: 198, costUsd: 2 };
  stats["gpt-oss-120b"] = { attempts: 100, clean: 60, contractFailures: 40, costUsd: 1 };
  const { attempts, rows } = await draftFixture(async (_args, _cfg, sel) => result(good, sel.model), () => stats);
  assert.deepEqual(attempts, ["gpt-oss-120b"]);
  const choice = rows.find((r) => r.step === "draft.routing.choice")!;
  assert.equal(choice.extra.reason, "thompson-clean-per-dollar");
  assert.equal((choice.extra.posterior as { alpha: number }).alpha, 61);
});

test("W1-T4067: measured success cannot resurrect a deployment removed by context fit", async () => {
  const { attempts } = await draftFixture(async (_args, _cfg, selection) => result(good, selection.model),
    () => ({ "gpt-oss-120b": { attempts: 1000, clean: 1000, contractFailures: 0, costUsd: 0.0001 } }), "x".repeat(800_000));
  assert.ok(!attempts.includes("gpt-oss-120b"));
  assert.ok(!attempts.includes("gpt-5.6-luna"));
});

test("W1-T4067: all contract failures exhaust each eligible rung once", async () => {
  const { attempts, rows } = await draftFixture(async (_args, _cfg, selection) => result("STAMP: missing fragment", selection.model));
  const expected = selectOpenWeightModel(undefined, "haiku", "high", Buffer.byteLength("draft P1"));
  assert.equal(attempts.length, 1 + expected.alternatives.length);
  assert.equal(new Set(attempts).size, attempts.length);
  assert.ok(rows.filter((r) => r.step === "draft.routing.outcome").every((r) => r.extra.contract_failed === true));
});

test("W1-T4067: a refusal is not a contract failure and does not walk", async () => {
  const { attempts, rows } = await draftFixture(async (_args, _cfg, selection) => ({ ...result("", selection.model), isError: true, budgetRefused: true }));
  assert.equal(attempts.length, 1);
  assert.equal(rows.find((r) => r.step === "draft.routing.outcome")?.extra.contract_failed, false);
});

test("W1-T4067: each contract fallback checks the real cash cap before transport", async () => {
  let transported = 0;
  const { worker, attempts, rows } = await draftFixture(async (args, config, selection) => spawnOpenWeightWorker({
    ...args, workerHome: join(config.root, "provider-home"),
    env: { RMD_OPENWEIGHT_API_KEY: "fixture-only" }, clock: fixedClock(Date.parse("2026-10-01T00:00:00Z")),
    fetchImpl: async () => {
      transported++;
      return new Response(JSON.stringify({ id: "fixture", usage: { prompt_tokens: 1000, completion_tokens: 200 },
        choices: [{ message: { content: "prose only" } }] }), { status: 200 });
    },
  }, config, selection), () => ({}), "draft P1", 0.0045);
  assert.equal(transported, 1, "the second rung cannot bypass the cap");
  assert.equal(attempts.length, 2);
  assert.equal(worker.budgetRefused, true);
  assert.equal(rows.filter((r) => r.step === "draft.routing.outcome")[1].extra.contract_failed, false);
});

test("W1-T4067: malformed fences retry and dirty lint is recorded as an unsuccessful draft", async () => {
  let calls = 0;
  const { attempts, rows } = await draftFixture(async (_args, _cfg, selection) => result(++calls === 1
    ? "=== FRAGMENT START ===\n```yaml\n- id: NEW-1\n=== FRAGMENT END ===\nSTAMP: - P1 (plan) -> NEW-1."
    : "=== FRAGMENT START ===\n- id: NEW-1\n=== FRAGMENT END ===\nSTAMP: - P1 (plan) -> NEW-1.", selection.model));
  assert.equal(attempts.length, 2);
  assert.ok(rows.some((r) => r.step === "draft.routing.error" && r.extra.reason === "output-contract"));
  const outcomes = rows.filter((r) => r.step === "draft.routing.outcome");
  assert.equal(outcomes[0].extra.contract_failed, true);
  assert.equal(outcomes[1].extra.clean, false);
  assert.equal(outcomes[1].extra.contract_failed, false);
});

test("W1-T4067: a broken archive refuses partial stats instead of treating them as a prior", async () => {
  await withTempDir("draft-broken-stats", async (root) => {
    writeFileSync(join(root, "ledger.2026-10-01T00-00-00-000Z.ndjson.gz"), "not gzip");
    assert.throws(() => readDraftStats(root, "inbox-draft"), /corpus incomplete/);
    assert.throws(() => readDraftStats(join(root, "absent"), "inbox-draft"), /ENOENT/);
  });
});

test("W1-T4067: one batch shares its stats read and learns from each new rung", () => {
  let reads = 0;
  const steps: string[] = [];
  const session = createDraftStatsSession("unused", "inbox-draft", (step) => steps.push(step), () => {
    reads++;
    return { nano: { attempts: 1, clean: 0, contractFailures: 1, costUsd: 0.01 } };
  });
  session.log("draft.routing.choice");
  assert.equal(reads, 0);
  session.readStats();
  session.log("draft.routing.outcome", { lane: "inbox-draft", deployment: "nano", draft_cost_usd: 0.02, clean: true });
  session.log("draft.routing.outcome", { lane: "inbox-draft", deployment: "oss", draft_cost_usd: 0.01, contract_failed: true });
  session.log("draft.routing.outcome", { lane: "other", deployment: "oss", draft_cost_usd: 100, clean: true });
  assert.deepEqual(session.readStats(), {
    nano: { attempts: 2, clean: 1, contractFailures: 1, costUsd: 0.03 },
    oss: { attempts: 1, clean: 0, contractFailures: 1, costUsd: 0.01 },
  });
  assert.equal(reads, 1);
  assert.equal(steps.length, 4);
});

test("W1-T4067: a batch preserves a stats read failure for each chooser without rereading", () => {
  let reads = 0;
  const session = createDraftStatsSession("unused", "inbox-draft", () => {}, () => { reads++; throw new Error("broken read"); });
  for (let i = 0; i < 2; i++) assert.throws(session.readStats, /broken read/);
  session.log("draft.routing.outcome", { lane: "inbox-draft", deployment: "nano", clean: true });
  assert.equal(reads, 1);
});

test("W1-T4067: a failed ledger sink preserves routing and reports its error", (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  recordDraftRouting(() => { throw new Error("sink unavailable"); }, "draft.routing.choice", { deployment: "nano" });
  const reported = JSON.parse(errors[0]);
  assert.equal(reported.event, "draft.routing.error");
  assert.equal(reported.reason, "ledger-write-failed");
  assert.match(reported.error, /sink unavailable/);
});

test("W1-T4067: invalid chooser inputs refuse explicitly", () => {
  assert.throws(() => chooseDraftDeployment({}, []), /no eligible deployments/);
  assert.throws(() => chooseDraftDeployment({}, [{ deployment: "nano", estimatedCostUsd: 0 }]), /invalid draft cost/);
});

test("W1-T4067: legacy relints credit only the final deployment and exclude other lanes", () => {
  const rows = [
    { step: "inbox.draft_synthesized", run_id: "a", proposal_id: "P1", routed_model: "nano", cost_usd: 0.01 },
    { step: "inbox.draft_relint", run_id: "a", proposal_id: "P1" },
    { step: "inbox.draft_synthesized", run_id: "a", proposal_id: "P1", routed_model: "oss", cost_usd: 0.02 },
    { step: "inbox.drafted", run_id: "a", proposal_id: "P1", lint_clean: true },
    { step: "inbox.draft_synthesized", run_id: "b", proposal_id: "P1", routed_model: "nano", cost_usd: 0.03 },
    { step: "inbox.draft_error", run_id: "b", proposal_id: "P1", fragments: 0, stamps: 0 },
    { step: "draft.routing.outcome", lane: "other", deployment: "nano", draft_cost_usd: 100, clean: true },
  ];
  assert.deepEqual(draftStatsFromRows(rows, "inbox-draft"), {
    nano: { attempts: 2, clean: 0, contractFailures: 1, costUsd: 0.04 },
    oss: { attempts: 1, clean: 1, contractFailures: 0, costUsd: 0.02 },
  });
});

test("W1-T4067: empty session ids do not hide old failures or double count new refusals", () => {
  const rows = [
    { step: "inbox.draft_synthesized", run_id: "old", proposal_id: "P1", session_id: "", routed_model: "nano", cost_usd: 0.01 },
    { step: "inbox.draft_error", run_id: "old", proposal_id: "P1", fragments: 0, stamps: 0 },
    { step: "draft.routing.outcome", lane: "inbox-draft", deployment: "oss", session_id: "", selection_assignment_id: "A", draft_cost_usd: 0, clean: false, contract_failed: false },
    { step: "inbox.draft_synthesized", run_id: "new", proposal_id: "P1", session_id: "", selection_assignment_id: "A", routed_model: "oss", cost_usd: 0 },
    { step: "inbox.draft_error", run_id: "new", proposal_id: "P1", fragments: 0, stamps: 0 },
  ];
  assert.deepEqual(draftStatsFromRows(rows, "inbox-draft"), {
    nano: { attempts: 1, clean: 0, contractFailures: 1, costUsd: 0.01 },
    oss: { attempts: 1, clean: 0, contractFailures: 0, costUsd: 0 },
  });
});

test("W1-T4067: the real stats reader unions live and both rotation forms without double credit", async () => {
  await withTempDir("rmd-draft-stats-", async (root) => {
    const row = (deployment: string, ts: string) => ({ step: "draft.routing.outcome", lane: "inbox-draft", deployment,
      ts, session_id: deployment, draft_cost_usd: 0.01, clean: true, contract_failed: false });
    const a = row("nano", "2026-09-21T00:00:00Z");
    writeFileSync(join(root, "ledger.2026-09-21T00-00-00-000Z.ndjson.gz"), gzipSync(JSON.stringify(a) + "\n"));
    writeFileSync(join(root, "ledger.2026-09-22T00-00-00-000Z.ndjson"), JSON.stringify(row("oss", "2026-09-22T00:00:00Z")) + "\n");
    writeFileSync(join(root, "ledger.ndjson.carried.json"), "{}");
    writeFileSync(join(root, "ledger.ndjson.retained-steps.json"), "{}");
    writeFileSync(join(root, "ledger.ndjson.rotate.lock"), "{}");
    writeFileSync(join(root, "ledger.ndjson"), [a, row("luna", "2026-09-23T00:00:00Z"),
      { step: "inbox.draft_synthesized", session_id: "luna", run_id: "r", proposal_id: "P1", routed_model: "luna", cost_usd: 0.01 },
      { step: "inbox.drafted", run_id: "r", proposal_id: "P1", lint_clean: true }].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const stats = createDraftStatsSession(root, "inbox-draft", () => {}).readStats();
    assert.deepEqual(Object.keys(stats).sort(), ["luna", "nano", "oss"]);
    for (const arm of Object.values(stats)) assert.deepEqual(arm, { attempts: 1, clean: 1, contractFailures: 0, costUsd: 0.01 });
  });
});
