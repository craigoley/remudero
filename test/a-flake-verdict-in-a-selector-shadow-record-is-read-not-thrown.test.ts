// W1-T5952: src/lib/affected-suites.ts's shadowRecord labels a failure caught only because
// recentFailures rescued its suite "flake" (W1-T4462). parseSelectorShadowLines accepted only
// "selected"/"missed" and threw "invalid failure verdict", so the first shadow record carrying a flake
// would stop the whole gardener pass — the evidence gate for narrowing PR CI. A flake is now read and
// counted on its own: neither a selection nor a miss, it never satisfies or fails the verdict.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A namespace import: `flakes` is new, so this suite still loads (and fails) at the base sha.
import * as gardener from "../src/lib/selector-shadow-gardener.js";
import { appendLedger } from "../src/lib/ledger.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const STEP = "selector-shadow.observation";
const NOW = Date.parse("2026-10-06T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => clockFromMillisFn(() => ms).iso();

type Failure = { file: string; floor: string; narrow?: string };
const shadowLine = (record: unknown) => `AFFECTED-SUITES-SHADOW: ${JSON.stringify(record)}`;

/** A complete eight-shard live run whose shard 1 carries `failures` and concluded failure when any. */
function liveRun(id: number, failures: Failure[] = [], fullRun = false): gardener.SelectorShadowRun {
  const record = fullRun ? { fullRun: true, floorSize: 0 } : { fullRun: false, floorSize: 2000, narrowSize: 1000 };
  const log = Array.from({ length: 8 }, (_, shard) => [
    `coverage-shard (${shard + 1}/8)\t${shadowLine({ ...record, failures: shard === 0 ? failures : [] })}`,
    `coverage-shard (${shard + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${shard === 0 && failures.length > 0 ? "failure" : "success"}`,
  ].join("\n")).join("\n");
  return { id, headSha: `head-${id}`, prNumber: id, log };
}

const hit = (file: string): Failure => ({ file, floor: "selected", narrow: "selected" });
const flake = (file: string): Failure => ({ file, floor: "selected", narrow: "flake" });

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-flake-`));
  const stateDir = join(root, "state");
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(stateDir);
  const path = join(stateDir, "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) => appendLedger(path, { run_id: "GARDEN-test", task_id: "DAEMON", step, ...extra });
  const deps = {
    stateDir,
    repoRoot: root,
    clock: fixedClock(NOW),
    openWorkspace: (): never => { throw new Error("no pass here opens a filing workspace"); },
    log,
  };
  const rows = (step: string): Array<Record<string, unknown>> => existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.step === step)
    : [];
  const pass = (runs: gardener.SelectorShadowRun[], options?: Parameters<typeof gardener.runSelectorShadowGardener>[7]) =>
    gardener.runSelectorShadowGardener(deps, () => runs, () => [], () => { throw new Error("nothing here files a task"); }, () => [], undefined, undefined, options);
  return { root, stateDir, deps, log, rows, pass };
}

test("a flake verdict is parsed, on the floor and on the narrow selection, instead of thrown", () => {
  const records = gardener.parseSelectorShadowLines([
    `coverage-shard (1/8)\t${shadowLine({ fullRun: false, floorSize: 80, narrowSize: 20, failures: [
      { file: "test/a.test.ts", floor: "flake", narrow: "flake" },
      { file: "test/b.test.ts", floor: "selected", narrow: "flake" },
    ] })}`,
    shadowLine({ fullRun: false, floorSize: 80, failures: [{ file: "test/c.test.ts", floor: "flake" }] }),
  ].join("\n"));
  assert.deepEqual(records.map((r) => r.failures), [
    [{ file: "test/a.test.ts", floor: "flake", narrow: "flake" }, { file: "test/b.test.ts", floor: "selected", narrow: "flake" }],
    [{ file: "test/c.test.ts", floor: "flake" }],
  ]);
});

test("an unknown verdict still throws, named, and a full run's floor must still be selected — never a flake", () => {
  const parse = (failure: unknown, fullRun = false) =>
    gardener.parseSelectorShadowLines(shadowLine({ fullRun, floorSize: 0, narrowSize: 0, failures: [failure] }));
  assert.throws(() => parse({ file: "test/a.test.ts", floor: "flaky", narrow: "selected" }), /selector shadow: invalid failure verdict/);
  assert.throws(() => parse({ file: "test/a.test.ts", floor: "selected", narrow: "maybe" }), /selector shadow: invalid failure verdict/);
  assert.throws(() => parse({ file: "test/a.test.ts", floor: "flake", narrow: "selected" }, true), /selector shadow: invalid failure verdict/,
    "a full run runs every suite, so nothing it caught was rescued by recentFailures alone");
  assert.equal(parse({ file: "test/a.test.ts", floor: "selected", narrow: "flake" }, true)[0]!.failures[0]!.narrow, "flake");
});

test("a flake is counted separately and is neither a selection nor a miss in the window report", () => {
  const report = gardener.selectorShadowReport([
    liveRun(1, [{ file: "test/a.test.ts", floor: "flake", narrow: "flake" }, { file: "test/b.test.ts", floor: "selected", narrow: "missed" }]),
    liveRun(2, [flake("test/c.test.ts"), hit("test/d.test.ts")]),
  ], 4000);
  assert.deepEqual(report.flakes, { floor: 1, narrow: 2 });
  assert.deepEqual([report.floor.failures, report.floor.selected, report.floor.missed], [3, 3, 0]);
  assert.deepEqual([report.narrow.failures, report.narrow.selected, report.narrow.missed, report.narrow.missRate], [2, 1, 1, 0.5]);
  assert.deepEqual(report.misses.map((m) => [m.selection, m.file]), [["narrow", "test/b.test.ts"]], "a flake files no miss");
});

test("a flake neither satisfies nor fails the verdict", () => {
  const MIN = gardener.SELECTOR_SHADOW_MIN_FAILURES;
  const runs = (hits: number) => Array.from({ length: gardener.SELECTOR_SHADOW_MIN_RUNS }, (_, i) =>
    liveRun(i + 1, [flake(`test/flake-${i}.test.ts`), ...(i < hits ? [hit(`test/hit-${i}.test.ts`)] : [])]));
  const short = gardener.selectorShadowReport(runs(MIN - 1), 4000);
  assert.deepEqual([short.narrow.failures, short.flakes.narrow, short.misses.length, short.verdict],
    [MIN - 1, gardener.SELECTOR_SHADOW_MIN_RUNS, 0, "insufficient"], "forty flakes do not make up the thirtieth failure");
  const enough = gardener.selectorShadowReport(runs(MIN), 4000);
  assert.deepEqual([enough.narrow.failures, enough.flakes.narrow, enough.verdict], [MIN, gardener.SELECTOR_SHADOW_MIN_RUNS, "ready"],
    "forty flakes beside thirty selections are no miss");
});

test("the gardener's report row names the flake count, and the observation row stores the flake verdict", async () => {
  const h = harness();
  const report = await h.pass([liveRun(1, [flake("test/a.test.ts"), hit("test/b.test.ts")]), liveRun(2, [hit("test/c.test.ts")])]);
  assert.deepEqual(report.flakes, { floor: 0, narrow: 1 });
  const [row] = h.rows("selector-shadow.report");
  assert.deepEqual(row!.flakes, { floor: 0, narrow: 1 }, "the ledgered report row names the count");
  assert.deepEqual([(row!.narrow as { failures: number }).failures, row!.verdict], [2, "insufficient"]);
  assert.deepEqual(h.rows(STEP).map((r) => [r.ci_run_id, r.failures]), [
    [1, [flake("test/a.test.ts"), hit("test/b.test.ts")]],
    [2, [hit("test/c.test.ts")]],
  ]);
  assert.equal(h.rows("selector-shadow.gardener_failed").length, 0);
});

test("a stored observation carrying a flake is folded into the accumulated report, counted separately", async () => {
  const h = harness();
  await h.pass([liveRun(1, [flake("test/a.test.ts")])]);
  h.log(STEP, { ci_run_id: 9, head_sha: "h", source: "replay", full_run: false, floor_size: 10, narrow_size: 5,
    failures: [{ file: "test/b.test.ts", floor: "flake", narrow: "flake" }, hit("test/c.test.ts")], recovered: 0 });
  const report = await h.pass([]);
  assert.deepEqual([report.runsComplete, report.observations.unreadable], [2, 0]);
  assert.deepEqual(report.flakes, { floor: 1, narrow: 2 }, "both stored rows' flakes, the live one and the replayed one");
  assert.deepEqual([report.narrow.failures, report.floor.failures, report.verdict], [1, 2, "insufficient"]);
  assert.deepEqual([report.replay.narrow.failures, report.live.narrow.failures], [1, 0]);
});

test("a stored observation with an unknown verdict, or a flake on a full run's floor, is counted unreadable, never folded", async () => {
  const h = harness();
  h.log(STEP, { ci_run_id: 1, head_sha: "h", source: "live", full_run: false, floor_size: 1, failures: [{ file: "test/a.test.ts", floor: "flaky" }], recovered: 0 });
  h.log(STEP, { ci_run_id: 2, head_sha: "h", source: "live", full_run: false, floor_size: 1, failures: [{ file: "test/a.test.ts", floor: "selected", narrow: "maybe" }], recovered: 0 });
  h.log(STEP, { ci_run_id: 3, head_sha: "h", source: "live", full_run: true, floor_size: 1, failures: [{ file: "test/a.test.ts", floor: "flake" }], recovered: 0 });
  h.log(STEP, { ci_run_id: 4, head_sha: "h", source: "live", full_run: true, floor_size: 1, failures: [{ file: "test/a.test.ts", floor: "selected", narrow: "flake" }], recovered: 0 });
  const report = await h.pass([]);
  assert.deepEqual([report.observations.unreadable, report.runsComplete, report.flakes], [3, 1, { floor: 0, narrow: 1 }]);
});

test("the scheduled pass reads a flake without failing, and still fails on an unknown verdict, naming it", async () => {
  const tick = async (failures: Failure[]) => {
    const h = harness();
    const garden = gardener.startSelectorShadowGardener(h.deps, () => [liveRun(1, failures)], () => [], () => "W1-T9002", 60_000);
    try {
      for (let waited = 0; waited < 2_000; waited += 10) {
        if (h.rows("selector-shadow.report").length + h.rows("selector-shadow.gardener_failed").length > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      garden.stop();
    }
    return h;
  };
  const read = await tick([flake("test/a.test.ts")]);
  assert.deepEqual(read.rows("selector-shadow.gardener_failed"), []);
  assert.deepEqual(read.rows("selector-shadow.report")[0]!.flakes, { floor: 0, narrow: 1 });
  const thrown = await tick([{ file: "test/a.test.ts", floor: "selected", narrow: "flaky" }]);
  assert.deepEqual(thrown.rows("selector-shadow.report"), []);
  assert.deepEqual(thrown.rows("selector-shadow.gardener_failed").map((r) => r.error), ["selector shadow: invalid failure verdict"]);
});

test("a replayed historical run whose shadow record carries a flake is read; one with an unknown verdict is skipped unreadable", async () => {
  const h = harness();
  const verdicts: Record<number, string> = { 7001: "flake", 7002: "flaky" };
  const readJson = async (args: string[]): Promise<unknown> => {
    const url = args[1]!;
    if (url.includes("/actions/workflows/ci.yml/runs?")) {
      return { workflow_runs: [7001, 7002].map((id, i) => ({
        id, head_sha: `head-${id}`, status: "completed", conclusion: "failure", created_at: iso(NOW - 4 * DAY - i * 1000),
        pull_requests: [{ number: id, base: { sha: `base-${id}` } }],
      })) };
    }
    const id = Number(/actions\/runs\/(\d+)\/jobs/.exec(url)![1]);
    return { total_count: 8, jobs: Array.from({ length: 8 }, (_, i) => ({
      id: id * 10 + i + 1, name: `coverage-shard (${i + 1}/8)`, status: "completed", conclusion: i === 0 ? "failure" : "success",
    })) };
  };
  const readText = async (args: string[]): Promise<string> => {
    const job = Number(/actions\/jobs\/(\d+)\/logs/.exec(args[1]!)![1]);
    const failures = job % 10 === 1 ? [{ file: "test/r.test.ts", floor: "selected", narrow: verdicts[Math.floor(job / 10)] }] : [];
    return `2026-10-01T00:00:00.0000000Z ${shadowLine({ fullRun: false, floorSize: 2000, narrowSize: 1500, failures })}`;
  };
  const select = async (_run: { id: number }, failed: readonly string[]) => ({
    record: { fullRun: false, floorSize: 900, narrowSize: 400, failures: failed.map((file) => ({ file, floor: "selected", narrow: "flake" })) },
    reasons: [],
  });
  const report = await h.pass([], { replay: { owner: "o", repo: "r", readJson, readText, select } });
  assert.deepEqual(h.rows(STEP).map((r) => [r.ci_run_id, r.source, r.failures]), [[7001, "replay", [flake("test/r.test.ts")]]],
    "the historical flake is read and the recomputed selection's flake is stored");
  assert.deepEqual(h.rows("selector-shadow.replay_skipped").map((r) => [r.ci_run_id, r.reason, r.detail]),
    [[7002, "unreadable", "selector shadow: invalid failure verdict"]]);
  assert.deepEqual([report.replay.runs, report.flakes, report.narrow.failures], [1, { floor: 0, narrow: 1 }, 0]);
});
