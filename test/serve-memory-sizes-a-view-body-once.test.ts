/**
 * W1-T13331: serve's memory sampler walked every held view body's objects on the main thread every three minutes
 * (603 ms inside main-thread stalls in the hour to 04:03Z on 2026-11-17). A held body never changes, so it is sized once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { approxBytes, heldBodyBytes, viewBodiesHolder } from "#src/lib/serve-memory.js";

type Entry = { view: string; generation: number; body: unknown };
const body = (n: number) => ({ data: { rows: Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, text: "x".repeat(20) })) } });

test("W1-T13331 criterion 1: a second sample walks no body; a new generation's body is walked once", () => {
  const walked: unknown[] = [];
  const walk = (value: unknown) => (walked.push(value), approxBytes(value));
  const entries = new Map<string, Entry>([["inbox:a", { view: "inbox", generation: 1, body: body(10) }], ["now:core", { view: "now", generation: 1, body: body(5) }]]);
  const holder = viewBodiesHolder(() => entries, walk);
  holder.size();
  assert.equal(walked.length, 2, "positive control: the first sample walks each body");
  holder.size();
  assert.equal(walked.length, 2, "the second sample walks none");
  const next = body(12);
  entries.set("inbox:a", { view: "inbox", generation: 2, body: next });
  holder.size();
  assert.deepEqual(walked.slice(2), [next], "only the new generation's body is walked");
});

test("W1-T13331 criterion 2: the sample's entries, bytes and parts equal a fresh walk of the same bodies", () => {
  const entries = new Map<string, Entry>([
    ["inbox:a", { view: "inbox", generation: 1, body: body(30) }], ["inbox:b", { view: "inbox", generation: 1, body: body(3) }],
    ["now:core", { view: "now", generation: 4, body: body(7) }], ["odd", { view: "odd", generation: 1, body: "a string body" }],
  ]);
  const holder = viewBodiesHolder(() => entries);
  holder.size();
  const memo = holder.size() as { entries: number; bytes: number; parts: Record<string, { entries: number; bytes: number }> };
  const fresh = viewBodiesHolder(() => entries, (value) => approxBytes(value)).size();
  const parts: Record<string, { entries: number; bytes: number }> = {};
  let bytes = 0;
  for (const e of entries.values()) {
    const size = approxBytes(e.body);
    const part = (parts[`${e.view}@g${e.generation}`] ??= { entries: 0, bytes: 0 });
    part.entries += 1; part.bytes += size; bytes += size;
  }
  assert.deepEqual(memo, { entries: entries.size, bytes, parts });
  assert.deepEqual(fresh, memo);
});

test("W1-T13331 criterion 3: the memo is keyed by the body object (module-level), and a non-object body is sized directly each time", () => {
  const walked: unknown[] = [];
  const walk = (value: unknown) => (walked.push(value), approxBytes(value));
  const shared = body(4);
  const first = heldBodyBytes(shared, walk);
  // a different holder/map with the SAME body object, and a different generation, still finds the memo
  const entries = new Map<string, Entry>([["other:x", { view: "other", generation: 9, body: shared }]]);
  const sample = viewBodiesHolder(() => entries, walk).size() as { bytes: number };
  assert.deepEqual(walked, [shared], "the shared body object was walked once across holders");
  assert.equal(sample.bytes, first);
  // a structurally equal but distinct object is a different key, so it is walked
  heldBodyBytes(body(4), walk);
  assert.equal(walked.length, 2, "a distinct object is walked");
  // non-object bodies are not memoized: each call walks them
  heldBodyBytes("a string body", walk);
  heldBodyBytes("a string body", walk);
  heldBodyBytes(42, walk);
  assert.deepEqual(walked.slice(2), ["a string body", "a string body", 42]);
});
