import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildMeasurementCadenceDaemonHooks, measurementBakeoffDeployments } from "#test/helpers/run-task-test.js";
import { runDeploymentBakeoff, readBakeoffTrialState, type DeployedModel } from "#src/lib/bakeoff-trigger.js";
import { scoreCandidate } from "#src/lib/inbox-bakeoff.js";
import { loadProposalRegistry } from "#src/lib/inbox.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { OPENWEIGHT_PRICES, OPENWEIGHT_CONTEXT_WINDOWS, OpenWeightAllowanceExhaustedError, openWeightDeploymentReady, selectOpenWeightModel, markOpenWeightDeploymentAbsent, clearOpenWeightAbsence } from "#src/lib/worker-provider.js";
import { CASH_RESPONSES_DEPLOYMENTS } from "#src/lib/cash-responses.js";
import type { Config } from "#src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const incumbent = { id: "incumbent", label: "incumbent", model: "sonnet", billing: "subscription" as const, tools: true };
const terra: DeployedModel = { model: "gpt-6.1-terra", billing: "cash", efforts: ["low", "medium", "high"], readinessDigest: "original" };
const rowFor = (candidate: Parameters<typeof scoreCandidate>[0]) => scoreCandidate(candidate, 1, [], 0);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-cadence-bakeoff-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  return { root, stateDir, clean: () => rmSync(root, { recursive: true, force: true }) };
}

function cadenceFixture(refusal?: "fleet" | "foundry-claude", throws = false) {
  const f = fixture();
  const origin = gitRepo({ bare: true, kind: "bakeoff-origin" });
  const seed = gitRepo({ kind: "bakeoff-seed" });
  mkdirSync(join(seed.dir, "plan"));
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T1\n  title: fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  files: [src/fixture.ts]\n  acceptance: []\n  status: queued\n");
  seed.git("add", "plan/tasks.yaml");
  seed.git("commit", "-qm", "fixture plan");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const registry = join(f.stateDir, "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: [1, 2, 3].map((n) => ({ id: `P${n}`, summary: "fixture proposal", evidenceAnchors: [] })) }));
  const calls: SpawnWorkerArgs[] = [];
  const rawSpawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    calls.push(args);
    const refused = refusal && args.mountProvider === "cash" &&
      (refusal === "fleet" || args.routingTrial?.models?.some((model) => model.startsWith("claude-")));
    if (refused && throws) throw new OpenWeightAllowanceExhaustedError({ limit: refusal, committedUsd: 5, capUsd: 5, wantUsd: 0.1, utcDay: new Date().toISOString().slice(0, 10) });
    return { sessionId: "fixture", costUsd: refused ? 0.012 : 0, numTurns: 0, text: "", blocks: [], stderr: "", isError: true,
      apiError: false, permissionDenials: [], childEnvKeys: [], model: args.model ?? "default", effort: args.effort ?? "default",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
      subtype: refused ? "cash_allowance_exhausted" : "success", budgetRefused: !!refused,
      ...(refused ? { cashAllowanceLimit: refusal } : {}) };
  };
  const hooks = () => buildMeasurementCadenceDaemonHooks({
    config: { root: f.root, installRoot: REPO_ROOT, claudeBin: "/bin/true" } as Config,
    policy: { values: { measurementCadence: { escalate: false } } } as never,
    creditedMergedIds: () => new Set(),
    verifyHumanCadenceResult: async () => ({ status: "clear" }) as never,
    successorWatch: async () => ({}) as never,
    measurementReport: async () => ({}) as never,
    proofDebtInput: () => undefined,
    bakeoff: { rawSpawn, repoClone: (args) => { seed.git("clone", "-q", origin.dir, args.at(-1)!); } },
  });
  return { ...f, registry, calls, hooks, clean: () => { f.clean(); seed.cleanup(); origin.cleanup(); } };
}

test("W1-T10840: the measurement cadence runs the deployment bake-off once for an untrialed deployment", async () => {
  const f = cadenceFixture();
  try {
    await f.hooks().runMeasurementCadence();
    const first = f.calls.length;
    assert.ok(first > 0);
    const trials = f.calls.filter((call) => call.routingTrial?.models?.includes("gpt-6.1-terra"));
    assert.deepEqual([...new Set(trials.map((call) => call.effort))], ["low", "medium", "high"]);
    assert.ok(trials.every((call) => call.onSelectionAssignment === undefined && call.mountProvider === "cash"));
    assert.ok(readBakeoffTrialState(f.stateDir).readinessDigests?.["cash:gpt-6.1-terra"]);
    await f.hooks().runMeasurementCadence();
    assert.equal(f.calls.length, first);
    const mounts = loadMounts(mountsPath(REPO_ROOT));
    assert.equal(f.calls[0].model, mounts.synthesis.inbox_draft.model);
    assert.equal(f.calls[0].effort, mounts.synthesis.inbox_draft.effort);
    for (const call of trials) {
      const selected = selectOpenWeightModel(mounts.capabilities, call.model, call.effort, Buffer.byteLength(call.prompt), { only: call.routingTrial!.models });
      assert.equal(selected.model, "gpt-6.1-terra");
      assert.equal(selected.effort, call.effort);
    }
    const models = measurementBakeoffDeployments(mounts);
    assert.ok(models.some((m) => m.billing === "cash" && m.model === "gpt-6.1-terra"));
    assert.ok(models.filter((m) => m.billing === "cash").every((m) => openWeightDeploymentReady(m.model)));
    assert.deepEqual(new Set(models.filter((m) => m.billing === "subscription").map((m) => m.model)),
      new Set(Object.values(mounts.capabilities!.claudeCandidates!).flat()));
    markOpenWeightDeploymentAbsent(terra.model);
    try {
      assert.ok(!measurementBakeoffDeployments(mounts).some((model) => model.model === terra.model),
        "a deployment known absent cannot buy a cadence trial");
    } finally { clearOpenWeightAbsence(); }
  } finally { f.clean(); }
});

test("W1-T10840: a changed deployment is trialed again", async () => {
  const f = fixture();
  let replays = 0;
  const mounts = loadMounts(mountsPath(REPO_ROOT));
  const price = OPENWEIGHT_PRICES[terra.model];
  const oldPrice = price.inputUsdPerMillion;
  const input = () => ({ stateDir: f.stateDir, incumbent,
    deployed: measurementBakeoffDeployments(mounts).filter((m) => m.model === terra.model),
    replay: async (candidates: readonly Parameters<typeof scoreCandidate>[0][]) => { replays++; return candidates.map(rowFor); } });
  try {
    const [first] = await runDeploymentBakeoff(input());
    const original = readBakeoffTrialState(f.stateDir).readinessDigests?.["cash:gpt-6.1-terra"];
    price.inputUsdPerMillion++;
    const [second] = await runDeploymentBakeoff(input());
    assert.equal(replays, 2);
    assert.notEqual(second.id, first.id);
    assert.notEqual(readBakeoffTrialState(f.stateDir).readinessDigests?.["cash:gpt-6.1-terra"], original);
    await runDeploymentBakeoff(input());
    assert.equal(replays, 2);
    const context = OPENWEIGHT_CONTEXT_WINDOWS[terra.model];
    const contexts = OPENWEIGHT_CONTEXT_WINDOWS as Record<string, typeof context>;
    const responses = CASH_RESPONSES_DEPLOYMENTS as Record<string, readonly string[]>;
    const allowed = responses[terra.model];
    try {
      contexts[terra.model] = { ...context, totalTokens: context.totalTokens + 1 };
      await runDeploymentBakeoff(input());
      assert.equal(replays, 3);
      responses[terra.model] = ["low", "high"];
      await runDeploymentBakeoff(input());
      assert.equal(replays, 4);
      contexts[terra.model] = context;
      responses[terra.model] = allowed;
      price.inputUsdPerMillion = oldPrice;
      const [reverted] = await runDeploymentBakeoff(input());
      assert.equal(replays, 5);
      assert.notEqual(reverted.id, first.id, "a return to earlier readiness still publishes its newly bought trial");
      assert.equal(loadProposalRegistry(join(f.stateDir, "inbox-proposals.json")).length, 5);
    } finally { contexts[terra.model] = context; responses[terra.model] = allowed; }
  } finally { price.inputUsdPerMillion = oldPrice; f.clean(); }
});

test("W1-T10840: first wiring seeds measured models and trials only the rest", async () => {
  const f = fixture();
  const old = { ...terra, model: "gpt-5-nano" };
  const history = JSON.stringify({ step: "inbox.bakeoff", candidate: "cash-gpt-5-nano", billing: "cash" });
  writeFileSync(join(f.stateDir, "ledger.1.ndjson.gz"), gzipSync(history + "\n"));
  writeFileSync(join(f.stateDir, "ledger.2.ndjson"), JSON.stringify({ step: "inbox.bakeoff", candidate: "subscription-claude-sonnet-5-5", billing: "subscription" }) + "\n");
  writeFileSync(join(f.stateDir, "ledger.ndjson"), JSON.stringify({ step: "other", candidate: "cash-gpt-6.1-terra" }) + "\n");
  let measured: string[] = [];
  try {
    await runDeploymentBakeoff({ stateDir: f.stateDir, incumbent, deployed: [old, terra,
      { model: "claude-sonnet-5-5", billing: "subscription", efforts: ["low"] }],
      replay: async (candidates) => { measured = candidates.slice(1).map((c) => c.model); return candidates.map(rowFor); } });
    assert.deepEqual(measured, [terra.model, terra.model, terra.model]);
    const state = readBakeoffTrialState(f.stateDir);
    assert.ok(state.trialed.includes("cash:gpt-5-nano"));
    assert.equal(state.readinessDigests?.["cash:gpt-5-nano"], old.readinessDigest);
    assert.ok(state.trialed.includes("subscription:claude-sonnet-5-5"));
  } finally { f.clean(); }
});

test("W1-T10840: an allowance refusal stops the candidate and reports a partial table", async () => {
  for (const [limit, throws] of [["fleet", false], ["foundry-claude", false], ["fleet", true], ["foundry-claude", true]] as const) {
    const f = cadenceFixture(limit, throws);
    try {
      await f.hooks().runMeasurementCadence();
      const ids = f.calls.filter((call) => call.mountProvider === "cash" &&
        (limit === "fleet" || call.routingTrial?.models?.some((model) => model.startsWith("claude-"))))
        .map((call) => call.routingTrial?.reason ?? call.model);
      assert.ok(ids.length > 0, "the refusal fixture reaches an eligible cash deployment");
      assert.equal(new Set(ids).size, ids.length, "a refusal never buys another proposal or relint for that candidate");
      const proposal = loadProposalRegistry(f.registry).find((p) => p.id.startsWith("bakeoff:"));
      assert.ok(proposal);
      assert.match(proposal.summary, /PARTIAL/);
      assert.ok(proposal.summary.includes(limit));
      const rows = readFileSync(join(f.stateDir, "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(rows.some((row) => row.step === "inbox.bakeoff" && row.refusal === limit && row.status === "partial"));
      assert.ok(rows.filter((row) => row.step === "inbox.bakeoff" && row.refusal === limit)
        .every((row) => row.cashUsd === (throws ? 0 : 0.012)), "a stopped proposal cannot count the previous call's spend twice");
      const count = f.calls.length;
      await f.hooks().runMeasurementCadence();
      assert.equal(f.calls.length, count);
    } finally { f.clean(); }
  }
});

test("W1-T10840: the bake-off files a proposal and never changes routing", async () => {
  const f = cadenceFixture();
  const mountBytes = readFileSync(mountsPath(REPO_ROOT), "utf8");
  const paths = ["mounts.yaml", "routing.json", "selection-store.json"].map((name) => join(f.stateDir, name));
  paths.forEach((path) => writeFileSync(path, "sentinel"));
  try {
    await f.hooks().runMeasurementCadence();
    const proposals = loadProposalRegistry(f.registry).filter((p) => p.id.startsWith("bakeoff:"));
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].summary, /\| rank \| candidate/);
    assert.ok(f.calls.every((call) => call.onSelectionAssignment === undefined));
    assert.ok(readFileSync(join(f.stateDir, "ledger.ndjson"), "utf8").includes('"step":"inbox.bakeoff"'));
    assert.equal(readFileSync(mountsPath(REPO_ROOT), "utf8"), mountBytes);
    paths.forEach((path) => assert.equal(readFileSync(path, "utf8"), "sentinel"));
  } finally { f.clean(); }
});

test("incomplete bake-off ledger history refuses before buying a trial", async () => {
  const f = fixture();
  writeFileSync(join(f.stateDir, "ledger.1.ndjson.gz"), "unreadable gzip");
  let replays = 0;
  try {
    await assert.rejects(runDeploymentBakeoff({ stateDir: f.stateDir, incumbent, deployed: [terra],
      replay: async () => { replays++; return []; } }), /ledger history is unreadable/);
    assert.equal(replays, 0);
  } finally { f.clean(); }
});

test("legacy trial keys acquire readiness digests without another paid trial", async () => {
  const f = fixture();
  const path = join(f.stateDir, "bakeoff-trialed.json");
  writeFileSync(path, JSON.stringify({ trialed: ["cash:gpt-6.1-terra"] }));
  let replays = 0;
  try {
    await runDeploymentBakeoff({ stateDir: f.stateDir, incumbent, deployed: [terra],
      replay: async () => { replays++; return []; } });
    assert.equal(replays, 0);
    assert.equal(readBakeoffTrialState(f.stateDir).readinessDigests?.["cash:gpt-6.1-terra"], "original");
    writeFileSync(path, JSON.stringify({ trialed: [], readinessDigests: { "cash:gpt-6.1-terra": 42 } }));
    assert.throws(() => readBakeoffTrialState(f.stateDir), /trial history is unreadable/);
  } finally { f.clean(); }
});

test("an empty inbox defers trials but still recovers an interrupted report", async () => {
  const f = cadenceFixture();
  try {
    writeFileSync(f.registry, JSON.stringify({ proposals: [] }));
    await f.hooks().runMeasurementCadence();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(readBakeoffTrialState(f.stateDir).trialed, []);
    writeFileSync(join(f.stateDir, "bakeoff-trialed.json"), JSON.stringify({
      trialed: ["cash:gpt-6.1-terra"], pending: { id: "bakeoff:interrupted", models: ["cash:gpt-6.1-terra"] },
    }));
    await f.hooks().runMeasurementCadence();
    assert.equal(f.calls.length, 0);
    assert.match(loadProposalRegistry(f.registry)[0].summary, /interrupted/);
    assert.equal(readBakeoffTrialState(f.stateDir).pending, undefined);
  } finally { f.clean(); }
});
