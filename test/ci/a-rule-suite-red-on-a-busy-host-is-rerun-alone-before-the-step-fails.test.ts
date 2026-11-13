import assert from "node:assert/strict";
import test from "node:test";

import { listRuleSuites } from "#src/lib/ci-parity.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
import { main, ruleSuiteRerunsAlone, runRuleSuitesConcurrently } from "#scripts/list-rule-suites.mjs";

// OBSERVED 2026-11-10 on the Azure host (load 44 to 113): four of five author preflight static failures
// were rule suites that pass alone. A suite red beside others is now run once more alone (W1-T12003).

type Result = { status: number | null; error?: Error; output: string };
type Mock = { mock: { method: (object: object, name: string, impl: (line: string) => void) => unknown } };

function capture(t: Mock) {
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => { printed.push(line); });
  t.mock.method(console, "error", (line: string) => { printed.push(line); });
  const write = (text: string) => { printed.push(...text.replace(/\n$/, "").split("\n")); };
  return { printed, write };
}

/** A fake suite child: `redOnCalls(suite, call)` says whether the call-th start (1-based) of `suite` is red. */
function fakeRun(redOnCalls: (suite: string, call: number) => boolean) {
  const calls = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  const run = async (suite: string): Promise<Result> => {
    const call = (calls.get(suite) ?? 0) + 1;
    calls.set(suite, call);
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    const red = redOnCalls(suite, call);
    return { status: red ? 1 : 0, output: `${red ? "red" : "green"} output ${call} of ${suite}` };
  };
  return { run, calls, peak: () => peak };
}

const idle = () => ({ cores: 8, cpuStallPercent: 0 });
const reruns = (printed: string[]) => printed.filter((line) => line.endsWith(": rerun alone"));

test("W1-T12003 criterion 1: a suite red in the concurrent pass is rerun once alone, and green alone the step passes with one RERUN-GREEN line", async (t) => {
  const { printed, write } = capture(t);
  const suites: string[] = listRuleSuites(REPO_ROOT);
  const flaky = suites[3]!;
  const fake = fakeRun((suite, call) => suite === flaky && call === 1);
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 4, run: fake.run, write, rerunAlone: true }), 0, "green alone passes the step");
  assert.equal(fake.peak(), 4, "positive control: the first pass really ran suites side by side");
  assert.equal(fake.calls.get(flaky), 2, "the red suite ran twice: in the pass and once alone");
  assert.ok(suites.filter((suite) => suite !== flaky).every((suite) => fake.calls.get(suite) === 1), "every green suite ran once");
  const green = printed.filter((line) => line.includes("RERUN-GREEN"));
  assert.equal(green.length, 1);
  assert.match(green[0]!, new RegExp(`^rule-checks: RERUN-GREEN ${flaky}: \\d+ ms in the concurrent pass, \\d+ ms alone$`));
  assert.ok(printed.includes(`green output 2 of ${flaky}`), "the alone run's output is printed");
  assert.equal(printed.at(-1), "rule-checks: reran 1 suites alone: 1 green alone, 0 still red");
  assert.equal(printed.some((line) => line.includes("failed suites")), false, "no failed-suites line");

  // The production entry: main forwards the rerun to the real concurrent runner; only the child spawn is faked.
  printed.length = 0;
  const viaMain = fakeRun((suite, call) => suite === flaky && call === 1);
  const runConcurrently = (root: string, options: object) => runRuleSuitesConcurrently(root, { ...options, run: viaMain.run, write });
  assert.equal(await main(["--run"], undefined, 4, runConcurrently, idle, true), 0);
  assert.equal(viaMain.calls.get(flaky), 2, "main's --run reruns the suite alone");
  assert.equal(printed.filter((line) => line.includes("RERUN-GREEN")).length, 1);
});

test("W1-T12003 criterion 2: a suite still red alone fails the step with both outputs printed, and no suite is rerun more than once", async (t) => {
  const { printed, write } = capture(t);
  const suites: string[] = listRuleSuites(REPO_ROOT);
  const red = new Set([suites[5]!, suites[1]!]);
  const fake = fakeRun((suite) => red.has(suite));
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 4, run: fake.run, write, rerunAlone: true }), 1, "a real red stays red");
  for (const suite of red) {
    assert.equal(fake.calls.get(suite), 2, `${suite} ran in the pass and once alone, never a third time`);
    assert.ok(printed.includes(`red output 1 of ${suite}`), "the concurrent run's output is printed");
    assert.ok(printed.includes(`red output 2 of ${suite}`), "the alone run's output is printed");
    assert.ok(printed.some((line) => line.startsWith(`rule-checks: ${suite}: still red alone (`)), "the run says it was red alone too");
  }
  assert.deepEqual(reruns(printed), [`rule-checks: ${suites[1]}: rerun alone`, `rule-checks: ${suites[5]}: rerun alone`], "population order");
  assert.equal(printed.some((line) => line.includes("RERUN-GREEN")), false);
  assert.equal(printed.at(-2), "rule-checks: reran 2 suites alone: 0 green alone, 2 still red");
  assert.equal(printed.at(-1), `rule-checks: failed suites: ${suites[1]} ${suites[5]}`, "the failed-suites line stays last");

  // Red alone after a green pass cannot happen (a green suite is not rerun), and a red-green-red suite is not run a third time.
  printed.length = 0;
  const once = fakeRun((suite, call) => suite === suites[2] && call !== 2);
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 4, run: once.run, write, rerunAlone: true }), 0);
  assert.equal(once.calls.get(suites[2]!), 2, "a rerun green is final; it is not rerun again");
});

test("W1-T12003 criterion 3: a clean pass reruns nothing, and at concurrency 1 a red suite already ran alone and is not rerun", async (t) => {
  const { printed, write } = capture(t);
  const suites: string[] = listRuleSuites(REPO_ROOT);
  const clean = fakeRun(() => false);
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 4, run: clean.run, write, rerunAlone: true }), 0);
  assert.ok(suites.every((suite) => clean.calls.get(suite) === 1), "every suite ran once");
  assert.equal(reruns(printed).length, 0);
  assert.equal(printed.at(-1), "rule-checks: reran 0 suites alone: 0 green alone, 0 still red");

  printed.length = 0;
  const alone = fakeRun((suite, call) => suite === suites[0] && call === 1);
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 1, run: alone.run, write, rerunAlone: true }), 1,
    "a suite red when it ran alone is a real red");
  assert.equal(alone.peak(), 1, "positive control: nothing ran beside it");
  assert.equal(alone.calls.get(suites[0]!), 1, "not rerun");
  assert.equal(reruns(printed).length, 0);
  assert.equal(printed.at(-1), `rule-checks: failed suites: ${suites[0]}`);

  // A host so busy that the pressure width is one: every suite ran alone, so none is rerun.
  printed.length = 0;
  const narrow = fakeRun((suite, call) => suite === suites[0] && call === 1);
  const saturated = () => ({ cores: 8, cpuStallPercent: 100, load1: 1e6 });
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 4, run: narrow.run, write, pressure: saturated, rerunAlone: true }), 1);
  assert.equal(narrow.calls.get(suites[0]!), 1);
});

test("W1-T12003: hosted CI reruns nothing and stays the gate; every other --run reruns", async (t) => {
  const { printed, write } = capture(t);
  assert.equal(ruleSuiteRerunsAlone({ GITHUB_ACTIONS: "true" }), false);
  assert.equal(ruleSuiteRerunsAlone({}), true);
  assert.equal(ruleSuiteRerunsAlone({ GITHUB_ACTIONS: "false" }), true);

  const suites: string[] = listRuleSuites(REPO_ROOT);
  const fake = fakeRun((suite, call) => suite === suites[0] && call === 1);
  const runConcurrently = (root: string, options: object) => runRuleSuitesConcurrently(root, { ...options, run: fake.run, write });
  assert.equal(await main(["--run"], undefined, 4, runConcurrently, idle, ruleSuiteRerunsAlone({ GITHUB_ACTIONS: "true" })), 1,
    "in hosted CI a suite red beside others fails the step");
  assert.equal(fake.calls.get(suites[0]!), 1);
  assert.equal(printed.some((line) => line.includes("rerun alone") || line.includes("reran")), false);
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 4, run: fakeRun(() => true).run, write }), 1,
    "the runner's own default is no rerun");
});
