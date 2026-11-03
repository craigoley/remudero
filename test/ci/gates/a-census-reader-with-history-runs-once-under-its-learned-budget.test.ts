import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FAST_GATE_CENSUS_REMEASURE_MARGIN } from "#src/lib/ci-parity.js";
import { gitRepo } from "#test/helpers/git-repo.js";
// @ts-ignore executable gate module.
import {
  CENSUS_READER_HISTORY_WINDOW, censusReaderHistoryBudget, censusReaderHistoryKey, readCensusReaderHistory, runCensusSuitesViaChild,
  // @ts-ignore executable gate module.
} from "#scripts/census-precheck.mjs";

// @census-reads: none — runtime contexts belong to isolated fixture repositories.
const POLICY = { floorMs: 1000, multiple: 4, remeasureMargin: FAST_GATE_CENSUS_REMEASURE_MARGIN };
const FILE = "test/reader.test.ts";
const PASS = "TAP version 13\nok 1 - reader works\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const RUNTIME = { version: "v24.0.0", platform: "darwin", arch: "arm64", cores: 10 };
const KEY = censusReaderHistoryKey(FILE, RUNTIME);
const priority = { wrap: (file: string, args: string[]) => ({ file, args }) };

function fixture(t: TestContext) {
  const repo = gitRepo({ kind: "reader-history" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, FILE), 'import { test } from "node:test";\ntest("reader works", () => {});\n');
  repo.git("add", "."); repo.git("commit", "--quiet", "-m", "reader input");
  const store = mkdtempSync(join(tmpdir(), "rmd-w11100-history-"));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  return { repo, path: join(store, "nested", "census-reader-history.json") };
}

function seed(path: string, runs: number[]) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, runs: { [KEY]: runs } }));
}

/** One reader run over injected seams, capturing the budgets handed to each child and every line printed. */
type ChildResult = { status: number | null; stdout: string; error?: Error };
function drive(t: TestContext, root: string, times: number[], history: Record<string, unknown>,
  outcome: () => ChildResult = () => ({ status: 0, stdout: PASS })) {
  const bounds: number[] = [];
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(String(line)); });
  const failing = runCensusSuitesViaChild({ root, files: [FILE], readerRuntimePolicy: POLICY, priority, history,
    now: () => times.shift()!, readContext: () => "same-runtime-input",
    run: (_f: string, _a: string[], options: { timeout: number }) => { bounds.push(options.timeout); return outcome(); } });
  t.mock.restoreAll();
  return { failing, bounds, lines };
}
const shadowLine = (lines: string[]) => {
  const line = lines.find((l) => l.startsWith("census-reader-history-shadow: "));
  return line === undefined ? undefined : JSON.parse(line.slice("census-reader-history-shadow: ".length));
};

test("an accepted qualification appends the reader's runtime to a history keyed by its file and runtime, bounded to the window", (t) => {
  const { repo, path } = fixture(t);
  drive(t, repo.dir, [0, 9000, 9001, 9002, 18002], { path, mode: "shadow", runtime: RUNTIME });
  assert.deepEqual(readCensusReaderHistory(path).runs, { [KEY]: [9000] }, "keyed by file and runtime fingerprint, never by the tree");
  assert.equal(statSync(path).mode & 0o777, 0o600, "the history is account-owned");
  seed(path, Array.from({ length: CENSUS_READER_HISTORY_WINDOW }, (_, i) => 1000 + i));
  drive(t, repo.dir, [0, 9000, 9001, 9002, 18002], { path, mode: "shadow", runtime: RUNTIME });
  const kept = readCensusReaderHistory(path).runs[KEY];
  assert.equal(kept.length, CENSUS_READER_HISTORY_WINDOW, "the window is kept");
  assert.equal(kept.at(-1), 9000, "the newest measurement is last");
  assert.ok(!kept.includes(1000), "the oldest falls out");
  writeFileSync(path, "{ not json");
  assert.deepEqual(readCensusReaderHistory(path).runs, {}, "a corrupt history reads as empty");
  assert.match(String(readCensusReaderHistory(path).reason), /unreadable/);
  assert.deepEqual(readCensusReaderHistory(join(path, "absent")).runs, {});
});

test("W1-T11100 criterion 2: in shadow a reader with history still calibrates and qualifies, and names its history budget, fit and saving", (t) => {
  const { repo, path } = fixture(t);
  seed(path, [8000, 9000, 10000]);
  const shadow = drive(t, repo.dir, [0, 9000, 9001, 9002, 18002], { path, mode: "shadow", runtime: RUNTIME });
  assert.deepEqual(shadow.bounds, [120000, 36000], "calibration then qualification, exactly as today");
  assert.deepEqual(shadowLine(shadow.lines), {
    file: FILE, historyRuns: 3, historyBudgetMs: censusReaderHistoryBudget([8000, 9000, 10000], POLICY),
    qualificationMs: 9000, wouldFit: true, wouldSaveMs: 9000,
  });
  assert.equal(censusReaderHistoryBudget([8000, 9000, 10000], POLICY), 36000, "the policy multiple over the median");
  assert.equal(censusReaderHistoryBudget([100, 200], POLICY), 4000, "floored like a calibration");
  seed(path, [1000]);
  const tight = drive(t, repo.dir, [0, 9000, 9001, 9002, 18002], { path, mode: "shadow", runtime: RUNTIME });
  assert.equal(shadowLine(tight.lines).wouldFit, false, "a qualification past the history budget says it would not have fit");
  const empty = fixture(t);
  const none = drive(t, empty.repo.dir, [0, 9000, 9001, 9002, 18002], { path: empty.path, mode: "shadow", runtime: RUNTIME });
  assert.deepEqual(shadowLine(none.lines), { file: FILE, historyRuns: 0, reason: "no history file" });
});

test("W1-T11100 criterion 3: shadow leaves the verdict and budgets byte-identical, and act runs once or falls back to today's path", (t) => {
  const { repo, path } = fixture(t);
  const off = drive(t, repo.dir, [0, 9000, 9001, 9002, 18002], { path: null });
  seed(path, [8000, 9000, 10000]);
  const shadow = drive(t, repo.dir, [0, 9000, 9001, 9002, 18002], { path, mode: "shadow", runtime: RUNTIME });
  assert.deepEqual([shadow.failing, shadow.bounds], [off.failing, off.bounds], "shadow changes neither the verdict nor a budget");
  assert.deepEqual(shadow.lines.filter((l) => !l.startsWith("census-reader-history-shadow: ")), off.lines, "only the shadow line is added");

  seed(path, [8000, 9000, 10000]);
  const act = drive(t, repo.dir, [0, 9000], { path, mode: "act", runtime: RUNTIME });
  assert.deepEqual(act.failing, []);
  assert.deepEqual(act.bounds, [36000], "with history, one run under the history budget");
  assert.ok(act.lines.some((l) => l.includes('"budgetSource":"history"')));

  seed(path, [1000]);
  let calls = 0;
  const overrun = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
  const fallback = drive(t, repo.dir, [0, 4100, 4101, 13101, 13102, 13103, 22103], { path, mode: "act", runtime: RUNTIME },
    () => (calls++ === 0 ? { status: null, stdout: "", error: overrun } : { status: 0, stdout: PASS }));
  assert.deepEqual(fallback.failing, [], "an overrun of the history budget is not a refusal");
  assert.deepEqual(fallback.bounds, [4000, 120000, 36000], "it falls back to calibrate then qualify");
  assert.ok(fallback.lines.some((l) => l.startsWith("census-reader-history-fallback: ")));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).runs[KEY].at(-1), 9000, "the fallback's qualification is recorded");
});
