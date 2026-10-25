import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock } from "#src/lib/clock.js";
import { OPENWEIGHT_ALLOWANCE_FILENAME, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const hidden = "private-fixture-body-key-prompt-and-reasoning";
const models = ["gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5"];

async function refuse(t: TestContext, response: Response, model = models[0]!, signal?: AbortSignal, timeout = 1000) {
  const { dir } = ownedFixtureDir(t, "cash-category");
  let calls = 0;
  const result = await spawnOpenWeightWorker({ cwd: dir, workerHome: dir, prompt: hidden, tools: [], maxTurns: 2,
    clock: fixedClock(Date.now()), signal, requestTimeoutMs: timeout,
    env: { RMD_OPENWEIGHT_API_KEY: hidden, RMD_FOUNDRY_CLAUDE_API_KEY: hidden,
      RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://fixture.invalid/anthropic" },
    fetchImpl: async () => { calls++; return response; },
  }, { root: dir, dailyCapUsd: 25, workerProviders: { cashEndpoint: "https://fixture.invalid/" } } as Config,
  { model, effort: "low" });
  const allowance = readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8");
  assert.equal(calls, 1, "failure diagnostics cannot add a paid request");
  assert.equal(result.isError, true);
  assert.equal(result.budgetRefused, false);
  assert.equal(result.stderr.includes(hidden), false);
  assert.equal(result.text.includes(hidden), false);
  assert.equal(allowance.includes(hidden), false);
  const reservations = Object.values(JSON.parse(allowance).reservations) as Array<{ settledUsd: number | null }>;
  assert.equal(reservations.length, 1);
  if (model.startsWith("claude-")) assert.equal(reservations[0]!.settledUsd, null);
  else assert.ok(reservations[0]!.settledUsd! > 0);
  return result;
}

test("cash bad-request diagnostics expose only allowlisted categories and signature booleans", async t => {
  for (const model of models) await t.test(model, async child => {
    const result = await refuse(child, Response.json({ error: { type: "invalid_request_error",
      message: `prompt is too long: ${hidden}`, private: hidden }, request_id: hidden }, { status: 400 }), model);
    assert.match(result.stderr, /HTTP 400/);
    assert.ok(result.stderr.includes('"error_category":"invalid_request_error"'), result.stderr);
    assert.ok(result.stderr.includes('"context_too_long":true'), result.stderr);
    assert.equal(result.stderr.includes('"message"'), false);
    assert.equal(result.stderr.includes('"private"'), false);
  });
});

test("cash bad-request diagnostics bound the complete response before classifying it", async t => {
  const prefix = JSON.stringify({ error: { type: "invalid_request_error", message: hidden } });
  const exact = prefix + " ".repeat(8192 - Buffer.byteLength(prefix));
  const admitted = await refuse(t, new Response(exact, { status: 400 }));
  assert.ok(admitted.stderr.includes('"error_category":"invalid_request_error"'));
  let cancelled = 0;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from(exact)); controller.enqueue(Buffer.from(" ")); },
    cancel() { cancelled++; },
  }), { status: 400, headers: { "content-length": "0" } });
  const refused = await refuse(t, oversized);
  assert.ok(refused.stderr.includes('"body_diagnostics":"oversized"'), refused.stderr);
  assert.equal(refused.stderr.includes("error_category"), false, "an oversized prefix is not a whole error envelope");
  assert.equal(cancelled, 1, "the unread tail is cancelled without consuming more chunks");
});

test("cash bad-request diagnostics keep malformed unknown and absent envelopes opaque", async t => {
  for (const body of ["{", "null", "[]", "{}", JSON.stringify({ error: [] }), JSON.stringify({ error: { type: hidden, message: hidden } }),
    JSON.stringify({ error: { type: hidden, message: "prompt is too long" } }),
    JSON.stringify({ error: { type: 42, message: hidden } }), JSON.stringify({ error: null })]) {
    const result = await refuse(t, new Response(body, { status: 400 }));
    assert.match(result.stderr, /HTTP 400/);
    assert.equal(result.stderr.includes("error_category"), false);
    assert.equal(result.stderr.includes("context_too_long"), false);
  }
  const empty = await refuse(t, new Response(null, { status: 400 }));
  assert.match(empty.stderr, /HTTP 400/);
  assert.equal(empty.stderr.includes("error_category"), false);
  const invalidUtf8 = await refuse(t, new Response(new Uint8Array([0xff]), { status: 400 }));
  assert.ok(invalidUtf8.stderr.includes('"body_diagnostics":"unreadable"'));
});

test("cash bad-request diagnostics preserve HTTP status when the default body stream fails", async t => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(Error(hidden)); } }), { status: 400 });
  const result = await refuse(t, response);
  assert.match(result.stderr, /HTTP 400/);
  assert.ok(result.stderr.includes('"body_diagnostics":"unreadable"'), result.stderr);
});

test("cash bad-request diagnostics refuse empty chunks and unreadable body ownership without leaking errors", async t => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  const emptyChunk = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array()); },
  }), { status: 400 });
  const emptyResult = await refuse(t, emptyChunk);
  assert.ok(emptyResult.stderr.includes('"body_diagnostics":"unreadable"'));
  const inaccessible = new Response(null, { status: 400 });
  Object.defineProperty(inaccessible, "body", { get() { throw Error(hidden); } });
  const inaccessibleResult = await refuse(t, inaccessible);
  assert.match(inaccessibleResult.stderr, /HTTP 400/);
  assert.ok(inaccessibleResult.stderr.includes('"body_diagnostics":"unreadable"'));
  const response = Response.json({ error: { type: "invalid_request_error" } }, { status: 400 });
  const body = response.body!, getReader = body.getReader.bind(body);
  let release: (() => void) | undefined;
  Object.defineProperty(body, "getReader", { value() {
    const reader = getReader(); release = reader.releaseLock.bind(reader);
    Object.defineProperty(reader, "releaseLock", { value() { throw Error(hidden); } });
    return reader;
  } });
  try {
    const result = await refuse(t, response);
    assert.ok(result.stderr.includes('"body_diagnostics":"unreadable"'));
    assert.equal(result.stderr.includes("error_category"), false);
  } finally { release?.(); await body.cancel(); }
  assert.ok(errors.length > 0, "cleanup refusal stays visible without retaining its exception text");
  assert.equal(JSON.stringify(errors).includes(hidden), false);
});

test("cash bad-request diagnostics never read other statuses or unknown diagnostic strings", async t => {
  for (const status of [401, 403, 429, 500]) {
    const response = new Response(JSON.stringify({ error: { type: "invalid_request_error", message: hidden } }), { status });
    const body = response.body!;
    Object.defineProperty(body, "getReader", { value() { throw Error("must not interpret another status"); } });
    const result = await refuse(t, response);
    assert.ok(result.stderr.includes(`HTTP ${status}`), result.stderr);
    assert.equal(result.stderr.includes("error_category"), false);
    assert.equal(result.stderr.includes("body_diagnostics"), false);
  }
});

test("cash bad-request body diagnostics obey the existing request deadline and caller cancellation", async t => {
  for (const model of models) for (const authority of ["deadline", "caller"]) await t.test(`${model} ${authority}`, async child => {
    const caller = new AbortController(); let cancelled = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { if (authority === "caller") queueMicrotask(() => caller.abort(Error("caller ended"))); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { status: 400 });
    const result = await refuse(child, response, model, caller.signal);
    assert.match(result.stderr, authority === "caller" ? /caller ended/ : /timed out|timeout/i);
    assert.equal(cancelled, 1);
    assert.equal(result.stderr.includes("error_category"), false);
  });
});
