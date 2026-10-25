import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGateRepair, gateRepairCandidates, loadGateRepairObservations, renderFalsePositiveShard } from "#src/lib/gate-gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "#src/lib/plan.js";
// @ts-ignore executable census module has no declaration file.
import { PRECHECK_TRIGGERED_SUITES, PRECHECK_PATH_TRIGGERED_SUITES } from "#scripts/census-precheck.mjs";

interface PrecheckEntry { testFile: string; ownFiles?: string[]; recognizer?: string; symbol?: string }

const baseline = "scripts/census-precheck-parity-baseline.json";
const pair = { pr: 10787, gate: "census", redSha: "red", greenSha: "green", state: "repaired" as const,
  repairFiles: ["test/example.test.ts"] };
const rule = { gate: "census", recognizer: "src/lib/ci-parity.ts", symbol: "censusCandidateWalks",
  ownFiles: [baseline, "src/lib/rule-suites.ts"], gateRegex: /tree-walk/ };
const dodge = '-const token = "tree-walk";\n+const token = ["tree", "walk"].join("-");';

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
  assert.equal(classifyGateRepair(pair, '-const token = "tree-walk";\n+const token = "other";', rule.ownFiles, rule.gateRegex), "genuine");
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
  for (const expression of ['"tree" + "-walk"', "['tree', 'walk'].join('-')"]) {
    assert.equal(classifyGateRepair(pair, `-const token = "tree-walk";\n+const token = ${expression};`, [], /tree-walk/g), "token-dodge");
  }
  for (const diff of [
    '-const token = "tree-walk";\n+const token = ["tree", "other"].join("-");',
    '-const token = "tree-walk";\n+const other = ["tree", "walk"].join("-");',
    '--- a/tree-walk\n+++ b/example\n-const x = 1;\n+const x = 2;',
    'diff --git a/one b/one\n-const token = "tree-walk";\ndiff --git a/two b/two\n+const token = ["tree", "walk"].join("-");',
  ]) assert.equal(classifyGateRepair(pair, diff, [], /tree-walk/), "genuine");
});

test("W1-T9049: a false trigger is off subject and incomplete repairs are not classified", () => {
  assert.equal(classifyGateRepair({ ...pair, triggered: false }, "-x\n+y", [], /x/), "off-subject");
  for (const repair of [{ ...pair, state: "open" as const }, { ...pair, greenSha: undefined },
    { ...pair, repairFiles: [] }, { ...pair, repairFiles: undefined }]) {
    assert.equal(classifyGateRepair(repair, dodge, [baseline], /tree-walk/), "genuine");
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
  for (const entry of PRECHECK_TRIGGERED_SUITES as PrecheckEntry[]) {
    assert.ok(Array.isArray(entry.ownFiles), entry.testFile);
    assert.ok(entry.ownFiles.length > 0, entry.testFile);
    assert.ok(entry.recognizer, entry.testFile);
  }
  const census = (PRECHECK_PATH_TRIGGERED_SUITES as PrecheckEntry[]).find((entry) => entry.testFile === "test/every-ci-census-is-asked-before-the-push.test.ts")!;
  assert.ok(census.ownFiles!.includes(baseline));
  assert.equal(census.recognizer, "src/lib/ci-parity.ts");
  assert.equal(census.symbol, "censusCandidateWalks");
});

test("W1-T9049: repair evidence is read through awaited gh calls, with the trigger's files fetched on demand", async () => {
  const calls: string[] = [];
  const content = (text: string) => ({ encoding: "base64", content: Buffer.from(text).toString("base64") });
  const ghJson = async (args: string[]): Promise<unknown> => {
    const path = args[1] ?? "";
    calls.push(path);
    if (args[0] === "repo") return { nameWithOwner: "o/r" };
    if (path.includes("/pulls?")) return [{ number: 5, base: { sha: "base" } }];
    if (path.endsWith("/pulls/5/commits?per_page=100")) return [{ sha: "red" }, { sha: "green" }];
    if (path.includes("/commits/red/check-runs")) return { check_runs: [{ id: 7, name: "census", status: "completed", conclusion: "failure" }] };
    if (path.includes("/commits/green/check-runs")) return { check_runs: [{ id: 8, name: "census", status: "completed", conclusion: "success" }] };
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.includes("/compare/red...green")) return { files: [{ filename: baseline, patch: "@@\n-1\n+2" }] };
    if (path.includes("/compare/base...red")) return { merge_base_commit: { sha: "mb" }, files: [{ filename: "a.ts" }] };
    if (path.includes("/contents/a.ts?ref=red")) return content("walks the tree");
    if (path.includes("/contents/gone.ts?ref=mb")) throw new Error("gh: Not Found (HTTP 404)");
    throw new Error(`unexpected read: ${path}`);
  };
  const triggered = { ...rule, trigger: ({ readHead, readBase }: { readHead: (p: string) => string | null; readBase: (p: string) => string | null }) =>
    readHead("a.ts") === "walks the tree" && readBase("gone.ts") === null };
  const observations = await loadGateRepairObservations([triggered], { ghJson, ghText: async () => "" });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].pair.triggered, true);
  assert.deepEqual(observations[0].pair.repairFiles, [baseline]);
  assert.equal(classifyGateRepair(observations[0].pair, observations[0].repairDiff, rule.ownFiles, rule.gateRegex), "baseline-only");
  assert.ok(calls.some((path) => path.includes("/contents/a.ts?ref=red")));
  // An unreadable repair diff is refused, never read as an empty repair.
  const unreadable = async (args: string[]) => (args[1] ?? "").includes("/compare/red...green") ? { files: [] } : ghJson(args);
  await assert.rejects(loadGateRepairObservations([rule], { ghJson: unreadable, ghText: async () => "" }), /repair diff unreadable/);
  for (const failure of [new Error("trigger unreadable"), undefined]) {
    const failing = { ...rule, trigger: () => { throw failure; } };
    await assert.rejects(loadGateRepairObservations([failing], { ghJson, ghText: async () => "" }),
      (error: unknown) => error === failure);
  }
});
