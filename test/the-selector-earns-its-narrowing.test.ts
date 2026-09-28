import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { fixedClock } from "../src/lib/clock.js";
import {
  SELECTOR_SHADOW_MIN_FAILURES,
  SELECTOR_SHADOW_MIN_RUNS,
  SELECTOR_SHADOW_SHARDS,
  parseSelectorShadowLines,
  readCoverageShardLogsAsync,
  readSelectorShadowChangedPaths,
  readSelectorShadowRuns,
  readSelectorShadowRunsAsync,
  runSelectorShadowGardener,
  selectorShadowReport,
  startSelectorShadowGardener,
  type SelectorShadowRecord,
  type SelectorShadowRun,
} from "../src/lib/selector-shadow-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";
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
  const skipped = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, i) =>
    `coverage-shard (${i + 1}/8)\tW1-T2428 fast-lane: class=PLAN_ONLY — skipping Test with coverage`,
  ).join("\n");
  const withPlanOnly = selectorShadowReport([...enough, { id: 99, headSha: "plan-only", log: skipped }], 100);
  assert.equal(withPlanOnly.runsSkipped, 1);
  assert.equal(withPlanOnly.runsIncomplete, 0);
  assert.equal(withPlanOnly.verdict, "ready", "an explicit eight-shard plan-only skip is not missing source evidence");
  const partialSkip = selectorShadowReport([{ id: 100, headSha: "partial", log: skipped.split("\n").slice(0, 7).join("\n") }], 100);
  assert.equal(partialSkip.runsSkipped, 0);
  assert.equal(partialSkip.runsIncomplete, 1, "seven skips cannot hide a missing coverage shard");
});

test("selector-shadow reads all eight coverage job logs instead of a partial run-view aggregate", async () => {
  const jobs = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, i) =>
    ({ id: i + 101, name: `coverage-shard (${i + 1}/8)`, status: "completed" }));
  const calls: string[][] = [];
  const io = {
    readJson: async (args: string[]) => {
      calls.push(args);
      return { total_count: jobs.length + 1, jobs: [...jobs, { id: 999, name: "commitlint", status: "completed" }] };
    },
    readText: async (args: string[]) => {
      calls.push(args);
      return `AFFECTED-SUITES-SHADOW: ${JSON.stringify({ fullRun: true, floorSize: 20, failures: [] })}`;
    },
  };
  const log = await readCoverageShardLogsAsync("acme", "remudero", 42, io);
  assert.equal(parseSelectorShadowLines(log).length, SELECTOR_SHADOW_SHARDS);
  assert.equal(calls.length, 1 + SELECTOR_SHADOW_SHARDS);
  assert.deepEqual(calls[0], ["api", "repos/acme/remudero/actions/runs/42/jobs?per_page=100"]);
  assert.deepEqual(calls.at(-1), ["api", "repos/acme/remudero/actions/jobs/108/logs"]);
  const skippedLog = await readCoverageShardLogsAsync("acme", "remudero", 42, {
    ...io, readText: async () => "W1-T2428 fast-lane: class=PLAN_ONLY — skipping Test with coverage",
  });
  const skippedReport = selectorShadowReport([{ id: 42, headSha: "plan-only", log: skippedLog }], 100);
  assert.equal(skippedReport.runsSkipped, 1);
  assert.equal(skippedReport.runsIncomplete, 0);
  await assert.rejects(readCoverageShardLogsAsync("acme", "remudero", 42, {
    ...io, readJson: async () => ({ total_count: 101, jobs }),
  }), /incomplete job list/);
  await assert.rejects(readCoverageShardLogsAsync("acme", "remudero", 42, {
    ...io, readJson: async () => ({ total_count: 7, jobs: jobs.slice(0, 7) }),
  }), /missing coverage jobs/);
  for (const invalid of [
    [{ ...jobs[0], status: "in_progress" }, ...jobs.slice(1)],
    [{ ...jobs[0], id: undefined }, ...jobs.slice(1)],
    [...jobs, { ...jobs[0], id: 109 }],
  ]) {
    await assert.rejects(readCoverageShardLogsAsync("acme", "remudero", 42, {
      readJson: async () => ({ total_count: invalid.length, jobs: invalid }),
      readText: async () => { throw new Error("unexpected job-log read"); },
    }), /invalid coverage job 1/);
  }
  await assert.rejects(readCoverageShardLogsAsync("acme", "remudero", 42, {
    ...io, readText: async () => { throw new Error("job log unavailable"); },
  }), /job log unavailable/);
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
  const filed = parseYaml(task) as Array<{ acceptance: Array<{ proof: string }> }>;
  assert.equal(filed[0]!.acceptance[0]!.proof, "grep: test/a\\.test\\.ts in src/lib/affected-suites.ts");
  assert.match(landed[0]!.body, /## Acceptance/);
  assert.doesNotMatch(landed[0]!.body, /Remudero-Task:/);
  const proof = landed[0]!.body.match(/proof: grep: (.+) in plan\/tasks\.d\/w1-t9001-selector-shadow-miss\.yaml/)?.[1];
  assert.ok(proof);
  assert.match(execFileSync("grep", ["-arn", "--", proof, join(root, landed[0]!.paths[0]!)], { encoding: "utf8" }), /origin:/);
  assert.ok(events.includes("selector-shadow.report"));
  assert.ok(events.includes("selector-shadow.miss_filed"));
  pass();
  assert.equal(landed.length, 1, "the same observed edge files once across passes");
});

test("selector-shadow reads the newest PR runs and filters pending runs locally", () => {
  const calls: string[][] = [];
  const runs = readSelectorShadowRuns("acme", "remudero", 2, {
    readJson: (args) => {
      calls.push(args);
      return { workflow_runs: [
        { id: 41, head_sha: "pending", status: "in_progress" },
        { id: 42, head_sha: "abc123", status: "completed", pull_requests: [{ number: 7, base: { sha: "def456" } }] },
      ] };
    },
    readLog: (args) => (calls.push(args), "coverage-shard\tAFFECTED-SUITES-SHADOW: {}"),
  });
  assert.deepEqual(calls, [
    ["api", "repos/acme/remudero/actions/workflows/ci.yml/runs?event=pull_request&per_page=100"],
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
  assert.throws(() => readSelectorShadowRuns("acme", "remudero", 2, { readJson: () => ({ workflow_runs: [{ head_sha: "abc123", status: "completed" }] }), readLog: () => "" }), /no id or head SHA/);
  assert.throws(() => readSelectorShadowRuns("acme", "remudero", 2, { readJson: () => ({ workflow_runs: [{ id: 42, head_sha: "abc123" }] }), readLog: () => "" }), /no status/);
});

test("the scheduled selector-shadow log read yields the daemon loop and does not overlap ticks", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-shadow-async-tick-`));
  const events: string[] = [];
  let reads = 0;
  let rejectRead: ((error: Error) => void) | undefined;
  const pendingRead = new Promise<SelectorShadowRun[]>((_, reject) => { rejectRead = reject; });
  const garden = startSelectorShadowGardener(
    {
      stateDir: join(root, "state"),
      repoRoot: root,
      openWorkspace: () => { throw new Error("no miss, so no workspace"); },
      log: (step) => { events.push(step); },
    },
    () => { reads += 1; return pendingRead; },
    () => [],
    () => "W1-T9002",
    10,
  );
  try {
    for (let waited = 0; reads === 0 && waited < 1_000; waited += 10) await new Promise((r) => setTimeout(r, 10));
    assert.equal(reads, 1, "the first scheduled pass started");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(reads, 1, "a pending GitHub read never starts a second pass");
    assert.deepEqual(events, [], "the daemon timer ran while the log read was pending");
    garden.stop();
    rejectRead!(new Error("log read failed"));
    for (let waited = 0; events.length === 0 && waited < 1_000; waited += 10) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, ["selector-shadow.gardener_failed"]);
  } finally {
    garden.stop();
  }
});

test("the async selector-shadow reader keeps run logs sequential while other timers run", async () => {
  const calls: string[][] = [];
  let releaseFirst: (() => void) | undefined;
  const firstLog = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const reading = readSelectorShadowRunsAsync("acme", "remudero", 2, {
    readJson: async (args) => {
      calls.push(args);
      return { workflow_runs: [{ id: 42, head_sha: "abc123", status: "completed" }, { id: 43, head_sha: "def456", status: "completed" }] };
    },
    readLog: async (args) => {
      calls.push(args);
      if (args[2] === "42") await firstLog;
      return `log for ${args[2]}`;
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.map((args) => args[2]), [undefined, "42"], "later logs wait for the first bounded read");
  releaseFirst!();
  const runs = await reading;
  assert.deepEqual(calls.map((args) => args[2]), [undefined, "42", "43"]);
  assert.deepEqual(runs.map((run) => [run.id, run.headSha, run.log]), [
    [42, "abc123", "log for 42"],
    [43, "def456", "log for 43"],
  ]);
});

test("selector-shadow resumes a bounded log window across ticks and daemon restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-shadow-cache-`));
  const cachePath = join(root, "logs.json");
  const headers = [1, 2, 3].map((id) => ({ id, head_sha: `head-${id}`, status: "completed" }));
  const record: SelectorShadowRecord = { fullRun: true, floorSize: 20, narrowSize: 10, failures: [] };
  const fetched: number[] = [];
  const io = {
    cachePath,
    freshLogsPerPass: 1,
    clock: fixedClock(1_000),
    readJson: async () => ({ workflow_runs: headers }),
    readLog: async (args: string[]) => {
      const id = Number(args[2]);
      fetched.push(id);
      return `large unrelated log\n${run(id, record).log}`;
    },
  };

  const first = await readSelectorShadowRunsAsync("acme", "remudero", 3, io);
  assert.deepEqual(fetched, [1], "one tick has a strict fresh-log budget");
  assert.equal(selectorShadowReport(first, 100).verdict, "insufficient", "unread runs cannot certify a window");
  assert.equal(first[1]?.log, "", "deferred runs remain explicitly incomplete");

  await readSelectorShadowRunsAsync("acme", "remudero", 3, io);
  const complete = await readSelectorShadowRunsAsync("acme", "remudero", 3, io);
  assert.deepEqual(fetched, [1, 2, 3]);
  assert.equal(complete.every((row) => parseSelectorShadowLines(row.log).length === SELECTOR_SHADOW_SHARDS), true);
  assert.doesNotMatch(readFileSync(cachePath, "utf8"), /large unrelated log/, "only shadow evidence is persisted");

  await readSelectorShadowRunsAsync("acme", "remudero", 3, io);
  assert.deepEqual(fetched, [1, 2, 3], "a new reader invocation reuses completed runs");
  headers[1] = { id: 2, head_sha: "replaced-head", status: "completed" };
  await readSelectorShadowRunsAsync("acme", "remudero", 3, io);
  assert.deepEqual(fetched, [1, 2, 3, 2], "a run ID with a different head cannot reuse evidence");
});

test("selector-shadow re-reads an old aggregate cache and remembers explicit plan-only skips", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-shadow-cache-upgrade-`));
  const cachePath = join(root, "logs.json");
  writeFileSync(cachePath, JSON.stringify({ "42": { headSha: "head-42", log: "", fetchedAt: 1_000, complete: false } }));
  const skipLog = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, i) =>
    `coverage-shard (${i + 1}/8)\tW1-T2428 fast-lane: class=PLAN_ONLY — skipping Test with coverage`,
  ).join("\n");
  let fetched = 0;
  const io = {
    cachePath, clock: fixedClock(1_000),
    readJson: async () => ({ workflow_runs: [{ id: 42, head_sha: "head-42", status: "completed" }] }),
    readLog: async () => { fetched++; return skipLog; },
  };
  const first = await readSelectorShadowRunsAsync("acme", "remudero", 1, io);
  assert.equal(fetched, 1, "the old aggregate cache is not trusted for six more hours");
  assert.equal(selectorShadowReport(first, 100).runsSkipped, 1);
  await readSelectorShadowRunsAsync("acme", "remudero", 1, io);
  assert.equal(fetched, 1, "an explicit eight-shard skip is complete and reusable");
});

test("selector-shadow reports a corrupt cache and rebuilds it from run evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-shadow-corrupt-`));
  const cachePath = join(root, "logs.json");
  writeFileSync(cachePath, "{invalid json");
  const warnings: string[] = [];
  const record: SelectorShadowRecord = { fullRun: true, floorSize: 20, narrowSize: 10, failures: [] };
  const rows = await readSelectorShadowRunsAsync("acme", "remudero", 1, {
    cachePath,
    readJson: async () => ({ workflow_runs: [{ id: 1, head_sha: "head-1", status: "completed" }] }),
    readLog: async () => run(1, record).log,
    warn: (message) => { warnings.push(message); },
  });
  assert.match(warnings[0] ?? "", /log cache unreadable/);
  assert.equal(parseSelectorShadowLines(rows[0]?.log ?? "").length, SELECTOR_SHADOW_SHARDS);
  assert.doesNotThrow(() => JSON.parse(readFileSync(cachePath, "utf8")), "the replacement cache is valid JSON");
});

test("selector-shadow names both cache write failures and re-reads on the next pass", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-shadow-write-`));
  const warnings: string[] = [];
  let logReads = 0;
  const record: SelectorShadowRecord = { fullRun: true, floorSize: 20, narrowSize: 10, failures: [] };
  const io = {
    cachePath: join(root, "logs.json"),
    readJson: async () => ({ workflow_runs: [{ id: 1, head_sha: "head-1", status: "completed" }] }),
    readLog: async () => { logReads++; return run(1, record).log; },
    writeCache: () => { throw new Error("disk unavailable"); },
    warn: (message: string) => { warnings.push(message); },
  };
  const first = await readSelectorShadowRunsAsync("acme", "remudero", 1, io);
  assert.equal(parseSelectorShadowLines(first[0]?.log ?? "").length, SELECTOR_SHADOW_SHARDS);
  assert.deepEqual(warnings.map((message) => message.includes("cache write failed") ? "write" : message.includes("cache prune failed") ? "prune" : "other"), ["write", "prune"]);
  await readSelectorShadowRunsAsync("acme", "remudero", 1, io);
  assert.equal(logReads, 2, "a failed cache write cannot be mistaken for persisted evidence");
});

test("selector-shadow keeps scanning after an unreadable log without treating it as complete", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-shadow-unreadable-`));
  const cachePath = join(root, "logs.json");
  const fetched: number[] = [];
  const warnings: string[] = [];
  const record: SelectorShadowRecord = { fullRun: true, floorSize: 20, narrowSize: 10, failures: [] };
  const io = {
    cachePath,
    clock: fixedClock(1_000),
    readJson: async () => ({ workflow_runs: [1, 2].map((id) => ({ id, head_sha: `head-${id}`, status: "completed" })) }),
    readLog: async (args: string[]) => {
      const id = Number(args[2]);
      fetched.push(id);
      if (id === 1) throw new Error("workflow log unavailable");
      return run(id, record).log;
    },
    warn: (message: string) => { warnings.push(message); },
  };
  const first = await readSelectorShadowRunsAsync("acme", "remudero", 2, io);
  assert.deepEqual(fetched, [1, 2], "one bad log does not block later evidence");
  assert.equal(first[0]?.log, "");
  assert.equal(selectorShadowReport(first, 100).verdict, "insufficient");
  assert.match(warnings[0] ?? "", /run 1 log unreadable/);
  await readSelectorShadowRunsAsync("acme", "remudero", 2, io);
  assert.deepEqual(fetched, [1, 2], "the incomplete entry backs off across invocations");

  await assert.rejects(readSelectorShadowRunsAsync("acme", "remudero", 2, {
    ...io,
    cachePath: join(root, "auth-logs.json"),
    readLog: async () => { throw new Error("HTTP 401 Bad credentials"); },
  }), /HTTP 401/, "authentication failures remain visible for credential recovery");
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

test("a self-hosting daemon keeps timers alive while selector-shadow reads a run log", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4439-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  const oldFloor = process.env.RMD_GH_TRANSPORT_FLOOR;
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
    const done = join(home, "log-done");
    const allDone = join(home, "all-logs-done");
    const jobs = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, i) =>
      ({ id: i + 101, name: `coverage-shard (${i + 1}/8)`, status: "completed" }));
    const shim = ghShim([
      { when: "actions/workflows/ci.yml/runs", stdout: JSON.stringify({ workflow_runs: [{ id: 42, head_sha: "abc123", status: "completed" }] }) },
      { when: "actions/runs/42/jobs", stdout: JSON.stringify({ total_count: jobs.length, jobs }) },
      { when: "actions/jobs/101/logs", stdout: "unparseable log", delaySeconds: 0.5, doneFile: done },
      ...jobs.slice(1).map((job, index) => ({
        when: `actions/jobs/${job.id}/logs`, stdout: "unparseable log",
        ...(index === jobs.length - 2 ? { doneFile: allDone } : {}),
      })),
    ], { kind: "selector-shadow-log" });
    process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
    process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
    const garden = start!(60_000);
    try {
      for (let waited = 0; !shim.calls().some((call) => call.includes("actions/jobs/101/logs")) && waited < 5_000; waited += 10) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(shim.calls().some((call) => call.includes("actions/jobs/101/logs")), "the installed reader reached the coverage job log child");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(existsSync(done), false, "the daemon event loop ran before the log child finished");
      // stop() clears future ticks, but the current eight-job read continues. Keep the
      // shim installed until that read finishes so no later child hits the shared gh stub.
      for (let waited = 0; !existsSync(allDone) && waited < 5_000; waited += 10) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(existsSync(allDone), "the current read completed all eight coverage jobs");
    } finally {
      garden.stop();
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldFloor === undefined) delete process.env.RMD_GH_TRANSPORT_FLOOR;
    else process.env.RMD_GH_TRANSPORT_FLOOR = oldFloor;
  }
});
