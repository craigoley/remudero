import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Config } from "#src/lib/config.js";
import { childGardenPassSpawn, GARDEN_PASS_STEP, startGardenOffLoop } from "#src/lib/garden-registry.js";
import type { GardenerRuntimeEvent } from "#src/lib/gardener-runtime.js";
import { issueRevalidationJudgeText, JudgeWorkerFailedError, parseIssueRevalidationVerdict } from "#src/lib/issue-revalidation-garden.js";
import { readLedgerLines } from "#src/lib/status.js";
import { ProviderCapacityBlockedError } from "#src/lib/worker-provider.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "#src/lib/worker.js";

type Fields = Record<string, unknown>;

function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-garden-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function gardenPass(t: TestContext, childSource: string) {
  const root = scratch(t);
  const entry = join(root, "garden.mjs");
  writeFileSync(entry, `import { writeSync } from "node:fs";\n${childSource}`);
  let finish!: (row: Fields) => void;
  const finished = new Promise<Fields>(resolve => { finish = resolve; });
  const events: GardenerRuntimeEvent[] = [];
  const log = (step: string, fields: Fields = {}) => { if (step === GARDEN_PASS_STEP) finish(fields); };
  const spawnPass = childGardenPassSpawn({ entry, execArgv: [], root, cwd: root,
    env: { ...process.env, NODE_V8_COVERAGE: "" }, reserve: () => undefined, setPriority: () => {}, ionice: "/bin/true", log });
  const garden = startGardenOffLoop("config", 60_000, { spawnPass, log, observe: event => { events.push(event); } });
  try {
    const row = await finished;
    const event = events.at(-1)!;
    assert.equal(event.passId, row.passId);
    return { row, event };
  } finally {
    garden.stop();
  }
}

test("W1-T13988 criterion 1: a plain failed garden exit keeps its stderr tail and first error class", { timeout: 10_000 }, async t => {
  const stderr = "warning: starting\nTypeError: first failure\nRangeError: later failure\n";
  for (const [output, failureClass] of [[stderr, "TypeError"], ["no structured error\n", "exit-only"], ["", "exit-only"]]) {
    const { row, event } = await gardenPass(t, `writeSync(2, ${JSON.stringify(output)}); process.exit(1);`);
    assert.equal(row.exit, 1);
    assert.equal(row.stderr, output);
    assert.equal(row.failure_class, failureClass);
    assert.equal(row.error, undefined);
    assert.equal(event.phase, "failed");
    assert.equal(event.reason, "process-failed");
  }
  const redacted = await gardenPass(t, 'writeSync(2, "Error: request failed with token=fixture-secret\\n"); process.exit(1);');
  assert.equal(redacted.row.stderr, "Error: request failed with token=<redacted>\n");
});

const answer = "REVALIDATION_VERDICT: resolved\nREVALIDATION_REASON: recovered\nREVALIDATION_CITATION: PR #10 merged";
const cashFailure = (subtype: string) => ({ subtype, text: "discard this failed answer", isError: true, apiError: true });

function judgeFixture(t: TestContext, outcomes: Array<Partial<WorkerResult> | Error>, pin?: "cash" | "claude") {
  const root = scratch(t);
  const config: Config = { root, claudeBin: "/bin/false", overflow: "api_key", dailyCapUsd: { normal: 5, squeezed: 10 },
    workerProviders: { enabled: ["cash", "claude", "codex"], cashFallbackWhenBlocked: true } };
  const requests: SpawnWorkerArgs[] = [];
  const judge = issueRevalidationJudgeText({ mount: { model: "haiku", effort: "low", maxTurns: 1, contextBudget: 1024, provider: pin },
    cwd: root, settingsFile: join(root, "settings.json"), config, spawn: async args => {
      requests.push(args);
      const outcome = outcomes[requests.length - 1];
      assert.ok(outcome, "the judge started an unexpected attempt");
      if (outcome instanceof Error) throw outcome;
      const provider = args.mountProvider ?? "codex";
      const model = provider === "codex" ? "gpt-6.1-mini" : "haiku";
      const id = `00000000-0000-4000-8000-00000000000${requests.length}`;
      const assignment: WorkerSelectionAssignment = { version: 1, phase: "pre-execution", id,
        requested: { model: args.model!, effort: args.effort!, maxTurns: args.maxTurns! }, selected: { provider, model, effort: "low" },
        routing: { mode: args.mountProvider ? "mount-affinity" : "multi-provider",
          policy: { preference: "automatic", reservePercent: 5, provenance: "default" } }, candidates: [] };
      args.onSelectionAssignment?.(assignment);
      return { sessionId: id, selectionAssignmentId: id, costUsd: 0.03, numTurns: 1, text: answer, blocks: [],
        stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], provider,
        model, effort: "low", tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
        compactionEvents: [], qualitySuspect: false, ...outcome };
    } });
  const rows = (step: string) => [...readLedgerLines(join(root, "state", "ledger.ndjson"))].filter(row => row.step === step);
  return { judge, config, requests, rows };
}

test("W1-T13988 criterion 2: each eligible cash failure retries once through the router and records the chosen arm", async t => {
  for (const cause of ["openweight_error", "cash_allowance_exhausted"]) {
    const f = judgeFixture(t, [cashFailure(cause), {}], "cash");
    const identities: Fields[] = [];
    assert.equal(await f.judge("same prompt", 42, identity => identities.push(identity)), answer);
    assert.deepEqual(f.requests.map(args => args.mountProvider), ["cash", undefined]);
    assert.deepEqual(f.rows("judge.fallback").map(row => [row.from_provider, row.to_provider, row.model, row.cause]),
      [["cash", "codex", "gpt-6.1-mini", cause]]);
    assert.deepEqual(identities, [{ identity_state: "observed", selection_assignment_id: "00000000-0000-4000-8000-000000000002" }]);
  }
  const failure = judgeFixture(t, [cashFailure("openweight_error"), cashFailure("error_max_turns")], "cash");
  await assert.rejects(failure.judge("same prompt", 42), { name: "JudgeWorkerFailedError", subtype: "error_max_turns" });
  assert.equal(failure.requests.length, 2);
  assert.equal(failure.rows("judge.fallback").length, 1);

  const error = new Error("subscription transport interrupted");
  const rejected = judgeFixture(t, [cashFailure("openweight_error"), error], "cash");
  await assert.rejects(rejected.judge("same prompt", 42), { name: "JudgeWorkerFailedError", subtype: "spawn-rejected", cause: error });
  assert.equal(rejected.requests.length, 2);
});

test("W1-T13988 criterion 3: the retry stays off cash and each attempt keeps its spend receipt", async t => {
  const f = judgeFixture(t, [cashFailure("cash_allowance_exhausted"), {}], "cash");
  await f.judge("prompt", 42);
  const routing = f.requests[1]!.config!;
  assert.equal(routing.workerProviders?.cashFallbackWhenBlocked, false);
  assert.equal(routing.overflow, "none");
  assert.deepEqual(f.rows("issue_revalidation.attempt_spend").map(row => [row.provider, row.attempt_state, row.total_cost_usd]),
    [["cash", "result", 0.03], ["codex", "result", 0.03]]);

  const blocked = judgeFixture(t, [cashFailure("openweight_error"), new ProviderCapacityBlockedError([])], "cash");
  await assert.rejects(blocked.judge("prompt", 42), { name: "JudgeWorkerFailedError", subtype: "openweight_error" });
  assert.equal(blocked.requests.length, 2);
  assert.deepEqual(blocked.rows("judge.fallback").map(row => [row.from_provider, row.to_provider, row.cause]),
    [["cash", null, "openweight_error"]]);
  assert.deepEqual(blocked.rows("issue_revalidation.attempt_spend").map(row => row.attempt_state), ["result", "not-started"]);

  for (const [outcome, pin] of [[{}, "cash"], [cashFailure("error_max_turns"), "cash"],
    [cashFailure("openweight_error"), "claude"], [cashFailure("openweight_error"), undefined]] as const) {
    const one = judgeFixture(t, [outcome], pin);
    if ("subtype" in outcome) await assert.rejects(one.judge("prompt", 42), JudgeWorkerFailedError);
    else assert.equal(await one.judge("prompt", 42), answer);
    assert.equal(one.requests.length, 1);
    assert.deepEqual(one.rows("judge.fallback"), []);
  }
});

test("a rejected initial spawn is neither retried nor treated as a judge answer", async t => {
  const error = new Error("provider transport interrupted");
  const f = judgeFixture(t, [error], "cash");
  await assert.rejects(f.judge("prompt", 42), error);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.rows("judge.fallback"), []);
});

test("W1-T13988 criterion 4: retry keeps the judge request, parsing and caps, and preserves the other garden reports", { timeout: 10_000 }, async t => {
  const f = judgeFixture(t, [cashFailure("openweight_error"), {}], "cash");
  const prompt = "verdict and citation";
  assert.deepEqual(parseIssueRevalidationVerdict(await f.judge(prompt, 42)), parseIssueRevalidationVerdict(answer));
  const expected = { model: "haiku", effort: "low", maxTurns: 1, tools: [], prompt,
    cwd: f.config.root, settingsFile: join(f.config.root, "settings.json"), permissionMode: "bypassPermissions" };
  assert.deepEqual(f.requests.map(({ model, effort, maxTurns, tools, prompt, cwd, settingsFile, permissionMode }) =>
    ({ model, effort, maxTurns, tools, prompt, cwd, settingsFile, permissionMode })), [expected, expected]);
  assert.deepEqual(f.requests[1]!.config?.dailyCapUsd, { normal: 5, squeezed: 10 });
  assert.equal(f.config.workerProviders?.cashFallbackWhenBlocked, true);

  const success = await gardenPass(t, 'writeSync(2, "TypeError: harmless diagnostic\\n");');
  assert.equal(success.row.exit, 0);
  assert.equal(success.event.phase, "completed");
  for (const key of ["stderr", "failure_class", "error", "output_retention"]) assert.equal(Object.hasOwn(success.row, key), false);
  const heap = await gardenPass(t, 'writeSync(2, "heap out of memory"); process.kill(process.pid, "SIGTERM");');
  assert.match(String(heap.row.error), /^heap_exhausted:/);
  assert.equal(heap.row.signal, "SIGTERM");
  assert.equal(heap.row.stderr, "heap out of memory");
  assert.equal(Object.hasOwn(heap.row, "failure_class"), false);
  const incomplete = await gardenPass(t, 'writeSync(2, "retained\\n"); await new Promise(r => setTimeout(r, 25)); writeSync(2, Buffer.from([0xc3])); process.exit(2);');
  assert.equal(incomplete.row.exit, 2);
  assert.match(String(incomplete.row.error), /incomplete stderr output \(malformed\)/);
  assert.equal(incomplete.row.stderr, "retained\n");
  assert.equal(Object.hasOwn(incomplete.row, "failure_class"), false);
});
