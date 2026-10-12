// A safeguard refusal (`stop_reason: "refusal"`) and the worker's final `stop_reason` were invisible: nothing read the SDK's
// `model_refusal_fallback` / `model_refusal_no_fallback` system messages, and `stop_reason` was never ledgered, so a refusal
// was indistinguishable from an ordinary empty run and nobody could measure early-stop or refusal rates. OBSERVATIONAL ONLY:
// no classification, strike or retry behaviour reads these fields.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import { collectWorkerResult, workerLedgerFields } from "../src/lib/worker.js";
import { spawnOpenWeightWorker } from "../src/lib/worker-provider.js";

const resultEnvelope = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  session_id: "s1",
  total_cost_usd: 0.01,
  num_turns: 1,
  ...over,
});

async function* stream(...messages: unknown[]): AsyncGenerator<unknown> {
  for (const m of messages) yield m;
}

test("a no-fallback safeguard refusal is recorded with its category", async () => {
  const r = await collectWorkerResult(
    stream(
      {
        type: "system",
        subtype: "model_refusal_no_fallback",
        original_model: "claude-opus-5-5",
        request_id: null,
        api_refusal_category: "cyber",
        api_refusal_explanation: "display only prose that must never be parsed",
        content: "refused",
        uuid: "u1",
        session_id: "s1",
      },
      resultEnvelope({ stop_reason: "refusal" }),
    ),
    { childEnvKeys: [] },
  );
  assert.deepEqual(r.safeguardRefusal, { category: "cyber", retried: false, originalModel: "claude-opus-5-5" });
  const f = workerLedgerFields(r) as Record<string, unknown>;
  assert.equal(f.safeguard_refusal_category, "cyber");
  assert.equal(f.safeguard_refusal_retried, false);
  assert.equal(f.safeguard_refusal_original_model, "claude-opus-5-5");
  assert.equal("safeguard_refusal_fallback_model" in f, false, "no fallback ran, so no fallback model is invented");
  assert.equal(JSON.stringify(f).includes("display only prose"), false, "the explanation is display-only and never ledgered");
});

test("a safeguard refusal with no category records a null category, not a missing refusal", async () => {
  const r = await collectWorkerResult(
    stream(
      { type: "system", subtype: "model_refusal_no_fallback", original_model: "claude-opus-5-5", api_refusal_category: null },
      resultEnvelope(),
    ),
    { childEnvKeys: [] },
  );
  assert.deepEqual(r.safeguardRefusal, { category: null, retried: false, originalModel: "claude-opus-5-5" });
  assert.equal((workerLedgerFields(r) as Record<string, unknown>).safeguard_refusal_category, null);
});

test("a retried safeguard refusal records the fallback model", async () => {
  const r = await collectWorkerResult(
    stream(
      {
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-opus-5-5",
        fallback_model: "claude-sonnet-5-5",
        api_refusal_category: "bio",
      },
      resultEnvelope({ stop_reason: "end_turn" }),
    ),
    { childEnvKeys: [] },
  );
  assert.deepEqual(r.safeguardRefusal, {
    category: "bio",
    retried: true,
    originalModel: "claude-opus-5-5",
    fallbackModel: "claude-sonnet-5-5",
  });
  const f = workerLedgerFields(r) as Record<string, unknown>;
  assert.equal(f.safeguard_refusal_retried, true);
  assert.equal(f.safeguard_refusal_fallback_model, "claude-sonnet-5-5");
});

test("a fallback notice that is not a retry is not a refusal", async () => {
  const r = await collectWorkerResult(
    stream(
      {
        type: "system",
        subtype: "model_refusal_fallback",
        direction: "revert",
        original_model: "claude-sonnet-5-5",
        fallback_model: "claude-opus-5-5",
      },
      resultEnvelope(),
    ),
    { childEnvKeys: [] },
  );
  assert.equal("safeguardRefusal" in r, false, "only the retry direction is a refusal; revert/sticky are legacy swaps");
});

test("the final stop reason is recorded on the worker result", async () => {
  const fromEnvelope = await collectWorkerResult(stream(resultEnvelope({ stop_reason: "end_turn" })), { childEnvKeys: [] });
  assert.equal(fromEnvelope.finalStopReason, "end_turn");
  assert.equal((workerLedgerFields(fromEnvelope) as Record<string, unknown>).final_stop_reason, "end_turn");

  // The envelope carries none (null): fall back to the LAST assistant message that actually has one. Streamed blocks carry
  // `stop_reason: null`, so a later null must not erase an earlier real value.
  const fromAssistant = await collectWorkerResult(
    stream(
      { type: "assistant", message: { model: "claude-opus-5-5", stop_reason: "tool_use", content: [] } },
      { type: "assistant", message: { model: "claude-opus-5-5", stop_reason: null, content: [] } },
      resultEnvelope({ stop_reason: null }),
    ),
    { childEnvKeys: [] },
  );
  assert.equal(fromAssistant.finalStopReason, "tool_use");

  // The envelope outranks an assistant message.
  const both = await collectWorkerResult(
    stream(
      { type: "assistant", message: { model: "claude-opus-5-5", stop_reason: "tool_use", content: [] } },
      resultEnvelope({ stop_reason: "refusal" }),
    ),
    { childEnvKeys: [] },
  );
  assert.equal(both.finalStopReason, "refusal");
});

test("a result with no refusal and no stop reason is unchanged", async () => {
  const r = await collectWorkerResult(
    stream({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } }, resultEnvelope()),
    { childEnvKeys: [] },
  );
  assert.equal("safeguardRefusal" in r, false, "absent, never a fabricated value");
  assert.equal("finalStopReason" in r, false, "absent, never a fabricated value");
  const f = workerLedgerFields(r) as Record<string, unknown>;
  for (const key of Object.keys(f)) {
    assert.equal(key.startsWith("safeguard_refusal"), false, key);
    assert.notEqual(key, "final_stop_reason");
  }
});

test("a foundry refusal names its stop_details category", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-foundry-refusal-"));
  try {
    const call = (stopDetails: unknown) => spawnOpenWeightWorker({
      cwd: root, workerHome: join(root, "home"), prompt: "Do the work", cashSqueezed: true, clock: fixedClock(Date.parse("2026-10-03T12:00:00Z")),
      env: { RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" },
      fetchImpl: async () => new Response(JSON.stringify({
        id: "msg-refused", stop_reason: "refusal", content: [],
        ...(stopDetails === undefined ? {} : { stop_details: stopDetails }),
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200 }),
    }, {
      claudeBin: "/unused", root, dailyCapUsd: { normal: 10, squeezed: 25 },
      workerProviders: { enabled: ["cash"], cashEndpoint: "https://openai.example.test/" },
    } as unknown as Config, { model: "claude-opus-5-5", effort: "medium" });
    const named = await call({ type: "refusal", category: "cyber", explanation: "unstable prose" });
    assert.equal(named.isError, true);
    assert.match(named.stderr, /refused the request/);
    assert.match(named.stderr, /category: cyber/);
    assert.doesNotMatch(named.stderr, /unstable prose/, "the explanation is display-only and never copied");
    const bare = await call(undefined);
    assert.match(bare.stderr, /refused the request/);
    assert.doesNotMatch(bare.stderr, /category/, "no category on the wire, none invented");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
