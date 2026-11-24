// W1-T13391 — a fix round whose own pre-push coverage precheck has a failing selected suite does not push as if
// that suite were unavailable. Each test drives judgeCoverage and coverageVerdictRefuses with scripted runs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COVERAGE_FIX_PUSH_SITE,
  coverageVerdictRefuses,
  judgeCoverage,
  narrowListing,
  type CoverageJudgement,
  type CoverageRun,
  type SuiteRerun,
} from "#src/lib/coverage-narrow.js";

const SUITES = ["test/a.test.ts", "test/b.test.ts"];
const BUILD_PUSH_SITE = "fallback_push";
const REAL_FAILURE =
  "diff-coverage-local: the instrumented suite exited 1 -- lcov was still checked above; this is a real test failure, not necessarily a coverage gap.";

/** A TAP failure block for `file`, the shape node's TAP reporter writes, with the location under `/wt`. */
const tapFailure = (file: string, title: string) =>
  [`not ok 1 - ${title}`, "  ---", "  duration_ms: 1.2", `  location: '/wt/${file}:3:1'`, "  failureType: 'testCodeFailure'", "  ..."].join("\n");
const instrumentedFailure = (file: string): CoverageRun => ({
  status: 1,
  output: ["diff-coverage-local: running the instrumented suite", tapFailure(file, "adds two numbers"), REAL_FAILURE].join("\n"),
  timedOut: false,
});
const fails = (file: string): SuiteRerun => ({ boundMs: 5000, r: { status: 1, output: tapFailure(file, "adds two numbers"), timedOut: false } });
const passes: SuiteRerun = { boundMs: 5000, r: { status: 0, output: "ok 1 - adds two numbers", timedOut: false } };

type Reruns = { head: SuiteRerun; base?: SuiteRerun };

function judgement(run: CoverageRun, reruns: Reruns | undefined, calls: string[], over: Partial<CoverageJudgement> = {}): CoverageJudgement {
  return {
    narrow: [],
    narrowUnreadable: "",
    selection: { suites: SUITES, fullRun: false, reasons: [] },
    passes: [SUITES],
    ceiling: 40,
    bounded: async (s) => {
      calls.push(`instrumented ${s.join(" ")}`);
      return { predictedMs: 1, boundMs: 5000, r: run };
    },
    head: () => "head-sha",
    isUncovered: (output) => /^diff-coverage: BLOCKED -- this diff adds/m.test(output),
    refusalText: (output) => output,
    isMissingSf: (output) => /no SF record in the coverage report/.test(output),
    ...(reruns === undefined
      ? {}
      : {
          rerun: async (s: string[], at: "head" | "merge-base") => {
            calls.push(`${at} ${s.join(" ")}`);
            return at === "head" ? reruns.head : (reruns.base ?? passes);
          },
        }),
    ...over,
  };
}

test("W1-T13391 criterion 1: a selected suite that fails at the head both ways and passes at the merge base refuses the fix round's push and is named", async () => {
  const calls: string[] = [];
  const result = await judgeCoverage(judgement(instrumentedFailure("test/a.test.ts"), { head: fails("test/a.test.ts"), base: passes }, calls));
  assert.equal(result.outcome, "tests-failed");
  assert.ok(result.outcome === "tests-failed");
  assert.deepEqual(result.failing, ["test/a.test.ts"]);
  assert.match(result.text, /test\/a\.test\.ts/);
  assert.match(result.text, /adds two numbers/);
  assert.equal(coverageVerdictRefuses(result, COVERAGE_FIX_PUSH_SITE), true);
  // Only the failing suite is re-run, once without instrumentation and once at the merge base.
  assert.deepEqual(calls, ["instrumented test/a.test.ts test/b.test.ts", "head test/a.test.ts", "merge-base test/a.test.ts"]);
});

test("W1-T13391 criterion 1: a failing selected suite the merge base does not have is the round's own and refuses", async () => {
  const result = await judgeCoverage(judgement(instrumentedFailure("test/a.test.ts"), { head: fails("test/a.test.ts"), base: { absent: true } }, []));
  assert.equal(result.outcome, "tests-failed");
  assert.equal(coverageVerdictRefuses(result, COVERAGE_FIX_PUSH_SITE), true);
});

test("W1-T13391 criterion 1: the narrow pass refuses on a head-owned failure of its own suites", async () => {
  const calls: string[] = [];
  const narrow = narrowListing({ own: ["test/a.test.ts"], importers: new Map([["src/a.ts", ["test/a.test.ts"]]]) });
  const result = await judgeCoverage(judgement(instrumentedFailure("test/a.test.ts"), { head: fails("test/a.test.ts"), base: passes }, calls, { narrow }));
  assert.equal(result.outcome, "tests-failed");
  assert.deepEqual(calls, ["instrumented test/a.test.ts", "head test/a.test.ts", "merge-base test/a.test.ts"]);
});

test("W1-T13391 criterion 2: a selected suite that also fails at the merge base does not refuse, and the row names it as main's", async () => {
  const result = await judgeCoverage(judgement(instrumentedFailure("test/a.test.ts"), { head: fails("test/a.test.ts"), base: fails("test/a.test.ts") }, []));
  assert.equal(result.outcome, "unavailable");
  assert.ok(result.outcome === "unavailable");
  assert.match(result.reason, /main already has this failure: test\/a\.test\.ts/);
  assert.equal(coverageVerdictRefuses(result, COVERAGE_FIX_PUSH_SITE), false);
});

test("W1-T13391 criterion 3: a suite that could not be judged never refuses the push", async (t) => {
  const timedOut: SuiteRerun = { boundMs: 5000, r: { status: null, output: "", timedOut: true } };
  const spawnFailed: SuiteRerun = { boundMs: 5000, r: { status: null, output: "", timedOut: false, spawnError: "spawn ENOENT" } };
  const cases: { name: string; run: CoverageRun; reruns: Reruns | undefined; over?: Partial<CoverageJudgement> }[] = [
    { name: "passes its uninstrumented retry", run: instrumentedFailure("test/a.test.ts"), reruns: { head: passes } },
    { name: "uninstrumented retry times out", run: instrumentedFailure("test/a.test.ts"), reruns: { head: timedOut } },
    { name: "uninstrumented retry cannot spawn", run: instrumentedFailure("test/a.test.ts"), reruns: { head: spawnFailed } },
    { name: "merge-base run times out", run: instrumentedFailure("test/a.test.ts"), reruns: { head: fails("test/a.test.ts"), base: timedOut } },
    { name: "merge-base run cannot spawn", run: instrumentedFailure("test/a.test.ts"), reruns: { head: fails("test/a.test.ts"), base: spawnFailed } },
    { name: "no re-run is available", run: instrumentedFailure("test/a.test.ts"), reruns: undefined },
    { name: "the failure names no selected suite", run: instrumentedFailure("test/other.test.ts"), reruns: { head: fails("test/other.test.ts") } },
    { name: "the instrumented run times out", run: { status: null, output: "", timedOut: true }, reruns: { head: fails("test/a.test.ts") } },
    { name: "the instrumented run cannot spawn", run: { status: null, output: "", timedOut: false, spawnError: "spawn ENOENT" }, reruns: { head: fails("test/a.test.ts") } },
    { name: "no lcov is produced", run: { status: 1, output: "diff-coverage-local: no lcov produced at coverage/x", timedOut: false }, reruns: { head: fails("test/a.test.ts") } },
    {
      name: "the selection is too wide to run",
      run: instrumentedFailure("test/a.test.ts"),
      reruns: { head: fails("test/a.test.ts") },
      over: { selection: { suites: SUITES, fullRun: false, reasons: [] }, passes: [Array.from({ length: 41 }, (_, i) => `test/w${i}.test.ts`)] },
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const result = await judgeCoverage(judgement(c.run, c.reruns, [], c.over));
      assert.equal(result.outcome, "unavailable");
      assert.equal(coverageVerdictRefuses(result, COVERAGE_FIX_PUSH_SITE), false);
    });
  }
});

test("W1-T13391 criterion 3: covered and uncovered are unchanged, and the build's own push never refuses a failing suite", async () => {
  const covered = await judgeCoverage(judgement({ status: 0, output: "diff-coverage: OK", timedOut: false }, { head: fails("test/a.test.ts") }, []));
  assert.equal(covered.outcome, "covered");
  const blocked = "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; cover each line:\n  - src/a.ts:3";
  const uncovered = await judgeCoverage(judgement({ status: 1, output: blocked, timedOut: false }, { head: fails("test/a.test.ts") }, []));
  assert.equal(uncovered.outcome, "uncovered");
  assert.equal(coverageVerdictRefuses(uncovered, COVERAGE_FIX_PUSH_SITE), true);
  assert.equal(coverageVerdictRefuses(uncovered, BUILD_PUSH_SITE), true);
  const headOwned = await judgeCoverage(judgement(instrumentedFailure("test/a.test.ts"), { head: fails("test/a.test.ts"), base: passes }, []));
  assert.equal(headOwned.outcome, "tests-failed");
  assert.equal(coverageVerdictRefuses(headOwned, BUILD_PUSH_SITE), false);
  // The build's own push is given no re-run (coveragePrecheck passes `rerun` only at the fix round's site): the
  // same head reads exactly as on origin/main, and nothing but the instrumented run is spawned.
  const calls: string[] = [];
  const atBuild = await judgeCoverage(judgement(instrumentedFailure("test/a.test.ts"), undefined, calls));
  assert.deepEqual(atBuild, { outcome: "unavailable", reason: "diff-coverage-local: running the instrumented suite" });
  assert.equal(coverageVerdictRefuses(atBuild, BUILD_PUSH_SITE), false);
  assert.deepEqual(calls, ["instrumented test/a.test.ts test/b.test.ts"]);
});
