import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { classifyGateRepair, gateGardenSpec, gateRepairCandidates, loadGateProbes, loadGateRepairObservations, renderFalsePositiveShard } from "#src/lib/gate-gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "#src/lib/plan.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
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
