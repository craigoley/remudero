/**
 * W1-T14841 — the bake-off replays a judge-trialed model once when the `shadow: auto` roles or the decision reader
 * change, or its pool figures grow stale; an auto shadow with an empty pool asks its fallback; the ci, fix-progress
 * and risk judges' shadows are as the operator chose on 2026-11-25. Every replay and spawn here is a fake.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { readBakeoffTrialState, runDeploymentBakeoff, type DeployedModel, type JudgeReplayOutcome } from "#src/lib/bakeoff-trigger.js";
import type { Config } from "#src/lib/config.js";
import { DECISION_READER_REVISION } from "#src/lib/decision-model.js";
import {
  JUDGE_REPLAY_STALE_DAYS, judgeReplayKey, judgeShadowAutoRoles, recordJudgeReplayFigures, runJudgeShadow, shadowJudgeCall,
  type JudgeShadowPoolMember, type ShadowJudgeCall,
} from "#src/lib/judge-shadow.js";
import { loadMounts, mountsPath, validateMounts, type JudgeMount } from "#src/lib/mounts.js";
import type { SpawnWorkerArgs } from "#src/lib/worker.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const MOUNTS = loadMounts(mountsPath(REPO_ROOT));
const incumbent = { id: "incumbent", label: "incumbent", model: "sonnet", billing: "subscription" as const, tools: true };
const MODEL: DeployedModel = { model: "gpt-oss-120b", billing: "cash", efforts: [], readinessDigest: "row-digest" };
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const finished: JudgeReplayOutcome["row"] = { corpus: "all", outcome: "finished", sent: 19, rejected: 0, median_case_settled_usd: 0.0004, settled_usd: 0.0076 };

/** One bake-off pass with only the judge replay; returns the models it replayed. */
async function pass(dir: string, opts: { key?: string; roles?: readonly string[]; now?: number }): Promise<string[]> {
  const replayed: string[] = [];
  await runDeploymentBakeoff({ stateDir: dir, deployed: [MODEL], incumbent,
    judgeReplay: async (model) => { replayed.push(model.model); return [{ roles: opts.roles ?? ["verify-human"], row: finished }]; },
    ...(opts.key === undefined ? {} : { judgeReplayKey: opts.key }), ...(opts.roles === undefined ? {} : { judgeReplayRoles: opts.roles }),
    clock: { now: () => opts.now ?? NOW, iso: () => new Date(opts.now ?? NOW).toISOString() } });
  return replayed;
}

const keyOf = (roles: string[], reader: number) => JSON.stringify({ roles: [...roles].sort(), reader });

test("W1-T14841 criterion 1: a new shadow-auto role replays every trialed model once", async (t) => {
  const { dir } = ownedFixtureDir(t, "judge-replay-roles");
  writeFileSync(join(dir, "bakeoff-trialed.json"), JSON.stringify({ trialed: [] }));
  assert.deepEqual(await pass(dir, { key: keyOf(["verify-human"], 2) }), ["gpt-oss-120b"], "an untrialed model is replayed");
  assert.deepEqual(await pass(dir, { key: keyOf(["verify-human"], 2) }), [], "the same roles replay nothing");
  assert.deepEqual(await pass(dir, { key: keyOf(["verify-human", "ci-judge"], 2) }), ["gpt-oss-120b"], "a new auto role replays it once");
  assert.deepEqual(await pass(dir, { key: keyOf(["verify-human", "ci-judge"], 2) }), [], "and not again");
  const roles = JSON.parse(judgeReplayKey(MOUNTS)).roles as string[];
  assert.deepEqual(roles, [...judgeShadowAutoRoles(MOUNTS)].sort(), "the production key names the mounts table's auto roles");
});

test("W1-T14841 criterion 2: a decision reader revision change replays once", async (t) => {
  const { dir } = ownedFixtureDir(t, "judge-replay-reader");
  writeFileSync(join(dir, "bakeoff-trialed.json"), JSON.stringify({ trialed: [] }));
  assert.deepEqual(await pass(dir, { key: keyOf(["verify-human"], 1) }), ["gpt-oss-120b"]);
  assert.deepEqual(await pass(dir, { key: keyOf(["verify-human"], 2) }), ["gpt-oss-120b"], "a new reader revision replays it once");
  assert.deepEqual(await pass(dir, { key: keyOf(["verify-human"], 2) }), [], "and not again");
  assert.equal(JSON.parse(judgeReplayKey(MOUNTS)).reader, DECISION_READER_REVISION, "the production key carries the reader revision");
  assert.ok(DECISION_READER_REVISION >= 2, "W1-T14838's reader is revision 2 or later");
});

test("W1-T14841 criterion 4: stale pool figures replay the model once", async (t) => {
  const { dir } = ownedFixtureDir(t, "judge-replay-stale");
  writeFileSync(join(dir, "bakeoff-trialed.json"), JSON.stringify({ trialed: [] }));
  const key = keyOf(["verify-human"], 2);
  const old = NOW - (JUDGE_REPLAY_STALE_DAYS + 1) * DAY;
  assert.deepEqual(await pass(dir, { key, roles: ["verify-human"], now: old }), ["gpt-oss-120b"]);
  recordJudgeReplayFigures(dir, "verify-human", "cash:gpt-oss-120b",
    { corpus: "all", sent: 19, rejected: 0, medianCaseUsd: 0.0004, finishedAt: new Date(old).toISOString() });
  assert.deepEqual(await pass(dir, { key, roles: ["verify-human"], now: old + DAY }), [], "fresh figures replay nothing");
  assert.deepEqual(await pass(dir, { key, roles: ["verify-human"] }), ["gpt-oss-120b"], "figures older than the bound replay it once");
  assert.equal(readBakeoffTrialState(dir).judgeReplayedAt?.["cash:gpt-oss-120b"], new Date(NOW).toISOString());
  assert.deepEqual(await pass(dir, { key, roles: ["verify-human"], now: NOW + DAY }), [],
    "a replay that left the figures old is not bought again inside the bound");
});

test("W1-T14841 criterion 3: the ci and fix-progress judges shadow auto", () => {
  const fallback = { provider: "cash", deployment: "DeepSeek-V4-Flash" };
  assert.deepEqual(MOUNTS.ci_judge?.shadow, { provider: "auto", deployment: "auto", fallback });
  assert.deepEqual(MOUNTS.fix_progress_judge?.shadow, { provider: "auto", deployment: "auto", fallback });
  const roles = judgeShadowAutoRoles(MOUNTS);
  assert.ok(roles.includes("ci-judge") && roles.includes("fix-progress"));
});

test("W1-T14841 criterion 6: the risk judge shadows on decision-1", () => {
  const risk = MOUNTS.risk_judge!;
  assert.equal(risk.shadow?.provider, "decisions");
  assert.ok(risk.shadow?.provider === "decisions");
  assert.equal(risk.shadow.candidate.name, "systemone-eastus2");
  assert.equal(risk.shadow.deployment, "decision-1");
  assert.deepEqual({ model: risk.model, effort: risk.effort, maxTurns: risk.maxTurns, contextBudget: risk.contextBudget, provider: risk.provider },
    { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000, provider: undefined }, "only the shadow changed");
});

test("W1-T14841 criterion 5: an auto shadow with an empty pool asks its fallback arm", async () => {
  const spawned: SpawnWorkerArgs[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const spawn = (async (args: SpawnWorkerArgs) => { spawned.push(args); return { sessionId: "s", costUsd: 0.0001, numTurns: 1, text: "no_change", subtype: "success" }; }) as never;
  const decisions = (pool: JudgeShadowPoolMember[]) => ({ config: () => ({ claudeBin: "/unused", root: "/unused" }) as Config, env: {},
    learnedLimit: () => undefined, ask: async () => { throw new Error("no decision request is sent"); }, pool: () => pool });
  const base = { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000 } as JudgeMount;
  const withFallback: JudgeMount = { ...base, shadow: { provider: "auto", deployment: "auto", fallback: { provider: "cash", deployment: "DeepSeek-V4-Flash" } } };
  const request = (mount: JudgeMount) => ({ surface: "ci-judge" as const, key: "PR9@def5678", mount,
    primaryArgs: { cwd: REPO_ROOT, prompt: "judge this" } as SpawnWorkerArgs, primaryVerdict: "no_change",
    parse: (text: string) => text || undefined, agreementKey: (v: string) => v, spawn, log: (step: string, f: Record<string, unknown>) => rows.push({ step, ...f }),
    decisions: decisions([]) as ShadowJudgeCall<string>["decisions"] });
  const outcome = await runJudgeShadow(request(withFallback));
  assert.equal(outcome.kind, "paired");
  assert.equal(rows.at(-1)?.shadow_deployment, "DeepSeek-V4-Flash", "the fallback arm answered on the cash path");
  const before = spawned.length;
  assert.equal((await runJudgeShadow(request({ ...base, shadow: { provider: "auto", deployment: "auto" } }))).kind, "deferred");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, before, "an auto arm with no fallback asks nothing on an empty pool");
  // The pool path (shadowJudgeCall) falls back the same way.
  const call: ShadowJudgeCall<string> = { role: "verify-human", key: "K", mount: withFallback, input: "x",
    primaryArgs: { cwd: REPO_ROOT, prompt: "x", tools: [] } as unknown as SpawnWorkerArgs, primary: {}, primaryAnswer: "no_change",
    parse: (text) => text, agreementKey: (v) => v, spawn, log: () => {}, decisions: decisions([]) as ShadowJudgeCall<string>["decisions"] };
  await shadowJudgeCall(call);
  assert.equal(spawned.length, before + 1, "the pool path asks the fallback on an empty pool");
});

test("W1-T14841: shadow_fallback is read only beside shadow: auto and never names auto", () => {
  const table = readFileSync(mountsPath(REPO_ROOT), "utf8");
  const withCi = (rest: string) =>
    parseYaml(table.replace(/^ci_judge: .*$/m, `ci_judge: { model: haiku, effort: low, max_turns: 400, context_budget: 60000, ${rest} }`));
  for (const bad of ["shadow_fallback: gpt-oss-120b", "shadow: gpt-oss-120b, shadow_fallback: Kimi-K2.6", "shadow: auto, shadow_fallback: auto"]) {
    assert.throws(() => validateMounts(withCi(bad)), /'shadow_fallback'/, bad);
  }
  const decided = validateMounts(withCi("shadow: auto, shadow_fallback: systemone-eastus2"));
  assert.equal(decided.ci_judge?.shadow?.provider === "auto" ? decided.ci_judge.shadow.fallback?.provider : undefined, "decisions",
    "a decision model may be the fallback");
});
