import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/lib/config.js";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import { ROUTING_EXPERIMENTS, routingExperimentFor } from "../src/lib/routing-experiments.js";
import { openWeightAllowancePath, openWeightCommittedUsd, openWeightReservationUsd, openWeightUsageUsd,
  selectOpenWeightModel, spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import { workerSelectionAssignment } from "../src/lib/worker.js";

const MODEL = "gpt-6.1-sol";
const root = join(import.meta.dirname, "..");
const table = loadMounts(mountsPath(root)).capabilities!;
const env = { RMD_OPENWEIGHT_API_KEY: "test-only-key" };
const selection = { model: MODEL, effort: "high" };
const reply = (over: Record<string, unknown> = {}) => ({ id: "resp-1", model: `${MODEL}-2026-09-29`, status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "ready" }] }],
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 } }, ...over });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "rmd-sol61-"));
  return { cwd, config: { root: cwd, dailyCapUsd: 25,
    workerProviders: { cashEndpoint: "https://foundry.example.test/" } } as Config,
    close: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("Sol 6.1 leads subscription Sol seats and cash keeps the measured economy order", () => {
  for (const effort of ["low", "medium", "high"]) {
    assert.deepEqual(table.codex.balanced[effort], [MODEL, "gpt-6-sol", "gpt-5.6-sol"]);
    assert.equal(table.codex.frontier[effort][0], MODEL);
    assert.equal(table.cash!.economy[effort][0], "gpt-oss-120b");
    assert.equal(table.cash!.economy[effort].includes(MODEL), false);
    assert.equal(table.cash!.balanced[effort][0], "gpt-5-nano");
    assert.equal(table.cash!.balanced[effort].at(-1), MODEL);
  }
  assert.equal(selectOpenWeightModel(table, "sonnet", "high", 100, { only: [MODEL] }).model, MODEL);
  assert.equal(selectOpenWeightModel(table, "sonnet", "high", 100).model, "gpt-5-nano");
  assert.equal(selectOpenWeightModel(table, "sonnet", "high", 100, { cashSqueezed: true }).model, "gpt-6-luna");
});

test("Sol 6.1 assignments start a separate Field Trials epoch from Sol 6", () => {
  const candidates = (codex: string, claude = "claude-sonnet-5-5") => [
    { provider: "claude" as const, model: claude, eligible: true },
    { provider: "codex" as const, model: codex, eligible: true },
  ];
  const classify = (codex: string, claude?: string) => routingExperimentFor({
    capability: "balanced", effort: "high", considered: candidates(codex, claude) });
  assert.equal(classify(MODEL), "sol61-vs-sonnet55");
  assert.equal(classify(MODEL, "claude-sonnet-5"), "sol61-vs-sonnet5");
  assert.equal(classify("gpt-6-sol"), "sol-vs-sonnet55");
  assert.equal(classify("gpt-6-sol", "claude-sonnet-5"), "sol-vs-sonnet");
  assert.equal(classify("gpt-6X1-sol"), undefined);
  const capacities = candidates(MODEL).map((candidate) => ({ provider: candidate.provider, model: candidate.model,
    readable: true, windows: [{ name: "weekly", usedPercent: 40 }] }));
  const row = workerSelectionAssignment({ cwd: root, permissionMode: "bypassPermissions", settingsFile: join(root, "settings", "worker.json"), prompt: "review", taskId: "PR-8639", runId: "switch-1",
    model: "sonnet", effort: "high" }, { provider: "codex", model: MODEL, effort: "high", capacities,
    capacity: capacities[1], capability: "balanced", mode: "multi-provider", selectionPath: "auction",
    policy: { preference: "automatic", reservePercent: 5, provenance: "default" } });
  assert.equal(row.routing.decision?.ab, "sol61-vs-sonnet55");
  assert.equal(row.routing.experiment?.id, "sol61-vs-sonnet55");
  assert.equal(row.selected.model, MODEL);
  const epoch = ROUTING_EXPERIMENTS.find((item) => item.id === "sol61-vs-sonnet55")!;
  assert.equal(epoch.startedOn, "2026-10-02");
  assert.equal(epoch.minTasksPerArm, 20);
});

test("Sol 6.1 cash Responses retains reasoning and real tool output and meters each turn", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.cwd, "input.txt"), "verified-input");
    const bodies: Record<string, unknown>[] = [];
    const result = await spawnOpenWeightWorker({ cwd: f.cwd, workerHome: f.cwd, prompt: "read input.txt", env, tools: ["Read"], maxTurns: 2,
      fetchImpl: async (url, init) => {
        assert.equal(String(url), "https://foundry.example.test/openai/v1/responses");
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        assert.equal(body.reasoning.effort, "high");
        assert.equal(body.max_output_tokens, 8000);
        assert.equal(body.store, false);
        assert.equal("temperature" in body, false);
        assert.equal("messages" in body, false);
        assert.equal(body.tools[0].name, "read_file");
        assert.equal(body.tools[0].strict, false);
        return new Response(JSON.stringify(bodies.length === 1 ? reply({ output: [
          { type: "reasoning", id: "rs-1", encrypted_content: "encrypted", summary: [] },
          { type: "function_call", id: "fc-1", call_id: "call-1", name: "read_file", arguments: '{"path":"input.txt"}' },
        ] }) : reply({ id: "resp-2" })), { status: 200 });
      } }, f.config, selection);
    assert.equal(result.isError, false, result.stderr);
    assert.equal(result.servedModel, `${MODEL}-2026-09-29`);
    assert.equal(result.numTurns, 2);
    assert.equal(result.tokens.cacheRead, 120);
    assert.equal(result.tokens.cacheCreation, 20);
    assert.ok(Math.abs(result.costUsd - 0.000582) < 1e-12);
    const input = bodies[1]!.input as Record<string, unknown>[];
    assert.equal(input.find((item) => item.type === "reasoning")?.encrypted_content, "encrypted");
    assert.match(String(input.find((item) => item.type === "function_call_output")?.output), /verified-input/);
    assert.ok(Math.abs(openWeightCommittedUsd(JSON.parse(readFileSync(openWeightAllowancePath(f.config), "utf8"))) - result.costUsd) < 1e-12);
  } finally { f.close(); }
});

test("Sol 6.1 prices cached input, writes and whole-request long context conservatively", () => {
  assert.equal(openWeightUsageUsd(MODEL, 100, 20, 60, 10), 0.000291);
  assert.equal(openWeightUsageUsd(MODEL, 272000, 100), 0.545);
  assert.equal(openWeightUsageUsd(MODEL, 272001, 100, 1000, 2000), 1.087704);
  assert.equal(openWeightReservationUsd(MODEL, 272001), 1.480005);
});

test("Sol 6.1 refuses a paid request before transport when the shared allowance cannot reserve it", async () => {
  const f = fixture();
  try {
    f.config.dailyCapUsd = 0.01;
    let calls = 0;
    const result = await spawnOpenWeightWorker({ cwd: f.cwd, workerHome: f.cwd, prompt: "work", tools: [], env,
      fetchImpl: async () => { calls++; throw new Error("must not send"); } }, f.config, selection);
    assert.equal(result.budgetRefused, true);
    assert.equal(calls, 0);
  } finally { f.close(); }
});

for (const [title, envelope, expected] of [
  ["Sol 6.1 reports incomplete output without claiming completion", reply({ status: "incomplete" }), /truncated/i],
  ["Sol 6.1 reports failed response without claiming completion", reply({ status: "failed" }), /no assistant message/],
  ["Sol 6.1 reports empty completed response without claiming completion", reply({ output: [] }), /no assistant message/],
  ["Sol 6.1 reports undeclared function without claiming completion", reply({ output: [{ type: "function_call", call_id: "c", name: "shell", arguments: "{}" }] }), /undeclared tool/],
  ["Sol 6.1 reports malformed arguments without claiming completion", reply({ output: [{ type: "function_call", call_id: "c", name: "read_file", arguments: "invalid" }] }), /tool read_file failed/],
  ["Sol 6.1 reports failed real tool without claiming completion", reply({ output: [{ type: "function_call", call_id: "c", name: "read_file", arguments: '{"path":"missing.txt"}' }] }), /tool read_file failed/],
] as const) {
  test(title, async () => {
    const f = fixture();
    try {
      const result = await spawnOpenWeightWorker({ cwd: f.cwd, workerHome: f.cwd, prompt: "work", tools: ["Read"], maxTurns: 2, env,
        fetchImpl: async () => new Response(JSON.stringify(envelope)) }, f.config, selection);
      assert.equal(result.isError, true); assert.match(result.stderr, expected);
      assert.equal(result.budgetSettledUsd, 0.000291);
    } finally { f.close(); }
  });
}

for (const status of [404, 429]) {
  test(`Sol 6.1 HTTP ${status} retains only the charge justified by transport evidence`, async () => {
    const f = fixture();
    try {
      const result = await spawnOpenWeightWorker({ cwd: f.cwd, workerHome: f.cwd, prompt: "work", tools: [], env,
        fetchImpl: async () => new Response("", { status }) }, f.config, selection);
      assert.equal(result.isError, true);
      assert.equal(result.budgetSettledUsd, status === 404 ? 0 : result.budgetReservedUsd);
      assert.equal(result.openWeightDeploymentAbsent, status === 404 ? MODEL : undefined);
    } finally { f.close(); }
  });
}

test("Sol 6.1 missing receipt and unnamed model remain honest while JSON output uses Responses format", async () => {
  const f = fixture();
  try {
    const result = await spawnOpenWeightWorker({ cwd: f.cwd, workerHome: f.cwd, prompt: "Return JSON", tools: [], env, responseFormat: "json_object",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); assert.deepEqual(body.text, { format: { type: "json_object" } });
        assert.equal(body.tools, undefined);
        return new Response(JSON.stringify(reply({ model: undefined, usage: undefined })));
      } }, f.config, { ...selection, effort: "default" });
    assert.equal(result.servedModel, null);
    assert.equal(result.budgetSettledUsd, result.budgetReservedUsd);
    assert.equal(result.costUsd, result.budgetReservedUsd);
    const refused = await spawnOpenWeightWorker({ cwd: f.cwd, workerHome: f.cwd, prompt: "work", env, tools: [] }, f.config, { ...selection, effort: "none" });
    assert.match(refused.stderr, /does not support reasoning effort none/);
    assert.equal(refused.budgetReservedUsd, 0);
  } finally { f.close(); }
});

test("Sol 6.1 missing cache write counter retains the reservation instead of undercharging", async () => {
  const f = fixture();
  try {
    const result = await spawnOpenWeightWorker({ cwd: f.cwd, workerHome: f.cwd, prompt: "work", tools: [], env,
      fetchImpl: async () => new Response(JSON.stringify(reply({ usage: { input_tokens: 100, output_tokens: 20,
        input_tokens_details: { cached_tokens: 60 } } }))) }, f.config, selection);
    assert.equal(result.isError, false);
    assert.equal(result.tokens.input, 100);
    assert.equal(result.budgetSettledUsd, result.budgetReservedUsd);
    assert.equal(result.costUsd, result.budgetReservedUsd);
  } finally { f.close(); }
});
