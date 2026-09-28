/**
 * W1-T4645 — a judge lane names its run.
 *
 * OBSERVED 2026-09-28 by the W1-T4639 build: the verify-human judge and the escalation judge passed
 * no task or run id into their spawn arguments, so every receipt they wrote read
 * `<lane>-unassigned` (or `<lane>-<assignment>`) under the lane's own upper-cased name, and joined no
 * task. This suite drives both lanes through the production composition — the lane's receipt
 * wrapper over `receiptIdentityOnly` — with a fake router standing where the real one stands, and
 * pins: every assignment and attempt receipt names the judged task and one per-decision run; and
 * the router is handed exactly the arguments it had before, so the provider, model and effort it
 * selects are identical with and without the new fields.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { benchmarkNonDispatchSpawn } from "../src/lib/benchmark-run.js";
import type { Config } from "../src/lib/config.js";
import { buildEscalationJudgeSpawnArgs, escalationJudgeRunId, spawnEscalationJudgeWorker, type Escalation } from "../src/lib/escalate.js";
import type { Mount, Mounts } from "../src/lib/mounts.js";
import { selectWorkerProviderForPolicy, type EffectiveProviderRoutingPolicy } from "../src/lib/provider-routing-policy.js";
import { shadowJudgeSampled } from "../src/lib/shadow-judge.js";
import {
  buildVerifyHumanJudgeSpawnArgs,
  receiptIdentityOnly,
  spawnVerifyHumanJudgeWorker,
  verifyHumanJudgeRunId,
  type ShardUnderJudgement,
} from "../src/lib/verify-human-judge.js";
import type { ProviderCapacity } from "../src/lib/worker-provider.js";
import {
  auctionDrawSeed,
  workerSelectionAssignment,
  type spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "../src/lib/worker.js";
import { shadowedVerifyHumanJudge } from "../src/run-task.js";

type Row = { step: string } & Record<string, unknown>;

const MOUNT: Mount = { model: "sonnet", effort: "low", maxTurns: 4, contextBudget: 8_000 };

const SHARD: ShardUnderJudgement = {
  id: "W1-T9101", title: "a parked shard", rationale: "r", acceptance: ["a"], ageDays: 3,
  depsAllMerged: true, citedInSrc: false,
};

const ESCALATION = {
  class: "BLOCKED", taskId: "W1-T9102", summary: "s", detail: "d",
  options: [{ label: "retry", consequence: "the fix rung runs again" }], recommendation: "retry",
} as unknown as Escalation;

function assignment(id: string): WorkerSelectionAssignment {
  return {
    version: 1, id, phase: "pre-execution",
    requested: { model: "sonnet", effort: "low", maxTurns: 4 },
    selected: { provider: "claude", model: "claude-sonnet-5", effort: "low" },
    routing: { mode: "claude-only", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
    candidates: [],
  } as unknown as WorkerSelectionAssignment;
}

function worker(text: string, assignmentId: string): WorkerResult {
  return {
    sessionId: "session-4645", costUsd: 0.01, numTurns: 1, text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    provider: "claude", model: "claude-sonnet-5", servedModel: "claude-sonnet-5", effort: "low",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, workerDurationMs: 30,
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, selectionAssignmentId: assignmentId,
  };
}

function rowsAt(root: string): Row[] {
  const path = join(root, "state", "ledger.ndjson");
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row)
    : [];
}

/** Stands where the real router stands: reports an assignment, as `spawnWorker` does, and keeps
 *  the args it was handed. `assignmentId` undefined throws before any assignment is written. */
function router(seen: SpawnWorkerArgs[], assignmentId: string | undefined, text: string): typeof spawnWorker {
  return async (args) => {
    seen.push(args);
    if (assignmentId === undefined) throw new Error("configuration file not found");
    args.onSelectionAssignment?.(assignment(assignmentId));
    return worker(text, assignmentId);
  };
}

/** The production composition, with this fixture's config named explicitly: an un-configured
 *  receipt under the test runner is never written, and the live ledger is never a test's to write. */
function lane(name: string, raw: typeof spawnWorker, config: Config): typeof spawnWorker {
  return (args) => benchmarkNonDispatchSpawn(name, receiptIdentityOnly(raw))({ ...args, config });
}

function assertNamesItsRun(rows: Row[], lanes: string[], taskId: string, runId: string): void {
  assert.ok(rows.length > 0, "positive control: the fixture ledger holds the lane's receipts");
  assert.deepEqual([...new Set(rows.map((row) => row.lane))].sort(), [...lanes].sort());
  for (const row of rows) {
    assert.equal(row.task_id, taskId, `${row.lane} ${row.step} joins its judged task`);
    assert.equal(row.run_id, runId, `${row.lane} ${row.step} names its decision's run`);
    assert.doesNotMatch(String(row.run_id), /unassigned/);
  }
}

function withRoot<T>(body: (root: string, config: Config) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4645-"));
  return body(root, { root } as Config).finally(() => rmSync(root, { recursive: true, force: true }));
}

const VERDICT = "VERIFY_HUMAN_DECISION: backlog\nVERIFY_HUMAN_REASON: dependencies are not merged";

test("W1-T4645: a verify-human judge receipt names its judged task and its decision's run", async () => {
  await withRoot(async (root, config) => {
    const seen: SpawnWorkerArgs[] = [];
    await spawnVerifyHumanJudgeWorker({ shard: SHARD, mount: MOUNT, cwd: root, settingsFile: "s.json",
      spawn: lane("verify-human-judge", router(seen, "asg-vh-1", VERDICT), config) });
    await assert.rejects(spawnVerifyHumanJudgeWorker({ shard: SHARD, mount: MOUNT, cwd: root, settingsFile: "s.json",
      spawn: lane("verify-human-judge", router(seen, undefined, VERDICT), config) }));

    const rows = rowsAt(root);
    assert.deepEqual(rows.map((row) => row.step), ["worker.assignment", "worker.attempt", "worker.attempt"]);
    assertNamesItsRun(rows, ["verify-human-judge"], SHARD.id, verifyHumanJudgeRunId(SHARD));
    assert.equal(rows[1]!.selection_assignment_id, "asg-vh-1", "the join to the assignment is kept");
    assert.equal(rows[2]!.selection_assignment_unavailable_reason, "spawn-threw-before-assignment");
    for (const args of seen) assert.equal("taskId" in args || "runId" in args, false, "the router never sees either id");
  });
});

test("W1-T4645: an escalation judge receipt names its judged task and its decision's run", async () => {
  await withRoot(async (root, config) => {
    const seen: SpawnWorkerArgs[] = [];
    const text = "ESCALATION_JUDGE_DECISION: deliver\nESCALATION_JUDGE_REASON: needs the operator";
    await spawnEscalationJudgeWorker({ escalation: ESCALATION, mount: MOUNT, cwd: root, settingsFile: "s.json",
      spawn: lane("escalation-summary", router(seen, "asg-esc-1", text), config) });
    await assert.rejects(spawnEscalationJudgeWorker({ escalation: ESCALATION, mount: MOUNT, cwd: root, settingsFile: "s.json",
      spawn: lane("escalation-summary", router(seen, undefined, text), config) }));

    const rows = rowsAt(root);
    assert.deepEqual(rows.map((row) => row.step), ["worker.assignment", "worker.attempt", "worker.attempt"]);
    assertNamesItsRun(rows, ["escalation-summary"], ESCALATION.taskId, escalationJudgeRunId(ESCALATION));
    assert.equal(rows[1]!.selection_assignment_id, "asg-esc-1");
    for (const args of seen) assert.equal("taskId" in args || "runId" in args, false, "the router never sees either id");
  });
});

test("W1-T4645: each judge decision gets its own run id, and a re-ask of one decision keeps it", () => {
  assert.equal(verifyHumanJudgeRunId(SHARD), verifyHumanJudgeRunId({ ...SHARD, ageDays: 9 }),
    "one observed state is one decision, however old the shard grows");
  assert.notEqual(verifyHumanJudgeRunId(SHARD), verifyHumanJudgeRunId({ ...SHARD, citedInSrc: true }));
  assert.notEqual(verifyHumanJudgeRunId(SHARD), verifyHumanJudgeRunId({ ...SHARD, id: "W1-T9103" }));
  assert.match(verifyHumanJudgeRunId(SHARD), /^verify-human-judge-W1-T9101-[0-9a-f]{12}$/);
  assert.equal(escalationJudgeRunId(ESCALATION), escalationJudgeRunId({ ...ESCALATION }));
  assert.notEqual(escalationJudgeRunId(ESCALATION), escalationJudgeRunId({ ...ESCALATION, detail: "another cause" }));
  assert.match(escalationJudgeRunId(ESCALATION), /^escalation-summary-W1-T9102-[0-9a-f]{12}$/);
});

// ─── routing is unchanged ───────────────────────────────────────────────────────────────────────

const POLICY: EffectiveProviderRoutingPolicy = {
  provenance: "default",
  committed: { enabledProviders: ["claude", "codex"], preference: "automatic", reservePercent: 5, parks: [], codexModelPreference: null },
  enabledProviders: ["claude", "codex"],
  routableProviders: ["claude", "codex"],
  preference: "automatic",
  reservePercent: 5,
  parks: [],
};

function capacity(provider: "claude" | "codex", usedPercent: number): ProviderCapacity {
  return { provider, readable: true, windows: [{ name: `${provider} weekly`, usedPercent }] };
}

/** The router's own auction over two equally-eligible providers, keyed exactly as `spawnWorker`
 *  keys it, and the assignment it would record: what was selected, and any experiment arm. */
function routedSelection(args: SpawnWorkerArgs, capability: "balanced" | undefined) {
  const capacities = [capacity("claude", 40), capacity("codex", 40)];
  const seed = auctionDrawSeed(args, POLICY, capacities, capability);
  const selection = selectWorkerProviderForPolicy(capacities, POLICY, seed).selection;
  const recorded = workerSelectionAssignment(args, {
    provider: selection.provider, model: selection.capacity.model, effort: selection.capacity.effort,
    capacity: selection.capacity, capacities, mode: "multi-provider", selectionPath: "auction",
    policy: POLICY, selection, ...(capability ? { capability } : {}),
  });
  return { seed, selected: recorded.selected, experiment: recorded.routing.experiment };
}

async function argsTheRouterSees(args: SpawnWorkerArgs): Promise<SpawnWorkerArgs> {
  const seen: SpawnWorkerArgs[] = [];
  await receiptIdentityOnly(router(seen, "asg-route", VERDICT))(args);
  assert.equal(seen.length, 1);
  return seen[0]!;
}

test("W1-T4645: the router selects the same provider, model and effort with and without the new fields", async () => {
  const cases: Array<[string, () => SpawnWorkerArgs]> = [
    ["verify-human-judge", () => buildVerifyHumanJudgeSpawnArgs({ shard: SHARD, mount: MOUNT, cwd: "/w", settingsFile: "s.json" })],
    ["escalation-summary", () => buildEscalationJudgeSpawnArgs({ escalation: ESCALATION, mount: MOUNT, cwd: "/w", settingsFile: "s.json" })],
  ];
  for (const [name, build] of cases) {
    const withFields = build();
    const { taskId, runId, ...before } = withFields;
    assert.ok(taskId && runId, `${name}: the lane now names its task and run`);
    const routed = await argsTheRouterSees(withFields);
    assert.deepEqual(routed, before, `${name}: the router is handed exactly what it had before`);
    for (const capability of [undefined, "balanced"] as const) {
      const now = routedSelection(routed, capability);
      const then = routedSelection(before as SpawnWorkerArgs, capability);
      assert.deepEqual(now.selected, then.selected, `${name}/${capability}: same provider, model and effort`);
      assert.deepEqual(now.experiment, then.experiment, `${name}/${capability}: same experiment arm`);
      assert.deepEqual(now.seed, then.seed);
      // Control: had the ids reached the router, its draw would be keyed differently.
      assert.notDeepEqual(routedSelection(withFields, capability).seed, then.seed,
        `${name}/${capability}: the ids are routing inputs, so dropping them is load-bearing`);
    }
  }
});

test("W1-T4645: the verify-human primary and its shadow judge join one task and one run", async () => {
  await withRoot(async (root, config) => {
    const shardId = Array.from({ length: 200 }, (_, i) => `W1-T${9200 + i}`)
      .find((id) => shadowJudgeSampled(`verify-human:${id}:deps=0:cited=0`));
    assert.ok(shardId, "some shard id is sampled for a shadow judgement");
    const shard: ShardUnderJudgement = { ...SHARD, id: shardId, depsAllMerged: false, citedInSrc: false };
    const primaryMount: Mount = { model: "judge-model", effort: "low", maxTurns: 12, contextBudget: 4_000 };
    const shadowMount: Mount = { model: "review-model", effort: "low", maxTurns: 20, contextBudget: 8_000 };
    const mounts = {
      tiers: { "judge-model": 1, "review-model": 2 }, efforts: { low: 1 },
      architect: primaryMount, judge: primaryMount, verify_human_judge: primaryMount, synthesis: {},
      routes: { reviewer: { low: { src: shadowMount } } },
    } as unknown as Mounts;
    const seen: SpawnWorkerArgs[] = [];
    const judge = shadowedVerifyHumanJudge({
      mounts, config, cwd: root, settingsFile: join(root, "settings.json"),
      spawns: {
        primary: lane("verify-human-judge", router(seen, "asg-primary", VERDICT), config),
        shadow: lane("verify-human-shadow", router(seen, "asg-shadow", VERDICT), config),
      },
      log: () => undefined,
    });
    await judge(shard);

    const rows = rowsAt(root);
    assert.equal(rows.length, 4, "an assignment and an attempt for each of the two judges");
    assertNamesItsRun(rows, ["verify-human-judge", "verify-human-shadow"], shard.id, verifyHumanJudgeRunId(shard));
    assert.equal(seen.length, 2);
    for (const args of seen) assert.equal("taskId" in args || "runId" in args, false, "the router never sees either id");
  });
});
