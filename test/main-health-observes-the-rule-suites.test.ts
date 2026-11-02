import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import * as reproduction from "#src/lib/base-reproduction.js";
import type { BaseProbeFile, BaseProbeResult } from "#src/lib/base-reproduction.js";
import { listRuleSuites } from "#src/lib/ci-parity.js";
import { ciFailureRegionReducer, extractCiFailureRegion } from "#src/run-task.js";
import {
  BASE_RED_REFRESH_STEP, DEFAULT_SWEEP_POLICY, baseRedHistoryFromLedger, decideBaseRed, mainLatestRunFromLedger, runSweep,
  type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";
// @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
import { runRuleSuites } from "#scripts/list-rule-suites.mjs";

// W1-T7848: `rule-checks` runs only on pull_request and merge_group, so main's CI census never names it
// and a green main reads as green for every rule red. The W1-T6024 probe is the only observer, and it
// read the whole light-gates log: a helper in a stack trace (test/setup/tmp-hygiene.ts) made every
// rule-checks probe set unrunnable (heads 5b135a223 and a9cef374b, 2026-10-11).

type Row = Record<string, unknown>;
const NOW = Date.now();
const REPO_ROOT = process.cwd();
const [M0, M1, M2] = ["0", "1", "2"].map((c) => c.repeat(40)) as [string, string, string];
const SUITE = "test/clock-signature-census.test.ts";
const OTHER_SUITE = "test/fixture-copy-census.test.ts";
const HELPER = "test/setup/tmp-hygiene.ts";
const MAIN_CHECKS = ["ci", "ci-shard (1/8)", "coverage-ratchet", "ci-gate"];
const STEP = "main.rule_checks.observed";

// Read through the namespace so this file loads at base, where the reader does not exist yet.
const known = reproduction as unknown as {
  failingRuleSuitesFromCiFailures?: (failures: readonly { name: string; logTail: string }[]) => string[];
};

/** What node 24's default (spec) reporter prints for one suite: a failing one ends in `✖ failing tests:`. */
function specOutput(suite: string, fails: boolean): string[] {
  const summary = ["ℹ tests 2", "ℹ suites 0", `ℹ pass ${fails ? 1 : 2}`, `ℹ fail ${fails ? 1 : 0}`, "ℹ cancelled 0",
    "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 812.4"];
  if (!fails) return ["✔ a census rule (0.4ms)", "✔ another census rule (0.2ms)", ...summary];
  return ["✖ a census rule (2.8ms)", "✔ another census rule (0.2ms)", ...summary, "", "✖ failing tests:", "",
    `test at ${suite}:12:1`, "✖ a census rule (2.8ms)", "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "  1 !== 2", `      at TestContext.<anonymous> (/home/runner/work/remudero/remudero/${suite}:14:10)`,
    `      at file:///home/runner/work/remudero/remudero/${HELPER}:40:5`,
    ...Array.from({ length: 30 }, (_, i) => `      at frame ${i} (node:internal/test_runner/test:${900 + i}:17)`)];
}

const ruleRed = (sha: string, suites = [SUITE]): Row =>
  ({ step: STEP, main_sha: sha, state: "red", failing_suites: suites, pr_number: 9724, head_sha: "f".repeat(40) });
const ruleGreen = (sha: string, suites = [SUITE]): Row => ({ step: STEP, main_sha: sha, state: "green", suites });
const greenMain = (sha: string, decidedBy = sha): Row => ({
  step: "main.health.observed", sha, state: "green", failing_checks: [], observed_checks: MAIN_CHECKS, decided_by_sha: decidedBy,
});
const reproducedRow = (prNumber: number, headSha: string, mainSha: string, files = [SUITE]): Row => ({
  step: "sweep.base_reproduction", pr_number: prNumber, head_sha: headSha, main_sha: mainSha, verdict: "reproduced",
  files: files.map((file) => ({ file, outcome: "fails", duration_ms: 0, cached: false })),
});
const ruleTail = (suites = [SUITE]) =>
  [...specOutput(suites[0]!, true), `rule-checks: ${suites[0]}: failed (1)`, `rule-checks: failed suites: ${suites.join(" ")}`].join("\n");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9724, prUrl: "https://github.com/craigoley/remudero/pull/9724", taskId: "W1-T9724",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    createdAt: new Date(NOW - 90 * 60_000).toISOString(),
    lastActivityAt: new Date(NOW - 60_000).toISOString(), headSha: "f".repeat(40),
    headRefName: "run-W1-T9724-1", autoMergeArmed: false,
    ciFailures: [{ name: "rule-checks", logTail: ruleTail() }], ...over,
  };
}

const peer = (): OpenPrView =>
  pr({ prNumber: 6000, taskId: "W1-T6000", headSha: "e".repeat(40), checksState: "green", reviewState: "success", ciFailures: [] });

type Probe = (files: readonly string[], sha: string) => BaseProbeResult;
const allFail: Probe = (files) => files.map((file): BaseProbeFile => ({ file, outcome: "fails", duration_ms: 0, cached: false }));
const allPass: Probe = (files) => files.map((file): BaseProbeFile => ({ file, outcome: "passes", duration_ms: 0, cached: false }));

function harness(rows: Row[]) {
  // W1-T8533: unrelated PR history covers this PR's entire lifetime for every refresh reader.
  rows.unshift(...["fix.base_refreshed", "sweep.base_red.refresh", "sweep.base_fixed.refresh", "refresh.clearance"]
    .map(step => ({ step, ts: new Date(NOW - 120 * 60_000).toISOString(), pr_number: 1, outcome: "skipped" })));
  const fixed: number[] = [];
  const refreshed: number[] = [];
  const probed: string[] = [];
  let tip = M1;
  let probe: Probe = allFail;
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    dispatchFix: (p) => {
      fixed.push(p.prNumber);
      rows.push({ step: "fix.dispatch", task_id: p.taskId, head_sha: p.headSha, strike: 1 });
    },
    updateBranch: (p) => { refreshed.push(p.prNumber); return "updated"; },
    ledgerPath: "/dev/null/w1-t7848.ndjson", runId: "W1-T7848-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, readMainTip: () => tip,
    reproduceFailingTestsOnMain: async (_pr, files, sha) => { probed.push(...files); return probe(files, sha); },
  };
  return {
    rows, fixed, refreshed, probed,
    at(sha: string, next: Probe) { tip = sha; probe = next; },
    sweep: (prs: OpenPrView[]) => runSweep([...prs, peer()], deps, DEFAULT_SWEEP_POLICY),
    observed: () => rows.filter((r) => r.step === STEP),
    reason: (n: number) => String([...rows].reverse().find((r) => r.step === "sweep.disposed" && r.pr_number === n)?.stand_down_reason),
  };
}

test("W1-T7848: a failing rule-checks run names its failing suites on its last line", (t) => {
  const suites = listRuleSuites(REPO_ROOT);
  const failing = new Set([suites[0]!, suites[2]!]);
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => printed.push(line));
  t.mock.method(console, "error", (line: string) => printed.push(line));
  // The child's own output reaches the same log as the runner's lines (stdio: "inherit", then `2>&1 | tee`).
  const run = (_cmd: string, args: string[]) => {
    const suite = args.at(-1)!;
    printed.push(...specOutput(suite, failing.has(suite)));
    return suite === suites[2] ? { status: null, error: new Error("spawn ENOENT") } : { status: failing.has(suite) ? 1 : 0, error: undefined };
  };
  assert.equal(runRuleSuites(REPO_ROOT, run as unknown as typeof spawnSync), 1);
  assert.equal(printed.at(-1), `rule-checks: failed suites: ${suites[0]} ${suites[2]}`, "a red suite and an unspawnable one, in run order");
  assert.equal(printed.filter((line) => line.startsWith("rule-checks: failed suites:")).length, 1);

  printed.length = 0;
  assert.equal(runRuleSuites(REPO_ROOT, (() => ({ status: 0, error: undefined })) as unknown as typeof spawnSync), 0);
  assert.equal(printed.filter((line) => line.includes("failed suites")).length, 0, "a green run names no failed suite");

  // The step's log as Actions stores it: the line sits far below the first `✖ failing tests:` block,
  // which is all the failure region keeps of a spec-reporter run. It must survive the cut anyway.
  printed.length = 0;
  runRuleSuites(REPO_ROOT, run as unknown as typeof spawnSync);
  const log = ["##[group]Run set -o pipefail", "##[endgroup]", ...printed, "##[error]Process completed with exit code 1.",
    "##[group]Run bash .github/scripts/leak-grep.sh", "##[endgroup]", "leak-grep: OK"]
    .map((line) => `2026-10-11T03:22:45.0000000Z ${line}`).join("\n");
  const reducer = ciFailureRegionReducer(60);
  for (const line of log.split("\n")) reducer.push(line);
  const fold = known.failingRuleSuitesFromCiFailures;
  assert.equal(typeof fold, "function", "base-reproduction.ts exports failingRuleSuitesFromCiFailures");
  for (const region of [reducer.finish(), extractCiFailureRegion(log, 60)]) {
    assert.match(region, /✖ failing tests:/, "the region is the spec reporter's failing-tests block");
    assert.deepEqual(fold!([{ name: "rule-checks", logTail: region }]), [suites[0], suites[2]], region);
  }
});

test("W1-T7848: a rule-checks probe set holds only the failing suites", () => {
  const fold = known.failingRuleSuitesFromCiFailures;
  assert.equal(typeof fold, "function", "base-reproduction.ts exports failingRuleSuitesFromCiFailures");
  // The light-gates job posts every gate's check from one log: another gate's file and a helper ride along.
  const shared = `${ruleTail([SUITE, OTHER_SUITE])}\nlint-plan: test/plan-shard-fixture.test.ts refused\nat ${HELPER}:40:5`;
  assert.deepEqual(reproduction.baseReproductionFiles([{ name: "rule-checks", logTail: shared }]), [SUITE, OTHER_SUITE]);
  assert.deepEqual(fold!([{ name: "rule-checks", logTail: shared }]), [SUITE, OTHER_SUITE]);
  assert.deepEqual(fold!([{ name: "lint-plan", logTail: shared }]), [], "only the rule-checks failure is read for its line");
  assert.deepEqual(reproduction.baseReproductionFiles([{ name: "lint-plan", logTail: shared }]),
    [SUITE, OTHER_SUITE, "test/plan-shard-fixture.test.ts"], "another check keeps today's extraction, without the helper");
  const noLine = specOutput(SUITE, true).join("\n");
  assert.deepEqual(reproduction.baseReproductionFiles([{ name: "rule-checks", logTail: noLine }]), [SUITE],
    "a rule-checks red with no failed-suites line keeps today's extraction, without the helper");
  assert.deepEqual(reproduction.baseReproductionFiles([{ name: "ci", logTail: `at ${HELPER}:40:5\ntest/helpers/git-repo.ts:3:1` }]), [],
    "a path that is not a .test.ts suite is never a probe candidate for any check");
  assert.deepEqual(reproduction.baseReproductionFiles([
    { name: "rule-checks", logTail: shared }, { name: "ci-shard (1/8)", logTail: "not ok 1 - test/daemon-tick.test.ts" },
  ]), [SUITE, OTHER_SUITE, "test/daemon-tick.test.ts"], "a rule red beside a shard red probes both");
});

test("W1-T7848: a reproduced rule suite reads main red on rule-checks at that sha", async () => {
  // Main's CI at M1 has no verdict of its own yet: its reading is decided by M0, so no CI run contradicts the probe.
  const h = harness([greenMain(M1, M0)]);
  h.at(M1, allFail);
  await h.sweep([pr()]);
  assert.deepEqual(h.probed, [SUITE], "only the failing suite is probed");
  assert.deepEqual(h.fixed, [], "a reproduced probe sends no fix worker");
  assert.deepEqual(h.observed().map(({ step, main_sha, state, failing_suites, pr_number, head_sha }) =>
    ({ step, main_sha, state, failing_suites, pr_number, head_sha })),
  [{ step: STEP, main_sha: M1, state: "red", failing_suites: [SUITE], pr_number: 9724, head_sha: "f".repeat(40) }]);
  const main = mainLatestRunFromLedger(h.rows);
  assert.equal(main?.sha, M1);
  assert.equal(main?.state, "red");
  assert.ok(main?.failingChecks.includes("rule-checks"));
  assert.ok(main?.observedChecks?.includes("rule-checks"));
  assert.deepEqual(main?.ruleChecks, { state: "red", suites: [SUITE] });

  // Main's reading lags its tip (M0 read, M1 probed), so later probes at M1 still run: each records nothing twice.
  const lag = harness([greenMain(M0)]);
  lag.at(M1, allFail);
  await lag.sweep([pr()]);
  await lag.sweep([pr(), pr({ prNumber: 9918, taskId: "W1-T9918", headSha: "9".repeat(40) })]);
  assert.equal(lag.rows.filter((r) => r.step === "sweep.base_reproduction" && r.verdict === "reproduced").length, 3, "three probes ran");
  assert.equal(lag.observed().length, 1, "one row per main sha and suite set");
  // A clear probe of another suite at the same sha records it green; the red suite still reads red.
  lag.at(M1, allPass);
  await lag.sweep([pr({ prNumber: 9919, taskId: "W1-T9919", headSha: "8".repeat(40),
    ciFailures: [{ name: "rule-checks", logTail: ruleTail([OTHER_SUITE]) }] })]);
  assert.deepEqual(lag.observed().at(-1), { run_id: "W1-T7848-test", task_id: "W1-T9919", step: STEP, main_sha: M1, state: "green",
    suites: [OTHER_SUITE], pr_number: 9919, head_sha: "8".repeat(40) });
  assert.deepEqual(mainLatestRunFromLedger([greenMain(M1, M0), ...lag.observed()])?.ruleChecks, { state: "red", suites: [SUITE] },
    "a clear suite never clears another");
  const green = mainLatestRunFromLedger([greenMain(M1), ruleGreen(M1)]);
  assert.equal(green?.state, "green");
  assert.ok(green?.observedChecks?.includes("rule-checks"), "a clear probe is an observation of rule-checks");
  assert.ok(!green?.failingChecks.includes("rule-checks"));
});

test("W1-T7848: an inherited rule red waits while main CI reads green", async () => {
  const h = harness([greenMain(M1, M0)]);
  h.at(M1, allFail);
  await h.sweep([pr()]);
  // Main's own CI then reads green at the same sha: rule-checks is not in its census, so it says nothing about the suite.
  h.rows.push(greenMain(M1));
  await h.sweep([pr()]);
  assert.deepEqual(h.refreshed, [], "no refresh onto a main that still fails the suite");
  assert.deepEqual(h.fixed, [], "and no fix worker");
  assert.match(h.reason(9724), new RegExp(`base red: rule-checks fails at main ${M1}: a probe reproduced ${SUITE}`));
  assert.equal(h.rows.filter((r) => r.step === BASE_RED_REFRESH_STEP && r.pr_number === 9724).length, 0);
  const rows = [reproducedRow(9724, "f".repeat(40), M1), ruleRed(M1), greenMain(M1)];
  const history = baseRedHistoryFromLedger(rows);
  assert.deepEqual(decideBaseRed(pr(), mainLatestRunFromLedger(rows), history), { kind: "wait", check: "rule-checks" });
  assert.deepEqual(decideBaseRed(pr({ ciFailures: [{ name: "rule-checks", logTail: ruleTail() }, { name: "ci-shard (1/8)", logTail: "" }] }),
    mainLatestRunFromLedger(rows), history), { kind: "own" }, "a check main's run passed is still the PR's own red");
  // A red only the rule probe saw names one check: a PR red on another check main's census lacks is not held on it.
  const lint = pr({ prNumber: 9801, headSha: "7".repeat(40), ciFailures: [{ name: "lint-plan", logTail: "lint-plan: 1 violation(s)" }] });
  assert.deepEqual(decideBaseRed(lint, mainLatestRunFromLedger(rows), history), { kind: "own" });
  const ciRed = { step: "main.health.observed", sha: M1, state: "red", failing_checks: ["ci"], observed_checks: MAIN_CHECKS, decided_by_sha: M1 };
  assert.deepEqual(decideBaseRed(lint, mainLatestRunFromLedger([ciRed, ruleRed(M1)]), history), { kind: "wait", check: "lint-plan" },
    "while main's own CI is red, an absent check still waits as before");
});

test("W1-T7848: a rule observation for an older main sha is ignored", () => {
  for (const rows of [[ruleRed(M1), greenMain(M2)], [greenMain(M2), ruleRed(M1)], [greenMain(M2), ruleRed(M1, [SUITE, OTHER_SUITE])]]) {
    const main = mainLatestRunFromLedger(rows);
    assert.equal(main?.sha, M2);
    assert.equal(main?.state, "green", "main has moved: the next probe decides");
    assert.deepEqual(main?.failingChecks, []);
    assert.deepEqual(main?.observedChecks, MAIN_CHECKS);
    assert.equal(main?.ruleChecks, undefined);
  }
  assert.equal(mainLatestRunFromLedger([ruleRed(M1)]), undefined, "an observation alone is not a reading of main");
  assert.equal(mainLatestRunFromLedger([greenMain(M2), ruleRed(M2)])?.state, "red", "the same row at main's head applies");
});
