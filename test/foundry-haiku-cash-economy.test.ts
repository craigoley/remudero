import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import { FOUNDRY_HAIKU_PRICE, OPENWEIGHT_CONTEXT_WINDOWS, openWeightAllowancePath,
  openWeightReservationUsd, openWeightUsageUsd, spawnOpenWeightWorker } from "../src/lib/worker-provider.js";

const MODEL = "claude-haiku-5-5";
const env = { RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key",
  RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" };
const NOW = Date.parse("2026-10-07T12:00:00Z");
function fixture(cap = 25) {
  const root = mkdtempSync(join(tmpdir(), "rmd-haiku55-"));
  return { root, config: { root, dailyCapUsd: cap, claudeBin: "/unused" } as Config,
    close: () => rmSync(root, { recursive: true, force: true }) };
}
function response(over: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ id: "haiku-fixture", model: MODEL, stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: '{"ok":true}' }],
    usage: { input_tokens: 100, output_tokens: 20 }, ...over }), { status: 200 });
}

test("Haiku 5.5 prices the whole prompt tier and reserves the one-hour cache-write ceiling", () => {
  assert.equal(OPENWEIGHT_CONTEXT_WINDOWS[MODEL].totalTokens, 1_000_000);
  assert.equal(FOUNDRY_HAIKU_PRICE.readAt, "2026-10-07");
  assert.equal(openWeightUsageUsd(MODEL, 100_000, 1_000), 0.0105);
  assert.equal(openWeightUsageUsd(MODEL, 100_001, 1_000), (100_001 * 0.5 + 1_000 * 2.5) / 1_000_000);
  assert.equal(openWeightUsageUsd(MODEL, 100_001, 1_000, 50_000, 10_000),
    (40_001 * 0.5 + 50_000 * 0.05 + 10_000 + 1_000 * 2.5) / 1_000_000);
  assert.equal(openWeightReservationUsd(MODEL, 100_000), (100_000 * 0.2 + 8_000 * 0.5) / 1_000_000);
  assert.equal(openWeightReservationUsd(MODEL, 100_001), (100_001 + 8_000 * 2.5) / 1_000_000);
});

test("Foundry Haiku runs ordinary cash economy without enabling non-squeezed Opus or Sonnet", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const args = { cwd: f.root, workerHome: join(f.root, "home"), prompt: "Return the checked JSON", env,
      clock: fixedClock(NOW), fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        sent++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, MODEL);
        assert.deepEqual(body.output_config, { effort: "low" });
        assert.equal(Object.hasOwn(body, "temperature"), false);
        return response();
      } };
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      const refused = await spawnOpenWeightWorker(args, f.config, { model, effort: "low" });
      assert.equal(refused.isError, true);
    }
    assert.equal(sent, 0);
    const result = await spawnOpenWeightWorker(args, f.config, { model: MODEL, effort: "low" });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text, '{"ok":true}', "thinking is never treated as visible structured output");
    assert.equal(result.servedModel, MODEL);
    assert.equal(result.costUsd, (100 * 0.1 + 20 * 0.5) / 1_000_000);
    assert.equal(sent, 1);
  } finally { f.close(); }
});

test("Foundry Haiku counts cached prompt tokens at the exact 100K whole-request breakpoint", async () => {
  const f = fixture();
  try {
    for (const cached of [50_000, 50_001]) {
      const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: join(f.root, "home"),
        prompt: "x".repeat(100_001), env, clock: fixedClock(NOW),
        fetchImpl: async () => response({ usage: { input_tokens: 40_000, cache_read_input_tokens: cached,
          cache_creation_input_tokens: 10_000, output_tokens: 20 } }),
      }, f.config, { model: MODEL, effort: "medium" });
      assert.equal(result.isError, false, result.text);
      const high = cached === 50_001;
      assert.equal(result.costUsd, (40_000 * (high ? 0.5 : 0.1) + cached * (high ? 0.05 : 0.01)
        + 10_000 * (high ? 1 : 0.2) + 20 * (high ? 2.5 : 0.5)) / 1_000_000);
    }
  } finally { f.close(); }
});

test("Haiku ordinary cash uses the normal shared cap and refuses before transport", async () => {
  const f = fixture(0.00001);
  try {
    let sent = 0;
    const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: join(f.root, "home"), prompt: "work", env,
      clock: fixedClock(NOW), fetchImpl: async () => { sent++; return response(); },
    }, { ...f.config, dailyCapUsd: { normal: 0.00001, squeezed: 25 } }, { model: MODEL, effort: "low" });
    assert.equal(result.budgetRefused, true);
    assert.equal(result.isError, true);
    assert.equal(sent, 0);
  } finally { f.close(); }
});

test("Foundry Haiku bills an empty thinking-only turn as failure and retains measured settlement", async () => {
  const f = fixture();
  try {
    const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: join(f.root, "home"), prompt: "work", env,
      clock: fixedClock(NOW), fetchImpl: async () => response({ content: [{ type: "thinking", thinking: "done" }] }),
    }, f.config, { model: MODEL, effort: "high" });
    assert.equal(result.isError, true);
    assert.match(result.stderr, /no visible text/);
    assert.ok(result.costUsd > 0);
    const state = JSON.parse(readFileSync(openWeightAllowancePath(f.config), "utf8"));
    assert.equal(Object.values(state.reservations).length, 1);
    assert.equal((Object.values(state.reservations)[0] as { settledUsd: number }).settledUsd, result.costUsd);
  } finally { f.close(); }
});

test("Foundry Haiku stops a real failed local Read before a fabricated follow-up turn", async () => {
  const f = fixture();
  try {
    let sent = 0;
    const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: join(f.root, "home"), prompt: "Read the file",
      tools: ["Read"], maxTurns: 2, env, clock: fixedClock(NOW), fetchImpl: async () => {
        sent++;
        return response({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "read-1", name: "Read",
          input: { file_path: "missing-file.txt" } }] });
      },
    }, f.config, { model: MODEL, effort: "medium" });
    assert.equal(result.isError, true);
    assert.match(result.stderr, /tool Read failed/);
    assert.equal(sent, 1, "the model never receives an invented successful tool result");
  } finally { f.close(); }
});
