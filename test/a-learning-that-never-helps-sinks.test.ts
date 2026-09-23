/**
 * test/a-learning-that-never-helps-sinks.test.ts — W1-T4091.
 *
 * `selectLearnings` broke ties by the `cited` date, which moved on every injection, so the fact
 * injected 325 times kept winning whether or not it helped. Within equal match strength it now
 * ranks by a seeded draw from each learning's Beta posterior over its offered/used history.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderDigest, renderLearningUsefulness, summarize, summarizeLearningUsefulness } from "../src/lib/digest.js";
import {
  foldLearningUsage,
  leastUsefulLearnings,
  learningUsagePath,
  learningValue,
  readLearningUsage,
  recordLearningUsage,
  sampleBeta,
  seededRandom,
  seedOf,
  type LearningUsage,
} from "../src/lib/knowledge-value.js";
import { selectLearnings, type LearningEntry } from "../src/lib/learnings.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { logLearningsUsed } from "../src/run-task.js";

const entry = (id: string, cited = "2026-09-22"): LearningEntry =>
  ({ id, subsystem: "t", lifecycle: "active", files: ["src/x.ts"], fact: `fact ${id}`, src: "t", cited }) as LearningEntry;

/** How often each id lands first over many seeded runs. */
function firstPlace(entries: LearningEntry[], usage: LearningUsage, runs = 400): Record<string, number> {
  const wins: Record<string, number> = {};
  for (let seed = 1; seed <= runs; seed++) {
    const first = selectLearnings(entries, ["src/x.ts"], 100_000, { usage, seed }).selected[0]!.id;
    wins[first] = (wins[first] ?? 0) + 1;
  }
  return wins;
}

test("W1-T4091: a learning injected often and never used sinks below one that is used", () => {
  // `stale` has the NEWER cited date, so the old tiebreak would always put it first.
  const entries = [entry("stale", "2026-09-22"), entry("useful", "2026-01-01")];
  const usage: LearningUsage = { stale: { offered: 300, used: 0 }, useful: { offered: 10, used: 8 } };
  const control = selectLearnings(entries, ["src/x.ts"], 100_000).selected.map((e) => e.id);
  assert.deepEqual(control, ["stale", "useful"], "control: without usage the cited date decides");
  const wins = firstPlace(entries, usage);
  assert.equal(wins.useful, 400, "the used learning ranks first in every run");
  assert.ok(learningValue("stale", usage).mean < 0.01);
  // Match strength still comes first: usage only orders entries of EQUAL strength.
  const stronger = { ...entry("stale"), symbols: ["loadThing"] } as LearningEntry;
  const withSymbol = selectLearnings([stronger, entry("useful")], ["src/x.ts"], 100_000, { usage, seed: 1, text: "calls loadThing" });
  assert.equal(withSymbol.selected[0]!.id, "stale");
});

test("W1-T4091: a learning with no history still gets selected sometimes", () => {
  const entries = [entry("known"), entry("new")];
  // A middling record: used about half the time.
  const usage: LearningUsage = { known: { offered: 40, used: 20 } };
  const wins = firstPlace(entries, usage);
  assert.ok((wins.new ?? 0) > 40 && (wins.known ?? 0) > 40, `both get tried: ${JSON.stringify(wins)}`);
});

test("W1-T4091: a run's selection is reproducible from its seed", () => {
  const entries = ["a", "b", "c", "d"].map((id) => entry(id));
  const usage: LearningUsage = { a: { offered: 5, used: 2 }, b: { offered: 5, used: 3 }, c: { offered: 1, used: 0 } };
  const order = (seed: number) => selectLearnings(entries, ["src/x.ts"], 100_000, { usage, seed }).selected.map((e) => e.id);
  assert.deepEqual(order(seedOf("run-1")), order(seedOf("run-1")));
  const orders = new Set(Array.from({ length: 30 }, (_, i) => order(i).join(",")));
  assert.ok(orders.size > 1, "different seeds explore different orders");
  // Input order does not change a seeded result.
  assert.deepEqual(
    selectLearnings([...entries].reverse(), ["src/x.ts"], 100_000, { usage, seed: 7 }).selected.map((e) => e.id),
    order(7),
  );
});

test("W1-T4091: the digest names the most injected unused learnings", () => {
  const rows = [
    { ts: "2026-09-23T01:00:00.000Z", step: "learnings.used", injected_ids: ["never", "often"], used_ids: ["often"], refused: [] },
    { ts: "2026-09-23T02:00:00.000Z", step: "learnings.used", injected_ids: ["never", "often"], used_ids: ["often"], refused: [] },
    { ts: "2026-09-23T03:00:00.000Z", step: "learnings.used", silent: true, injected_ids: ["never"] },
    { ts: "2026-09-23T04:00:00.000Z", step: "learnings.injected", matched_ids: ["never"] },
  ];
  const u = summarizeLearningUsefulness(rows as never)!;
  assert.deepEqual({ reports: u.reports, silent: u.silent, offered: u.offered, used: u.used }, { reports: 2, silent: 1, offered: 4, used: 2 });
  assert.equal(u.leastUseful[0]!.id, "never");
  const line = renderLearningUsefulness(u);
  assert.match(line, /learnings used: 2 of 4 offered \(50%\)/);
  assert.match(line, /least useful: never \(0\/2\)/);
  assert.match(renderDigest(summarize(rows as never, "2026-09-23T00:00:00.000Z")), /learnings used: 2 of 4 offered .*least useful: never/, "the daily digest carries the line");
  assert.equal(summarizeLearningUsefulness([] as never), undefined, "no rows: the line is left out");
  assert.match(renderLearningUsefulness({ reports: 0, silent: 1, offered: 0, used: 0, leastUseful: [] }), /\(n\/a\).*none yet/);
});

test("W1-T4091: the usage store folds each run and survives a bad file", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4091-`));
  const path = learningUsagePath(dir);
  assert.deepEqual(readLearningUsage(path), {});
  recordLearningUsage(path, { injected_ids: ["a", "b"], used_ids: ["a"] });
  recordLearningUsage(path, { silent: true, injected_ids: ["a"] });
  recordLearningUsage(path, { injected_ids: ["a"], used_ids: [] });
  assert.deepEqual(readLearningUsage(path), { a: { offered: 2, used: 1 }, b: { offered: 1, used: 0 } });
  writeFileSync(path, "{ torn");
  assert.deepEqual(readLearningUsage(path), {});
  writeFileSync(path, "[]");
  assert.deepEqual(readLearningUsage(path), {});
  // Malformed rows fold to nothing rather than throwing.
  assert.deepEqual(foldLearningUsage([{ step: "learnings.used", injected_ids: "x" }, { step: "other" }]), {});
  assert.deepEqual(leastUsefulLearnings({ z: { offered: 1, used: 1 }, y: { offered: 1, used: 1 } }, 1).map((l) => l.id), ["y"]);
});

test("W1-T4091: the Beta draw is a proper sample", () => {
  const rng = seededRandom(42);
  const draws = Array.from({ length: 4000 }, () => sampleBeta({ alpha: 2, beta: 6, mean: 0.25 }, rng));
  assert.ok(draws.every((x) => x > 0 && x < 1));
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.25) < 0.02, `mean ${mean}`);
  const small = Array.from({ length: 2000 }, () => sampleBeta({ alpha: 0.5, beta: 0.5, mean: 0.5 }, rng));
  assert.ok(Math.abs(small.reduce((a, b) => a + b, 0) / small.length - 0.5) < 0.05, "shape below one is sampled too");
});

test("W1-T4091: each run's report updates the usage store that selection reads", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4091-run-`));
  const path = learningUsagePath(dir);
  const rows: string[] = [];
  logLearningsUsed((step) => rows.push(step), "LEARNINGS_USED: learnings#a", ["a", "b"], path);
  logLearningsUsed((step) => rows.push(step), "no report line", ["a"], path);
  logLearningsUsed((step) => rows.push(step), "LEARNINGS_USED: none", ["b"]);
  assert.deepEqual(rows, ["learnings.used", "learnings.used", "learnings.used"]);
  assert.deepEqual(readLearningUsage(path), { a: { offered: 1, used: 1 }, b: { offered: 1, used: 0 } }, "silent and unrecorded runs change nothing");
});

