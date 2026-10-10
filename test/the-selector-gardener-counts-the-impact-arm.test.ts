import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import * as gardener from "../src/lib/selector-shadow-gardener.js";
import { shadowRecord } from "../src/lib/affected-suites.js";
import { appendLedger } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const line = (record: unknown) => `AFFECTED-SUITES-SHADOW: ${JSON.stringify(record)}`;
const hit = (file = "test/hit.test.ts") => ({ file, floor: "selected", narrow: "selected", impact: "selected" });
const record = (failures: unknown[] = [hit()], impactSize = 10) =>
  ({ fullRun: false, floorSize: 80, narrowSize: 20, impactSize, failures });

function run(id: number, row: ReturnType<typeof record> & { impactFallback?: string }): gardener.SelectorShadowRun {
  return { id, headSha: `head-${id}`, baseSha: "base", prNumber: id,
    log: Array.from({ length: gardener.SELECTOR_SHADOW_SHARDS }, (_, shard) =>
      `coverage-shard (${shard + 1}/8)\t${line({ ...row, failures: shard === 0 ? row.failures : [] })}`,
    ).join("\n") };
}

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-impact-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  mkdirSync(join(root, "test"));
  const path = join(stateDir, "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(path, { run_id: "GARDEN-test", task_id: "DAEMON", step, ...extra });
  const deps = { repoRoot: root, stateDir, log,
    openWorkspace: (): never => { throw new Error("an unattributed miss cannot file a task"); } };
  const rows = (step: string) => readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((row) => row.step === step);
  const pass = (runs: gardener.SelectorShadowRun[], mainFailures?: gardener.SelectorShadowMainFailures,
    options?: Parameters<typeof gardener.runSelectorShadowGardener>[7]) =>
    gardener.runSelectorShadowGardener(deps, () => runs, () => [],
      () => { throw new Error("an unattributed miss cannot reserve an id"); }, () => [], undefined, mainFailures, options);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { stateDir, log, rows, pass };
}

describe("test/the-selector-gardener-counts-the-impact-arm.test.ts", () => {
  test("impact fields survive parsing, including the installed producer's fallback shape", () => {
    const produced = shadowRecord({ fullRun: false, suites: ["test/hit.test.ts"], narrow: ["test/hit.test.ts"],
      impact: ["test/hit.test.ts"], impactFallback: "absent", reasons: [],
      recentOnly: { floor: [], narrow: [], impact: [] } }, ["test/hit.test.ts"]);
    assert.deepEqual(gardener.parseSelectorShadowLines(line(produced)), [produced]);
    const flakes = record([{ ...hit(), impact: "flake" }], 0);
    assert.deepEqual(gardener.parseSelectorShadowLines(line(flakes)), [flakes]);
    const legacy = { fullRun: true, floorSize: 100, failures: [{ file: "test/a.test.ts", floor: "selected" }] };
    assert.deepEqual(gardener.parseSelectorShadowLines(line(legacy)), [legacy]);
  });

  test("the report folds impact selections, attributed misses, flakes and median savings beside narrow", () => {
    const report = gardener.selectorShadowReport([
      run(1, record([hit(), { ...hit("test/missed.test.ts"), impact: "missed" },
        { ...hit("test/flake.test.ts"), impact: "flake" }], 10)),
      run(2, record([hit("test/second.test.ts")], 30)),
    ], 100);
    assert.deepEqual([report.impact.failures, report.impact.selected, report.impact.missed, report.impact.missRate,
      report.impact.medianSize, report.impact.medianSavingPercent, report.impact.runs], [3, 2, 1, 1 / 3, 20, 80, 2]);
    assert.deepEqual([report.narrow.selected, report.narrow.missed, report.narrow.medianSize], [4, 0, 20]);
    assert.equal(report.flakes.impact, 1);
    assert.deepEqual(report.misses.map((m) => [m.selection, m.file]), [["impact", "test/missed.test.ts"]]);
    assert.equal(report.impact.verdict, "misses");
    assert.equal(report.verdict, "misses");
  });

  test("malformed or half-present impact fields refuse the whole row", () => {
    for (const impactSize of [-1, 1.5, "10", null]) {
      assert.throws(() => gardener.parseSelectorShadowLines(line({ ...record(), impactSize })), /invalid record/);
    }
    for (const invalid of [
      { ...record(), impactSize: undefined },
      record([{ file: "test/a.test.ts", floor: "selected", narrow: "selected" }]),
      record([{ ...hit(), impact: "unknown" }]),
      { ...record(), impactFallback: "" },
      { ...record(), impactFallback: 42 },
      { fullRun: false, floorSize: 1, impactFallback: "absent", failures: [] },
    ]) assert.throws(() => gardener.parseSelectorShadowLines(line(invalid)), /invalid/);
    const mixed = run(3, record());
    mixed.log = mixed.log.replace(line({ ...record(), failures: [] }), line({ fullRun: false, floorSize: 80, failures: [] }));
    assert.throws(() => gardener.selectorShadowReport([mixed], 100), /impact/);
  });

  test("fallback reasons count once per run and contribute no impact evidence or savings", () => {
    const report = gardener.selectorShadowReport([
      run(1, record([hit()], 20)),
      run(2, { ...record([hit(), { ...hit("test/not-impact.test.ts"), impact: "missed" }], 0), impactFallback: "absent" }),
      run(3, { ...record([{ ...hit(), impact: "flake" }], 1), impactFallback: "stale" }),
      run(4, { ...record([], 2), impactFallback: "absent" }),
    ], 100);
    assert.deepEqual(report.impact.fallbacks, { absent: 2, stale: 1 });
    assert.deepEqual([report.impact.runs, report.impact.selected, report.impact.missed, report.impact.medianSize,
      report.flakes.impact, report.unattributed.impact], [1, 1, 0, 20, 0, 0]);
    assert.deepEqual(report.misses, []);
    assert.equal(report.narrow.failures, 4);
  });

  test("impact-only misses use retry recovery and mass attribution without counting fallback misses", () => {
    const files = Array.from({ length: gardener.SELECTOR_SHADOW_MASS_FAILURE_FILES + 1 }, (_, i) => `test/mass-${i}.test.ts`);
    const report = gardener.selectorShadowReport([
      run(1, record([{ ...hit(), impact: "missed", retry: "recovered" }])),
      run(2, record(files.map((file) => ({ ...hit(file), impact: "missed" })))),
      run(3, { ...record(files.map((file) => ({ ...hit(file), impact: "missed" }))), impactFallback: "absent" }),
    ], 100);
    assert.equal(report.impact.failures, 0);
    assert.equal(report.unattributed.impact, files.length + 1);
    assert.deepEqual(report.unattributed.misses.map((m) => [m.selection, m.reason]),
      [["impact", "retry_recovered"], ...files.map(() => ["impact", "mass"])]);
    assert.deepEqual(report.misses, []);
    const fallbackWithNarrowMiss = gardener.selectorShadowReport([run(4, {
      ...record(files.map((file, i) => ({ ...hit(file), narrow: i === 0 ? "missed" : "selected", impact: "missed" }))),
      impactFallback: "absent",
    })], 100);
    assert.equal(fallbackWithNarrowMiss.narrow.missed, 1);
    assert.deepEqual(fallbackWithNarrowMiss.misses.map((m) => m.selection), ["narrow"]);
  });

  test("live impact attribution and fallback reasons survive storage and source reports", async (t) => {
    const h = harness(t);
    const first = await h.pass([
      run(1, record([{ ...hit(), impact: "missed" }])),
      run(2, { ...record([hit()], 0), impactFallback: "absent" }),
    ], async () => ["test/hit.test.ts"]);
    assert.equal(first.unattributed.impact, 1);
    assert.equal(first.impact.failures, 0);
    assert.deepEqual(first.impact.fallbacks, { absent: 1 });
    assert.deepEqual(h.rows(gardener.SELECTOR_SHADOW_OBSERVATION_STEP).map((r) =>
      [r.impact_size, r.impact_fallback, (r.failures as gardener.SelectorShadowFailure[])[0]?.impact]),
    [[10, undefined, "missed"], [0, "absent", "selected"]]);
    const stored = gardener.readSelectorShadowObservations(h.stateDir).observations;
    assert.equal(stored[0]!.failures[0]!.unattributed, "base_red");
    assert.equal(stored[1]!.impactFallback, "absent");
    const again = await h.pass([]);
    assert.deepEqual(again.impact, first.impact);
    assert.deepEqual(again.live.impact, first.impact);
    assert.equal(again.unattributed.misses[0]!.selection, "impact");
    assert.deepEqual(h.rows("selector-shadow.report").at(-1)!.impact, first.impact);
    h.log(gardener.SELECTOR_SHADOW_OBSERVATION_STEP, { ci_run_id: 9, head_sha: "replay", source: "replay",
      full_run: false, floor_size: 80, narrow_size: 20, impact_size: 5, failures: [hit()], recovered: 0 });
    const replayed = await h.pass([]);
    assert.deepEqual([replayed.replay.impact!.runs, replayed.replay.impact!.selected, replayed.replay.impact!.medianSize], [1, 1, 5]);
  });

  test("flake history stamps an impact-only miss and stored malformed impact rows are unreadable", async (t) => {
    const h = harness(t);
    const observation: gardener.SelectorShadowObservation = { runId: 1, headSha: "h", source: "live", ...record([{ ...hit(), impact: "missed" }]) as gardener.SelectorShadowRecord, recovered: 0 };
    const attributed = await gardener.attributeSelectorShadowObservation(observation, { recoveredInWindow: new Set(["test/hit.test.ts"]) });
    assert.equal(attributed.failures[0]!.unattributed, "flake_history");
    const stored = { ci_run_id: 1, head_sha: "h", source: "replay", full_run: false,
      floor_size: 80, narrow_size: 20, impact_size: 10, failures: [hit()], recovered: 0 };
    for (const [i, bad] of [
      { impact_size: -1 }, { impact_size: undefined }, { failures: [{ ...hit(), impact: "maybe" }] },
      { failures: [{ file: "test/a.test.ts", floor: "selected", narrow: "selected" }] }, { impact_fallback: "" },
    ].entries()) h.log(gardener.SELECTOR_SHADOW_OBSERVATION_STEP, { ...stored, ...bad, ci_run_id: i + 1 });
    const read = gardener.readSelectorShadowObservations(h.stateDir);
    assert.equal(read.unreadable, 5);
    assert.deepEqual(read.observations, []);
  });

  test("recomputed historical impact selections and fallbacks are persisted and folded by source", async (t) => {
    const h = harness(t);
    const created = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const readJson = async (args: string[]) => args[1]!.includes("/workflows/")
      ? { workflow_runs: [11, 12].map((id) => ({ id, head_sha: `replay-${id}`, status: "completed", conclusion: "failure",
        created_at: created, pull_requests: [{ number: id, base: { sha: "base" } }] })) }
      : { total_count: 8, jobs: Array.from({ length: 8 }, (_, shard) => ({
        id: shard + 1, name: `coverage-shard (${shard + 1}/8)`, status: "completed", conclusion: shard === 0 ? "failure" : "success",
      })) };
    const readText = async (args: string[]) => line(record(args[1]!.includes("/jobs/1/") ? [hit()] : []));
    const select: NonNullable<gardener.SelectorShadowReplay["select"]> = async (historical) => ({
      record: { fullRun: false, floorSize: 80, narrowSize: 20, impactSize: historical.id === 11 ? 5 : 0,
        ...(historical.id === 11 ? {} : { impactFallback: "absent" }), failures: [hit()] }, reasons: [],
    });
    const report = await h.pass([], undefined, { replay: { owner: "o", repo: "r", readJson, readText, select } });
    assert.deepEqual([report.impact.runs, report.impact.selected, report.impact.medianSize, report.impact.fallbacks], [1, 1, 5, { absent: 1 }]);
    assert.deepEqual(report.replay.impact, report.impact);
    assert.deepEqual(h.rows(gardener.SELECTOR_SHADOW_OBSERVATION_STEP).map((r) => [r.source, r.impact_size, r.impact_fallback]),
      [["replay", 5, undefined], ["replay", 0, "absent"]]);
    assert.deepEqual((await h.pass([])).impact, report.impact);
  });

  test("readiness names each arm's own evidence and fallbacks cannot certify impact", () => {
    const enough = Array.from({ length: gardener.SELECTOR_SHADOW_MIN_RUNS }, (_, i) => run(i + 1, record([hit()])));
    const ready = gardener.selectorShadowReport(enough, 100);
    assert.equal(ready.impact.verdict, "ready");
    assert.match(ready.reason, /narrow:.*impact: ready.*40 failures.*40.*runs/);
    const missed = gardener.selectorShadowReport([
      run(1, record([{ ...hit(), impact: "missed" }])), ...enough.slice(1),
    ], 100);
    assert.equal(missed.impact.verdict, "misses");
    assert.equal(missed.verdict, "misses");
    assert.match(missed.reason, /narrow: ready.*repair the other selector arms' misses.*impact: misses/);
    const absent = gardener.selectorShadowReport(enough.map((r) => ({ ...r,
      log: r.log.replaceAll('"impactSize":10,', "").replaceAll(',"impact":"selected"', "") })), 100);
    assert.equal(absent.impact.verdict, "insufficient");
    assert.equal(absent.impact.runs, 0);
    const fallback = gardener.selectorShadowReport(enough.map((r) => ({ ...r,
      log: r.log.replaceAll('"impactSize":10,', '"impactSize":10,"impactFallback":"absent",') })), 100);
    assert.equal(fallback.impact.verdict, "insufficient");
    assert.deepEqual([fallback.impact.failures, fallback.impact.medianSize, fallback.impact.fallbacks.absent], [0, null, 40]);
    assert.match(fallback.reason, /impact: insufficient.*0 failures.*0.*runs.*40 fallback/);
    const short = gardener.selectorShadowReport(enough.map((r, i) => i === 0
      ? run(1, record(Array.from({ length: gardener.SELECTOR_SHADOW_MIN_FAILURES }, (_, n) => hit(`test/hit-${n}.test.ts`)))) : ({ ...r,
      log: r.log.replaceAll('"impactSize":10,', '"impactSize":10,"impactFallback":"absent",') })), 100);
    assert.equal(short.impact.verdict, "insufficient");
    assert.equal(short.impact.runs, 1);
    assert.equal(short.impact.failures, gardener.SELECTOR_SHADOW_MIN_FAILURES);
    const flakes = gardener.selectorShadowReport(enough.map((r) => ({ ...r,
      log: r.log.replaceAll('"impact":"selected"', '"impact":"flake"') })), 100);
    assert.equal(flakes.impact.verdict, "insufficient");
    assert.equal(flakes.flakes.impact, 40);
    const incomplete = gardener.selectorShadowReport([...enough, { id: 99, headSha: "missing", log: "" }], 100);
    assert.equal(incomplete.impact.verdict, "insufficient");
    const fewFailures = gardener.selectorShadowReport(enough.map((r, i) => i < gardener.SELECTOR_SHADOW_MIN_FAILURES - 1
      ? r : run(i + 1, record([{ ...hit(), impact: "flake" }]))), 100);
    assert.equal(fewFailures.impact.verdict, "insufficient");
    assert.equal(fewFailures.impact.failures, gardener.SELECTOR_SHADOW_MIN_FAILURES - 1);
    const exactFailures = gardener.selectorShadowReport(enough.map((r, i) => i < gardener.SELECTOR_SHADOW_MIN_FAILURES
      ? r : run(i + 1, record([{ ...hit(), impact: "flake" }]))), 100);
    assert.equal(exactFailures.impact.verdict, "ready");
    const noNarrow = enough.map((r) => ({ ...r,
      log: r.log.replaceAll('"narrowSize":20,', "").replaceAll(',"narrow":"selected"', "") }));
    const impactOnly = gardener.selectorShadowReport(noNarrow, 100);
    assert.equal(impactOnly.impact.verdict, "ready");
    assert.match(impactOnly.reason, /narrow: insufficient, 0 failures across 0 complete runs.*impact: ready/);
    const oneNarrow = gardener.selectorShadowReport([enough[0]!, ...noNarrow.slice(1)], 100);
    assert.equal(oneNarrow.verdict, "insufficient");
    assert.equal(oneNarrow.narrowRuns, 1);
  });
});
