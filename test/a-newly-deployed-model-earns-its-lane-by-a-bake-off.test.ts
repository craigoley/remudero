import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findUntrialedModels, deploymentCandidates, runDeploymentBakeoff, type DeployedModel } from "../src/lib/bakeoff-trigger.js";
import { bakeoffSpawnArgs, scoreCandidate, type BakeoffCandidate } from "../src/lib/inbox-bakeoff.js";
import { loadProposalRegistry } from "../src/lib/inbox.js";
import { openWeightThinkingLevels, selectOpenWeightModel } from "../src/lib/worker-provider.js";

const deployed: DeployedModel[] = [
  { model: "gpt-5-nano", billing: "cash", efforts: ["low", "medium", "high"] },
  { model: "claude-sonnet-5-5", billing: "subscription", efforts: ["low", "medium", "high"] },
];
const incumbent: BakeoffCandidate = { id: "incumbent", label: "incumbent", model: "gpt-oss-120b", billing: "cash", tools: true, effort: "medium" };
const rowsFor = (candidates: readonly BakeoffCandidate[]) => candidates.map((c) => scoreCandidate(c, 1, [
  { step: "inbox.draft_synthesized", extra: { cost_usd: c.billing === "cash" ? 0.01 : 0.5 } },
  { step: "inbox.drafted", extra: { lint_clean: true } },
], 10));
function fixture() { return mkdtempSync(join(tmpdir(), "rmd-deployment-bakeoff-")); }

test("W1-T4926: a newly deployed model is trialed once and never on a timer", async () => {
  const stateDir = fixture();
  let calls = 0;
  const replay = async (candidates: readonly BakeoffCandidate[]) => { calls++; return rowsFor(candidates); };
  try {
    const input = { stateDir, deployed, incumbent, replay };
    assert.equal((await runDeploymentBakeoff(input)).length, 1);
    assert.equal((await runDeploymentBakeoff(input)).length, 0);
    assert.equal(calls, 1);
    const more = [...deployed, { model: "new-model", billing: "subscription" as const, efforts: ["high"] }];
    await runDeploymentBakeoff({ ...input, deployed: more });
    assert.equal(calls, 2);
    assert.deepEqual(findUntrialedModels(deployed, ["cash:gpt-5-nano"]), [deployed[1]]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("W1-T4926: the trial covers every thinking level the model accepts", () => {
  const candidates = deploymentCandidates(deployed, incumbent);
  assert.deepEqual(candidates.map((c) => [c.model, c.effort]), [
    ["gpt-oss-120b", "medium"],
    ...["low", "medium", "high"].map((effort) => ["gpt-5-nano", effort]),
    ...["low", "medium", "high"].map((effort) => ["claude-sonnet-5-5", effort]),
  ]);
  assert.deepEqual(openWeightThinkingLevels("gpt-6-luna", true), ["none"]);
  assert.deepEqual(openWeightThinkingLevels("gpt-6-luna", false), ["low", "medium", "high"]);
  assert.deepEqual(openWeightThinkingLevels("gpt-6.1-sol", true), ["low", "medium", "high", "xhigh", "max"]);
  assert.throws(() => openWeightThinkingLevels("unpriced", true), /thinking levels/);
  for (const candidate of candidates) {
    const args = bakeoffSpawnArgs(candidate, { cwd: "/tmp", permissionMode: "bypassPermissions", settingsFile: "/tmp/settings.json", prompt: "measure", model: "sonnet", effort: "medium", tools: ["Read"], mountProvider: "cash" });
    assert.equal(args.effort, candidate.effort);
    assert.equal(args.mountProvider, candidate.billing === "cash" ? "cash" : "claude");
    assert.equal(args.model, candidate.billing === "cash" ? "sonnet" : candidate.model);
    assert.equal(args.onSelectionAssignment, undefined);
    assert.equal(args.draftRouting, undefined);
    if (candidate.billing === "cash") assert.deepEqual(args.routingTrial?.models, [candidate.model]);
  }
});

test("W1-T4926: the result is one proposal with the ranked table, and routing is unchanged", async () => {
  const stateDir = fixture();
  const mount = { model: "sonnet", effort: "medium", provider: "cash" };
  const routingPath = join(stateDir, "mounts.yaml");
  writeFileSync(routingPath, JSON.stringify(mount));
  try {
    await runDeploymentBakeoff({ stateDir, deployed, incumbent, replay: async (c) => rowsFor(c) });
    const proposals = loadProposalRegistry(join(stateDir, "inbox-proposals.json"));
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].summary, /\| rank \| candidate/);
    assert.match(proposals[0].summary, /gpt-5-nano.*high/);
    assert.match(proposals[0].summary, /notional \(subscription\)/);
    assert.match(proposals[0].summary, /contract errors/);
    assert.deepEqual(JSON.parse(readFileSync(routingPath, "utf8")), mount);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("a bake-off pins a priced model outside the routing ladder", () => {
  const picked = selectOpenWeightModel(undefined, "sonnet", "high", 100, { bakeoffModel: "gpt-6.1-sol" });
  assert.equal(picked.model, "gpt-6.1-sol");
  assert.deepEqual(picked.alternatives, []);
  assert.throws(() => selectOpenWeightModel(undefined, "sonnet", "high", 100, { bakeoffModel: "unknown" }), /no safe deployment/);
});

test("overlapping sweeps do not spend twice and a failed trial does not retry on cadence", async () => {
  const stateDir = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  try {
    const input = { stateDir, deployed, incumbent, replay: async () => { calls++; await blocked; throw new Error("account unavailable"); } };
    const first = runDeploymentBakeoff(input);
    assert.deepEqual(await runDeploymentBakeoff(input), []);
    release();
    await first;
    await runDeploymentBakeoff(input);
    assert.equal(calls, 1);
    const proposals = loadProposalRegistry(join(stateDir, "inbox-proposals.json"));
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].summary, /account unavailable/);
    assert.doesNotMatch(proposals[0].summary, /\| rank/);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("unreadable trial history refuses before spending", async () => {
  const stateDir = fixture();
  try {
    writeFileSync(join(stateDir, "bakeoff-trialed.json"), "{}");
    await assert.rejects(runDeploymentBakeoff({ stateDir, deployed, incumbent, replay: async () => { assert.fail("must not spend"); } }), /trial history/);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("an interrupted trial reports once without buying a replay", async () => {
  const stateDir = fixture();
  try {
    writeFileSync(join(stateDir, "bakeoff-trialed.json"), JSON.stringify({
      trialed: deployed.map((m) => `${m.billing}:${m.model}`),
      pending: { id: "bakeoff:interrupted", models: ["cash:gpt-5-nano"] },
    }));
    const input = { stateDir, deployed, incumbent, replay: async () => { assert.fail("must not replay an interrupted trial"); } };
    await runDeploymentBakeoff(input);
    await runDeploymentBakeoff(input);
    const proposals = loadProposalRegistry(join(stateDir, "inbox-proposals.json"));
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].summary, /interrupted/);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("the full-sweep production composition replays the same sample at pinned efforts", async () => {
  const root = fixture();
  const repoRoot = join(import.meta.dirname, "..");
  const argv = [...process.argv];
  // Explicit root keeps the CLI module import from shelling a repository-location probe.
  process.argv.push("--repo-root", repoRoot);
  const { deploymentBakeoffInput } = await import("../src/run-task.js");
  process.argv.splice(0, process.argv.length, ...argv);
  const { mkdirSync } = await import("node:fs");
  const { runSweepBakeoff } = await import("../src/lib/sweep.js");
  const { OPENWEIGHT_PRICES } = await import("../src/lib/worker-provider.js");
  const seen: { effort?: string; model?: string; tools?: string[]; mountProvider?: string }[] = [];
  const log = () => {};
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "repos", "fixture", "plan"), { recursive: true });
    writeFileSync(join(root, "repos", "fixture", "plan", "tasks.yaml"), "- id: W1-T1\n");
    const registry = join(root, "state", "inbox-proposals.json");
    writeFileSync(registry, JSON.stringify({ proposals: [{ id: "P1", summary: "fixture proposal", evidenceAnchors: [] }] }));
    const config = { claudeBin: "/unused", root, installRoot: repoRoot, dailyCapUsd: 5,
      workerProviders: { enabled: ["cash", "claude"] } } as import("../src/lib/config-schema.js").Config;
    const input = deploymentBakeoffInput("owner", "fixture", config, "fixture", log, () => true, async (args) => {
      seen.push(args);
      assert.ok(args.prompt.includes("fixture proposal"));
      assert.equal(args.onSelectionAssignment, undefined);
      return { sessionId: "s", costUsd: 0.01, numTurns: 1, text: "prose", blocks: [], stderr: "", subtype: "success",
        isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: args.model!, effort: args.effort!,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
    });
    assert.ok(input);
    assert.deepEqual(input.deployed.filter((m) => m.billing === "cash").map((m) => m.model), Object.keys(OPENWEIGHT_PRICES));
    await runSweepBakeoff(input);
    const count = seen.length;
    assert.equal(count, deploymentCandidates(input.deployed, input.incumbent).length);
    assert.ok(seen.some((args) => args.model === "claude-opus-5-5" && args.effort === "high"));
    assert.ok(seen.every((args) => args.tools?.every((tool) => ["Read", "Grep", "Glob"].includes(tool))));
    await runSweepBakeoff(input);
    assert.equal(seen.length, count);
    assert.equal(loadProposalRegistry(registry).filter((p) => p.id.startsWith("bakeoff:")).length, 1);
    writeFileSync(registry, JSON.stringify({ proposals: [] }));
    // Also remove the shard mirror so the sample is empty.
    rmSync(join(root, "state", "inbox-proposals.d"), { recursive: true, force: true });
    assert.equal(deploymentBakeoffInput("owner", "fixture", config, "fixture", log, () => true), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed proposal write recovers the completed table without another paid replay", async () => {
  const stateDir = fixture();
  const { mkdirSync } = await import("node:fs");
  const registry = join(stateDir, "inbox-proposals.json");
  let calls = 0;
  try {
    mkdirSync(registry);
    const input = { stateDir, deployed, incumbent, replay: async (c: readonly BakeoffCandidate[]) => { calls++; return rowsFor(c); } };
    await assert.rejects(runDeploymentBakeoff(input));
    rmSync(registry, { recursive: true, force: true });
    await runDeploymentBakeoff(input);
    await runDeploymentBakeoff(input);
    assert.equal(calls, 1);
    const proposals = loadProposalRegistry(registry);
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].summary, /\| rank \| candidate/);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
