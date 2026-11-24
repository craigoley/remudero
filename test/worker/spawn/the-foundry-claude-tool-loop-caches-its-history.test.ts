import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import { spawnOpenWeightWorker } from "#src/lib/worker-provider.js";

const MODEL = "claude-haiku-5-5";
const env = { RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key",
  RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" };
const NOW = Date.parse("2026-11-24T12:00:00Z");
// The body keys, in order, that origin/main sends for a call with tools; JSON.stringify keeps insertion order.
const TODAY_KEYS = ["model", "system", "messages", "max_tokens", "output_config", "tools"];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t14629-"));
  mkdirSync(join(root, "home"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "fixture text\n", "utf8");
  return { root, config: { root, dailyCapUsd: 25, claudeBin: "/unused" } as Config,
    close: () => rmSync(root, { recursive: true, force: true }) };
}
function reply(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ id: "w1t14629-fixture", model: MODEL, ...body }), { status: 200 });
}
const toolTurn = () => reply({ stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "notes.txt" } }],
  usage: { input_tokens: 2_000, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
const finalTurn = (usage: Record<string, number>) => reply({ stop_reason: "end_turn",
  content: [{ type: "text", text: '{"ok":true}' }], usage });

function twoTurnRun(f: ReturnType<typeof fixture>, bodies: Array<Record<string, unknown>>, usage: Record<string, number>) {
  let n = 0;
  return spawnOpenWeightWorker({ cwd: f.root, workerHome: join(f.root, "home"), prompt: "Read notes.txt and answer", env,
    tools: ["Read"], maxTurns: 2, clock: fixedClock(NOW),
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return ++n === 1 ? toolTurn() : finalTurn(usage);
    } }, f.config, { model: MODEL, effort: "low" });
}

test("W1-T14629 criterion 1: a Foundry Claude run allowed a second turn sends top-level automatic caching on every turn, append-only", async () => {
  const f = fixture();
  try {
    const bodies: Array<Record<string, unknown>> = [];
    const result = await twoTurnRun(f, bodies, { input_tokens: 100, output_tokens: 20 });
    assert.equal(result.isError, false, result.text);
    assert.equal(bodies.length, 2);
    for (const body of bodies) assert.deepEqual(body.cache_control, { type: "ephemeral" });
    const [first, second] = bodies.map((body) => body.messages as unknown[]);
    assert.deepEqual(second.slice(0, first.length), first, "turn 2 starts with turn 1's exact messages");
    assert.equal(second.length, first.length + 2, "turn 2 appends the assistant turn and its tool results only");
  } finally { f.close(); }
});

test("W1-T14629 criterion 2: invariant:one-turn-body-is-today, a one-turn call sends no cache_control and today's body", async () => {
  const f = fixture();
  try {
    for (const maxTurns of [undefined, 1]) {
      const bodies: Array<Record<string, unknown>> = [];
      const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: join(f.root, "home"), prompt: "Return the checked JSON",
        env, tools: ["Read"], ...(maxTurns === undefined ? {} : { maxTurns }), clock: fixedClock(NOW),
        fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return finalTurn({ input_tokens: 100, output_tokens: 20 });
        } }, f.config, { model: MODEL, effort: "low" });
      assert.equal(result.isError, false, result.text);
      assert.equal(bodies.length, 1);
      assert.equal(Object.hasOwn(bodies[0], "cache_control"), false, `maxTurns=${String(maxTurns)}`);
      assert.deepEqual(Object.keys(bodies[0]), TODAY_KEYS, `maxTurns=${String(maxTurns)}`);
    }
  } finally { f.close(); }
});

test("W1-T14629 criterion 3: cached turns settle at the existing Foundry cache-read and reservation-input rates", async () => {
  const f = fixture();
  try {
    const bodies: Array<Record<string, unknown>> = [];
    const result = await twoTurnRun(f, bodies, { input_tokens: 300, output_tokens: 20,
      cache_read_input_tokens: 1_900, cache_creation_input_tokens: 200 });
    assert.equal(result.isError, false, result.text);
    // FOUNDRY_HAIKU_PRICE: input 0.1, cached input 0.01, reservation input (cache write) 0.2, output 0.5 per million.
    const turn1 = (2_000 * 0.1 + 40 * 0.5) / 1_000_000;
    const turn2 = (300 * 0.1 + 1_900 * 0.01 + 200 * 0.2 + 20 * 0.5) / 1_000_000;
    assert.ok(Math.abs((result.costUsd ?? NaN) - (turn1 + turn2)) < 1e-12, `costUsd ${String(result.costUsd)}`);
  } finally { f.close(); }
});
