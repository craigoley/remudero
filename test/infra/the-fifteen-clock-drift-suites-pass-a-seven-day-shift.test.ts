/**
 * W1-T14786: on core PR #20802 (2026-11-25) the clock sweep listed 15 suites that passed today and failed in the
 * future. Each now takes its "now" from the clock the code under test reads: this process's clock for in-process
 * code, the host clock for a child whose clock the shift preload never moves, or the same shift for a child that
 * models the same host. This suite runs each of the 15 as its own child, exactly as the sweep's runner does, at
 * the 7-day shift that first named them and at the sweep's own shift, so none of them can drift back unseen. At the
 * 7-day shift each child runs only that suite's drifting tests, by exact name. At the sweep's shift each child runs
 * the whole suite, as the sweep's report does, so a pinned pass cannot hide another test in the file that drifts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type SweepRow = { suite: string };
// `scripts/**` is outside tsconfig's `include`, so the sweep loads through a dynamic specifier, as
// test/clock-sweep.test.ts loads it.
const { classifySweep, deriveCandidates, runnableCandidates, SUITE_PRELOAD, suiteName, SWEEP_SHIFT_DAYS } = (await import(
  pathToFileURL(join(REPO_ROOT, "scripts", "clock-sweep.mjs")).href)) as {
  classifySweep: (results: Map<string, { failed: boolean }>) => { newDrift: SweepRow[]; drifted: SweepRow[] };
  deriveCandidates: () => string[];
  runnableCandidates: (candidates: string[]) => string[];
  SUITE_PRELOAD: string;
  suiteName: (file: string) => string;
  SWEEP_SHIFT_DAYS: number;
};

/**
 * The drifting tests of each suite: every test that failed at this task's merge base (5b1ca1b321) under the 7-day
 * shift, the sweep's 400-day shift or both, and passed there unshifted. Each child runs only these, by exact name,
 * so the pin costs seconds, not the suites' ~335 s whole-file runtime, and every name must report its own `ok`.
 * Slowest first (measured on the Mac).
 * `bash4`: the test drives a ci.yml step body that calls `mapfile`, which macOS's /bin/bash 3.2 lacks, so it fails
 * there at any clock; it runs wherever `bash` has `mapfile` (every CI runner).
 */
const DRIFTING: readonly { file: string; tests: readonly string[]; bash4?: readonly string[] }[] = [
  // Failed at base only at +400 days.
  { file: "test/sweep/a-light-pass-with-no-scope-decides-from-the-tick-reads-open-pr-views.test.ts", tests: [
    "W1-T13831 criterion 3: with no fresh, clean, newer generation a pass with no scope reads its own views",
  ] },
  { file: "test/inbox/a-triage-outcome-that-files-no-task-lands-through-the-feedback-landing.test.ts", tests: [
    "W1-T12790 criterion 1: a no_task landing awaits its 2 s preflight check, and a 50 ms timer keeps firing",
    "W1-T12790 criterion 2: a grill landing awaits its 2 s preflight check, and a 50 ms timer keeps firing",
    "W1-T12790 criterion 2: a private-home entry lands in its own repository through the async landing, and the timer keeps firing",
  ] },
  { file: "test/daemon/a-paused-instance-says-when-it-has-drained.test.ts", tests: [
    "W1-T12939 criterion 3: the beat prints not-paused for an instance with no hold",
    "W1-T12939 criterion 3: the beat never prints drained for an unreadable, stale or census-less ledger",
  ] },
  { file: "test/console-api/serve/product-routes.test.ts", tests: [
    "W1-T10823: the served plan proposal reaches the maintained native handoff; served product proposal uses the verified managed checkout default",
    "W1-T14388 criterion 1: the fixture child writes its rows only after the test has observed pending, however late the response is",
  ] },
  { file: "test/fix-lane/rmd-fix-never-reports-a-round-fixed-when-its-progress-judgment-failed.test.ts", tests: [
    "W1-T12701 criterion 2: the verb refuses, never fixed, when the judge throws ProviderCapacityBlockedError",
    "W1-T12701 criterion 3: the verb prints one no-round line with the provider cause, never dispatched",
    "W1-T12701 criterion 4: a verb run whose rung wrote fix.dispatch still reads fixed and exits 0",
  ] },
  { file: "test/sweep/a-light-pass-decides-from-its-last-good-open-pr-list-when-the-read-fails.test.ts", tests: [
    "W1-T12755 criterion 6: through the real list read, a 403 rate limit on the second pass still admits the review",
  ] },
  { file: "test/sweep/an-idle-light-pass-decides-from-the-tick-reads-open-pr-views.test.ts", tests: [
    "W1-T13709 criterion 2: a stale served generation uses the hook's own read and keeps its source",
  ] },
  { file: "test/dispatch/product-plan-operation.test.ts", tests: [
    "W1-T10823: the real CLI launcher correlates the native plan brief across distinct PIDs",
    "W1-T13875: a nonzero child exit preserves an opened proposal across resumes",
    "W1-T13875: a resume of a refused hand-off reads no ledger evidence after keeping a proposal recovered from nonadjacent compacted rotations",
  ] },
  { file: "test/daemon/a-worktree-janitor-reports-what-it-would-retire.test.ts", tests: [
    "W1-T11941 criterion 1: the roots come from the operator checkout's git worktree list, and each qualifying tree gets one would-retire row naming its reason",
  ] },
  // Failed at base only at +400 days.
  { file: "test/github/every-mac-session-reads-github-through-one-broker.test.ts", tests: [
    "W1-T10279: rmd gh prints what gh would, refuses writes, and needs a live broker to broker",
  ] },
  { file: "test/sweep/the-sweep-effects-read-terminal-heads-from-the-slice-store.test.ts", tests: [
    "a failed snapshot write preserves the terminal heads and the next build can publish",
    "W1-T12271 criterion 3: same-size, same-mtime corruption holds warm and restarted dispatch",
    "W1-T12271 criterion 3: cached rotation read EIO holds dispatch even when stat and R_OK succeed",
  ] },
  { file: "test/expiring-fixture-census.test.ts", tests: [
    "W1-T14578: one batched shifted run measures each file it reads",
  ] },
  { file: "test/ci/coverage/the-live-coverage-flip-requires-a-fresh-nightly-floor.test.ts", tests: [
    "W1-T5892: an old event cannot make a 49-hour-old floor fresh at execution",
    "W1-T5892: the CLI writes the decision for the shard and refuses an altered pin",
    "W1-T5892: the final merge group is full when live selection is enabled and flag-off stays unchanged",
    "W1-T5892: an admitted floor becoming unreadable or split refuses without replacement",
    "W1-T5892: builtin consumers reject absent admission identities and missing shard receipts",
  ], bash4: [
    "W1-T5892: sparse admission shares the producers' policy identity without dependencies",
    "W1-T5892: one admission precedes all shards and every consumer uses its published pin",
    "W1-T5892: refused admission and publication failure make every shard full with one named reason",
  ] },
  { file: "test/daemon/repository-maintenance-escalation-heals-itself.test.ts", tests: [
    "W1-T10750: the gc prune window is derived from the fleet live state",
  ] },
  { file: "test/deploy/preserve-retire-keep-declarations-hold-every-action.test.ts", tests: [
    "a dry run never prunes worktree records, and an apply run still prunes an unmarked store's stale record",
  ] },
];
/**
 * Each suite's whole-file wall time at the sweep's shift, two at a time (seconds, measured 2026-11-26 in a 4-core cloud
 * container; the paused-instance suite re-measured once its beats stopped walking the host's /tmp, 137 s to 13 s). Only
 * an order is read from them: the pool starts the slowest first, and the tests await the quickest first. The proof
 * runner gives each test 120 s from the end of the one before it, so a test never waits behind a slower suite's start.
 */
const WHOLE_SECONDS: Readonly<Record<string, number>> = {
  "test/daemon/repository-maintenance-escalation-heals-itself.test.ts": 3,
  "test/deploy/preserve-retire-keep-declarations-hold-every-action.test.ts": 4,
  "test/ci/coverage/the-live-coverage-flip-requires-a-fresh-nightly-floor.test.ts": 7,
  "test/daemon/a-worktree-janitor-reports-what-it-would-retire.test.ts": 10,
  "test/sweep/an-idle-light-pass-decides-from-the-tick-reads-open-pr-views.test.ts": 12,
  "test/daemon/a-paused-instance-says-when-it-has-drained.test.ts": 13,
  "test/github/every-mac-session-reads-github-through-one-broker.test.ts": 13,
  "test/fix-lane/rmd-fix-never-reports-a-round-fixed-when-its-progress-judgment-failed.test.ts": 13,
  "test/sweep/the-sweep-effects-read-terminal-heads-from-the-slice-store.test.ts": 15,
  "test/expiring-fixture-census.test.ts": 15,
  "test/sweep/a-light-pass-decides-from-its-last-good-open-pr-list-when-the-read-fails.test.ts": 21,
  "test/console-api/serve/product-routes.test.ts": 42,
  "test/inbox/a-triage-outcome-that-files-no-task-lands-through-the-feedback-landing.test.ts": 49,
  "test/sweep/a-light-pass-with-no-scope-decides-from-the-tick-reads-open-pr-views.test.ts": 51,
  "test/dispatch/product-plan-operation.test.ts": 112,
};
type Suite = (typeof DRIFTING)[number];
const byTime = (a: Suite, b: Suite) => WHOLE_SECONDS[a.file]! - WHOLE_SECONDS[b.file]!;
/** The whole-suite tests, quickest suite first: each one's run has usually finished by the time its test starts. */
const WHOLE_TEST_ORDER = [...DRIFTING].sort(byTime);
const FIFTEEN = DRIFTING.map((suite) => suite.file);
assert.deepEqual(Object.keys(WHOLE_SECONDS).sort(), [...FIFTEEN].sort(), "every suite has a measured whole-file time");
assert.equal(new Set(FIFTEEN).size, 15, "fifteen distinct suites");
const BASH_HAS_MAPFILE = spawnSync("bash", ["-c", "type mapfile"], { stdio: "ignore" }).status === 0;
/** The names this host can run: the bash-4 tests only where `bash` has `mapfile`. */
const pinned = (suite: (typeof DRIFTING)[number]) => [...suite.tests, ...(BASH_HAS_MAPFILE ? suite.bash4 ?? [] : [])];
const exactName = (name: string) => `^${name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}$`;

type Run = { failed: boolean; output: string; names: readonly string[] };

function withoutTestContext(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _context, ...rest } = env;
  return rest;
}

/**
 * One suite's drifting tests as the sweep's `runSuite` runs the suite: TAP, the test preload, the shift preload and a
 * private TMPDIR, plus one exact `--test-name-pattern` per pinned test.
 */
function runShifted(suite: (typeof DRIFTING)[number], days: number, whole: boolean): Promise<Run> {
  const isolatedTmp = mkdtempSync(join(tmpdir(), "rmd-w1-t14786-"));
  // A whole-suite run, as the sweep's report runs it, pins no name: every test in the file must pass.
  const names = whole ? [] : pinned(suite);
  return new Promise((resolve) => {
    execFile(process.execPath,
      ["--test", "--test-reporter=tap", ...names.map((name) => `--test-name-pattern=${exactName(name)}`),
        "--import", "tsx", "--import", join(REPO_ROOT, SUITE_PRELOAD),
        "--import", join(REPO_ROOT, "scripts", "clock-shift.mjs"), suite.file],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
        // Without NODE_TEST_CONTEXT the child reports its own TAP, as it does under the sweep's script runner.
        env: { ...withoutTestContext(process.env), TMPDIR: isolatedTmp, FK_SHIFT_DAYS: String(days) } },
      (error, stdout, stderr) => {
        rmSync(isolatedTmp, { recursive: true, force: true });
        resolve({ failed: error !== null, output: `${stdout}${stderr}`, names });
      });
  });
}

/**
 * Every suite at one shift through a pool, started on first use. Each suite's run is its own promise, so a test per
 * suite waits only for that suite: one test awaiting all fifteen took ~155 s, past the proof runner's per-test
 * timeout, while the pool still finishes all fifteen in one wall-clock pass.
 */
function runShift(days: number, whole: boolean): Map<string, Promise<Run>> {
  const settled = new Map(DRIFTING.map((suite) => {
    let resolve!: (run: Run) => void;
    return [suite.file, { promise: new Promise<Run>((r) => { resolve = r; }), resolve }] as const;
  }));
  // Slowest first over one shared pool (longest-processing-time): the wall time is then about the slowest suite alone
  // (~112 s) rather than the quick suites' sum split across two workers (~161 s at 4 cores, W1-T14786 at 2a5f).
  const queue = [...DRIFTING].sort((a, b) => byTime(b, a));
  // Half a child per core. Serially a proof took ~150 s against the reviewer's 180 s proof bound and failed on a hosted
  // runner (#20913); the children mostly wait, so a pool cuts that roughly in half. The flake screen runs twice
  // availableParallelism() copies of this file at once, and a core-sized pool there held 32 children and ~14.5 GB on
  // a 4-core, 15 GB box; half the cores keeps that load near one child per core per copy pair.
  const drain = async (lane: Suite[]) => {
    for (let suite = lane.shift(); suite !== undefined; suite = lane.shift()) {
      settled.get(suite.file)!.resolve(await runShifted(suite, days, whole));
    }
  };
  // Four workers at least, as many children as the earlier two long lanes plus two quick workers held, so the flake
  // screen's load is unchanged: one shared long lane ran 112 s + 137 s back to back, past the reviewer's whole-proof
  // 180 s bound (#20913's review at e7aa53b, exec_error).
  for (let w = 0; w < Math.max(2, Math.floor(availableParallelism() / 2) - 1) + 2; w++) void drain(queue);
  return new Map([...settled].map(([file, { promise }]) => [file, promise]));
}
// Each shift runs only when a test asks for it, so a proof run that selects one shift's tests spawns only its children.
// `whole` runs every test in each suite, as the sweep's report does; otherwise only the pinned drifting tests run.
const pools = new Map<string, Map<string, Promise<Run>>>();
const runOf = (days: number, file: string, whole = false): Promise<Run> => {
  const key = `${days}:${whole ? "whole" : "pinned"}`;
  if (!pools.has(key)) pools.set(key, runShift(days, whole));
  return pools.get(key)!.get(file)!;
};

/**
 * A run counts only when its own TAP summary says it ran tests and failed none, and every pinned name reported its
 * own `ok` line: a name that matched nothing would otherwise pass by not running.
 */
function verdict(run: Run): string {
  const tests = Number(/^# tests (\d+)$/m.exec(run.output)?.[1] ?? 0);
  const fails = Number(/^# fail (\d+)$/m.exec(run.output)?.[1] ?? -1);
  const passed = new Set(run.output.split("\n").map((line) => /^\s*ok \d+ - (.*)$/.exec(line)?.[1]).filter((name) => name !== undefined));
  const unrun = run.names.filter((name) => !passed.has(name));
  if (!run.failed && tests >= Math.max(1, run.names.length) && fails === 0 && unrun.length === 0) return "pass";
  const notOk = run.output.split("\n").filter((line) => /^\s*not ok /.test(line)).slice(0, 3).join(" | ");
  return `fail (tests ${tests}, fail ${fails}${notOk ? `: ${notOk}` : ""}${unrun.length ? `; no ok for ${unrun.length} pinned` : ""})`;
}

const sweepId = (file: string) => suiteName(file.slice("test/".length));

for (const suite of DRIFTING) {
  test(`W1-T14786 the fifteen clock drift suites pass under a seven day clock shift: ${sweepId(suite.file)}`, async () => {
    assert.equal(verdict(await runOf(7, suite.file)), "pass", `${suite.file} passes 7 days from now`);
  });
}

// The report's input is the sweep's own discovery (deriveCandidates: an age surface and a date literal). A suite whose
// fix removed its last date literal leaves that population, so the report never measures it again; it is named here,
// and every other one of the fifteen must be a runnable candidate, so no pass below stands in for a suite the report
// does not run.
const DATE_LITERAL = /\d{4}-\d{2}-\d{2}/;
const LEFT_THE_SWEEP = new Set(["sweep/a-light-pass-with-no-scope-decides-from-the-tick-reads-open-pr-views"]);
const measured = () => new Set(runnableCandidates(deriveCandidates()));

test("W1-T14786 the clock sweep reports no new drift for the fifteen suites: the sweep measures each one it can", () => {
  const runnable = measured();
  assert.deepEqual(FIFTEEN.map(sweepId).filter((suite) => !runnable.has(suite) && !LEFT_THE_SWEEP.has(suite)), [],
    "every one of the fifteen is a runnable candidate of the sweep, or named as having left it");
  for (const suite of LEFT_THE_SWEEP) {
    assert.equal(runnable.has(suite), false, `${suite} is no longer a sweep candidate`);
    assert.equal(DATE_LITERAL.test(readFileSync(join(REPO_ROOT, "test", `${suite}.test.ts`), "utf8")), false,
      `${suite} left the sweep because it carries no date literal, the sweep's own rule`);
  }
});

for (const suite of WHOLE_TEST_ORDER) {
  test(`W1-T14786 the clock sweep reports no new drift for the fifteen suites: ${sweepId(suite.file)}`, async () => {
    // The whole suite, as the sweep's report runs it: a pinned run could pass while another test in the file drifts.
    const run = await runOf(SWEEP_SHIFT_DAYS, suite.file, true);
    // Positive control: a child that never reported its own summary would read as "not failed" to the classifier.
    assert.equal(verdict(run), "pass", `${suite.file} runs in full and passes at +${SWEEP_SHIFT_DAYS} days`);
    if (LEFT_THE_SWEEP.has(sweepId(suite.file))) return; // the report does not measure it; the test above says why
    const sweep = classifySweep(new Map([[sweepId(suite.file), run]]));
    assert.deepEqual(sweep.newDrift.map((row) => row.suite), [], `the sweep's own classifier names ${suite.file} as no new drift`);
    assert.deepEqual(sweep.drifted.map((row) => row.suite), []);
  });
}
