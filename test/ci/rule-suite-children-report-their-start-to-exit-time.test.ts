import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import test from "node:test";

import { listRuleSuites } from "#src/lib/ci-parity.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  main,
  measureSuiteStarts,
  runRuleSuites,
  runRuleSuitesConcurrently,
  timedSuiteRun,
  // @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
} from "#scripts/list-rule-suites.mjs";

// W1-T12401: W1-T11938 needs a before and an after number for a repeated rule-suite child start, and
// nothing on main measured one. The runner now times each child from spawn to exit, and
// `--measure-starts <n> [suite]` starts one suite n times in the caller's own environment.

type SyncRun = typeof spawnSync;
type Options = { cwd?: string; stdio?: unknown; env?: unknown };

/** A clock the fake children advance: each suite "takes" the next of `durations`, in call order. */
function fakeClock(durations: readonly number[]) {
  let t = 1_000;
  let call = 0;
  return {
    now: () => t,
    advance: () => { t += durations[call++ % durations.length]!; },
  };
}

function capture(t: { mock: { method: (object: object, name: string, impl: (line: string) => void) => unknown } }) {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, "log", (line: string) => { out.push(line); });
  t.mock.method(console, "error", (line: string) => { err.push(line); });
  return { out, err };
}

test("W1-T12401 c1 each rule-suite child reports its wall time", async (t) => {
  const { out } = capture(t);
  const suites: string[] = listRuleSuites(REPO_ROOT);
  const durations = suites.map((_, index) => 10 + index);
  const clock = fakeClock(durations);
  const run = () => { clock.advance(); return { status: 0, error: undefined }; };
  assert.equal(runRuleSuites(REPO_ROOT, run as unknown as SyncRun, clock.now), 0);
  suites.forEach((suite, index) => {
    const at = out.indexOf(`rule-checks: ${suite}`);
    assert.ok(at >= 0, `the serial path prints ${suite}'s header`);
    assert.equal(out[at + 1], `rule-checks: ${suite}: ${durations[index]} ms`, "the timing line follows its own header");
  });

  out.length = 0;
  const concurrent = fakeClock(durations);
  const write = (text: string) => { out.push(...text.replace(/\n$/, "").split("\n")); };
  const runCaptured = async (suite: string) => { concurrent.advance(); return { status: 0, output: `out of ${suite}` }; };
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 1, run: runCaptured, write, now: concurrent.now }), 0);
  suites.forEach((suite, index) => {
    const at = out.indexOf(`rule-checks: ${suite}`);
    assert.deepEqual(out.slice(at, at + 3), [`rule-checks: ${suite}`, `out of ${suite}`, `rule-checks: ${suite}: ${durations[index]} ms`],
      "the concurrent path prints the time after the suite's own block");
  });

  // The helper itself: a synchronous result and a promised one are timed the same way, on the real clock by default.
  const sync = timedSuiteRun(() => "done", fakeClock([4]).now);
  assert.deepEqual(sync, { result: "done", ms: 0 });
  const real = await timedSuiteRun(() => new Promise((resolve) => setTimeout(() => resolve("later"), 15)));
  assert.equal(real.result, "later");
  assert.ok(real.ms >= 10, `a 15 ms child reads at least 10 ms on the real clock, read ${real.ms}`);
});

test("W1-T12401 c2 measure mode prints the median of N starts", (t) => {
  const { out, err } = capture(t);
  const suite = "test/clock-signature-census.test.ts";
  const clock = fakeClock([40, 10, 30, 20, 50]);
  let starts = 0;
  const run = () => { starts += 1; clock.advance(); return { status: 0, error: undefined }; };
  assert.equal(measureSuiteStarts(5, suite, { repoRoot: REPO_ROOT, run, now: clock.now }), 0);
  assert.equal(starts, 5, "one child per start, one after another");
  assert.deepEqual(out, [
    `rule-checks: measure-starts: ${suite}: start 1/5: 40 ms`,
    `rule-checks: measure-starts: ${suite}: start 2/5: 10 ms`,
    `rule-checks: measure-starts: ${suite}: start 3/5: 30 ms`,
    `rule-checks: measure-starts: ${suite}: start 4/5: 20 ms`,
    `rule-checks: measure-starts: ${suite}: start 5/5: 50 ms`,
    `rule-checks: measure-starts: ${suite}: n=5 median 30 ms, min 10 ms, max 50 ms`,
  ]);
  assert.deepEqual(err, []);

  out.length = 0;
  const even = fakeClock([40, 10, 30, 21]);
  measureSuiteStarts(4, suite, { repoRoot: REPO_ROOT, run: () => { even.advance(); return { status: 0 }; }, now: even.now });
  assert.equal(out.at(-1), `rule-checks: measure-starts: ${suite}: n=4 median 26 ms, min 10 ms, max 40 ms`, "an even count takes the middle pair's mean");

  // A start that fails still counts its time, names itself, and makes the measurement exit 1.
  out.length = 0;
  const red = fakeClock([5]);
  assert.equal(measureSuiteStarts(2, suite, { repoRoot: REPO_ROOT, run: () => { red.advance(); return { status: 1 }; }, now: red.now }), 1);
  assert.deepEqual(err, [`rule-checks: ${suite}: failed (1)`, `rule-checks: ${suite}: failed (1)`]);
  assert.equal(out.at(-1), `rule-checks: measure-starts: ${suite}: n=2 median 5 ms, min 5 ms, max 5 ms`);

  // The CLI: the count is required and positive, the suite defaults to the population's first.
  out.length = 0;
  err.length = 0;
  const named: string[] = [];
  const cliRun = (_node: string, args: string[]) => { named.push(args.at(-1)!); return { status: 0 }; };
  assert.equal(main(["--measure-starts", "2"], cliRun as unknown as SyncRun), 0);
  assert.deepEqual(named, Array(2).fill(listRuleSuites(REPO_ROOT)[0]));
  assert.match(out.at(-1)!, /: n=2 median \d+ ms, min \d+ ms, max \d+ ms$/);
  for (const bad of [["--measure-starts"], ["--measure-starts", "0"], ["--measure-starts", "x"], ["--measure-starts", "2", suite, "extra"]]) {
    assert.equal(main(bad, cliRun as unknown as SyncRun), 2, bad.join(" "));
  }
  assert.match(err.at(-1)!, /usage: .*\[--list\|--run\] \| --measure-starts <n> \[suite\]/);
});

test("W1-T12401 c3 timing leaves the failed suites line unchanged", async (t) => {
  const { out, err } = capture(t);
  const suites: string[] = listRuleSuites(REPO_ROOT);
  const failing = new Set([suites[0]!, suites[2]!]);
  const clock = fakeClock([3]);
  const run = (_node: string, args: string[]) => {
    clock.advance();
    const suite = args.at(-1)!;
    return suite === suites[2] ? { status: null, error: new Error("spawn ENOENT") } : { status: failing.has(suite) ? 1 : 0, error: undefined };
  };
  assert.equal(runRuleSuites(REPO_ROOT, run as unknown as SyncRun, clock.now), 1, "the exit code is today's");
  assert.deepEqual(err, [
    `rule-checks: ${suites[0]}: failed (1)`,
    `rule-checks: ${suites[2]}: spawn ENOENT`,
    `rule-checks: failed suites: ${suites[0]} ${suites[2]}`,
  ], "stderr carries only today's verdict lines and the closing line, last");
  assert.equal(out.filter((line) => line.endsWith(" ms")).length, suites.length, "the timing lines all go to stdout");

  err.length = 0;
  out.length = 0;
  const write = () => {};
  const runCaptured = async (suite: string) => ({ status: failing.has(suite) ? 1 : 0, output: "" });
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 3, run: runCaptured, write }), 1);
  assert.equal(err.at(-1), `rule-checks: failed suites: ${suites[0]} ${suites[2]}`);
  assert.equal(err.filter((line) => line.startsWith("rule-checks: failed suites:")).length, 1);
  assert.ok(out.every((line) => !line.includes("failed suites")), "no timing line imitates the closing line");

  err.length = 0;
  assert.equal(runRuleSuites(REPO_ROOT, (() => ({ status: 0 })) as unknown as SyncRun), 0);
  assert.deepEqual(err, [], "a green run names no failed suite");
});

test("W1-T12401 c4 the instrument passes the child env untouched", (t) => {
  capture(t);
  const callerEnv = { ...process.env };
  const options: Options[] = [];
  const run = (_node: string, _args: string[], opts: Options) => { options.push(opts); return { status: 0 }; };
  runRuleSuites(REPO_ROOT, run as unknown as SyncRun);
  const serial = options.length;
  assert.equal(measureSuiteStarts(2, "test/clock-signature-census.test.ts", { repoRoot: REPO_ROOT, run }), 0);
  assert.equal(main(["--measure-starts", "1"], run as unknown as SyncRun), 0);
  assert.equal(options.length, serial + 3, "every measured start reached the injected spawn");
  for (const opts of options) assert.equal(Object.hasOwn(opts, "env"), false, "no child gets an env of the instrument's own, so it inherits the caller's");
  assert.deepEqual({ ...process.env }, callerEnv, "the caller's environment, NODE_COMPILE_CACHE included, is exactly as it was");
  assert.equal(process.env.NODE_COMPILE_CACHE, callerEnv.NODE_COMPILE_CACHE, "the instrument sets no NODE_COMPILE_CACHE of its own");
});
