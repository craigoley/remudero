import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertSameTokens } from "#test/helpers/compression-pin.js";

// W1-T11342: a failing assert.deepEqual over two whole token arrays builds its diff in roughly quadratic
// memory (10,000 tokens: 9.2 GiB), so a real compression-pin failure ended as a killed runaway. These
// cases never hand a large array to assert.deepEqual.

type Token = [number, string, boolean];

function tokens(count: number): Token[] {
  return Array.from({ length: count }, (_, i): Token => [i % 7, `identifier${i}`, i % 3 === 0]);
}

function thrown(run: () => void): assert.AssertionError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof assert.AssertionError, `expected an AssertionError, got ${String(error)}`);
    return error;
  }
  assert.fail("assertSameTokens returned on token arrays that differ");
}

test("W1-T11342: assertSameTokens returns on equal token arrays", () => {
  assertSameTokens(tokens(50_000), tokens(50_000), "equal streams");
  assertSameTokens([], [], "empty streams");
});

// The runner's own 5 s timeout bounds the time. A synchronous body cannot be interrupted, so the test
// yields to a timer afterwards: an overrun's timeout timer is then due first and the test times out.
test("W1-T11342: two 50,000-entry token arrays differing at one index name it, bounded", { timeout: 5_000 }, async () => {
  const actual = tokens(50_000);
  const expected = tokens(50_000);
  expected[31_337] = [9, "changed", false];
  const error = thrown(() => assertSameTokens(actual, expected, "executable tokens must remain unchanged"));
  await delay(0);
  assert.ok(Buffer.byteLength(error.message) < 4096, `message is ${Buffer.byteLength(error.message)} bytes`);
  assert.match(error.message, /executable tokens must remain unchanged/);
  assert.match(error.message, /first difference at index 31337/);
  assert.match(error.message, /actual length 50000, expected length 50000/);
  assert.ok(error.message.includes('"changed"'));
  assert.ok(error.message.includes('"identifier31337"'));
  // At most 10 entries before and after the index, from each side: 21 per side.
  assert.ok(error.message.includes('"identifier31327"') && error.message.includes('"identifier31347"'));
  assert.ok(!error.message.includes('"identifier31326"') && !error.message.includes('"identifier31348"'));
  assert.equal(error.message.match(/"identifier\d+"/g)?.length, 41);
});

test("W1-T11342: token arrays that differ only in length name the first index past the shorter", () => {
  const error = thrown(() => assertSameTokens(tokens(50_000), tokens(40_000), "prefix"));
  assert.match(error.message, /first difference at index 40000/);
  assert.match(error.message, /actual length 50000, expected length 40000/);
  assert.ok(error.message.includes('"identifier40000"') && !error.message.includes('"identifier40011"'));
  assert.match(thrown(() => assertSameTokens([], tokens(3), "empty actual")).message, /first difference at index 0/);
});

test("W1-T11342: assertSameTokens renders entries JSON cannot and truncates a long one", () => {
  const long = "x".repeat(10_000);
  const { message } = thrown(() => assertSameTokens<unknown>([1n, undefined, long], [1n, undefined, "short"], "render"));
  assert.match(message, /first difference at index 2/);
  assert.ok(message.includes("1n") && message.includes("undefined"), message);
  assert.ok(message.includes(`"${"x".repeat(79)}…`) && !message.includes("x".repeat(81)), message);
});
