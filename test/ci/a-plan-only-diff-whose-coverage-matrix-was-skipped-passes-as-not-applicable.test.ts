// W1-T11161 — a plan-only diff's coverage-ratchet is not applicable on evidence, never on a skip.
// MEASURED 2026-11-02: #16322 (run 41538944616) and #16297 attempt 1 were plan-only. Their coverage-ledger job was
// cancelled at its 1-minute ceiling, the coverage-shard matrix was skipped, and the aggregator failed "the shard matrix
// never ran". The aggregator now classifies the diff itself with scripts/diff-class.mjs and passes a skipped matrix only
// for an evidenced PLAN_ONLY pull request; every other skip stays red. This drives the shipped scripts out of ci.yml.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { name?: string; id?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> };

function aggregatorSteps(): Step[] {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  return doc.jobs["coverage-ratchet-required"]?.steps ?? [];
}

const step = (id: string): Step => {
  const found = aggregatorSteps().find((s) => s.id === id);
  assert.ok(found?.run, `coverage-ratchet-required has a step with id ${id}`);
  return found!;
};

/** Runs one step's own bash with a controlled environment; GITHUB_OUTPUT is read back. */
function runStep(script: string, env: Record<string, string>, cwd?: string): { code: number; out: string; outputs: string } {
  const dir = makeTempDir("w1-t11161-step-");
  const scriptPath = join(dir, "step.sh");
  const outputPath = join(dir, "github-output");
  writeFileSync(scriptPath, script);
  writeFileSync(outputPath, "");
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, GITHUB_OUTPUT: outputPath };
  try {
    const out = execFileSync("bash", [scriptPath], { encoding: "utf8", env: { ...base, ...env }, cwd: cwd ?? dir });
    return { code: 0, out, outputs: readFileSync(outputPath, "utf8") };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`, outputs: readFileSync(outputPath, "utf8") };
  }
}

const PLAN_PR = { CLASS_EVENT: "pull_request", COVERAGE_CLASS: "PLAN_ONLY", COVERAGE_CLASS_COUNT: "1", LEDGER_RESULT: "cancelled" };

test("W1-T11161 criterion 1: a skipped matrix on an evidenced PLAN_ONLY pull request passes with a named not-applicable line", () => {
  const gate = step("coverage-gate");
  const r = runStep(gate.run!, { ...PLAN_PR, SHARD_RESULT: "skipped" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /coverage-ratchet: not applicable — class=PLAN_ONLY over 1 changed file\(s\) per scripts\/diff-class\.mjs; coverage-ledger=cancelled/);
  assert.match(r.outputs, /^not_applicable=true$/m, "the steps after the gate are told nothing was collected");

  // The gate reads the class the classify step wrote, and the classify step runs before it.
  const steps = aggregatorSteps();
  const classifyAt = steps.findIndex((s) => s.id === "coverage-plan-class");
  assert.ok(classifyAt >= 0 && classifyAt < steps.findIndex((s) => s.id === "coverage-gate"), "the class is read before the gate judges");
  assert.equal(gate.env?.COVERAGE_CLASS, "${{ steps.coverage-plan-class.outputs.class }}");
  assert.equal(gate.env?.COVERAGE_CLASS_COUNT, "${{ steps.coverage-plan-class.outputs.count }}");
  assert.match(step("coverage-plan-class").run!, /node scripts\/diff-class\.mjs --coverage-class --changed-files coverage-class-files\.txt/,
    "the class comes from the predicate the coverage shards use, not a copy");

  // The artifact step after the gate stands down as PLAN_ONLY, so every later fast-lane guard skips its work.
  const artifact = step("coverage-artifact");
  assert.equal(artifact.env?.NOT_APPLICABLE, "${{ steps.coverage-gate.outputs.not_applicable }}");
  const stood = runStep(artifact.run!, { NOT_APPLICABLE: "true" });
  assert.equal(stood.code, 0, stood.out);
  assert.match(stood.outputs, /^class=PLAN_ONLY$/m);
  const missing = runStep(artifact.run!, { NOT_APPLICABLE: "" });
  assert.equal(missing.code, 1, "without the gate's verdict a missing artifact still refuses");
  assert.match(missing.out, /expected coverage-shard-1 artifact metadata/);
});

test("W1-T11161 criterion 1: the classify step clamps its predicate's answer and fails closed to SOURCE", () => {
  const classify = `git() { return 1; }\n${step("coverage-plan-class").run!}`;
  const pr = { GITHUB_EVENT_NAME: "pull_request", MATRIX_RESULT: "skipped" };
  const withPredicate = (body: string) => {
    const dir = makeTempDir("w1-t11161-class-");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "diff-class.mjs"), body);
    return dir;
  };
  const says = (token: string) => withPredicate(`console.log(${JSON.stringify(token)});\n`);
  const plan = runStep(classify, pr, says("PLAN_ONLY"));
  assert.match(plan.outputs, /^class=PLAN_ONLY$/m);
  assert.match(plan.outputs, /^count=0$/m, "outside a checkout no changed file is read, so the gate cannot treat it as evidenced");
  assert.match(runStep(classify, pr, says("BOGUS")).outputs, /^class=SOURCE$/m);
  assert.match(runStep(classify, pr, withPredicate("process.exit(3);\n")).outputs, /^class=SOURCE$/m);
  assert.match(runStep(classify, { ...pr, GITHUB_EVENT_NAME: "push" }, says("PLAN_ONLY")).outputs, /^class=SOURCE$/m, "only a pull request is classified");

  // The real predicate, over the unreadable diff it gets outside a checkout: SOURCE.
  const real = sparseWorkspace();
  assert.match(runStep(classify, pr, real).outputs, /^class=SOURCE$/m);
});

function sparseWorkspace(): string {
  const checkout = aggregatorSteps().find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout?.with?.["fetch-depth"], 2);
  assert.equal(checkout?.with?.["sparse-checkout-cone-mode"], false);
  const paths = String(checkout?.with?.["sparse-checkout"] ?? "").split("\n").map((p) => p.trim()).filter(Boolean);
  for (const required of ["scripts/", "src/lib/plan-scope.ts", "src/lib/rule-suites.ts", "package.json", "package-lock.json", ".nvmrc"]) {
    assert.ok(paths.includes(required), `sparse checkout must include ${required}`);
  }
  const dir = makeTempDir("w1-t11161-sparse-");
  for (const path of paths) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(dir, path), { recursive: true });
  }
  assert.equal(existsSync(join(dir, "node_modules")), false);
  return dir;
}

test("W1-T11161 criterion 1: only skipped or successful pull request matrices classify the diff", () => {
  const classify = step("coverage-plan-class");
  assert.equal(classify.env?.MATRIX_RESULT, "${{ needs.coverage-ratchet.result }}");
  const steps = aggregatorSteps();
  const classifyAt = steps.findIndex((s) => s.id === classify.id);
  assert.ok(steps.findIndex((s) => s.uses?.startsWith("actions/checkout@")) < classifyAt);
  assert.ok(steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@")) < classifyAt);
  const script = `git() {
    printf '%s\\n' "$*" >> git-calls
    printf '%s\\n' 'plan/tasks.d/example.yaml' 'MASTER-PLAN.md'
  }\n${classify.run!}`;
  for (const event of ["pull_request", "push", "merge_group", "workflow_dispatch"]) {
    for (const result of ["skipped", "success", "failure", "cancelled", "unknown", ""]) {
      const dir = makeTempDir("w1-t11161-guard-");
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts/diff-class.mjs"),
        'import { writeFileSync } from "node:fs"; writeFileSync("predicate-called", "yes"); console.log("PLAN_ONLY");\n');
      const r = runStep(script, { GITHUB_EVENT_NAME: event, MATRIX_RESULT: result }, dir);
      const eligible = event === "pull_request" && ["skipped", "success"].includes(result);
      assert.equal(r.code, 0, r.out);
      assert.equal(existsSync(join(dir, "git-calls")), eligible, `${event}/${result}: diff invocation`);
      assert.equal(existsSync(join(dir, "predicate-called")), eligible, `${event}/${result}: classifier invocation`);
      assert.match(r.outputs, eligible ? /^class=PLAN_ONLY$/m : /^class=SOURCE$/m);
      assert.match(r.outputs, eligible ? /^count=2$/m : /^count=0$/m);
      if (eligible) assert.equal(readFileSync(join(dir, "git-calls"), "utf8").trim(), "diff --name-only HEAD^1...HEAD");
    }
  }
});

test("W1-T11161 criterion 1: the declared sparse checkout runs the real coverage classifier without dependencies", () => {
  const dir = sparseWorkspace();
  for (const [path, expected] of [
    ["plan/tasks.d/example.yaml", "PLAN_ONLY"], ["docs/example.md", "DOCS_ONLY"],
    ["test/example.test.ts", "TEST_ONLY"], ["scripts/example.mjs", "NO_SRC"], ["src/example.ts", "SOURCE"],
  ]) {
    const r = runStep(`git() { printf '%s\\n' '${path}'; }\n${step("coverage-plan-class").run!}`,
      { GITHUB_EVENT_NAME: "pull_request", MATRIX_RESULT: "skipped" }, dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.outputs, new RegExp(`^class=${expected}$`, "m"), r.out);
    assert.match(r.outputs, /^count=1$/m);
  }
});

test("W1-T11161 criterion 1: the artifact consumer restores the full checkout only after an applicable gate", () => {
  const steps = aggregatorSteps();
  const restore = steps.find((s) => s.id === "coverage-full-checkout");
  assert.ok(restore?.run);
  assert.equal(restore.env?.NOT_APPLICABLE, "${{ steps.coverage-gate.outputs.not_applicable }}");
  assert.ok(steps.indexOf(restore) > steps.findIndex((s) => s.id === "coverage-gate"));
  assert.ok(steps.indexOf(restore) < steps.findIndex((s) => s.uses?.startsWith("actions/download-artifact@")));
  const script = `git() { printf 'git %s\\n' "$*"; }\n${restore.run}`;
  const skipped = runStep(script, { NOT_APPLICABLE: "true" });
  assert.equal(skipped.code, 0, skipped.out);
  assert.doesNotMatch(skipped.out, /git /);
  const applicable = runStep(script, { NOT_APPLICABLE: "" });
  assert.equal(applicable.code, 0, applicable.out);
  assert.match(applicable.out, /git sparse-checkout disable/);
  assert.match(applicable.out, /git fetch .*--unshallow/);
});

test("W1-T11161 criterion 2: any other skipped matrix still fails with the never-ran message", () => {
  const gate = step("coverage-gate").run!;
  const cases: Array<[string, Record<string, string>]> = [
    ["a SOURCE diff", { ...PLAN_PR, COVERAGE_CLASS: "SOURCE" }],
    ["a DOCS_ONLY diff", { ...PLAN_PR, COVERAGE_CLASS: "DOCS_ONLY" }],
    ["a TEST_ONLY diff", { ...PLAN_PR, COVERAGE_CLASS: "TEST_ONLY" }],
    ["an unread classification", { ...PLAN_PR, COVERAGE_CLASS: "" }],
    ["no changed file read", { ...PLAN_PR, COVERAGE_CLASS_COUNT: "0" }],
    ["an unread count", { ...PLAN_PR, COVERAGE_CLASS_COUNT: "" }],
    ["a push", { ...PLAN_PR, CLASS_EVENT: "push" }],
    ["a merge group", { ...PLAN_PR, CLASS_EVENT: "merge_group" }],
    ["a workflow dispatch", { ...PLAN_PR, CLASS_EVENT: "workflow_dispatch" }],
    ["no evidence at all", {}],
  ];
  for (const [label, env] of cases) {
    const r = runStep(gate, { ...env, SHARD_RESULT: "skipped" });
    assert.equal(r.code, 1, `${label}: a skipped matrix must stay red\n${r.out}`);
    assert.match(r.out, /the shard matrix never ran \(matrix result: skipped\)/, label);
    assert.doesNotMatch(r.out, /not applicable/, label);
    assert.doesNotMatch(r.outputs, /not_applicable/, label);
  }
});

test("W1-T11161 criterion 3: a plan-only diff whose matrix ran ends with the same named line, and the other arms are unchanged", () => {
  const gate = step("coverage-gate").run!;
  const ran = runStep(gate, { ...PLAN_PR, LEDGER_RESULT: "success", SHARD_RESULT: "success" });
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /coverage-ratchet: not applicable — class=PLAN_ONLY over 1 changed file\(s\).*coverage-ledger=success/);
  assert.doesNotMatch(ran.outputs, /not_applicable/, "a matrix that ran leaves its artifacts to be checked");

  const source = runStep(gate, { ...PLAN_PR, COVERAGE_CLASS: "SOURCE", SHARD_RESULT: "success" });
  assert.equal(source.code, 0, source.out);
  assert.doesNotMatch(source.out, /not applicable/, "a SOURCE pass stays a plain pass");

  const failed = runStep(gate, { ...PLAN_PR, SHARD_RESULT: "failure" });
  assert.equal(failed.code, 1, "a failed shard is red even on a plan-only diff");
  assert.match(failed.out, /a coverage shard FAILED/);
  const cancelled = runStep(gate, { ...PLAN_PR, SHARD_RESULT: "cancelled", RUN_HEAD_SHA: "a".repeat(40) });
  assert.equal(cancelled.code, 1, "a cancelled matrix with no readable head is red even on a plan-only diff");
  assert.match(cancelled.out, /not permission to pass/);
  assert.equal(runStep(gate, { ...PLAN_PR, SHARD_RESULT: "zzz" }).code, 1, "an unknown result is red");
});
