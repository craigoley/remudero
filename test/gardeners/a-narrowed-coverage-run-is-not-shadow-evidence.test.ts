import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { appendLedger } from "#src/lib/ledger.js";
import { fixedClock } from "#src/lib/clock.js";
import {
  SELECTOR_SHADOW_READER_VERSION, readCoverageShardLogsAsync, readSelectorShadowRunsAsync,
  readSelectorShadowObservations, runSelectorShadowGardener, selectorShadowReport, type SelectorShadowRun,
} from "#src/lib/selector-shadow-gardener.js";

function run(id: number, modes?: string[], miss = false): SelectorShadowRun {
  return { id, headSha: `head-${id}`, log: Array.from({ length: 8 }, (_, i) => {
    const prefix = `coverage-shard (${i + 1}/8)\t`;
    const record = { fullRun: false, floorSize: 80, narrowSize: modes ? 1 : 50,
      failures: i ? [] : [{ file: "test/a.test.ts", floor: "selected", narrow: miss ? "missed" : "selected" }] };
    return `${modes?.[i] === undefined ? "" : `${prefix}2026-10-05T00:00:00Z COVERAGE-SELECTION: ${modes[i]}\n`}${prefix}AFFECTED-SUITES-SHADOW: ${JSON.stringify(record)}`;
  }).join("\n") };
}

test("test/gardeners/a-narrowed-coverage-run-is-not-shadow-evidence.test.ts: W1-T5891: only full executions qualify the selector and narrowed runs remain visible", () => {
  const full = selectorShadowReport([run(1, undefined, true)], 100);
  const mixed = selectorShadowReport([run(1, undefined, true), run(2, Array(8).fill("narrow"))], 100);
  assert.equal(mixed.narrow.missRate, 1, "a narrowed success cannot dilute a real full-run miss");
  assert.deepEqual(mixed.floor, full.floor);
  assert.deepEqual(mixed.narrow, full.narrow, "savings use the full shadow executions only");
  assert.deepEqual(mixed.misses, full.misses);
  assert.equal(mixed.runsComplete, 1);
  assert.equal(mixed.narrowed, 1);
  assert.equal(mixed.runsIncomplete, 0);
  const explicit = selectorShadowReport([run(1, Array(8).fill("all"), true)], 100);
  assert.equal(explicit.narrow.missRate, full.narrow.missRate);
  assert.equal(full.narrowed, 0);
  const allNarrow = selectorShadowReport(Array.from({ length: 40 }, (_, i) => run(i, Array(8).fill("narrow"))), 100);
  assert.equal(allNarrow.narrowed, 40);
  assert.equal(allNarrow.runsComplete, 0);
  assert.equal(allNarrow.narrow.failures, 0);
  assert.equal(allNarrow.narrow.medianSize, null);
  assert.equal(allNarrow.verdict, "insufficient");
});

test("W1-T5891: mixed shards exclude the run and malformed or partial markers cannot qualify it", () => {
  assert.equal(selectorShadowReport([run(1, ["narrow", ...Array(7).fill("all")])], 100).narrowed, 1);
  for (const modes of [Array(7).fill("all"), ["bad", ...Array(7).fill("all")]]) {
    const report = selectorShadowReport([run(2, modes)], 100);
    assert.equal(report.runsIncomplete, 1);
    assert.equal(report.runsComplete, 0);
    assert.equal(report.narrow.failures, 0);
  }
  const duplicate = run(3, Array(8).fill("all"));
  duplicate.log += "\ncoverage-shard (1/8)\tCOVERAGE-SELECTION: all";
  assert.equal(selectorShadowReport([duplicate], 100).runsIncomplete, 1);
  for (const marker of ["coverage-shard (1/8)\tCOVERAGE-SELECTION:", "coverage-shard (1/8)\tCOVERAGE-SELECTION:narrow", "COVERAGE-SELECTION: all"]) {
    const invalid = run(4);
    invalid.log += `\n${marker}`;
    assert.equal(selectorShadowReport([invalid], 100).runsIncomplete, 1);
  }
});

test("narrowed coverage validates impact evidence without qualifying the impact arm", () => {
  const narrowed = run(50, Array(8).fill("narrow"));
  narrowed.log = narrowed.log.split("\n").map((line) => {
    const marker = "AFFECTED-SUITES-SHADOW: ";
    const start = line.indexOf(marker);
    if (start < 0) return line;
    const row = JSON.parse(line.slice(start + marker.length));
    row.impactSize = 20;
    row.failures = row.failures.map((failure: { file: string; floor: string; narrow: string }) => ({ ...failure, impact: "selected" }));
    return line.slice(0, start + marker.length) + JSON.stringify(row);
  }).join("\n");
  const report = selectorShadowReport([narrowed], 100);
  assert.equal(report.narrowed, 1);
  assert.equal(report.runsComplete, 0);
  assert.equal(report.impact.runs, 0, "a narrowed execution cannot establish impact coverage");
  assert.equal(report.impact.verdict, "insufficient");
  assert.throws(() => selectorShadowReport([{ ...narrowed, log: narrowed.log.replace('"impactSize":20', '"impactSize":21') }], 100),
    /inconsistent impact evidence/, "narrowing must preserve the accepted impact consistency check");
});

test("W1-T5891: the real coverage workflow emits the executed mode for the gardener", () => {
  const workflow = parse(readFileSync(new URL(".github/workflows/ci.yml", __workspaceRootUrl), "utf8"));
  const coverageStep = workflow.jobs["coverage-ratchet"].steps.find((step: { name?: string }) => step.name?.startsWith("Test with coverage"));
  assert.ok(coverageStep?.run, "the actual coverage step must exist");
  const body = coverageStep.run
    .replaceAll("${{ matrix.shard }}", "1").replaceAll("${{ steps.classify.outputs.class }}", "SOURCE");
  for (const [event, flag, mode] of [["pull_request", "0", "all"], ["pull_request", "1", "narrow"], ["merge_group", "1", "all"]]) {
    const root = mkdtempSync(join(tmpdir(), "rmd-shadow-producer-"));
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "changed-files.txt"), "src/a.ts\n");
      for (const [name, source] of [["git", "#!/usr/bin/env bash\nexit 0\n"], ["node", `#!/usr/bin/env bash
case "$*" in
  scripts/coverage-floor.mjs\\ mode*) echo narrow ;;
  scripts/coverage-floor.mjs\\ shard*) echo test/a.test.ts ;;
  *--import\\ tsx\\ -e*) for last; do :; done; echo test/a.test.ts > "$last" ;;
  *--select-*) echo test/a.test.ts ;;
  *test-with-retry.mjs*) mkdir -p coverage/raw; echo SF:src/a.ts > coverage/lcov.info; echo '{}' > coverage/raw/coverage-1.json ;;
esac
`]]) {
        writeFileSync(join(root, "bin", name!), source!);
        chmodSync(join(root, "bin", name!), 0o755);
      }
      const shim = 'mapfile() { COVERAGE_TEST_FILES=(); while IFS= read -r line; do COVERAGE_TEST_FILES+=("$line"); done; }\n';
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", shim + body], {
        cwd: root, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, GITHUB_EVENT_NAME: event!,
          RMD_AFFECTED_SUITE_LIVE: flag!, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, "summary") },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`^COVERAGE-SELECTION: ${mode}$`, "m"));
      assert.equal(readFileSync(join(root, "coverage-selection.txt"), "utf8").trim(), mode);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("W1-T5891: actual job-log extraction and the bounded cache retain execution selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-narrow-shadow-"));
  try {
    mkdirSync(join(root, "state"));
    const cachePath = join(root, "state/logs.json");
    const legacyLog = run(42).log;
    writeFileSync(cachePath, JSON.stringify({ "42": { headSha: "head-42", log: legacyLog,
      fetchedAt: 1_000, complete: true, readerVersion: 3 } }));
    let reads = 0;
    const readLog = async () => readCoverageShardLogsAsync("acme", "rmd", 42, {
      readJson: async () => ({ total_count: 8, jobs: Array.from({ length: 8 }, (_, i) => ({ id: i + 1,
        name: `coverage-shard (${i + 1}/8)`, status: "completed", conclusion: "failure" })) }),
      readText: async () => { reads++; return '2026-10-05T00:00:00Z COVERAGE-SELECTION: narrow\nAFFECTED-SUITES-SHADOW: {"fullRun":false,"floorSize":80,"narrowSize":1,"failures":[]}\necho "COVERAGE-SELECTION: all"'; },
    });
    const io = { cachePath, clock: fixedClock(1_000), freshLogsPerPass: 1, readLog,
      readJson: async () => ({ workflow_runs: [{ id: 42, head_sha: "head-42", status: "completed", created_at: new Date(1_000).toISOString() }] }) };
    const first = await readSelectorShadowRunsAsync("acme", "rmd", 1, io);
    assert.equal(reads, 8, "version-3 cache lacks execution selection and must be re-read");
    assert.equal(selectorShadowReport(first, 100).narrowed, 1);
    const second = await readSelectorShadowRunsAsync("acme", "rmd", 1, io);
    assert.equal(reads, 8, "a matching complete cache avoids duplicate provider/GitHub reads");
    assert.equal(selectorShadowReport(second, 100).narrowed, 1);
    assert.ok(SELECTOR_SHADOW_READER_VERSION > 3);
    assert.doesNotMatch(readFileSync(cachePath, "utf8"), /echo/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("W1-T5891: narrowed executions never enter the durable live store or historical replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-narrowed-durable-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  mkdirSync(join(root, "test"));
  const now = Date.parse("2026-10-06T00:00:00Z");
  const deps = { repoRoot: root, stateDir, clock: fixedClock(now),
    log: (step: string, extra: Record<string, unknown> = {}) => appendLedger(join(stateDir, "ledger.ndjson"),
      { run_id: "fixture", task_id: "DAEMON", step, ...extra }),
    openWorkspace: (): never => { throw new Error("this evidence-only pass must not open a workspace"); } };
  const pass = (runs: SelectorShadowRun[], options?: Parameters<typeof runSelectorShadowGardener>[7]) =>
    runSelectorShadowGardener(deps, () => runs, () => [], () => { throw new Error("no fixture files a task"); },
      () => [], undefined, undefined, options);
  try {
    const first = await pass([run(1, Array(8).fill("narrow"))]);
    assert.equal(first.narrowed, 1);
    assert.equal(first.runsComplete, 0);
    assert.equal(first.observations.appended, 0);
    assert.deepEqual(readSelectorShadowObservations(stateDir).observations, []);
    const full = await pass([run(2, Array(8).fill("all"))]);
    assert.equal(full.live.runs, 1, "a real full execution is the positive durable-store control");
    let selected = 0;
    const replay = await pass([run(3, Array(8).fill("narrow"))], { replay: {
      owner: "acme", repo: "rmd",
      readJson: async (args) => args[1]!.includes("/actions/workflows/")
        ? { workflow_runs: [{ id: 42, head_sha: "head-42", status: "completed", conclusion: "failure",
          created_at: new Date(now - 7 * 24 * 3600 * 1000).toISOString(), pull_requests: [{ number: 42 }] }] }
        : { total_count: 8, jobs: Array.from({ length: 8 }, (_, i) => ({ id: i + 1,
          name: `coverage-shard (${i + 1}/8)`, status: "completed", conclusion: "failure" })) },
      readText: async () => `COVERAGE-SELECTION: narrow\nAFFECTED-SUITES-SHADOW: ${JSON.stringify({
        fullRun: false, floorSize: 80, narrowSize: 1,
        failures: [{ file: "test/a.test.ts", floor: "selected", narrow: "selected" }],
      })}`,
      select: async () => { selected++; throw new Error("a narrowed historical run cannot be replayed into full evidence"); },
    } });
    assert.equal(selected, 0);
    assert.equal(replay.replayPass?.observed, 0);
    assert.equal(replay.replayPass?.skipped, 1);
    assert.equal(replay.live.runs, 1, "later narrowed successes never dilute the full-run population");
    assert.equal(replay.replay.runs, 0);
    assert.equal(replay.observations.appended, 0);
    assert.equal(readSelectorShadowObservations(stateDir).observations.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
