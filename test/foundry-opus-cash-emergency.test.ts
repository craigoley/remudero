import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import {
  OPENWEIGHT_ALLOWANCE_FILENAME,
  OPENWEIGHT_PRICES,
  openWeightReservationUsd,
  openWeightUsageUsd,
  reserveOpenWeightBudget,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
} from "../src/lib/worker-provider.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const ISO = "2026-09-24T12:00:00.000Z";
const env = {
  RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key",
  RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-foundry-opus-"));
  const config = {
    root, claudeBin: "/unused", dailyCapUsd: { normal: 10, squeezed: 25 },
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://openai.example.test/" },
  } as Config;
  return { root, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function allowance(root: string): OpenWeightAllowanceState {
  return JSON.parse(readFileSync(join(root, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")) as OpenWeightAllowanceState;
}

test("Luna prices short and long context independently and reserves the dearer tier before a request", () => {
  assert.equal(OPENWEIGHT_PRICES["gpt-6-luna"]?.inputUsdPerMillion, 0.1);
  assert.equal(openWeightUsageUsd("gpt-6-luna", 272_000, 1_000), 0.0277);
  assert.equal(openWeightUsageUsd("gpt-6-luna", 272_001, 1_000), (272_001 * 0.2 + 1_000 * 0.75) / 1_000_000);
  assert.equal(openWeightReservationUsd("gpt-6-luna", 272_001), (272_001 * 0.2 + 8_000 * 0.75) / 1_000_000);
});

test("Luna Chat Completions declares no reasoning effort when it offers tools", async () => {
  const f = fixture();
  try {
    let body: Record<string, unknown> | undefined;
    const result = await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "Read the file", tools: ["Read"],
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-key" }, clock: fixedClock(NOW),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: "chat-1", choices: [{ message: { content: "Nothing to read." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 10 },
        }), { status: 200 });
      },
    }, f.config, { model: "gpt-6-luna", effort: "low" });
    assert.equal(result.isError, false, result.text);
    assert.equal(body?.reasoning_effort, "none");
    assert.ok(Array.isArray(body?.tools));
  } finally { f.cleanup(); }
});

test("Opus has a separate $5 ordinary limit, $10 squeeze limit, and shares the $25 cash ceiling", () => {
  const f = fixture();
  try {
    const reserve = (id: string, deployment: string, squeezed: boolean, bytes = 10) =>
      reserveOpenWeightBudget(f.config, { requestId: id, deployment, requestBodyBytes: bytes, atIso: ISO, squeezed });
    reserve("cheap", "gpt-6-luna", true);
    for (let i = 0; i < 31; i++) reserve(`opus-${i}`, "claude-opus-5-5", false);
    assert.throws(() => reserve("normal-over", "claude-opus-5-5", false), /\$5\.00 dailyCapUsd/);
    for (let i = 31; i < 62; i++) reserve(`opus-${i}`, "claude-opus-5-5", true);
    assert.throws(() => reserve("squeeze-over", "claude-opus-5-5", true), /\$10\.00 dailyCapUsd/);
    const rows = Object.values(allowance(f.root).reservations);
    assert.equal(rows.filter((row) => row.deployment === "claude-opus-5-5").length, 62);
    assert.ok(rows.some((row) => row.deployment === "gpt-6-luna"), "cheap calls occupy the same ledger");

    // A nearly full shared ledger refuses Opus even while its own allowance has room.
    const other = fixture();
    try {
      const near = reserveOpenWeightBudget(other.config, {
        requestId: "large-cheap", deployment: "gpt-6-luna", requestBodyBytes: 124_900_000,
        atIso: ISO, squeezed: true,
      });
      assert.ok(near.reservedUsd < 25);
      assert.throws(() => reserveOpenWeightBudget(other.config, {
        requestId: "opus-shared-over", deployment: "claude-opus-5-5", requestBodyBytes: 10,
        atIso: ISO, squeezed: true,
      }), /\$25\.00 dailyCapUsd/);
    } finally { other.cleanup(); }
  } finally { f.cleanup(); }
});

test("Foundry Opus sends Messages requests, settles measured usage, and refuses a non-squeeze call", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const call = (cashSqueezed: boolean) => spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "Summarize the finding",
      cashSqueezed, env, clock: fixedClock(NOW),
      fetchImpl: async (url, init) => {
        sent++;
        assert.equal(String(url), "https://foundry.example.test/anthropic/v1/messages");
        assert.equal(new Headers(init?.headers).get("x-api-key"), "test-only-key");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, "claude-opus-5-5");
        assert.ok(!("response_format" in body));
        return new Response(JSON.stringify({
          id: "msg-1", stop_reason: "end_turn", content: [{ type: "text", text: "The finding is verified." }],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }), { status: 200 });
      },
    }, f.config, { model: "claude-opus-5-5", effort: "medium" });
    const refused = await call(false);
    assert.equal(refused.isError, true);
    assert.equal(sent, 0);
    const result = await call(true);
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text, "The finding is verified.");
    assert.equal(result.costUsd, (100 * 4 + 20 * 20) / 1_000_000);
    assert.equal(sent, 1);
    assert.deepEqual(Object.values(allowance(f.root).reservations).map((row) => row.settledUsd), [result.costUsd]);
  } finally { f.cleanup(); }
});

test("Foundry Opus carries a real tool result into its next billed turn", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "finding.txt"), "verified source", "utf8");
    let sent = 0;
    const result = await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "Read finding.txt", tools: ["Read"],
      maxTurns: 2, cashSqueezed: true, env, clock: fixedClock(NOW),
      fetchImpl: async (_url, init) => {
        sent++;
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }>; tools: Array<{ name: string }> };
        assert.equal(body.tools[0]?.name, "read_file");
        if (sent === 1) return new Response(JSON.stringify({
          id: "msg-tool", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "finding.txt" } }],
          usage: { input_tokens: 50, output_tokens: 20 },
        }), { status: 200 });
        assert.equal(body.messages[1]?.role, "assistant");
        assert.equal(body.messages[2]?.role, "user");
        assert.match(JSON.stringify(body.messages[2]?.content), /verified source/);
        return new Response(JSON.stringify({
          id: "msg-final", stop_reason: "end_turn", content: [{ type: "text", text: "Verified from the file." }],
          usage: { input_tokens: 60, output_tokens: 30 },
        }), { status: 200 });
      },
    }, f.config, { model: "claude-opus-5-5", effort: "medium" });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.numTurns, 2);
    assert.equal(sent, 2);
    assert.equal(Object.values(allowance(f.root).reservations).length, 2, "each paid turn has a reservation");
  } finally { f.cleanup(); }
});

test("Foundry Opus reports a failed tool instead of continuing a fabricated chain", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const result = await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "Read the file", tools: ["Read"],
      maxTurns: 3, cashSqueezed: true, env, clock: fixedClock(NOW),
      fetchImpl: async () => {
        sent++;
        return new Response(JSON.stringify({
          id: "msg-tool", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "../outside.txt" } }],
          usage: { input_tokens: 50, output_tokens: 20 },
        }), { status: 200 });
      },
    }, f.config, { model: "claude-opus-5-5", effort: "medium" });
    assert.equal(result.isError, true);
    assert.match(result.stderr, /cash Opus tool read_file failed: tool path escapes/);
    assert.equal(sent, 1, "a failed tool must not buy or run another model turn");
  } finally { f.cleanup(); }
});

test("an invalid Foundry usage receipt cannot release a cash reservation", async () => {
  const f = fixture();
  try {
    const result = await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "short answer", cashSqueezed: true,
      env, clock: fixedClock(NOW), fetchImpl: async () => new Response(JSON.stringify({
        id: "msg-invalid-usage", stop_reason: "end_turn", content: [{ type: "text", text: "answer" }],
        usage: { input_tokens: -1, output_tokens: 20 },
      }), { status: 200 }),
    }, f.config, { model: "claude-opus-5-5", effort: "medium" });
    assert.equal(result.isError, false);
    const row = Object.values(allowance(f.root).reservations)[0];
    assert.equal(row?.settledUsd, null);
    assert.equal(result.costUsd, row?.reservedUsd);
  } finally { f.cleanup(); }
});

test("Foundry Opus keeps an uncertain bill reserved and settles a definite 404 to zero", async () => {
  const f = fixture();
  try {
    const call = (status: number) => spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "work", cashSqueezed: true,
      env, clock: fixedClock(NOW), fetchImpl: async () => new Response("unavailable", { status }),
    }, f.config, { model: "claude-opus-5-5", effort: "medium" });
    const absent = await call(404);
    assert.equal(absent.openWeightDeploymentAbsent, "claude-opus-5-5");
    const uncertain = await call(503);
    assert.equal(uncertain.isError, true);
    const rows = Object.values(allowance(f.root).reservations);
    assert.deepEqual(rows.map((row) => row.settledUsd), [0, null]);
    assert.equal(uncertain.budgetSettledUsd, rows[1]?.reservedUsd);
  } finally { f.cleanup(); }
});
