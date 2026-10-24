import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGateRepair, gateRepairCandidates, renderFalsePositiveShard, loadGateRepairObservations } from "#src/lib/gate-gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "#src/lib/plan.js";
import { ghTextAsync } from "#src/lib/github-transport.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { rmSync } from "node:fs";

const precheckModule: string = "#scripts/census-precheck.mjs";
const { PRECHECK_TRIGGERED_SUITES, PRECHECK_PATH_TRIGGERED_SUITES } = await import(precheckModule) as {
  PRECHECK_TRIGGERED_SUITES: Array<{ testFile: string; ownFiles: string[]; recognizer: string }>;
  PRECHECK_PATH_TRIGGERED_SUITES: Array<{ testFile: string; ownFiles: string[]; recognizer: string; symbol: string }>;
};

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

const readerDeps = { repoRoot: REPO_ROOT, stateDir: "/unused", log: () => {},
  openWorkspace: () => { throw new Error("reader must not open a workspace"); } };

function repairReader(overrides: Record<string, unknown> = {}, gate = "census") {
  const responses: Record<string, unknown> = {
    "repo view --json nameWithOwner": { nameWithOwner: "o/r" },
    "api repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100": [{ number: 7, base: { sha: "base" } }],
    "api repos/o/r/pulls/7/commits?per_page=100": [{ sha: "red" }, { sha: "green" }],
    "api repos/o/r/commits/red/check-runs?per_page=100": { check_runs: [
      { id: 99, name: gate, conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/2/job/42" },
      { id: 1, name: gate, conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/1/job/10" },
    ] },
    "api repos/o/r/commits/green/check-runs?per_page=100": { check_runs: [{ id: 100, name: gate, conclusion: "success" }] },
    "api repos/o/r/commits/red/status": { statuses: [] },
    "api repos/o/r/commits/green/status": { statuses: [] },
    "api repos/o/r/compare/red...green": { files: [{ filename: "test/example.test.ts", patch: dodge }] },
    "api repos/o/r/compare/base...red": { merge_base_commit: { sha: "merge" },
      files: [{ filename: "new.ts", status: "added" }, { filename: "gone.ts", status: "removed" },
        { filename: "renamed.ts", previous_filename: "old.ts", status: "renamed" }] },
    ...Object.fromEntries(["new.ts?ref=red", "gone.ts?ref=merge", "renamed.ts?ref=red", "old.ts?ref=merge"]
      .map((path) => [`api repos/o/r/contents/${path}`, { encoding: "base64", content: Buffer.from(path).toString("base64") }])),
    ...overrides,
  };
  const calls: string[] = [];
  const readRepair = async (args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    if (key === "run view --job 42 --log-failed") return "census failed";
    assert.ok(Object.hasOwn(responses, key), `unexpected read: ${key}`);
    return JSON.stringify(responses[key]);
  };
  return { readRepair, calls };
}

test("W1-T9049: asynchronous repair reads retain the latest Actions job and added, removed and renamed trigger files", async () => {
  const reader = repairReader({}, "rule-checks");
  const observations = await loadGateRepairObservations(readerDeps, [{ ...rule, trigger: ({ readHead, readBase }) => {
    assert.equal(readHead("gone.ts"), null);
    assert.equal(readBase("new.ts"), null);
    assert.equal(readHead("new.ts"), "new.ts?ref=red");
    assert.equal(readBase("renamed.ts"), "old.ts?ref=merge");
    return false;
  } }], reader);
  assert.equal(observations.length, 1);
  assert.equal(classifyGateRepair(observations[0].pair, observations[0].repairDiff, [], rule.gateRegex), "off-subject");
  assert.ok(reader.calls.includes("run view --job 42 --log-failed"));
  assert.ok(!reader.calls.includes("run view --job 99 --log-failed"));
});

test("W1-T9049: unreadable repair patches, rollups and trigger contents never become an empty success", async () => {
  for (const [key, value, message] of [
    ["api repos/o/r/compare/red...green", { files: [] }, /diff unreadable/],
    ["api repos/o/r/compare/red...green", { files: [{ filename: "binary" }] }, /diff unreadable/],
    ["api repos/o/r/commits/red/status", null, /checks unreadable/],
    ["api repos/o/r/contents/new.ts?ref=red", {}, /content unreadable/],
  ] as const) {
    await assert.rejects(loadGateRepairObservations(readerDeps, [{ ...rule, trigger: () => true }],
      repairReader({ [key]: value })), message);
  }
});

test("W1-T9049: the default repair reader uses the asynchronous transport with its own CLI stub", async () => {
  const shim = ghShim([{ when: "repo view", stdout: '{"nameWithOwner":"o/r"}' },
    { when: "pulls?state=all", stdout: "[]" }]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    assert.deepEqual(await loadGateRepairObservations(readerDeps, [rule], {}), []);
    assert.equal(shim.calls().length, 2);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T9049: plain-text transport preserves the repair reader's checkout", async () => {
  const output = await ghTextAsync(["repo", "view"], { cwd: REPO_ROOT }, async (_file, _args, options) => {
    assert.equal(options.cwd, REPO_ROOT);
    return { stdout: "fixture", stderr: "" };
  });
  assert.equal(output, "fixture");
});
