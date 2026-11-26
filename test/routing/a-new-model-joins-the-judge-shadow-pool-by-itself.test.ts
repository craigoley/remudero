/**
 * W1-T12422 — a new decision model or cash deployment joins each judge's shadow pool by itself, after its corpus
 * replay. `shadow: auto` draws one pool member per call by a seeded draw; a member needs a passing direct judge
 * replay for the role; the bake-off keys a decision model apart from a cash deployment and replays each new or
 * changed model once per readiness digest, retrying a replay a 429 or a budget refusal stopped.
 * Every replay and every decision request here is a fake: no network and no paid call runs.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { findUntrialedModels, readBakeoffTrialState, runDeploymentBakeoff, type DeployedModel, type JudgeReplayOutcome } from "#src/lib/bakeoff-trigger.js";
import type { Config } from "#src/lib/config.js";
import type { askDecisionModel, DecisionAnsweredRow } from "#src/lib/decision-model.js";
import { loadProposalRegistry } from "#src/lib/inbox.js";
import {
  JUDGE_SHADOW_POOL_BAR, judgeShadowAutoRoles, judgeShadowPool, readJudgeShadowPoolRecord, readyCashShadowDeployments, recordJudgeReplayFigures,
  shadowJudgeCall, shadowPoolMember, type JudgeShadowPoolMember, type JudgeShadowPoolRecord, type ShadowJudgeCall,
} from "#src/lib/judge-shadow.js";
import type { JudgeReplayFinishedRow } from "#src/lib/judge-replay-batch.js";
import { loadMounts, mountsPath, validateMounts, type DecisionCandidate, type JudgeMount } from "#src/lib/mounts.js";
import type { SpawnWorkerArgs } from "#src/lib/worker.js";
import { isFoundryClaudeDeployment, OPENWEIGHT_PRICES } from "#src/lib/worker-provider.js";
import { createJudgeShadowReplay, decisionBakeoffDeployments, measurementBakeoffDeployments } from "#test/helpers/run-task-test.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TABLE = readFileSync(mountsPath(REPO_ROOT), "utf8");
const MOUNTS = loadMounts(mountsPath(REPO_ROOT));
const DECISIONS = MOUNTS.decision_models!;
const ROW = { model: "haiku", effort: "low", max_turns: 400, context_budget: 60000 };
const incumbent = { id: "incumbent", label: "incumbent", model: "sonnet", billing: "subscription" as const, tools: true };
const passing = (corpus = "all") => ({ corpus, sent: 19, rejected: 1, medianCaseUsd: 0.0004, finishedAt: "2026-11-17T12:00:00.000Z" });

/** A replay record where every key in `keys` passed its replay for `role`. */
function record(role: string, keys: readonly string[], figures = passing()): JudgeShadowPoolRecord {
  return { replays: { [role]: Object.fromEntries(keys.map((key) => [key, figures])) } };
}

function finished(patch: Partial<JudgeReplayFinishedRow> = {}): JudgeReplayOutcome["row"] {
  return { corpus: "all", outcome: "finished", sent: 19, rejected: 0, median_case_settled_usd: 0.0004, settled_usd: 0.0076, ...patch };
}

/** A shadow call whose decision requests and cash spawns are recorded and never sent. */
function call(role: ShadowJudgeCall<string>["role"], mount: JudgeMount, pool: JudgeShadowPoolMember[], input = "judge this change") {
  const asked: Array<Parameters<typeof askDecisionModel>[1]> = [];
  const spawned: SpawnWorkerArgs[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const reply = (candidate: DecisionCandidate): DecisionAnsweredRow => ({ role, input_digest: "d", candidate: candidate.name, deployment: candidate.deployment,
    shape: candidate.shape, model_surface: "decisions", outcome: "answered", served_model: null, latency_ms: 300, reserved_usd: 0.001, settled_usd: 0.0002,
    held_usd: 0, usage: null, question_count: 1, answers: [{ name: "x", outcome: "distribution", confidence: null,
      distribution: [{ option: "automate", probability: 0.9 }, { option: "needs_operator", probability: 0.05 }, { option: "backlog", probability: 0.05 }] }] });
  const shadow: ShadowJudgeCall<string> = { role, key: "K", mount, input, primaryArgs: { cwd: REPO_ROOT, prompt: input, tools: [] } as unknown as SpawnWorkerArgs,
    primary: { costUsd: 0.003 }, primaryAnswer: "automate", parse: (text) => text.trim(), agreementKey: (v) => v,
    spawn: async (args) => { spawned.push(args); return { sessionId: "s", costUsd: 0.0001, numTurns: 1, text: "automate", subtype: "success" } as never; },
    log: (step, fields) => rows.push({ step, ...fields }),
    decisions: { config: () => ({ claudeBin: "/unused", root: "/unused" }) as Config, env: {}, learnedLimit: () => undefined,
      ask: async (_config, request) => { asked.push(request); return reply(request.candidate); }, pool: () => pool } };
  return { shadow, asked, spawned, rows };
}

const autoMount: JudgeMount = { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000, shadow: { provider: "auto", deployment: "auto" } };

test("W1-T12422 criterion 1: `shadow: auto` pools every decision model and every ready cash deployment, not Foundry Claude, that has a replay for the role", async (t) => {
  // W1-T14841: the repo's fix-progress row is auto too; this table keeps it without a shadow to name its own roles.
  const table = validateMounts({ ...(parseYaml(TABLE) as Record<string, unknown>), ci_judge: { ...ROW, shadow: "auto" }, fix_progress_judge: ROW,
    judge_shadows: { "head-rehome": "auto" } });
  assert.deepEqual(table.ci_judge!.shadow, { provider: "auto", deployment: "auto" });
  assert.deepEqual(judgeShadowAutoRoles(table).sort(), ["ci-judge", "head-rehome", "verify-human"]);
  assert.ok(judgeShadowAutoRoles(MOUNTS).length > 0, "the repo's table sets `shadow: auto` on the fixed-option rows");

  const cash = ["gpt-oss-120b", "Kimi-K2.6", "claude-haiku-5-5"];
  const replayed = record("verify-human", ["decisions:decisions-eastus", "cash:gpt-oss-120b", "cash:claude-haiku-5-5"]);
  const pool = judgeShadowPool("verify-human", { decisionModels: DECISIONS, cashDeployments: cash, record: replayed });
  assert.deepEqual(pool.members.map((m) => m.key), ["decisions:decisions-eastus", "cash:gpt-oss-120b"]);
  assert.deepEqual(pool.excluded.map((e) => [e.key, e.reason]), [["decisions:systemone-eastus2", "no judge replay for this role"],
    ["cash:Kimi-K2.6", "no judge replay for this role"]], "a member with no replay row stays out; a Foundry Claude deployment is never a candidate");
  assert.deepEqual(judgeShadowPool("refresh-value", { decisionModels: DECISIONS, cashDeployments: cash, record: replayed }).members, [],
    "a replay for one role admits nobody to another role's pool");

  // An auto role asks the drawn member as W1-T12417 asks a named one; a role naming one candidate never reads a pool.
  const auto = call("verify-human", autoMount, pool.members);
  await shadowJudgeCall(auto.shadow);
  assert.equal(auto.asked.length + auto.spawned.length, 1, "one paid shadow call, whatever the pool's size");
  const named = call("verify-human", { ...autoMount, shadow: { provider: "decisions", deployment: DECISIONS["systemone-eastus2"]!.deployment, candidate: DECISIONS["systemone-eastus2"]! } }, pool.members);
  await shadowJudgeCall(named.shadow);
  assert.equal(named.asked[0]!.candidate.name, "systemone-eastus2");
  // The production pool: the mounts table the judge runs from and the replay record under the host's state directory.
  const { dir: root } = ownedFixtureDir(t, "judge-pool-production");
  recordJudgeReplayFigures(join(root, "state"), "verify-human", "decisions:systemone-eastus2", passing());
  const production = call("verify-human", autoMount, []);
  production.shadow.decisions = { ...production.shadow.decisions, pool: undefined, config: () => ({ claudeBin: "/unused", root }) as Config };
  await shadowJudgeCall(production.shadow);
  assert.deepEqual(production.asked.map((a) => a.candidate.name), ["systemone-eastus2"]);
  // A pool that cannot be read writes one skipped row.
  const unreadable = call("verify-human", autoMount, []);
  unreadable.shadow.decisions = { ...unreadable.shadow.decisions, pool: () => { throw new Error("record unreadable"); } };
  await shadowJudgeCall(unreadable.shadow);
  assert.deepEqual(unreadable.rows.map((r) => [r.step, r.reason]), [["judge_shadow.skipped", "the shadow pool is unreadable: record unreadable"]]);
  // An empty pool asks nothing and writes nothing.
  const empty = call("verify-human", autoMount, []);
  await shadowJudgeCall(empty.shadow);
  assert.deepEqual([empty.asked.length, empty.spawned.length, empty.rows.length], [0, 0, 0]);
});

test("W1-T12422 criterion 2: the shadow draws one member by a seeded draw on the role and the input digest: the same input, the same member, and about equal shares", async () => {
  const pool = judgeShadowPool("verify-human", { decisionModels: DECISIONS, cashDeployments: ["gpt-oss-120b", "Kimi-K2.6"],
    record: record("verify-human", ["decisions:decisions-eastus", "decisions:systemone-eastus2", "cash:gpt-oss-120b", "cash:Kimi-K2.6"]) }).members;
  assert.equal(pool.length, 4);
  const first = shadowPoolMember("verify-human", "digest-1", pool)!;
  for (let i = 0; i < 5; i++) assert.equal(shadowPoolMember("verify-human", "digest-1", [...pool].reverse())!.key, first.key, "order of the pool does not matter");
  const shares = new Map<string, number>();
  const draws = 4000;
  for (let i = 0; i < draws; i++) {
    const key = shadowPoolMember("verify-human", `digest-${i}`, pool)!.key;
    shares.set(key, (shares.get(key) ?? 0) + 1);
  }
  assert.equal(shares.size, 4);
  for (const [key, count] of shares) assert.ok(Math.abs(count / draws - 0.25) < 0.04, `${key} got ${count} of ${draws}`);
  assert.equal(shadowPoolMember("verify-human", "x", []), undefined);
  // Through the shadow: the same input, asked twice, goes to the same member.
  const picks: string[] = [];
  for (let i = 0; i < 2; i++) {
    const c = call("verify-human", { ...autoMount, provider: undefined }, pool, "the same input");
    await shadowJudgeCall(c.shadow);
    picks.push(c.asked[0]?.candidate.name ?? String(c.spawned[0]?.routingTrial?.models?.[0]));
  }
  assert.equal(picks[0], picks[1]);
});

test("W1-T12422 criterion 3: a member above the rejected share or the cost ceiling stays out, and the bake-off proposal names it with its figures", async (t) => {
  const { dir } = ownedFixtureDir(t, "judge-pool-bar");
  const over = { ...passing(), rejected: 3 };
  const costly = { ...passing(), medianCaseUsd: 0.0123 };
  assert.ok(over.rejected / over.sent > JUDGE_SHADOW_POOL_BAR.maxRejectedShare);
  const pool = judgeShadowPool("verify-human", { decisionModels: {}, cashDeployments: ["gpt-oss-120b", "Kimi-K2.6", "gpt-5.6-terra"],
    record: { replays: { "verify-human": { "cash:gpt-oss-120b": passing(), "cash:Kimi-K2.6": over, "cash:gpt-5.6-terra": costly } } } });
  assert.deepEqual(pool.members.map((m) => m.key), ["cash:gpt-oss-120b"]);
  assert.match(pool.excluded.find((e) => e.key === "cash:Kimi-K2.6")!.reason, /rejected 15\.8% of 19 cases, above 10%/);
  assert.match(pool.excluded.find((e) => e.key === "cash:gpt-5.6-terra")!.reason, /median settled cost per case is \$0\.0123, above \$0\.003/);

  writeFileSync(join(dir, "bakeoff-trialed.json"), JSON.stringify({ trialed: [] }));
  const deployed: DeployedModel[] = [{ model: "gpt-5.6-terra", billing: "cash", efforts: [], readinessDigest: "a" },
    { model: "decisions-eastus", billing: "decisions", efforts: [], readinessDigest: "b" }];
  const [proposal] = await runDeploymentBakeoff({ stateDir: dir, deployed, incumbent,
    judgeReplay: async (model) => [{ roles: ["verify-human"], row: model.billing === "cash" ? finished({ median_case_settled_usd: 0.0123 }) : finished() }] });
  assert.match(proposal!.summary, /\| cash:gpt-5\.6-terra \| verify-human \| all \| 19 \| 0\.0% \| \$0\.0123 \| stays out: its median settled cost per case is \$0\.0123, above \$0\.003 \|/);
  assert.match(proposal!.summary, /\| decisions:decisions-eastus \| verify-human \| all \| 19 \| 0\.0% \| \$0\.0004 \| joins the pool \|/);
  assert.ok(loadProposalRegistry(join(dir, "inbox-proposals.json")).some((p) => p.id === proposal!.id));
  const stored = readJudgeShadowPoolRecord(dir);
  assert.deepEqual(judgeShadowPool("verify-human", { decisionModels: DECISIONS, cashDeployments: ["gpt-5.6-terra"], record: stored }).members.map((m) => m.key),
    ["decisions:decisions-eastus"]);
});

test("W1-T12422 criterion 4: the bake-off keys a decision model as decisions:<candidate>, apart from cash:<deployment>", () => {
  const cashLuna: DeployedModel = { model: "gpt-6-luna", billing: "cash", efforts: [] };
  const decisionLuna: DeployedModel = { model: "gpt-6-luna", billing: "decisions", efforts: [] };
  assert.deepEqual(findUntrialedModels([cashLuna, decisionLuna], ["cash:gpt-6-luna"]), [decisionLuna], "a trialed cash gpt-6-luna leaves the decision model untrialed");
  assert.deepEqual(findUntrialedModels([decisionLuna], ["decisions:gpt-6-luna"]), []);
  const rows = decisionBakeoffDeployments(MOUNTS);
  assert.deepEqual(rows.map((r) => [r.model, r.billing]), Object.keys(DECISIONS).map((name) => [name, "decisions"]));
  const changed = decisionBakeoffDeployments({ ...MOUNTS, decision_models: { ...DECISIONS, "decisions-eastus": { ...DECISIONS["decisions-eastus"]!, deployment: "gpt-6.1-luna" } } });
  assert.notEqual(changed[0]!.readinessDigest, rows[0]!.readinessDigest, "a changed decision_models row has a new readiness digest");
});

test("W1-T12422 criterion 5: the cadence replays each new or changed model once per readiness digest, and retries a replay a 429 or a budget refusal stopped", async (t) => {
  const { dir } = ownedFixtureDir(t, "judge-pool-cadence");
  writeFileSync(join(dir, "bakeoff-trialed.json"), JSON.stringify({ trialed: [] }));
  const replays: string[] = [];
  const inboxArms: string[] = [];
  let stop: string | undefined = "rate-limited";
  const pass = (deployed: DeployedModel[]) => runDeploymentBakeoff({ stateDir: dir, deployed, incumbent,
    replay: async (candidates) => { inboxArms.push(...candidates.map((c) => c.id)); return []; },
    judgeReplay: async (model) => {
      replays.push(model.model);
      const reason = model.billing === "decisions" ? stop : undefined;
      return [{ roles: ["verify-human"], row: reason === undefined ? finished() : finished({ outcome: "stopped", reason, sent: 3 }) }];
    } });
  const decision: DeployedModel = { model: "decisions-eastus", billing: "decisions", efforts: [], readinessDigest: "v1" };
  const cash: DeployedModel = { model: "gpt-oss-120b", billing: "cash", efforts: ["low"], readinessDigest: "c1" };
  const claude: DeployedModel = { model: "claude-haiku-5-5", billing: "cash", efforts: ["low"], readinessDigest: "h1" };
  assert.ok(isFoundryClaudeDeployment(claude.model));
  await pass([decision, cash, claude]);
  assert.deepEqual(replays, ["decisions-eastus", "gpt-oss-120b"], "no Foundry Claude replay");
  assert.ok(!inboxArms.some((id) => id.startsWith("decisions:")), "a decision model gets the judge replay only");
  assert.ok(inboxArms.some((id) => id.startsWith("cash:gpt-oss-120b")), "a cash deployment gets the inbox-draft trial too");
  assert.deepEqual(readBakeoffTrialState(dir).judgeTrialed, ["cash:gpt-oss-120b"], "a replay stopped by a 429 is not marked trialed");
  stop = "budget-refused";
  await pass([decision, cash]);
  assert.deepEqual(replays.slice(2), ["decisions-eastus"], "tried again on a later pass; a budget refusal is not a trial either");
  stop = undefined;
  await pass([decision, cash]);
  await pass([decision, cash]);
  assert.deepEqual(replays.slice(3), ["decisions-eastus"], "once per readiness digest");
  assert.deepEqual(readBakeoffTrialState(dir).judgeTrialed!.sort(), ["cash:gpt-oss-120b", "decisions:decisions-eastus"]);
  await pass([{ ...decision, readinessDigest: "v2" }, cash]);
  assert.deepEqual(replays.slice(4), ["decisions-eastus"], "a changed row is replayed again");

  // The cadence's replay: one W1-T12421 direct replay per corpus the auto roles read, one at a time.
  const sent: Array<{ model: string; corpus: string; lane?: string }> = [];
  const replay = createJudgeShadowReplay({ claudeBin: "/unused", root: dir } as Config, REPO_ROOT,
    validateMounts({ ...(parseYaml(TABLE) as Record<string, unknown>), risk_judge: { ...ROW, shadow: "auto" } }),
    (async (_config: Config, request: { model: string; corpus: string; lane?: string }) => { sent.push(request); return { ...finished(), corpus: request.corpus }; }) as never)!;
  const outcomes = await replay(decision);
  assert.deepEqual(sent.map((s) => [s.model, s.corpus, s.lane]), [["decisions-eastus", "risk-judge-dispositions", "direct"], ["decisions-eastus", "all", "direct"]]);
  assert.deepEqual(outcomes.map((o) => o.roles), [["risk-judge"],
    ["ci-judge", "fix-progress", "verify-human", "refresh-value", "quiet-worker-watchdog", "head-rehome", "typed-judgment"]]);
  assert.equal(createJudgeShadowReplay({ claudeBin: "/unused", root: dir } as Config, REPO_ROOT,
    validateMounts({ ...(parseYaml(TABLE) as Record<string, unknown>), verify_human_judge: undefined, judge_shadows: undefined,
      ci_judge: ROW, fix_progress_judge: ROW })), undefined, "no auto role, no replay");
});

test("W1-T12422 criterion 6: with today's price rows and both decision models, an auto role's pool holds them and the four open-weight deployments once their replays pass", (t) => {
  const { dir } = ownedFixtureDir(t, "judge-pool-today");
  const deployed = [...measurementBakeoffDeployments(MOUNTS), ...decisionBakeoffDeployments(MOUNTS)].filter((m) => m.billing !== "subscription");
  // Every ready model's replay passed, at its own price row: about 2,000 input and 8 output tokens a case.
  for (const model of deployed) {
    const price = model.billing === "decisions" ? DECISIONS[model.model]!.price : OPENWEIGHT_PRICES[model.model]!;
    recordJudgeReplayFigures(dir, "verify-human", `${model.billing}:${model.model}`, { ...passing(),
      medianCaseUsd: (2000 * price.inputUsdPerMillion + 8 * price.outputUsdPerMillion) / 1_000_000 });
  }
  const pool = judgeShadowPool("verify-human", { decisionModels: DECISIONS, cashDeployments: readyCashShadowDeployments(), record: readJudgeShadowPoolRecord(dir) });
  const names = pool.members.map((m) => m.name);
  for (const name of [...Object.keys(DECISIONS), "gpt-oss-120b", "DeepSeek-V4-Flash", "DeepSeek-V4.1-Flash", "Kimi-K2.6"]) assert.ok(names.includes(name), name);
  assert.ok(!names.some(isFoundryClaudeDeployment), "no Foundry Claude deployment");
  assert.ok(Object.keys(DECISIONS).length === 2);
});
