import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadLearningsIndex, type LearningsIndex } from "../src/lib/learnings.js";
import { generateSandboxTask } from "../src/lib/wipe-test.js";

// W1-T1253 — the wipe-test harness's design says signal comes only from an AGGREGATE over
// many SEEDED pairs, but nothing seeded: `generateSandboxTask` is the subject GENERATOR
// that supplies fresh, distinct subjects on demand instead of drawing from the sandbox's
// original three (already-merged) tasks. These proofs run against the REAL, committed
// `learnings/index.json` — the actual project-layer corpus this generator has to reach,
// not a hand-picked fixture — so a claim like "reaches the smallest shard" is proven
// against the real smallest shard, not a stand-in.

const REPO_ROOT = join(new URL("..", import.meta.url).pathname);

function realIndex(): LearningsIndex {
  const index = loadLearningsIndex(join(REPO_ROOT, "learnings", "index.json"));
  assert.ok(index, "learnings/index.json must load for these proofs to mean anything");
  return index;
}

test("generateSandboxTask: a generated subject selects the shard it was asked to select", () => {
  const index = realIndex();
  const subject = generateSandboxTask(index, ["architecture.yaml"], 0);
  assert.deepEqual(subject.selectedShards, ["architecture.yaml"]);
  assert.ok(subject.files.length > 0);
});

test("generateSandboxTask: successive generated subjects are distinct, not drawn from a fixed list that runs out", () => {
  const index = realIndex();
  // The sandbox's original hand-written supply was exactly three (SBX-T1/2/3), and once
  // their work merged it was spent. Ask for far more than three to prove this generator
  // never runs dry.
  const ids = new Set<string>();
  for (let seq = 0; seq < 50; seq++) {
    ids.add(generateSandboxTask(index, ["platform.yaml"], seq).id);
  }
  assert.equal(ids.size, 50, "every generated subject id must be distinct");
});

test("generateSandboxTask: reaches every shard in the project layer, including the smallest (ci.yaml)", () => {
  const index = realIndex();
  const shardNames = Object.keys(index.files).sort();
  // Sanity: the corpus really is lopsided (design ii) — ci.yaml really is the smallest.
  const smallest = shardNames.reduce((a, b) => (index.files[a].entries.length <= index.files[b].entries.length ? a : b));
  assert.equal(smallest, "ci.yaml");

  for (const shard of shardNames) {
    const subject = generateSandboxTask(index, [shard], 0);
    assert.deepEqual(subject.selectedShards, [shard], `requesting only '${shard}' must select only '${shard}'`);
  }
});

test("generateSandboxTask: a subject whose paths select two shards is reported as selecting both, not one", () => {
  const index = realIndex();
  // ci.yaml and failures.yaml overlap on src/lib/review.ts (design ii's own example class):
  // a naive generator that reasoned "I asked for two shards, so I must have used two paths"
  // would misreport this. The real lookup must not.
  const subject = generateSandboxTask(index, ["ci.yaml", "failures.yaml"], 0);
  assert.deepEqual(subject.selectedShards, ["ci.yaml", "failures.yaml"]);
});

test("generateSandboxTask: refuses an empty shard request rather than emitting a meaningless subject", () => {
  const index = realIndex();
  assert.throws(() => generateSandboxTask(index, [], 0), /at least one shard/);
});

test("generateSandboxTask: refuses a shard name the index does not carry", () => {
  const index = realIndex();
  assert.throws(() => generateSandboxTask(index, ["not-a-real-shard.yaml"], 0), /unknown shard/);
});
