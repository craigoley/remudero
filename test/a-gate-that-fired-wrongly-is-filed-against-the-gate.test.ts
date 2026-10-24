import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGateRepair, gateRepairCandidates, renderFalsePositiveShard } from "#src/lib/gate-gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "#src/lib/plan.js";
import { PRECHECK_TRIGGERED_SUITES, PRECHECK_PATH_TRIGGERED_SUITES } from "#scripts/census-precheck.mjs";

const baseline = "scripts/census-precheck-parity-baseline.json";
const pair = { pr: 10787, gate: "census", redSha: "red", greenSha: "green", state: "repaired" as const,
  repairFiles: ["test/example.test.ts"] };
const rule = { gate: "census", recognizer: "src/lib/ci-parity.ts", symbol: "censusCandidateWalks",
  ownFiles: [baseline, "src/lib/rule-suites.ts"], gateRegex: /ls-files/ };
const dodge = '-const token = "ls-files";\n+const token = ["ls", "files"].join("-");';

function candidates(diff: string, repair = pair, open: string[] = []) {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const result = gateRepairCandidates([{ pair: repair, repairDiff: diff }], [rule], open,
    (step, extra) => rows.push({ step, extra }));
  return { result, rows };
}

test("W1-T9049: a repair that only edits the gate's own baseline is a suspected false positive", () => {
  const repair = { ...pair, repairFiles: [baseline] };
  assert.equal(classifyGateRepair(repair, "-1\n+2", rule.ownFiles, rule.gateRegex), "baseline-only");
  const { result, rows } = candidates("-1\n+2", repair);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, rule.recognizer);
  assert.equal(rows[0].step, "gate.false_positive_suspected");
  assert.equal(rows[0].extra?.classification, "baseline-only");
});

test("W1-T9049: a token rebuilt at runtime to dodge a gate's regex is a suspected false positive", () => {
  assert.equal(classifyGateRepair(pair, dodge, rule.ownFiles, rule.gateRegex), "token-dodge");
  const { result, rows } = candidates(dodge);
  assert.equal(rows[0].extra?.classification, "token-dodge");
  assert.equal(rows[0].extra?.redSha, "red");
  const shard = renderFalsePositiveShard(result[0], "NEW-1");
  assert.equal(shard.refused, undefined);
  const plan = loadPlanFromYaml(shard.text, "false-positive");
  const task = plan.tasks[0];
  assert.equal(task.origin, "gate-false-positive:census");
  assert.deepEqual(task.files, [rule.recognizer]);
  assert.match(task.rationale!, /censusCandidateWalks/);
  assert.match(task.rationale!, /10787/);
  assert.equal(task.author_class, "machine");
  // The new origin needs admission outside this task's declared files; do not bypass it.
  assert.match(machineFilingAdmissionViolations(task, { plan, releasedIds: new Set(), pathExists: () => true }).join(";"), /verify:human/);
});

test("W1-T9049: a repair that changes the gated code is genuine", () => {
  assert.equal(classifyGateRepair(pair, '-const token = "ls-files";\n+const token = "other";', rule.ownFiles, rule.gateRegex), "genuine");
  const { result, rows } = candidates('-const count = 0;\n+const count = 1;');
  assert.deepEqual(result, []);
  assert.deepEqual(rows, []);
});

test("W1-T9049: only a pure identifier rename is a rename dodge", () => {
  assert.equal(classifyGateRepair(pair, "-const BadDeps = read();\n+const Options = read();", [], /BadDeps/), "rename-dodge");
  assert.equal(classifyGateRepair(pair, "-const BadDeps = read();\n+const Options = write();", [], /BadDeps/), "genuine");
  assert.equal(classifyGateRepair(pair, '-const name = "BadDeps";\n+const name = "Options";', [], /BadDeps/), "genuine");
});

test("W1-T9049: token reconstruction must preserve the removed token and its context", () => {
  for (const expression of ['"ls" + "-files"', "['ls', 'files'].join('-')"]) {
    assert.equal(classifyGateRepair(pair, `-const token = "ls-files";\n+const token = ${expression};`, [], /ls-files/g), "token-dodge");
  }
  for (const diff of [
    '-const token = "ls-files";\n+const token = ["ls", "other"].join("-");',
    '-const token = "ls-files";\n+const other = ["ls", "files"].join("-");',
    '--- a/ls-files\n+++ b/example\n-const x = 1;\n+const x = 2;',
    'diff --git a/one b/one\n-const token = "ls-files";\ndiff --git a/two b/two\n+const token = ["ls", "files"].join("-");',
  ]) assert.equal(classifyGateRepair(pair, diff, [], /ls-files/), "genuine");
});

test("W1-T9049: a false trigger is off subject and incomplete repairs are not classified", () => {
  assert.equal(classifyGateRepair({ ...pair, triggered: false }, "-x\n+y", [], /x/), "off-subject");
  for (const repair of [{ ...pair, state: "open" as const }, { ...pair, greenSha: undefined },
    { ...pair, repairFiles: [] }, { ...pair, repairFiles: undefined }]) {
    assert.equal(classifyGateRepair(repair, dodge, [baseline], /ls-files/), "genuine");
  }
});

test("W1-T9049: each gate has one proposal while every suspect repair is ledgered", () => {
  const observations = [{ pair, repairDiff: dodge }, { pair: { ...pair, pr: 10788 }, repairDiff: dodge }];
  const rows: string[] = [];
  assert.equal(gateRepairCandidates(observations, [rule], [], (step) => rows.push(step)).length, 1);
  assert.equal(rows.length, 2);
  const covered = candidates(dodge, pair, ["gate-false-positive:census"]);
  assert.deepEqual(covered.result, []);
  assert.equal(covered.rows.length, 1);
});

test("W1-T9049: precheck gate ownership is explicit and names the census recognizer", () => {
  for (const entry of PRECHECK_TRIGGERED_SUITES) {
    assert.ok(Array.isArray(entry.ownFiles), entry.testFile);
    assert.ok(entry.ownFiles.length > 0, entry.testFile);
    assert.ok(entry.recognizer, entry.testFile);
  }
  const census = PRECHECK_PATH_TRIGGERED_SUITES.find((entry) => entry.testFile === "test/every-ci-census-is-asked-before-the-push.test.ts")!;
  assert.ok(census.ownFiles.includes(baseline));
  assert.equal(census.recognizer, "src/lib/ci-parity.ts");
  assert.equal(census.symbol, "censusCandidateWalks");
});
