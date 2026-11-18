/**
 * W1-T13684: serve's memory sample sized every holder in one turn of its request loop, every 3 minutes. Each snapshot
 * holder is walked node by node up to 200,000 nodes (approxBytes); on 2026-11-18 serve's loop-stall profiles carried
 * sampleServeMemory and its holder closures for 638 to 708 ms an hour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { approxBytes, approxBytesSliced, heldBodyBytesSliced, sampleServeMemory, sampleServeMemorySliced, snapshotHolder,
  viewBodiesHolder, type MemoryHolder } from "#src/lib/serve-memory.js";

/** A value of about `rows` x 12 nodes, shaped like a board snapshot. */
const big = (rows: number, tag = "") => ({
  rows: Array.from({ length: rows }, (_, i) => ({ number: i, title: `pull request ${i}${tag}`, labels: ["a", "b"],
    author: { login: "fleet", type: "Bot" }, body: "x".repeat(40) })),
  index: new Map(Array.from({ length: 50 }, (_, i) => [i, `row ${i}`])),
});
const usage = (): NodeJS.MemoryUsage => ({ rss: 1_000, heapTotal: 400, heapUsed: 300, external: 100, arrayBuffers: 10 });
const headroom = () => ({ limitBytes: 2_000, freeBytes: 1_000, fraction: 0.5 });

test("W1-T13684: a sliced walk yields the loop between slices and counts exactly what the whole walk counts", async () => {
  const value = big(2_000);
  let turns = 0;
  const bytes = await approxBytesSliced(value, async () => { turns += 1; }, undefined, 1_000);
  assert.equal(bytes, approxBytes(value));
  assert.ok(turns >= 20, `a ~24,000-node walk took ${turns} turns of at most 1,000 nodes`);
  assert.equal(await approxBytesSliced("plain", async () => { turns += 1; }), approxBytes("plain"));
  // The node budget bounds the sliced walk the same way: a lower bound, never a throw.
  assert.equal(await approxBytesSliced(value, async () => undefined, 500, 100), approxBytes(value, 500));
});

test("W1-T13684: invariant:same-reading — the sliced sample reports every holder exactly as the whole sample does", async () => {
  const fixed: MemoryHolder = { name: "legacy", kind: "legacy-cache", view: "now", size: () => ({ entries: 2, bytes: 64 }) };
  const broken: MemoryHolder = { name: "broken", kind: "measured", size: () => { throw new Error("gone"); },
    sizeSliced: async () => { throw new Error("gone"); } };
  const bodies = new Map([["now@1", { view: "now", generation: 1, body: big(300, "-now") }]]);
  const holders = [snapshotHolder("board", () => big(2_000)), viewBodiesHolder(() => bodies), fixed, broken,
    snapshotHolder("empty", () => undefined)];
  const workerHeaps = [{ name: "worker-heap:w", kind: "worker-heap" as const, entries: 1, bytes: 50 }];
  let turns = 0;
  const sliced = await sampleServeMemorySliced(holders, { usage, headroom, workerHeaps, turn: async () => { turns += 1; } });
  assert.deepEqual(sliced, sampleServeMemory(holders, { usage, headroom, workerHeaps }));
  assert.ok(turns > holders.length, `each holder took its own turn, and the large one several (${turns})`);
  assert.equal(sliced.holders.find((reading) => reading.name === "broken")?.error, "gone");
});

test("W1-T13684: a sliced view body size is memoized like a whole one, so a held body is walked once", async () => {
  const body = big(1_000, "-held");
  let turns = 0;
  const turn = async () => { turns += 1; };
  assert.equal(await heldBodyBytesSliced(body, turn), approxBytes(body));
  const first = turns;
  assert.ok(first > 0);
  assert.equal(await heldBodyBytesSliced(body, turn), approxBytes(body));
  assert.equal(turns, first, "the second read walked nothing");
});

test("W1-T13684: serve's sample runs between requests: a timer queued before it fires before it finishes", async () => {
  const holders = [snapshotHolder("board", () => big(5_000))];
  let fired = false;
  setTimeout(() => { fired = true; }, 0);
  let firedBeforeEnd = false;
  await sampleServeMemorySliced(holders, { usage, headroom }).then(() => { firedBeforeEnd = fired; });
  assert.equal(firedBeforeEnd, true);
});
