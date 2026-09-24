import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import {
  evaluateRoutingExperiment,
  ROUTING_EXPERIMENTS,
  routingAbCommand,
  routingExperimentFor,
  type RoutingExperiment,
} from "../src/lib/routing-experiments.js";
import { selectCodexModel, type CodexModelInfo, type ProviderCapacity } from "../src/lib/worker-provider.js";
import { workerSelectionAssignment, type SpawnWorkerArgs } from "../src/lib/worker.js";

// Operator ruling 2026-09-24 (DECISIONS.md): Sol vs Sonnet for mid-tier work is an A/B test. The
// headroom auction splits sonnet/high work between the two, each such assignment is tagged, and
// `rmd routing-ab` compares the arms from the ledger. Revisit 2026-10-08.

const REPO_ROOT = join(import.meta.dirname, "..");
const SOL_VS_SONNET = ROUTING_EXPERIMENTS.find((experiment) => experiment.id === "sol-vs-sonnet")!;

const MODELS: CodexModelInfo[] = ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna"].map((id) => ({
  id,
  model: id,
  supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
}));
const SHARED = { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 10080 } } } };

test("all sonnet efforts reach Sol on Codex while the high-effort A/B stays scoped", () => {
  const ladder = loadMounts(mountsPath(REPO_ROOT)).capabilities!;
  assert.equal(ladder.codex.balanced.high[0], "gpt-6-sol");
  for (const effort of ["low", "medium", "high"] as const) {
    assert.equal(selectCodexModel(MODELS, SHARED, {} as never, "sonnet", effort, ladder).model, "gpt-6-sol", `sonnet/${effort}`);
  }
  assert.equal(selectCodexModel(MODELS, SHARED, {} as never, "haiku", "medium", ladder).model, "gpt-6-luna");
  const considered = [
    { provider: "claude" as const, model: "claude-sonnet-5", eligible: true },
    { provider: "codex" as const, model: "gpt-6-sol", eligible: true },
  ];
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered }), "sol-vs-sonnet");
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "medium", considered }), undefined);
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: [considered[0]!, { ...considered[1]!, model: "gpt-5.6-sol" }] }), undefined,
    "the older Sol fallback is not pooled into the GPT-6 experiment arm");
  assert.equal(SOL_VS_SONNET.revisitOn, "2026-10-08", "the ruling fixes the revisit two weeks out");
});

test("an assignment joins the experiment only when either arm could have won", () => {
  const both = [
    { provider: "claude" as const, model: "claude-sonnet-5", eligible: true },
    { provider: "codex" as const, model: "gpt-6-sol", eligible: true },
  ];
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: both }), "sol-vs-sonnet");
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "medium", considered: both }), undefined);
  assert.equal(routingExperimentFor({ capability: "frontier", effort: "high", considered: both }), undefined);
  const codexBlocked = [both[0]!, { ...both[1]!, eligible: false }];
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: codexBlocked }), undefined);
  const lunaServing = [both[0]!, { ...both[1]!, model: "gpt-6-luna" }];
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: lunaServing }), undefined);
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: [both[0]!] }), undefined);
});

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return { provider, readable: true, windows: [{ name: `${provider} weekly`, usedPercent }], ...(model ? { model } : {}) };
}

test("the assignment row carries the ab marker from a headroom auction and from nothing else", () => {
  const claude = capacity("claude", 40);
  const codex = capacity("codex", 50, "gpt-6-sol");
  const input = {
    provider: "codex" as const,
    model: "gpt-6-sol",
    effort: "high",
    capacity: codex,
    capacities: [claude, codex],
    mode: "multi-provider" as const,
    selectionPath: "auction" as const,
    policy: { preference: "automatic" as const, reservePercent: 5, provenance: "default" as const },
    capability: "balanced" as const,
  };
  const args = { cwd: "/w", prompt: "p", model: "sonnet", effort: "high" } as SpawnWorkerArgs;
  assert.equal(workerSelectionAssignment(args, input).routing.decision?.ab, "sol-vs-sonnet");
  const preferred = workerSelectionAssignment(args, { ...input, capabilityPreference: { capability: "balanced", provider: "claude" } });
  assert.equal(preferred.routing.decision?.ab, undefined, "a preference, not headroom, chose this arm");
});

function assignment(task: string, id: string, provider: "claude" | "codex", ts: string, ab: string | null = "sol-vs-sonnet") {
  return {
    ts,
    run_id: `run-${task}`,
    task_id: task,
    step: "worker.assignment",
    worker_assignment: { id, selected: { provider }, routing: { decision: ab ? { rule: "headroom-auction", ab } : { rule: "headroom-auction" } } },
  };
}

const ROWS = [
  { ts: "2026-09-24T00:00:00Z", task_id: "T1", step: "verdict.merged" },
  assignment("T1", "a1", "claude", "2026-09-24T01:00:00Z"),
  { ts: "2026-09-24T01:30:00Z", task_id: "T1", step: "implement.done", selection_assignment_id: "a1", worker_duration_ms: 600_000, tokens: { input: 1000, output: 200 }, cost_usd: 4 },
  { ts: "2026-09-24T02:00:00Z", task_id: "T1", step: "fix.dispatch" },
  { ts: "2026-09-24T03:00:00Z", task_id: "T1", step: "fix.dispatch" },
  { ts: "2026-09-24T04:00:00Z", task_id: "T1", step: "verdict.merged" },
  { ts: "2026-09-24T00:30:00Z", task_id: "T2", step: "verdict.merged" },
  { ts: "2026-09-24T00:40:00Z", task_id: "T3", step: "fix.dispatch" },
  assignment("T2", "a2", "claude", "2026-09-24T01:00:00Z"),
  { ts: "2026-09-24T01:40:00Z", task_id: "T2", step: "verdict", selection_assignment_id: "a2", worker_duration_ms: 1_200_000, tokens: { input: 3000, output: 600 }, cost_usd: 6 },
  assignment("T3", "a3", "codex", "2026-09-24T01:00:00Z"),
  { ts: "2026-09-24T01:20:00Z", task_id: "T3", step: "implement.done", selection_assignment_id: "a3", worker_duration_ms: 300_000, tokens: { input: 500, output: 100 }, cost_usd: 0 },
  { ts: "2026-09-24T05:00:00Z", task_id: "T3", step: "verdict.merged" },
  assignment("T4", "a4", "codex", "2026-09-24T01:00:00Z"),
  assignment("T4", "a5", "claude", "2026-09-24T02:00:00Z"),
  assignment("T5", "a6", "codex", "2026-09-24T01:00:00Z", null),
];

test("the evaluator compares merge rate fix strikes time and cost per arm", () => {
  const report = evaluateRoutingExperiment(ROWS, SOL_VS_SONNET, "2026-09-30");
  assert.equal(report.assignments, 5, "an untagged assignment is not in the experiment");
  assert.equal(report.mixedTasks, 1);
  assert.equal(report.revisitDue, false);
  assert.equal(report.sufficient, false, "three tasks is not a verdict");
  const [sonnet, sol] = report.arms;
  assert.deepEqual(sonnet, {
    arm: "sonnet",
    provider: "claude",
    tasks: 2,
    merged: 1,
    mergeRate: 0.5, // T2's only merge predates its assignment, so it is not the arm's
    meanFixDispatches: 1,
    medianWorkerMinutes: 15,
    meanTokens: 2400,
    meanNotionalCostUsd: 5,
  });
  assert.equal(sol?.tasks, 2, "the mixed task counts under the arm of its first tagged assignment");
  assert.equal(sol?.merged, 1);
  assert.equal(sol?.meanFixDispatches, 0, "a fix dispatched before the task joined the experiment is not the arm's");
  assert.equal(sol?.medianWorkerMinutes, 5);
  const small: RoutingExperiment = { ...SOL_VS_SONNET, minTasksPerArm: 2 };
  assert.equal(evaluateRoutingExperiment(ROWS, small, "2026-10-08").sufficient, true);
  assert.equal(evaluateRoutingExperiment(ROWS, small, "2026-10-08").revisitDue, true);
});

test("rmd routing-ab prints each arm and refuses an unknown flag", async () => {
  const lines: string[] = [];
  const readRows = async () => ROWS;
  assert.equal(await routingAbCommand([], { stateDir: "/state", readRows, today: "2026-10-09", print: (line) => lines.push(line) }), 0);
  assert.match(lines[0]!, /\/state \(16 ledger rows read\)/);
  assert.match(lines[1]!, /^sol-vs-sonnet: insufficient sample; 5 assignments, 1 tasks in both arms; revisit 2026-10-08 \(DUE\)$/);
  assert.match(lines[2]!, /sonnet \(claude\): 2 tasks, 1 merged \(50\.0%\), 1\.0 fix dispatches\/task, 15\.0 min median, 2400 tokens, \$5\.00 notional/);
  const json: string[] = [];
  assert.equal(await routingAbCommand(["--json"], { stateDir: "/state", readRows, today: "2026-09-25", print: (line) => json.push(line) }), 0);
  assert.equal(JSON.parse(json[0]!).reports[0].arms[1].arm, "sol");
  const bad: string[] = [];
  assert.equal(await routingAbCommand(["--csv"], { readRows, print: (line) => bad.push(line) }), 2);
  assert.match(bad[0]!, /unknown: --csv/);
});

test("rmd routing-ab reads the real ledger union under the configured root by default", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-routing-ab-"));
  const savedHome = process.env.HOME;
  try {
    const root = join(home, "Remudero");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.ndjson"), ROWS.slice(0, 6).map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(join(root, "state", "ledger.2026-09-24T00-00-00-000Z.ndjson.gz"), gzipSync(ROWS.slice(6).map((row) => JSON.stringify(row)).join("\n") + "\n"));
    process.env.HOME = home;
    const out: string[] = [];
    assert.equal(await routingAbCommand(["--json"], { print: (line) => out.push(line) }), 0);
    const parsed = JSON.parse(out[0]!);
    assert.equal(parsed.stateDir, join(root, "state"));
    assert.equal(parsed.rowsRead, ROWS.length, "both the live file and the gzipped rotation are read");
    assert.equal(parsed.reports[0].assignments, 5);
    assert.match(parsed.reports[0].revisitOn, /^2026-10-08$/);
    assert.equal(typeof parsed.reports[0].revisitDue, "boolean");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
