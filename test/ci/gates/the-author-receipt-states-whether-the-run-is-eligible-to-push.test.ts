import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as authorModule from "#scripts/preflight-author.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT as ROOT } from "#test/helpers/repo-root.js";

type Step = { name: string; ok: boolean; notMeasured?: string; testSummary?: Record<string, number> | null };
type Receipt = { verdict?: string | undefined; steps: Step[]; suites?: string[]; tiered?: { ran: string[] }; error?: string;
  affectedTestsNotRunReason?: string; pushEligible?: boolean; pushEligibleReason?: string };
type Eligibility = { pushEligible: boolean; pushEligibleReason: string };
const author = authorModule as unknown as {
  main: (argv: string[], deps: { root: string; select?: () => unknown; host?: () => unknown }) => number;
  authorPushEligibility: (receipt: Receipt) => Eligibility;
  OVER_CAPACITY_EXIT: number;
};


// The fixtures' suite slot lives in owned scratch, so a busy host's real queue never decides these outcomes.
const slotDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}push-eligible-slots-`));
const originalSlotDir = process.env.RMD_TEST_SLOT_DIR;
process.env.RMD_TEST_SLOT_DIR = slotDir;
const cleanups: (() => void)[] = [];
after(() => {
  if (originalSlotDir === undefined) delete process.env.RMD_TEST_SLOT_DIR;
  else process.env.RMD_TEST_SLOT_DIR = originalSlotDir;
  rmSync(slotDir, { recursive: true, force: true });
  for (const cleanup of cleanups) cleanup();
});

const summary = (pass: number, fail = 0) => ({ tests: pass + fail, suites: 0, pass, fail, cancelled: 0, skipped: 0, todo: 0 });
const census: Step = { name: "census-precheck", ok: true };
const staticGate: Step = { name: "static-preflight", ok: true };
const subset = (pass: number, fail = 0): Step => ({ name: "affected-tests-subset", ok: fail === 0, testSummary: summary(pass, fail) });
const suiteNames = (count: number) => Array.from({ length: count }, (_, index) => `test/s${index}.test.ts`);
/** The run this task observed: 489 of 804 suites, 4,379 tests passing, none failing, census and static green. */
const observed = (): Receipt => ({ verdict: "over-capacity", steps: [census, staticGate, subset(4379)],
  suites: suiteNames(804), tiered: { ran: suiteNames(489) } });

function assertOneLine(answer: Eligibility) {
  assert.equal(typeof answer.pushEligibleReason, "string");
  assert.ok(answer.pushEligibleReason.length > 0, "the reason is never empty");
  assert.doesNotMatch(answer.pushEligibleReason, /[\r\n]/, "the reason is one line");
}

/** A committed author tree: a cheap changed suite, an unchanged one, a census and a static gate that pass unless told otherwise. */
function fixture(opts: { otherCostMs?: number; leafCostMs?: number; leafFails?: boolean; staticFails?: boolean } = {}) {
  const repo = gitRepo({ kind: "push-eligible", seedCommit: false });
  cleanups.push(() => repo.cleanup());
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), opts.staticFails ? "process.exitCode = 1;\n" : "console.log('fixture static preflight passed');\n");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 1;\n");
  const suite = "import { test } from 'node:test'; test('fixture', () => {});\n";
  writeFileSync(join(root, "test/leaf.test.ts"), suite);
  writeFileSync(join(root, "test/other.test.ts"), suite);
  writeFileSync(join(root, "scripts/test-tier-manifest.json"), JSON.stringify({ thresholdMs: 5000,
    files: { "test/leaf.test.ts": opts.leafCostMs ?? 1_000, "test/other.test.ts": opts.otherCostMs ?? 1_000 } }));
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-push-eligible");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 2;\n");
  writeFileSync(join(root, "test/leaf.test.ts"), opts.leafFails
    ? "import { test } from 'node:test'; test('fixture changed', () => { throw new Error('fixture red'); });\n"
    : "import { test } from 'node:test'; test('fixture changed', () => {});\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: change");
  return root;
}

const HUGE = 10 * 60 * 60 * 1000;
const select = () => ({ fullRun: false, suites: ["test/leaf.test.ts", "test/other.test.ts"], reasons: ["fixture"], recentOnly: { floor: [] } });
const host = () => ({ cores: 8, load1: 0, headroomBytes: 8 * 1024 ** 3 });

/** One real author run per outcome, made once and read by every criterion: what `main` returned and the receipt it wrote. */
const SCENARIOS = {
  passed: () => ({ root: fixture(), argv: [] as string[] }),
  overCapacityGreen: () => ({ root: fixture({ otherCostMs: HUGE }), argv: [] }),
  overCapacityNothingFits: () => ({ root: fixture({ leafCostMs: HUGE, otherCostMs: HUGE }), argv: [] }),
  overCapacityRedSubset: () => ({ root: fixture({ otherCostMs: HUGE, leafFails: true }), argv: [] }),
  staticFailed: () => ({ root: fixture({ staticFails: true }), argv: [] }),
  refusedDirtyTree: () => {
    const root = fixture();
    writeFileSync(join(root, "untracked.ts"), "export {};\n");
    return { root, argv: [] };
  },
  dryRun: () => ({ root: fixture(), argv: ["--dry-run"] }),
} as const;
type Scenario = keyof typeof SCENARIOS;
const ran = new Map<Scenario, { status: number; receipt: Receipt }>();
function scenario(name: Scenario) {
  const known = ran.get(name);
  if (known) return known;
  const { root, argv } = SCENARIOS[name]();
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  let status: number;
  try { status = author.main([...argv], { root, select, host }); }
  finally { console.log = log; console.error = error; }
  const outcome = { status, receipt: JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")) as Receipt };
  ran.set(name, outcome);
  return outcome;
}

test("W1-T11914 criterion 1: a passed receipt and an over-capacity receipt with every stage green carry pushEligible true and a one-line reason", () => {
  const passed = author.authorPushEligibility({ verdict: "passed", suites: suiteNames(2),
    steps: [census, staticGate, { name: "affected-tests", ok: true, testSummary: summary(12) }] });
  assert.equal(passed.pushEligible, true);
  assertOneLine(passed);
  assert.match(passed.pushEligibleReason, /^passed: /);
  // A plan-only pass ran plan lint instead of a suite: the verdict is passed, so it is as pushable as any pass.
  assert.equal(author.authorPushEligibility({ verdict: "passed", steps: [census, staticGate, { name: "lint-plan-fast", ok: true }],
    affectedTestsNotRunReason: "the plan-only selection named no suite; plan lint is its check" }).pushEligible, true);

  const overCapacity = author.authorPushEligibility(observed());
  assert.equal(overCapacity.pushEligible, true);
  assertOneLine(overCapacity);
  assert.match(overCapacity.pushEligibleReason, /^over-capacity with nothing red: /);
  assert.match(overCapacity.pushEligibleReason, /4379 test\(s\) passed, 0 failed, 489 of 804 suite\(s\)/);
  assert.match(overCapacity.pushEligibleReason, /315 suite\(s\) are left to the hosted checks/);

  // The receipt a real run writes carries both fields, and they are the derivation of that same receipt.
  for (const name of ["passed", "overCapacityGreen"] as const) {
    const { receipt } = scenario(name);
    assert.equal(receipt.pushEligible, true, `${name}: ${receipt.pushEligibleReason}`);
    assertOneLine(receipt as Eligibility);
    assert.deepEqual({ pushEligible: receipt.pushEligible, pushEligibleReason: receipt.pushEligibleReason },
      author.authorPushEligibility(receipt));
  }
  const green = scenario("overCapacityGreen").receipt;
  assert.equal(green.verdict, "over-capacity");
  assert.deepEqual(green.steps.map((step) => [step.name, step.ok]),
    [["census-precheck", true], ["static-preflight", true], ["affected-tests-subset", true]]);
  assert.match(green.pushEligibleReason ?? "", /1 test\(s\) passed, 0 failed, 1 of 2 suite\(s\)/);
});

test("W1-T11914 criterion 2: a failing test, a failed or refused stage, a not-run stage and a refused verdict carry pushEligible false and name the stage", () => {
  const refuses = (receipt: Receipt, stage: RegExp, why: string) => {
    const answer = author.authorPushEligibility(receipt);
    assert.equal(answer.pushEligible, false, `${why}: ${answer.pushEligibleReason}`);
    assertOneLine(answer);
    assert.match(answer.pushEligibleReason, stage, why);
  };
  // A failing test: the verdict main sets is failed, and an over-capacity verdict would not rescue it either.
  refuses({ ...observed(), verdict: "failed", steps: [census, staticGate, subset(4378, 1)] },
    /^affected-tests-subset failed: 1 failing test\(s\)/, "one failing test under the failed verdict");
  refuses({ ...observed(), steps: [census, staticGate, subset(4378, 1)] },
    /^affected-tests-subset failed: 1 failing test\(s\)/, "one failing test under an over-capacity verdict");
  refuses({ ...observed(), steps: [census, staticGate, { ...subset(4378, 1), ok: true }] },
    /^affected-tests-subset: 1 failing/, "a failing count beside a step recorded ok");
  refuses({ ...observed(), steps: [census, staticGate, { name: "affected-tests-subset", ok: true, testSummary: null }] },
    /^affected-tests-subset recorded no passing test summary/, "a subset with no summary");
  // A failed stage.
  refuses({ ...observed(), verdict: "failed", steps: [census, { ...staticGate, ok: false }],
    affectedTestsNotRunReason: "static-preflight did not succeed; see its native outcome" }, /^static-preflight failed/, "a failed static gate");
  refuses({ ...observed(), verdict: "failed", steps: [{ ...census, ok: false }] }, /^census-precheck failed/, "a failed census");
  refuses({ ...observed(), steps: [census, { ...staticGate, ok: false }, subset(4379)] }, /^static-preflight failed/,
    "a failed static gate under an over-capacity verdict");
  // A refused stage: the step that failed is named beside the refusal it caused.
  refuses({ verdict: "refused", error: "changed workflow inputs failed the cache/timeout contracts",
    steps: [census, { name: "workflow-contract-precheck", ok: false, testSummary: summary(3, 2) }] },
  /^workflow-contract-precheck failed: 2 failing test\(s\); refused: changed workflow inputs/, "a refused precheck");
  // A stage that did not run, or ran without measuring.
  refuses({ verdict: "over-capacity", suites: suiteNames(804), steps: [census, staticGate],
    affectedTestsNotRunReason: "over capacity: priced 72000000ms of suite work exceeds the host budget 900000ms" },
  /^affected-tests was not run: over capacity: priced 72000000ms/, "an over-capacity run whose suites were all skipped");
  refuses({ ...observed(), steps: [census, subset(4379)] }, /^static-preflight was not run/, "no static stage");
  refuses({ verdict: "over-capacity", steps: [], error: "host refused the author run\nat static-preflight" },
    /^census-precheck was not run: host refused the author run at static-preflight$/, "a capacity refusal before any stage");
  refuses({ ...observed(), steps: [{ ...census, notMeasured: "time-bound" }, staticGate, subset(4379)] },
    /^census-precheck was not measured \(time-bound\)/, "a census the time bound left unmeasured");
  // A refused verdict names the stage it stopped before; a dry run and an unfinished run are not pushable.
  refuses({ verdict: "refused", steps: [], error: "commit the author tree first" }, /^refused before census-precheck ran: commit/, "refused before any stage");
  refuses({ verdict: "refused", steps: [census], error: "runtime deadline does not fit" }, /^refused before static-preflight ran: /, "refused after the census");
  refuses({ verdict: "refused", steps: [census, staticGate], error: "author context NOT_RUN (start): source" },
    /^refused before affected-tests ran: /, "refused after the static gate");
  refuses({ verdict: "refused", steps: [census, staticGate, subset(4379)], error: "author receipt could not be written: EISDIR" },
    /^refused at the receipt, after its stages ran: author receipt could not be written/, "a receipt that could not be written");
  refuses({ verdict: "not-run", steps: [] }, /^census-precheck was not run \(verdict not-run\)/, "a dry run");
  refuses({ steps: [census] }, /^static-preflight was not run \(verdict running\)/, "a run with no verdict yet");

  // The same answers on the receipts real runs write.
  const expected: [Scenario, RegExp][] = [
    ["overCapacityRedSubset", /^affected-tests-subset failed: 1 failing test\(s\)/],
    ["overCapacityNothingFits", /^affected-tests was not run: over capacity: priced/],
    ["staticFailed", /^static-preflight failed/],
    ["refusedDirtyTree", /^refused before census-precheck ran: commit the author tree first/],
    ["dryRun", /^census-precheck was not run \(verdict not-run\)/],
  ];
  for (const [name, stage] of expected) {
    const { receipt } = scenario(name);
    assert.equal(receipt.pushEligible, false, `${name}: ${receipt.pushEligibleReason}`);
    assertOneLine(receipt as Eligibility);
    assert.match(receipt.pushEligibleReason ?? "", stage, name);
  }
  assert.equal(scenario("overCapacityRedSubset").receipt.steps.at(-1)?.testSummary?.fail, 1, "the red subset really ran and failed");
});

test("W1-T11914 criterion 3: the verdict string and the exit code of every receipt are what they were before the field existed", () => {
  // The verdicts and exits the gate gave each of these runs before this change, pinned as literals.
  const before: Record<Scenario, { verdict: string; exit: number }> = {
    passed: { verdict: "passed", exit: 0 },
    overCapacityGreen: { verdict: "over-capacity", exit: 3 },
    overCapacityNothingFits: { verdict: "over-capacity", exit: 3 },
    overCapacityRedSubset: { verdict: "failed", exit: 1 },
    staticFailed: { verdict: "failed", exit: 1 },
    refusedDirtyTree: { verdict: "refused", exit: 1 },
    dryRun: { verdict: "not-run", exit: 0 },
  };
  assert.equal(author.OVER_CAPACITY_EXIT, 3);
  for (const name of Object.keys(before) as Scenario[]) {
    const { status, receipt } = scenario(name);
    assert.equal(receipt.verdict, before[name].verdict, `${name}: verdict`);
    assert.equal(status, before[name].exit, `${name}: exit code`);
    assert.equal(typeof receipt.pushEligible, "boolean", `${name}: the field is present on every receipt`);
    // Eligibility is not the exit code: an eligible over-capacity run still exits 3 under its own verdict.
    if (receipt.pushEligible) assert.ok(["passed", "over-capacity"].includes(receipt.verdict ?? ""), name);
  }
  assert.equal(scenario("overCapacityGreen").receipt.pushEligible, true);
  assert.equal(scenario("overCapacityGreen").status, 3);

  // The derivation reads a receipt and returns two fields: it never writes the verdict or anything else.
  for (const verdict of ["passed", "over-capacity", "failed", "refused", "not-run", undefined]) {
    const receipt = { ...observed(), verdict };
    const snapshot = structuredClone(receipt);
    const answer = author.authorPushEligibility(receipt);
    assert.deepEqual(receipt, snapshot, `${verdict}: the receipt is unchanged`);
    assert.deepEqual(Object.keys(answer).sort(), ["pushEligible", "pushEligibleReason"]);
  }
});
