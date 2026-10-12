import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findUntrialedModels, deploymentCandidates, runDeploymentBakeoff, type DeployedModel, type DeploymentBakeoffCandidate } from "../src/lib/bakeoff-trigger.js";
import { scoreCandidate } from "../src/lib/inbox-bakeoff.js";
import { loadProposalRegistry } from "../src/lib/inbox.js";
import { runSweepBakeoff } from "./helpers/sweep-test.js";

const deployed: DeployedModel[] = [
  { model: "gpt-5-nano", billing: "cash", efforts: ["low", "medium", "high"] },
  { model: "claude-sonnet-5-5", billing: "subscription", efforts: ["low", "medium", "high"] },
];
const incumbent: DeploymentBakeoffCandidate = { id: "incumbent", label: "incumbent", model: "gpt-oss-120b", billing: "cash", tools: true, effort: "medium" };
const rowsFor = (candidates: readonly DeploymentBakeoffCandidate[]) => candidates.map((c) => scoreCandidate(c, 1, [
  { step: "inbox.draft_synthesized", extra: { cost_usd: c.billing === "cash" ? 0.01 : 0.5 } },
  { step: "inbox.drafted", extra: { lint_clean: true } },
], 10));
function fixture() { return mkdtempSync(join(tmpdir(), "rmd-deployment-bakeoff-")); }

test("W1-T4926: a newly deployed model is trialed once and never on a timer", async () => {
  const stateDir = fixture();
  let calls = 0;
  const replay = async (candidates: readonly DeploymentBakeoffCandidate[]) => { calls++; return rowsFor(candidates); };
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
  assert.ok(candidates.every((candidate) => candidate.tools), "each deployed effort is an independently measured lane");
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

test("the full-sweep rung invokes the deployment trigger only while a model remains untrialed", async () => {
  const stateDir = fixture();
  let calls = 0;
  try {
    const input = { stateDir, deployed, incumbent, replay: async (candidates: readonly DeploymentBakeoffCandidate[]) => {
      calls++;
      return rowsFor(candidates);
    } };
    await runSweepBakeoff(input);
    await runSweepBakeoff(input);
    assert.equal(calls, 1);
    assert.equal(loadProposalRegistry(join(stateDir, "inbox-proposals.json")).length, 1);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("a failed proposal write recovers the completed table without another paid replay", async () => {
  const stateDir = fixture();
  const { mkdirSync } = await import("node:fs");
  const registry = join(stateDir, "inbox-proposals.json");
  let calls = 0;
  try {
    mkdirSync(registry);
    const input = { stateDir, deployed, incumbent, replay: async (c: readonly DeploymentBakeoffCandidate[]) => { calls++; return rowsFor(c); } };
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
