import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import * as gardener from "#src/lib/selector-shadow-gardener.js";
import { appendLedger } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const TS = "2026-10-27T23:40:00.0000000Z";
const shadow = (record: unknown) => `AFFECTED-SUITES-SHADOW: ${JSON.stringify(record)}`;

/** One complete eight-shard run; `selection` is what each shard's COVERAGE-SELECTION marker says. */
function run(id: number, failures: gardener.SelectorShadowFailure[], selection?: "narrow" | "all"): gardener.SelectorShadowRun {
  const record = { fullRun: false, floorSize: 80, narrowSize: 20 };
  const lines = Array.from({ length: gardener.SELECTOR_SHADOW_SHARDS }, (_, shard) => [
    ...(selection === undefined ? [] : [`coverage-shard (${shard + 1}/8)\t${TS} COVERAGE-SELECTION: ${selection}`]),
    `coverage-shard (${shard + 1}/8)\t${shadow({ ...record, failures: shard === 0 ? failures : [] })}`,
  ]).flat();
  return { id, headSha: `head-${id}`, baseSha: "base", prNumber: id, log: lines.join("\n") };
}

const missed: gardener.SelectorShadowFailure = { file: "test/missed.test.ts", floor: "selected", narrow: "missed" };
const caught: gardener.SelectorShadowFailure = { file: "test/caught.test.ts", floor: "selected", narrow: "selected" };
const inside: gardener.SelectorShadowFailure = { file: "test/inside.test.ts", floor: "selected", narrow: "selected" };

test("W1-T5891: selectorShadowReport counts a narrowed run but scores misses from full runs only", () => {
  const full = [run(1, [missed, caught]), run(2, [], "all")];
  const before = gardener.selectorShadowReport(full, 100);
  assert.equal(before.narrowed, 0);
  assert.equal(before.narrow.missRate, 0.5);
  assert.doesNotMatch(before.reason, /narrowed/, "a report of only full runs reads as before");

  const after = gardener.selectorShadowReport([...full, run(3, [inside], "narrow")], 100);
  assert.equal(after.narrowed, 1);
  assert.deepEqual(after.narrow, before.narrow, "a narrowed run's in-selection failure never lowers the miss rate");
  assert.deepEqual(after.floor, before.floor);
  assert.equal(after.runsComplete, before.runsComplete);
  assert.equal(after.narrowRuns, before.narrowRuns, "nor does it add to the saving evidence");
  assert.match(after.reason, /1 narrowed run\(s\) excluded as evidence \(W1-T5891\)/);

  // One narrowed shard narrows the run: the full suite did not execute.
  const mixed = run(4, [inside], "all");
  mixed.log = mixed.log.replace(`(8/8)\t${TS} COVERAGE-SELECTION: all`, `(8/8)\t${TS} COVERAGE-SELECTION: narrow`);
  assert.equal(gardener.selectorShadowReport([mixed], 100).narrowed, 1);
  // The step's echoed source names the marker without a mode; it is not one.
  const echoed = run(5, [inside]);
  echoed.log += `\ncoverage-shard (1/8)\t${TS}           echo "COVERAGE-SELECTION: \${SELECTION}"`;
  assert.equal(gardener.selectorShadowReport([echoed], 100).narrowed, 0);
});

test("W1-T5891: the gardener keeps the selection marker from the job logs", async () => {
  const jobs = Array.from({ length: gardener.SELECTOR_SHADOW_SHARDS }, (_, i) =>
    ({ id: 100 + i, name: `coverage-shard (${i + 1}/8)`, status: "completed", conclusion: "failure" }));
  const log = await gardener.readCoverageShardLogsAsync("acme", "remudero", 42, {
    readJson: async () => ({ total_count: jobs.length, jobs }),
    readText: async () => [`${TS} COVERAGE-SELECTION: narrow`, `${TS} unrelated output`,
      shadow({ fullRun: false, floorSize: 80, narrowSize: 20, failures: [] })].join("\n"),
  });
  assert.equal(log.split("\n").filter((l) => l.endsWith("COVERAGE-SELECTION: narrow")).length, gardener.SELECTOR_SHADOW_SHARDS);
  assert.doesNotMatch(log, /unrelated output/);
  assert.equal(gardener.selectorShadowReport([{ id: 42, headSha: "h", log }], 100).narrowed, 1);
  assert.equal(gardener.SELECTOR_SHADOW_READER_VERSION, 4, "a cached version-3 log dropped the marker and is read again");
});

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-narrowed-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  mkdirSync(join(root, "test"));
  const path = join(stateDir, "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(path, { run_id: "GARDEN-test", task_id: "DAEMON", step, ...extra });
  const deps = { repoRoot: root, stateDir, log,
    openWorkspace: (): never => { throw new Error("no miss here files a task"); } };
  const rows = (step: string) => readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((row) => row.step === step);
  const pass = (runs: gardener.SelectorShadowRun[]) => gardener.runSelectorShadowGardener(deps, () => runs, () => [],
    () => { throw new Error("no miss here reserves an id"); }, () => [], undefined, async () => []);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { stateDir, log, rows, pass };
}

test("W1-T5891: a stored narrowed observation stays out of the accumulated evidence", async (t) => {
  const h = harness(t);
  const first = await h.pass([run(1, [caught], "all"), run(2, [inside], "narrow")]);
  assert.equal(first.narrowed, 1);
  assert.equal(first.runsComplete, 1);
  assert.deepEqual(h.rows(gardener.SELECTOR_SHADOW_OBSERVATION_STEP).map((r) => [r.ci_run_id, r.narrowed]), [[1, undefined], [2, true]]);
  const stored = gardener.readSelectorShadowObservations(h.stateDir);
  assert.deepEqual(stored.observations.map((o) => [o.runId, o.narrowed]), [[1, undefined], [2, true]]);
  const again = await h.pass([]);
  assert.equal(again.narrowed, 1, "the fold over the store keeps excluding it");
  assert.deepEqual(again.narrow, first.narrow);
  h.log(gardener.SELECTOR_SHADOW_OBSERVATION_STEP, { ci_run_id: 9, head_sha: "h", source: "replay", full_run: false,
    floor_size: 80, narrow_size: 20, failures: [], recovered: 0, narrowed: "yes" });
  assert.equal(gardener.readSelectorShadowObservations(h.stateDir).unreadable, 1, "only `true` is a narrowed mark");
});
