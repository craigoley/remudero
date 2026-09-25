import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SELECTOR_SHADOW_MIN_FAILURES,
  SELECTOR_SHADOW_MIN_RUNS,
  SELECTOR_SHADOW_SHARDS,
  parseSelectorShadowLines,
  readSelectorShadowChangedPaths,
  readSelectorShadowRuns,
  runSelectorShadowGardener,
  selectorShadowReport,
  startSelectorShadowGardener,
  type SelectorShadowRecord,
  type SelectorShadowRun,
} from "../src/lib/selector-shadow-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { daemonCommand } from "../src/run-task.js";

function run(id: number, record: SelectorShadowRecord, overrides: Partial<SelectorShadowRun> = {}): SelectorShadowRun {
  const log = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, shard) =>
    `coverage-shard (${shard + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify(shard === 0 ? record : { ...record, failures: [] })}`,
  ).join("\n");
  return { id, headSha: `head-${id}`, prNumber: id, log, ...overrides };
}

test("W1-T4439: the gardener reports each selection's miss rate from the shadow lines", () => {
  const records = [
    run(1, { fullRun: false, floorSize: 80, narrowSize: 20, failures: [
      { file: "test/a.test.ts", floor: "selected", narrow: "missed" },
      { file: "test/b.test.ts", floor: "missed", narrow: "selected" },
    ] }),
    run(2, { fullRun: false, floorSize: 60, narrowSize: 10, failures: [
      { file: "test/c.test.ts", floor: "selected", narrow: "selected" },
    ] }),
  ];
  const report = selectorShadowReport(records, 100);
  assert.deepEqual(report.floor, {
    failures: 3, selected: 2, missed: 1, missRate: 1 / 3,
    medianSize: 70, medianSavingPercent: 30,
  });
  assert.deepEqual(report.narrow, {
    failures: 3, selected: 2, missed: 1, missRate: 1 / 3,
    medianSize: 15, medianSavingPercent: 85,
  });
  assert.equal(report.verdict, "misses");
  assert.deepEqual(report.misses.map((m) => [m.selection, m.file]),
    [["narrow", "test/a.test.ts"], ["floor", "test/b.test.ts"]]);

  const incomplete = selectorShadowReport([{ ...records[0]!, log: records[0]!.log.split("\n").slice(0, 7).join("\n") }], 100);
  assert.equal(incomplete.runsIncomplete, 1);
  assert.equal(incomplete.floor.failures, 0);
  assert.equal(incomplete.verdict, "insufficient");
  assert.throws(() => parseSelectorShadowLines('AFFECTED-SUITES-SHADOW: {"fullRun":false,"floorSize":0,"failures":[{"file":"test/a.test.ts","floor":"unknown"}]}'), /invalid failure verdict/);
  assert.throws(() => parseSelectorShadowLines('AFFECTED-SUITES-SHADOW: {"fullRun":false,"floorSize":-1,"failures":[]}'), /invalid record sizes or failures/);

  const enough = Array.from({ length: SELECTOR_SHADOW_MIN_RUNS }, (_, i) => run(i + 10, {
    fullRun: false, floorSize: 80, narrowSize: 20,
    failures: Array.from({ length: Math.ceil(SELECTOR_SHADOW_MIN_FAILURES / SELECTOR_SHADOW_MIN_RUNS) }, (_, n) =>
      ({ file: `test/f-${i}-${n}.test.ts`, floor: "selected" as const, narrow: "selected" as const })),
  }));
  const ready = selectorShadowReport(enough, 100);
  assert.equal(ready.verdict, "ready");
  assert.equal(ready.narrow.missed, 0);
  assert.match(ready.reason, /W1-T4406 may be reviewed/);
});

test("W1-T4439: a missed failure files a task naming the missing edge", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-shadow-`));
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "test", "a.test.ts"), "");
  const observed = run(42, { fullRun: false, floorSize: 1, narrowSize: 0, failures: [
    { file: "test/a.test.ts", floor: "selected", narrow: "missed" },
  ] }, { headSha: "abc123", baseSha: "def456" });
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const events: string[] = [];
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({
      root,
      land: (opts: { paths: string[]; title: string; body: string }) =>
        (landed.push(opts), "https://github.com/acme/remudero/pull/99"),
      dispose: () => {},
    }),
    log: (step: string) => { events.push(step); },
  };
  const pass = () => runSelectorShadowGardener(deps, () => [observed], () => ["scripts/clock-signature-ratchet.mjs"], () => "W1-T9001");
  const report = pass();
  assert.equal(report.verdict, "misses");
  assert.equal(landed.length, 1);
  assert.deepEqual(landed[0]!.paths, ["plan/tasks.d/w1-t9001-selector-shadow-miss.yaml"]);
  const task = readFileSync(join(root, landed[0]!.paths[0]!), "utf8");
  assert.match(task, /scripts\/clock-signature-ratchet\.mjs -> test\/a\.test\.ts/);
  assert.match(task, /at abc123/);
  assert.match(task, /origin: "selector-shadow:abc123:narrow:test\/a\.test\.ts"/);
  assert.match(task, /verify: human/);
  assert.ok(events.includes("selector-shadow.report"));
  assert.ok(events.includes("selector-shadow.miss_filed"));
  pass();
  assert.equal(landed.length, 1, "the same observed edge files once across passes");
});

test("W1-T4439: the GitHub reader keeps each run's exact head and comparison", () => {
  const calls: string[][] = [];
  const runs = readSelectorShadowRuns("acme", "remudero", 2, {
    readJson: (args) => {
      calls.push(args);
      return { workflow_runs: [{ id: 42, head_sha: "abc123", pull_requests: [{ number: 7, base: { sha: "def456" } }] }] };
    },
    readLog: (args) => (calls.push(args), "coverage-shard\tAFFECTED-SUITES-SHADOW: {}"),
  });
  assert.deepEqual(calls, [
    ["api", "repos/acme/remudero/actions/workflows/ci.yml/runs?event=pull_request&status=completed&per_page=2"],
    ["run", "view", "42", "--repo", "acme/remudero", "--log"],
  ]);
  assert.deepEqual(runs, [{ id: 42, headSha: "abc123", baseSha: "def456", prNumber: 7,
    log: "coverage-shard\tAFFECTED-SUITES-SHADOW: {}" }]);
  const miss = { runId: 42, headSha: "abc123", baseSha: "def456", selection: "narrow" as const,
    file: "test/a.test.ts" };
  assert.deepEqual(readSelectorShadowChangedPaths("acme", "remudero", miss, (args) => {
    assert.deepEqual(args, ["api", "repos/acme/remudero/compare/def456...abc123"]);
    return { files: [{ filename: "scripts/clock-signature-ratchet.mjs" }] };
  }), ["scripts/clock-signature-ratchet.mjs"]);
  assert.throws(() => readSelectorShadowChangedPaths("acme", "remudero", miss, () => ({ files: null })), /incomplete comparison/);
  assert.throws(() => readSelectorShadowChangedPaths("acme", "remudero", miss, () => null), /no comparison object for abc123/);
  assert.throws(() => readSelectorShadowRuns("acme", "remudero", 2, { readJson: () => null, readLog: () => "" }), /no workflow-runs object/);
  assert.throws(() => readSelectorShadowRuns("acme", "remudero", 2, { readJson: () => ({}), readLog: () => "" }), /no workflow_runs list/);
  assert.throws(() => readSelectorShadowRuns("acme", "remudero", 2, { readJson: () => ({ workflow_runs: [{ head_sha: "abc123" }] }), readLog: () => "" }), /no id or head SHA/);
});

test("W1-T4439: a failed pass is logged by name and never stops the daemon's timer", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-shadow-tick-`));
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const garden = startSelectorShadowGardener(
    {
      stateDir: join(root, "state"),
      repoRoot: root,
      openWorkspace: () => { throw new Error("no miss, so no workspace"); },
      log: (step, extra) => { events.push({ step, extra }); },
    },
    () => { throw new Error("gh run list unavailable"); },
    () => [],
    () => "W1-T9002",
    60_000,
  );
  try {
    for (let waited = 0; events.length === 0 && waited < 5_000; waited += 10) await new Promise((r) => setTimeout(r, 10));
  } finally {
    garden.stop();
  }
  assert.deepEqual(events, [{ step: "selector-shadow.gardener_failed", extra: { error: "gh run list unavailable" } }]);
});

test("W1-T4439: a self-hosting daemon wires the selector-shadow gardener", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4439-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    // plan, gate, test, config, export, ci-friction, then this gardener.
    const start = captured?.gardens?.[6];
    assert.ok(start, "a seventh garden is wired after the ci-friction gardener");
    // Stopped before its first tick, so the pass never reaches the real GitHub transport.
    start!(60_000).stop();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
