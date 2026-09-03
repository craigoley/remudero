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

test("generateSandboxTask: reaches every shard in the project layer, including the smallest", () => {
  const index = realIndex();
  const shardNames = Object.keys(index.files).sort();
  // Sanity: the corpus really is lopsided (design ii) — some shard is meaningfully smaller than
  // the largest, and the loop below covers whichever one that is.
  //
  // DERIVED, NOT NAMED (W1-T2784). This line used to assert `smallest === "failures.yaml"`, and
  // its own comment recorded that it had ALREADY been re-hand-maintained once: "(Was ci.yaml,
  // tied at 6, until PR#2997 added two entries there — 8 now beats the tie.)" It drifted a second
  // time when W1-T2784 added one entry to failures.yaml (7) and testing.yaml (6) became the
  // smallest — reddening a test whose real claim, the loop below, was never in question. A
  // hand-maintained assertion about a DERIVED fact decays under any legitimate edit that had no
  // way to know; the fix is to derive it. This also honours this file's own header, which asks
  // that "reaches the smallest shard" be proven "against the real smallest shard, not a stand-in"
  // — a hardcoded name IS the stand-in.
  const smallest = shardNames.reduce((a, b) => (index.files[a].entries.length <= index.files[b].entries.length ? a : b));
  const largest = shardNames.reduce((a, b) => (index.files[a].entries.length >= index.files[b].entries.length ? a : b));
  assert.ok(
    index.files[smallest]!.entries.length < index.files[largest]!.entries.length,
    `the corpus must stay lopsided for this proof to mean anything — smallest ${smallest} ` +
      `(${index.files[smallest]!.entries.length}) vs largest ${largest} (${index.files[largest]!.entries.length})`,
  );
  assert.ok(shardNames.includes(smallest), "the smallest shard is one the loop below actually covers");

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

test("generateSandboxTask: falls back to the per-shard isolating union when no single path reaches the combo", () => {
  const index = realIndex();
  // ci.yaml + platform.yaml has no single literal path that selects that exact pair in one
  // hop under the real corpus — this combo forces the fallback branch design (iii)
  // describes: one isolating path PER shard, unioned, rather than the single-path
  // shortcut. (W1-T2507: architecture.yaml + ci.yaml, this test's pair before that task,
  // GAINED a single-hop path — src/lib/open-prs-rest.ts, now owned by exactly those two
  // shards — once architecture.yaml picked up path-scoped facts migrated out of CLAUDE.md,
  // so it no longer exercises the fallback branch this test proves; re-pick a still-disjoint
  // pair here rather than asserting a stale premise.)
  const subject = generateSandboxTask(index, ["ci.yaml", "platform.yaml"], 0);
  assert.deepEqual(subject.selectedShards, ["ci.yaml", "platform.yaml"]);
  assert.ok(subject.files.length >= 2, "the fallback must union one path per shard, not reuse a single hop");
});

test("generateSandboxTask: refuses a shard with no isolating literal path in the fallback branch", () => {
  // A hand-seeded minimal fixture (not the real corpus) is the only way to prove this refusal:
  // the real project-layer corpus provides an isolating path for every shard it carries today
  // (design iii's own note), so this edge only exists for a corpus shaped like this one, where
  // 'wildcard-only' carries nothing but a `*`-glob and so can never isolate itself.
  const fixture: LearningsIndex = {
    files: {
      "literal-only.yaml": { entries: ["e1"], globs: ["src/lib/only-here.ts"] },
      "wildcard-only.yaml": { entries: ["e2"], globs: ["*.md"] },
    },
    bySubsystem: {},
  };
  assert.throws(
    () => generateSandboxTask(fixture, ["literal-only.yaml", "wildcard-only.yaml"], 0),
    /no isolating literal path/,
  );
});
