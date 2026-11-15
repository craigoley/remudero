import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listRuleSuites } from "#src/lib/ci-parity.js";
import { pressureWidth, readHostPressure, unwrapLowPriority, type HostPressure } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
import { main, ruleSuitePressure, runRuleSuites, runRuleSuitesConcurrently, spawnSuiteCaptured, suiteCommand } from "#scripts/list-rule-suites.mjs";

// OBSERVED 2026-11-10: about nine concurrent preflights each ran their rule suites one per core on an
// 8-core host (load 40 to 55), and time-bound suites flapped. The width now follows host pressure,
// re-read at the start and whenever a suite ends, and every suite child runs niced (W1-T11939).

type Result = { status: number | null; error?: Error; output: string };
const quiet = (t: { mock: { method: (o: object, m: string, f: () => void) => unknown } }) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
};

/** A fake suite run that records how many suites were in flight when each one started. */
function trackingRun() {
  let inFlight = 0;
  const startedAt: number[] = [];
  const run = async (): Promise<Result> => {
    startedAt.push(++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return { status: 0, output: "" };
  };
  return { run, startedAt };
}

test("W1-T11939 criterion 1: the rule-suite width is computed from injected pressure, rising when the host is idle and falling when it is busy", async (t) => {
  quiet(t);
  const idle: HostPressure = { cores: 8, cpuStallPercent: 0, load1: 0 };
  const busy: HostPressure = { cores: 8, cpuStallPercent: 95, load1: 48 };
  assert.equal(pressureWidth(idle, 2), 8, "an idle host raises the width above the starting one");
  assert.equal(pressureWidth(busy, 8), 1, "a stalled host lowers it");
  assert.equal(pressureWidth({ cores: 8, cpuStallPercent: 50 }, 3), 4, "PSI: the cores the host is not stalling on");
  assert.equal(pressureWidth({ cores: 8, load1: 6 }, 3), 2, "load average: the cores the load leaves free");
  assert.equal(pressureWidth({ cores: 8, load1: 6 }, 3, 4), 6, "this run's own in-flight children are not counted as foreign load");

  const suites = listRuleSuites(REPO_ROOT);
  assert.ok(suites.length > 40, "positive control: the real rule population is large enough to observe both phases");
  const { run, startedAt } = trackingRun();
  let sampled = 0;
  const pressure = () => (++sampled <= 20 ? idle : busy);
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 2, run, write: () => {}, pressure }), 0);
  assert.equal(startedAt.length, suites.length, "every suite runs exactly once");
  assert.equal(Math.max(...startedAt.slice(0, 20)), 8, "idle: the run widened past its starting width of 2 to the 8 free cores");
  assert.deepEqual(startedAt.slice(-15), Array(15).fill(1), "busy: the run narrowed to one suite at a time");
  assert.ok(sampled >= suites.length, "the width is re-derived between suites, not once");

  const calls: { pressure?: unknown }[] = [];
  await main(["--run"], undefined, 3, async (_root: string, options: { pressure?: unknown }) => { calls.push(options); return 0; });
  assert.equal(typeof calls[0]?.pressure, "function", "the CLI hands the run a pressure sampler by default");
  assert.equal(ruleSuitePressure({ RMD_RULE_SUITE_CONCURRENCY: "4" }), undefined, "an operator's explicit pin is a fixed width");
});

test("W1-T11939 criterion 2: there is no fixed ceiling constant, and the minimum width is one so the run always progresses", async (t) => {
  quiet(t);
  for (const cores of [8, 64, 512]) assert.equal(pressureWidth({ cores, cpuStallPercent: 0 }, 1), cores, `an idle ${cores}-core host gets ${cores}`);
  assert.equal(pressureWidth({ cores: 256, load1: 0 }, 1), 256, "the load-average path has no ceiling but the core count");
  assert.equal(pressureWidth({ cores: 8, cpuStallPercent: 100 }, 8), 1, "total stall still leaves one");
  assert.equal(pressureWidth({ cores: 8, load1: 1e6 }, 8), 1, "an overwhelming load still leaves one");
  assert.equal(pressureWidth(undefined, 0), 1, "a zero starting width becomes one");

  const suites = listRuleSuites(REPO_ROOT);
  const { run, startedAt } = trackingRun();
  const saturated = () => ({ cores: 8, cpuStallPercent: 100, load1: 1e6 });
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 0, run, write: () => {}, pressure: saturated }), 0);
  assert.equal(startedAt.length, suites.length, "a saturated host still finishes every suite");
  assert.equal(Math.max(...startedAt), 1);
});

test("W1-T11939 criterion 3: rule-suite children run niced, and the failed-suites line and exit status are unchanged", async (t) => {
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => printed.push(line));
  t.mock.method(console, "error", (line: string) => printed.push(line));
  const suites = listRuleSuites(REPO_ROOT);
  const failing = new Set([suites[2]!, suites[0]!]);
  const run = async (suite: string): Promise<Result> => ({ status: failing.has(suite) ? 1 : 0, output: "" });
  const idle = () => ({ cores: 8, cpuStallPercent: 0 });
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 3, run, write: () => {}, pressure: idle }), 1, "a red suite still exits 1");
  assert.equal(printed.at(-1), `rule-checks: failed suites: ${suites[0]} ${suites[2]}`, "the verdict line is unchanged, in population order");
  printed.length = 0;
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 3, run: async () => ({ status: 0, output: "" }), write: () => {}, pressure: idle }), 0);
  assert.equal(printed.some((line) => line.includes("failed suites")), false, "a green run still exits 0 and names none");

  const nice = ["/usr/bin/nice", "/bin/nice"].some((path) => existsSync(path));
  const command = suiteCommand(suites[0], REPO_ROOT);
  if (nice) assert.match(command.file, /nice$/, "the suite child starts under nice");
  assert.equal(unwrapLowPriority(command.file, command.args).file, process.execPath, "the wrapped command is still node");
  const files: string[] = [];
  printed.length = 0;
  assert.equal(runRuleSuites(REPO_ROOT, ((file: string) => { files.push(file); return { status: 0 }; }) as never), 0);
  assert.ok(files.length === suites.length && files.every((file) => file === command.file), "the serial path spawns the same niced command");

  // The real spawn: a suite reports its own niceness, which must be ten above this process's (capped at 19).
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rule-suite-nice-`));
  try {
    const suite = join(dir, "niceness.test.mjs");
    const want = nice ? Math.min(19, getPriority() + 10) : getPriority();
    writeFileSync(suite, `import { getPriority } from "node:os";\nimport test from "node:test";\nimport assert from "node:assert/strict";\n`
      + `test("niceness", () => assert.equal(getPriority(), ${want}));\n`);
    // A standalone child runner, as `--run` starts it: not a subtest of this one, and outside its coverage session.
    const env = { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: undefined };
    const result = await spawnSuiteCaptured(suite, REPO_ROOT, env);
    assert.match(result.output, /ℹ pass 1/, "positive control: the niceness test really ran in the child");
    assert.equal(result.status, 0, result.output);
    writeFileSync(suite, `import test from "node:test";\ntest("red", () => { throw new Error("red suite"); });\n`);
    const red = await spawnSuiteCaptured(suite, REPO_ROOT, env);
    assert.equal(red.status, 1, "a niced red suite's exit status reaches the run unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T11939 criterion 4: an unreadable pressure source falls back to the current width, never to zero", async (t) => {
  quiet(t);
  assert.equal(pressureWidth(undefined, 5), 5, "no sample keeps the current width");
  assert.equal(pressureWidth({ cores: 8 }, 3), 3, "a sample with neither reading keeps it");
  assert.equal(pressureWidth({ cores: Number.NaN, load1: 0 }, 4), 4, "an unreadable core count keeps it");
  assert.equal(pressureWidth(undefined, Number.NaN), 1, "and never falls to zero");

  const unreadable = () => { throw new Error("EACCES /proc/pressure/cpu"); };
  assert.equal(readHostPressure(unreadable, () => [Number.NaN], () => 8), undefined, "neither PSI nor load reads");
  assert.deepEqual(readHostPressure(unreadable, () => [3], () => 8), { cores: 8, load1: 3 }, "PSI unreadable: the load average stands");
  assert.deepEqual(readHostPressure(() => "some avg10=12.50 avg60=1.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    () => [2], () => 8), { cores: 8, cpuStallPercent: 12.5, load1: 2 });
  assert.equal(readHostPressure(() => "garbage", () => [], () => 8), undefined, "an unparseable PSI file and no load is no reading");
  assert.equal(readHostPressure(unreadable, () => [1], () => 0), undefined, "no core count is no reading");
  const real = readHostPressure();
  if (real !== undefined) assert.ok(real.cores >= 1 && (real.cpuStallPercent !== undefined || real.load1 !== undefined), "the real host reads");

  const { run, startedAt } = trackingRun();
  let sampled = 0;
  const flaky = () => {
    if (++sampled === 1) return { cores: 8, cpuStallPercent: 75 };
    throw new Error("pressure unreadable");
  };
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 6, run, write: () => {}, pressure: flaky }), 0);
  assert.equal(Math.max(...startedAt), 2, "after a reading of 2, an unreadable source keeps 2 — not the starting 6, and not 0");
  assert.equal(startedAt.length, listRuleSuites(REPO_ROOT).length, "and the run completes");
});
