import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { classifyGateRepair, gateGardenSpec, gateRepairCandidates, loadGateProbes, loadGateRepairObservations, renderFalsePositiveShard, type GateRepairRule } from "#src/lib/gate-gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "#src/lib/plan.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore executable census module has no declaration file.
import { GATE_REPAIR_RULES, PRECHECK_TRIGGERED_SUITES, PRECHECK_PATH_TRIGGERED_SUITES } from "#scripts/census-precheck.mjs";

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

function productionRule(testFile: string): GateRepairRule {
  const found = (GATE_REPAIR_RULES as GateRepairRule[]).find(entry => entry.gate === testFile);
  assert.ok(found, `production rule missing: ${testFile}`);
  return found;
}

async function productionRepair(gate: string, repairFile: string, patch: string, redSource: string, failedLog?: string) {
  const source = "src/lib/example.ts";
  const ghJson = async (args: string[]): Promise<unknown> => {
    const path = args[1] ?? "";
    if (args[0] === "repo") return { nameWithOwner: "o/r" };
    if (path.includes("/pulls?")) return [{ number: pair.pr, base: { sha: "base" } }];
    if (path.endsWith(`/pulls/${pair.pr}/commits?per_page=100`)) return [{ sha: "red" }, { sha: "green" }];
    if (path.includes("/check-runs")) return { check_runs: [{ id: 7, name: gate, status: "completed",
      conclusion: path.includes("/commits/red/") ? "failure" : "success" }] };
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.includes("/compare/red...green")) return { files: [{ filename: repairFile, patch }] };
    if (path.includes("/compare/base...red")) return { merge_base_commit: { sha: "base" }, files: [{ filename: source }] };
    if (path.includes(`/contents/${source}?ref=`)) return { encoding: "base64",
      content: Buffer.from(path.endsWith("ref=red") ? redSource : "").toString("base64") };
    throw new Error(`unexpected production evidence read: ${args.join(" ")}`);
  };
  const observations = await loadGateRepairObservations(GATE_REPAIR_RULES, { ghJson, ghText: async args => {
    if (failedLog === undefined || args.join(" ") !== "run view --job 7 --log-failed") throw new Error(`unexpected production log read: ${args.join(" ")}`);
    return failedLog;
  } });
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.pair.triggered, true, `${gate}: the original PR must trigger the production rule`);
  return observations[0]!;
}

test("W1-T9049: a repair that only edits the gate's own baseline is a suspected false positive", async () => {
  const repair = { ...pair, repairFiles: [baseline] };
  assert.equal(classifyGateRepair(repair, "-1\n+2", rule.ownFiles, rule.gateRegex), "baseline-only");
  const { result, rows } = candidates("-1\n+2", repair);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, rule.recognizer);
  assert.equal(rows[0].step, "gate.false_positive_suspected");
  assert.equal(rows[0].extra?.classification, "baseline-only");
  for (const [gate, owned, recognizer, symbol] of [
    ["test/env-var-registry.test.ts", "src/lib/config-schema.ts", "test/env-var-registry.test.ts", "harnessEnvNamesInSource"],
    ["test/error-subclass-census.test.ts", "scripts/error-subclass-baseline.json", "test/error-subclass-census.test.ts", "census:error-subclass"],
    // The priced-ledger gate's reasoned EXEMPT allowlist lives in its own suite, not in the registry.
    ["test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts", "test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts",
      "src/lib/config-gardener.ts", "census:every-priced-ledger-step"],
  ]) {
    const production = productionRule(gate!);
    const evidence = await productionRepair(production.gate, owned!, "@@\n-1\n+2",
      'const token = "RMD_EXAMPLE"; class ExampleError extends Error {}\nlog("example.step", { cost_usd: 1 });');
    assert.deepEqual(evidence.pair.repairFiles, [owned]);
    const events: Array<Record<string, unknown> | undefined> = [];
    const actions = gateRepairCandidates([evidence], GATE_REPAIR_RULES, [], (step, extra) => {
      assert.equal(step, "gate.false_positive_suspected");
      events.push(extra);
    });
    assert.equal(actions.length, 1);
    assert.equal(events[0]?.classification, "baseline-only");
    assert.equal(events[0]?.recognizer, recognizer);
    assert.equal(events[0]?.symbol, symbol);
    const rendered = renderFalsePositiveShard(actions[0]!, "NEW-1");
    assert.equal(rendered.refused, undefined);
    const task = loadPlanFromYaml(rendered.text, "production-baseline").tasks[0]!;
    assert.deepEqual(task.files, [recognizer]);
    assert.equal(task.origin, `gate-false-positive:${production.gate}`);
  }
});

test("W1-T9049: a token rebuilt at runtime to dodge a gate's regex is a suspected false positive", async () => {
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
  const production = productionRule("test/env-var-registry.test.ts");
  const before = 'const token = "RMD_EXAMPLE";';
  for (const after of ['const token = "RMD_" + "EXAMPLE";', 'const token = ["RMD", "EXAMPLE"].join("_");']) {
    const triggered = (head: string, base: string) => production.trigger!({ changed: ["src/lib/example.ts"],
      readHead: () => head, readBase: () => base });
    assert.equal(triggered(before, ""), true);
    assert.equal(triggered(after, before), false);
    const evidence = await productionRepair(production.gate, "src/lib/example.ts", `@@\n-${before}\n+${after}`, before);
    assert.equal(classifyGateRepair(evidence.pair, evidence.repairDiff, production.ownFiles, production.gateRegex), "token-dodge");
    const events: string[] = [];
    const actions = gateRepairCandidates([evidence], GATE_REPAIR_RULES, [], (step, extra) => {
      events.push(step);
      assert.equal(extra?.classification, "token-dodge");
    });
    assert.deepEqual(events, ["gate.false_positive_suspected"]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.file, "test/env-var-registry.test.ts");
    const rendered = renderFalsePositiveShard(actions[0]!, "NEW-1");
    assert.equal(rendered.refused, undefined);
    const task = loadPlanFromYaml(rendered.text, "production-token").tasks[0]!;
    assert.deepEqual(task.files, [production.recognizer]);
    assert.equal(task.origin, `gate-false-positive:${production.gate}`);
    // A comment, an unrelated line or a gated line moved unchanged beside the reconstruction does not make the
    // dodge a repair.
    for (const patch of [`@@\n-${before}\n+// rebuilt so the registry census no longer sees it\n+${after}`,
      `@@\n-${before}\n-const unrelated = 1;\n+${after}`, `@@\n-${before} // old note\n+${after} // new note`,
      `@@\n-const moved = "RMD_MOVED";\n-${before}\n+${after}\n+const moved = "RMD_MOVED";`]) {
      const beside = await productionRepair(production.gate, "src/lib/example.ts", patch, before);
      assert.equal(classifyGateRepair(beside.pair, beside.repairDiff, production.ownFiles, production.gateRegex), "token-dodge", patch);
    }
  }
});

test("W1-T9049: a repair that changes the gated code is genuine", async () => {
  assert.equal(classifyGateRepair(pair, '-const token = "tree-walk";\n+const token = "other";', rule.ownFiles, rule.gateRegex), "genuine");
  const { result, rows } = candidates('-const count = 0;\n+const count = 1;');
  assert.deepEqual(result, []);
  assert.deepEqual(rows, []);
  const production = productionRule("test/env-var-registry.test.ts");
  const events: string[] = [];
  assert.deepEqual(gateRepairCandidates([{ pair: { ...pair, gate: production.gate },
    repairDiff: '-const token = "RMD_EXAMPLE";\n+const token = "RMD_OTHER";' }], GATE_REPAIR_RULES, [],
  step => events.push(step)), []);
  assert.deepEqual(events, []);
  // A dodge in one hunk does not hide a gated line another hunk really changed, nor does a comment beside it.
  const dodged = '@@\n-const token = "RMD_EXAMPLE";\n+const token = "RMD_" + "EXAMPLE";';
  const renamed = "@@\n-const RMD_EXAMPLE_FLAG = read();\n+const exampleFlag = read();";
  const repaired = '@@\n-const other = process.env.RMD_UNREGISTERED;\n+// registered below\n+const other = registered("example");';
  for (const diff of [`${dodged}\n${repaired}`, `${renamed}\n${repaired}`, `${repaired}\n${renamed}`,
    `diff --git a/src/lib/one.ts b/src/lib/one.ts\n${renamed}\ndiff --git a/src/lib/two.ts b/src/lib/two.ts\n${repaired}`]) {
    assert.equal(classifyGateRepair({ ...pair, gate: production.gate }, diff, production.ownFiles, production.gateRegex), "genuine", diff);
  }
  assert.equal(classifyGateRepair({ ...pair, gate: production.gate }, renamed, production.ownFiles, production.gateRegex), "rename-dodge");
  // An aggregate rule-checks log names every suite it ran; only the suite it names as failed owns the repair.
  const ran = (suite: string) => `rule-checks: ${suite}\nok 1 - ${suite.replace("test/", "")} holds`;
  const subclass = "test/error-subclass-census.test.ts";
  for (const failedLine of [`rule-checks: ${subclass}: failed (1)\nrule-checks: failed suites: ${subclass}`,
    `not ok 4 - /home/runner/work/remudero/remudero/${subclass}`]) {
    const log = [ran("test/env-var-registry.test.ts"), `rule-checks: ${subclass}`, "not ok 1 - census", failedLine].join("\n");
    const evidence = await productionRepair("rule-checks", "src/lib/example.ts",
      "@@\n-class ExampleError extends Error {}\n+class ExampleError extends RmdError {}",
      'const token = "RMD_EXAMPLE"; class ExampleError extends Error {}', log);
    assert.equal(evidence.pair.gate, subclass, failedLine);
    const filed: string[] = [];
    assert.deepEqual(gateRepairCandidates([evidence], GATE_REPAIR_RULES, [], step => filed.push(step)), []);
    assert.deepEqual(filed, []);
  }
});

test("W1-T9049: production regexes recognize token reconstruction in its source context", () => {
  for (const [gate, before, after] of [
    ["test/ledger-rotation.test.ts", 'if (step === "example.step") {}', 'if (step === ["example", "step"].join(".")) {}'],
    ["test/a-union-read-of-an-unretained-step-is-refused.test.ts", 'if (step === "example.step") {}', 'if (step === ["example", "step"].join(".")) {}'],
    ["test/spend-is-counted-once-at-its-producer.test.ts", 'log("example.step", {});', 'log(["example", "step"].join("."), {});'],
    ["test/cycle-ratchet.test.ts", 'require("./example");', 'require([".", "example"].join("/"));'],
    ["test/source-size-baseline-is-enforced.test.ts", 'require("../run-task.js");', 'require(["..", "run-task.js"].join("/"));'],
    ["test/the-affected-suite-reach-ratchet.test.ts", 'require("../src/run-task.js");', 'require(["../src", "run-task.js"].join("/"));'],
    ["test/node-24-runtime-compatibility.test.ts", 'run(["--test"]);', 'run(["--" + "test"]);'],
    ["test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts", 'log("example.step", { cost_usd: 1 });', 'log(["example", "step"].join("."), { cost_usd: 1 });'],
    ["test/host-capability-fixtures.test.ts", 'const command = "hostname";', 'const command = "host" + "name";'],
    ["test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts", 'main(["preflight"]);', 'main(["pre" + "flight"]);'],
    ["test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts", 'execFile("git", []);', 'execFile("g" + "it", []);'],
    ["test/worktree-creation-census.test.ts", 'run(["worktree", "add"]);', 'run(["work" + "tree", "add"]);'],
    ["test/every-ci-census-is-asked-before-the-push.test.ts", 'const token = "ls-files";', 'const token = ["ls", "files"].join("-");'],
  ]) {
    const production = productionRule(gate!);
    const diff = `-${before}\n+${after}`;
    assert.equal(classifyGateRepair({ ...pair, gate: production.gate }, diff,
      production.ownFiles, production.gateRegex), "token-dodge", gate);
    assert.equal(classifyGateRepair({ ...pair, gate: production.gate }, diff.replace(after!, 'const changed = "other";'),
      production.ownFiles, production.gateRegex), "genuine", `${gate}: unrelated edit`);
  }
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

test("W1-T9049: the join recognizer is linear on comma-less literal runs", { timeout: 5000 }, () => {
  assert.equal(classifyGateRepair(pair, '-const token = "tree-walk";\n+const token = [ "tree", "walk", ].join("-");', [], /tree-walk/), "token-dodge");
  const run = `[${'"a" '.repeat(40)};`;
  assert.equal(classifyGateRepair(pair, `-const token = "tree-walk";\n+const token = ${run}`, [], /tree-walk/), "genuine");
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
  const pathOnly = ["test/citation-anchor-census.test.ts", "test/a-near-fixture-crossing-blocks-only-once-a-shifted-run-proves-it-red.test.ts"];
  for (const production of GATE_REPAIR_RULES as GateRepairRule[]) {
    if (!pathOnly.includes(production.gate)) {
      assert.ok(production.gateRegex instanceof RegExp, `${production.gate}: missing source predicate`);
      continue;
    }
    assert.equal(production.gateRegex, null, `${production.gate}: explicitly path-triggered`);
    const repair = { ...pair, gate: production.gate };
    assert.equal(classifyGateRepair(repair, dodge, production.ownFiles, null), "genuine");
    assert.equal(classifyGateRepair({ ...repair, triggered: false }, dodge, production.ownFiles, null), "off-subject");
    assert.equal(classifyGateRepair({ ...repair, repairFiles: [...production.ownFiles] }, "-1\n+2", production.ownFiles, null), "baseline-only");
  }
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

async function inventoryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-gate-repair-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  };
  put(".github/workflows/ci-gate.yml", "jobs:\n  ci-gate:\n    env:\n      REQUIRED: '[]'\n      ADVISORY: '[]'\n");
  put("scripts/source-size-baseline.json", "{}\n");
  put("scripts/learnings-budget-baseline.json", '{"measuredChars":0,"measuredActiveEntries":0}\n');
  put("plan/tasks.yaml", "[]\n");
  put("state/GATE_OFF-defuse", "");
  put("state/GATE_OFF-compress", "");
  mkdirSync(join(root, "learnings"));
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps = {
    repoRoot: root, stateDir: join(root, "state"),
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); },
    openWorkspace: () => { throw new Error("inventory must not open a workspace"); },
  };
  return { root, put, rows, deps, probes: await loadGateProbes(REPO_ROOT) };
}

test("W1-T9049: inventory counts genuine repairs and suppresses queued and open gate remedies", async t => {
  const f = await inventoryFixture(t);
  const gates = ["census", "open", "completed", "retired", "uncovered"];
  const rules = gates.map(gate => ({ ...rule, gate }));
  const observations = gates.map(gate => ({ pair: { ...pair, gate }, repairDiff: dodge }));
  observations.push({ pair: { ...pair, pr: 10789 }, repairDiff: '-const token = "tree-walk";\n+const token = "other";' });
  observations.push({ pair: { ...pair, gate: "unknown" }, repairDiff: dodge });
  const task = (id: string, status: string, origin?: string, retirement?: string) => ({
    id, title: "repair a gate", repo: "remudero", depends_on: [], type: "implement",
    verify: "human", risk: "low", status, attempts: 0, origin, retirement,
  });
  f.put("plan/tasks.yaml", JSON.stringify([
    task("W1-T990001", "queued", "gate-false-positive:census"),
    task("W1-T990002", "done", "gate-false-positive:completed"),
    task("W1-T990003", "queued", "gate-false-positive:retired", "retired"),
    task("W1-T990004", "queued"),
  ]));
  const spec = gateGardenSpec(f.deps, f.probes, { repairRules: rules,
    repairObservations: () => observations, openOrigins: () => ["gate-false-positive:open"] });
  const inv = spec.inventory();
  assert.deepEqual(spec.metric!(inv, "false-positive"), { trials: 7, successes: 1 });
  assert.deepEqual(inv.candidates.map(action => ({ target: action.target, file: action.file })),
    ["completed", "retired", "uncovered"].map(gate => ({ target: `gate-false-positive:${gate}`, file: rule.recognizer })));
  assert.deepEqual(f.rows.map(row => row.extra?.classification), Array(5).fill("token-dodge"));
  assert.ok(f.rows.every(row => row.step === "gate.false_positive_suspected"));
});

test("W1-T9049: empty async repair inventory has a zero tally and never reads open PRs", async t => {
  const f = await inventoryFixture(t);
  let reads = 0;
  const spec = gateGardenSpec(f.deps, f.probes, { repairRules: [rule], repairObservations: () => [],
    ghJson: async () => { reads++; throw new Error("empty inventory must not read GitHub"); } });
  const inv = await spec.inventoryAsync!();
  assert.deepEqual(spec.metric!(inv, "false-positive"), { trials: 0, successes: 0 });
  assert.deepEqual(inv.candidates, []);
  assert.deepEqual(f.rows, []);
  assert.equal(reads, 0);
});

test("W1-T9049: async inventory parses open PR origins and preserves baseline-only evidence", async t => {
  const f = await inventoryFixture(t);
  const calls: string[][] = [];
  f.put("plan/tasks.yaml", JSON.stringify([{
    id: "W1-T990005", title: "repair the census recognizer", repo: "remudero", depends_on: [],
    type: "implement", verify: "human", risk: "low", status: "queued", attempts: 0,
    origin: "gate-false-positive:census",
  }]));
  const spec = gateGardenSpec(f.deps, f.probes, { repairRules: [rule, { ...rule, gate: "open" }, { ...rule, gate: "other" }],
    repairObservations: () => [
      { pair: { ...pair, repairFiles: [baseline] }, repairDiff: "-1\n+2" },
      { pair: { ...pair, gate: "open" }, repairDiff: dodge },
      { pair: { ...pair, gate: "other" }, repairDiff: dodge },
      { pair: { ...pair, pr: 10789 }, repairDiff: '-const token = "tree-walk";\n+const token = "other";' },
    ],
    ghJson: async args => {
      calls.push(args);
      return [{ body: 'Remedies: "gate-false-positive:open"\n`gate-false-positive:unrelated`' }, { body: "ordinary PR" }];
    } });
  const inv = await spec.inventoryAsync!();
  assert.deepEqual(calls, [["pr", "list", "--state", "open", "--limit", "1000", "--json", "body"]]);
  assert.deepEqual(inv.candidates.map(({ class: actionClass, target, file }) => ({ actionClass, target, file })),
    [{ actionClass: "false-positive", target: "gate-false-positive:other", file: rule.recognizer }]);
  assert.deepEqual(spec.metric!(inv, "false-positive"), { trials: 4, successes: 1 });
  assert.deepEqual(f.rows.map(({ step, extra }) => ({ step, gate: extra?.gate, classification: extra?.classification,
    recognizer: extra?.recognizer, symbol: extra?.symbol })),
    [["census", "baseline-only"], ["open", "token-dodge"], ["other", "token-dodge"]].map(([gate, classification]) => ({
      step: "gate.false_positive_suspected", gate, classification, recognizer: rule.recognizer, symbol: rule.symbol,
    })));
});

test("W1-T9049: async inventory propagates open PR read failures", async t => {
  const f = await inventoryFixture(t);
  const failure = new Error("open PR inventory unavailable");
  const spec = gateGardenSpec(f.deps, f.probes, { repairRules: [rule],
    repairObservations: () => [{ pair, repairDiff: dodge }], ghJson: async () => { throw failure; } });
  await assert.rejects(spec.inventoryAsync!(), error => error === failure);
  assert.deepEqual(f.rows, [], "an unreadable open-PR inventory must not propose duplicate work");
});

test("W1-T9049: async inventory uses the default transport to read open PRs", async t => {
  const f = await inventoryFixture(t);
  const shim = ghShim([{ when: "pr list --state open --limit 1000 --json body",
    stdout: JSON.stringify([{ body: "gate-false-positive:census" }]) },
    { when: "", stderr: "unexpected inventory command", exit: 1 }]);
  const previousPath = process.env.PATH;
  const previousCache = process.env.RMD_GH_CACHE_HOME;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = previousCache;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  process.env.RMD_GH_CACHE_HOME = join(f.root, "github-cache");
  const spec = gateGardenSpec(f.deps, f.probes, { repairRules: [rule],
    repairObservations: () => [{ pair, repairDiff: dodge }] });
  const inv = await spec.inventoryAsync!();
  assert.deepEqual(shim.calls(), ["pr list --state open --limit 1000 --json body"]);
  assert.deepEqual(inv.candidates, []);
  assert.deepEqual(spec.metric!(inv, "false-positive"), { trials: 1, successes: 0 });
  assert.equal(f.rows[0].extra?.classification, "token-dodge");
});
