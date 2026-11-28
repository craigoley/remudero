import assert from "node:assert/strict";
import test from "node:test";
import { loadMounts, mountsPath, type CapabilityLadder } from "#src/lib/mounts.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ROUTING_EXPERIMENTS, routingExperimentFor } from "#src/lib/routing-experiments.js";
import { codexCandidatesForCapability, codexNotionalCostUsd, selectCodexModel,
  type CodexModelInfo } from "#src/lib/worker-provider.js";

// W1-T13445 (2026-11-17): GPT-6.2 Sol is the current Sol. Every Codex Sol seat leads with it and keeps
// gpt-6.1-sol next as the availability and effort fallback; nothing else in the routing table moves.

const SOL62 = "gpt-6.2-sol";
const SOL61 = "gpt-6.1-sol";
const EFFORTS = ["low", "medium", "high"] as const;
const SOL_TIERS = ["balanced", "frontier"] as const;

// The Codex Sol rows as they stood on origin/main before the bump (base 64fd1e318e).
const ORIGIN_SOL_ROWS: Record<(typeof SOL_TIERS)[number], string[]> = {
  balanced: [SOL61, "gpt-6-sol", "gpt-5.6-sol"],
  frontier: [SOL61, "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"],
};
// The Codex economy rows remain as they stood on origin/main.
const ORIGIN_CODEX_ECONOMY = {
  low: ["gpt-5.3-codex-spark", "gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"],
  medium: ["gpt-6-luna", "gpt-5.3-codex-spark", "gpt-5.6-luna", "gpt-5.4-mini"],
  high: ["gpt-5.3-codex-spark", "gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"],
};
const CASH_ECONOMY = ["gpt-oss-120b", "gpt-5-nano", "gpt-6-luna", "claude-haiku-5-5"];
// Cash keeps its prior order with Sol 6.2 inserted directly before Sol 6.1.
const CASH_BALANCED = ["gpt-5-nano", "gpt-oss-120b", "gpt-6-luna", "gpt-6.1-terra", SOL62, SOL61];
const CASH_FRONTIER = ["gpt-6-luna", "gpt-6.1-terra"];
const ORIGIN_CASH = {
  economy: { low: CASH_ECONOMY, medium: CASH_ECONOMY, high: CASH_ECONOMY },
  balanced: { low: CASH_BALANCED, medium: CASH_BALANCED, high: CASH_BALANCED },
  frontier: { low: CASH_FRONTIER, medium: CASH_FRONTIER, high: CASH_FRONTIER },
};

const ladder = (): CapabilityLadder => loadMounts(mountsPath(REPO_ROOT)).capabilities!;

// The account's model/list read in the daemon container on 2026-11-17 (codex-cli 0.169.0): ids and
// efforts only. gpt-6.2-sol is the account default.
const ALL = ["low", "medium", "high", "xhigh", "max", "ultra"];
const LIVE_MODELS: CodexModelInfo[] = ([
  [SOL62, ALL, true],
  ["gpt-6.2-astra", ALL],
  [SOL61, ALL],
  ["gpt-6.1-terra", ALL],
  ["gpt-6-sol", ALL],
  ["gpt-6-luna", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.6-sol", ALL],
  ["gpt-5.6-terra", ALL],
  ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
] as const).map(([id, efforts, isDefault]) => ({
  id, model: id, isDefault: isDefault === true,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
}));
// One shared `codex` bucket for every model, as measured: headroom ties, so row order decides.
const LIVE_LIMITS = { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 73, windowDurationMins: 10080 } } } };

test("W1-T13445 criterion 1: every Codex Sol row and the fallback list lead gpt-6.2-sol, then gpt-6.1-sol, then the origin/main row", () => {
  const codex = ladder().codex;
  let rows = 0;
  for (const tier of SOL_TIERS) {
    for (const effort of EFFORTS) {
      const row = codex[tier]?.[effort];
      assert.deepEqual(row, [SOL62, ...ORIGIN_SOL_ROWS[tier]], `mounts codex.${tier}.${effort}`);
      assert.equal(row![1], SOL61, `codex.${tier}.${effort}: Sol 6.1 is the next availability fallback`);
      rows++;
    }
    // No capability table: the code-side fallback list holds the same row, whatever the effort.
    for (const effort of [...EFFORTS, undefined]) {
      assert.deepEqual(codexCandidatesForCapability(undefined, tier, effort), [SOL62, ...ORIGIN_SOL_ROWS[tier]],
        `FALLBACK_CODEX_MODELS.${tier} (effort ${String(effort)})`);
    }
  }
  assert.equal(rows, 6, "six Sol rows were compared");
});

test("W1-T13445 criterion 2: selectCodexModel serves gpt-6.2-sol when the account offers it at the effort, else gpt-6.1-sol", () => {
  const table = ladder();
  const pick = (models: CodexModelInfo[], requested: string, effort: string) =>
    selectCodexModel(models, LIVE_LIMITS, {} as never, requested, effort, table);
  const withoutSol62 = LIVE_MODELS.filter((model) => model.id !== SOL62);
  // gpt-6.2-sol is listed, but not at any effort the rows request.
  const sol62TopEffortsOnly = LIVE_MODELS.map((model) => model.id !== SOL62 ? model
    : { ...model, supportedReasoningEfforts: ["xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })) });
  let picks = 0;
  for (const requested of ["sonnet", "claude-sonnet-5-5", "opus", "claude-opus-5-5"]) {
    for (const effort of EFFORTS) {
      const label = `${requested}/${effort}`;
      const served = pick(LIVE_MODELS, requested, effort);
      assert.equal(served.readable, true, label);
      assert.equal(served.model, SOL62, `${label}: the current Sol serves when the account lists it`);
      assert.equal(served.effort, effort, label);

      const absent = pick(withoutSol62, requested, effort);
      assert.equal(absent.model, SOL61, `${label}: an account without gpt-6.2-sol falls to Sol 6.1`);
      assert.equal(absent.modelDecision?.mappedCandidates[0], SOL62, `${label}: the row still asked for 6.2 first`);

      const noEffort = pick(sol62TopEffortsOnly, requested, effort);
      assert.equal(noEffort.model, SOL61, `${label}: gpt-6.2-sol without the effort falls to Sol 6.1`);
      assert.equal(noEffort.modelDecision?.options.find((option) => option.id === SOL62)?.reason, "unsupported-effort", label);
      picks++;
    }
  }
  assert.equal(picks, 12, "twelve sonnet/opus requests were replayed");
});

test("W1-T13445 criterion 3: cash inserts Sol 6.2 before Sol 6.1; all other rows stay unchanged", () => {
  const table = ladder();
  assert.deepEqual(table.codex.economy, ORIGIN_CODEX_ECONOMY, "the Codex economy rows are as on origin/main");
  assert.deepEqual(table.cash, ORIGIN_CASH, "the cash rows add Sol 6.2 immediately ahead of Sol 6.1");
  // W1-T14297 (operator option A, 2026-11-22) adds balanced: codex; this suite's Sol rows are unchanged by it.
  assert.deepEqual(table.providerPreference, { frontier: "claude", balanced: "codex", economy: "claude" });
  assert.deepEqual(table.rolePreference, { reviewer: "claude" });
  assert.deepEqual(table.subscriptionOnly, ["frontier"]);
  assert.deepEqual(Object.keys(table.codex).sort(), ["balanced", "economy", "frontier"]);
  for (const tier of SOL_TIERS) {
    assert.deepEqual(Object.keys(table.codex[tier]!).sort(), ["high", "low", "medium"], `codex.${tier} efforts`);
    for (const effort of EFFORTS) {
      assert.deepEqual(table.codex[tier]![effort]!.filter((model) => model !== SOL62), ORIGIN_SOL_ROWS[tier],
        `codex.${tier}.${effort}: every member other than gpt-6.2-sol is as on origin/main`);
    }
  }
  const lists: Array<[string, string[]]> = [];
  for (const [kind, byTier] of [["codex", table.codex], ["cash", table.cash ?? {}]] as const) {
    for (const [tier, byEffort] of Object.entries(byTier)) {
      for (const [effort, row] of Object.entries(byEffort)) lists.push([`${kind}.${tier}.${effort}`, row]);
    }
  }
  for (const tier of ["economy", ...SOL_TIERS] as const) {
    for (const effort of [...EFFORTS, undefined]) {
      lists.push([`fallback.${tier}.${String(effort)}`, codexCandidatesForCapability(undefined, tier, effort)]);
    }
  }
  assert.ok(lists.length >= 30, `rows and fallback lists were scanned (${lists.length})`);
  for (const [name, row] of lists) {
    assert.equal(row.some((model) => /astra/i.test(model)), false, `${name} names an astra model`);
  }
});

test("W1-T13445 criterion 4: a gpt-6.2-sol candidate joins a sol62 epoch, Sol 6.1 keeps its own, and 6.2 is priced", () => {
  const classify = (codex: string, claude = "claude-sonnet-5-5") => routingExperimentFor({
    capability: "balanced", effort: "high", considered: [
      { provider: "claude", model: claude, eligible: true },
      { provider: "codex", model: codex, eligible: true },
    ] });
  assert.equal(classify(SOL62), "sol62-vs-sonnet55");
  assert.equal(classify(SOL62, "claude-sonnet-5"), "sol62-vs-sonnet5");
  assert.equal(classify(SOL61), "sol61-vs-sonnet55", "a Sol 6.1 candidate stays in its sol61 epoch");
  assert.equal(classify(SOL61, "claude-sonnet-5"), "sol61-vs-sonnet5");
  assert.equal(classify("gpt-6X2-sol"), undefined, "the epoch matches the concrete model id exactly");
  for (const [sol62Id, sol61Id] of [["sol62-vs-sonnet55", "sol61-vs-sonnet55"], ["sol62-vs-sonnet5", "sol61-vs-sonnet5"]]) {
    const sol62 = ROUTING_EXPERIMENTS.find((item) => item.id === sol62Id);
    const sol61 = ROUTING_EXPERIMENTS.find((item) => item.id === sol61Id);
    assert.ok(sol62 && sol61, `${sol62Id} and ${sol61Id} are live`);
    assert.equal(sol62.codexModel.test(SOL61), false, `${sol62Id} never pools a Sol 6.1 task`);
    assert.equal(sol61.codexModel.test(SOL62), false, `${sol61Id} never pools a Sol 6.2 task`);
    assert.equal(String(sol62.claudeModel), String(sol61.claudeModel), `${sol62Id} keeps the Sonnet treatment`);
    assert.deepEqual(sol62.arms, { claude: "sonnet", codex: "sol62" });
    assert.deepEqual([sol62.capability, sol62.effort, sol62.reviewCadence, sol62.minTasksPerArm, sol62.decision],
      [sol61.capability, sol61.effort, sol61.reviewCadence, sol61.minTasksPerArm, sol61.decision], `${sol62Id} reads against the sol61 standard`);
    assert.equal(sol62.startedOn, "2026-11-17");
    assert.equal(sol62.revisitOn, "2026-11-17");
  }
  const million = 1_000_000;
  assert.equal(codexNotionalCostUsd(SOL62, { input: million, output: 0, cacheRead: 0 }), 2, "$2 per 1M input");
  assert.equal(codexNotionalCostUsd(SOL62, { input: million, output: 0, cacheRead: million }), 0.1, "$0.10 per 1M cached input");
  assert.equal(codexNotionalCostUsd(SOL62, { input: 0, output: million, cacheRead: 0 }), 10, "$10 per 1M output");
});
