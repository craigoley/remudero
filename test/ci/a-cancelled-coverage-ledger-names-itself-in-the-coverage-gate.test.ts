// W1-T13175 — a coverage matrix skipped behind a CANCELLED coverage-ledger job names the cancellation and the head.
// MEASURED by W1-T11164 (2026-11-02/03, 30 pull_request runs of ci.yml): 2 of 32 coverage-ledger attempts were cancelled
// at the job's 1-minute ceiling after every step had concluded success within 19 s. A cancelled prerequisite skips the
// coverage-shard matrix, and coverage-ratchet then failed with the same never-ran text as any other skip, so W1-T11164's
// sweep rung had nothing to tell the two apart by. The gate step now prints a named line for that one case and keeps
// every exit code. This drives the step's own bash out of ci.yml with a controlled environment, as the W1-T11161 suite does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { id?: string; run?: string; env?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; steps?: Step[] };

function jobs(): Record<string, Job> {
  return (parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;
}

function gateStep(): Step {
  const gate = jobs()["coverage-ratchet-required"]?.steps?.find((s) => s.id === "coverage-gate");
  assert.ok(gate?.run, "coverage-ratchet-required has a step with id coverage-gate");
  assert.match(gate.run, /case "\$SHARD_RESULT" in/, "the gate judges the matrix result, so this suite cannot pass over nothing");
  return gate;
}

/** Runs the gate's own bash with a controlled environment; GITHUB_OUTPUT is read back. No PR_NUMBER is
 *  set, so the cancelled arm never reaches `gh` and reads the PR head as unreadable. */
function runGate(env: Record<string, string>): { code: number; out: string; outputs: string } {
  const dir = makeTempDir("w1-t13175-gate-");
  const scriptPath = join(dir, "step.sh");
  const outputPath = join(dir, "github-output");
  writeFileSync(scriptPath, gateStep().run!);
  writeFileSync(outputPath, "");
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, GITHUB_OUTPUT: outputPath };
  try {
    const out = execFileSync("bash", [scriptPath], { encoding: "utf8", env: { ...base, ...env }, cwd: dir });
    return { code: 0, out, outputs: readFileSync(outputPath, "utf8") };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`, outputs: readFileSync(outputPath, "utf8") };
  }
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";
// THE CONTRACT W1-T11164 READS. Its sweep rung matches these words, so they are pinned here whole; a change to them is a
// change to that task. The `::error::` prefix is the SHARD HANG line's, so the line is also a failure annotation.
const tokenLine = (head: string) =>
  `::error::coverage-ratchet: coverage-ledger-cancelled — the coverage ledger job was cancelled at its ceiling at ${head}; the matrix never ran (W1-T11164)`;
const TOKEN = /coverage-ratchet: coverage-ledger-cancelled/;
const NEVER_RAN = /the shard matrix never ran \(matrix result: skipped\)/;

const SOURCE_PR = { CLASS_EVENT: "pull_request", COVERAGE_CLASS: "SOURCE", COVERAGE_CLASS_COUNT: "3", RUN_HEAD_SHA: HEAD };
const PLAN_PR = { CLASS_EVENT: "pull_request", COVERAGE_CLASS: "PLAN_ONLY", COVERAGE_CLASS_COUNT: "1", RUN_HEAD_SHA: HEAD };

// The ten classes and events "W1-T11161 criterion 2" lists, none of them an evidenced PLAN_ONLY pull request.
const NOT_PLAN_ONLY: Array<[string, Record<string, string>]> = [
  ["a SOURCE diff", { ...PLAN_PR, COVERAGE_CLASS: "SOURCE" }],
  ["a DOCS_ONLY diff", { ...PLAN_PR, COVERAGE_CLASS: "DOCS_ONLY" }],
  ["a TEST_ONLY diff", { ...PLAN_PR, COVERAGE_CLASS: "TEST_ONLY" }],
  ["an unread classification", { ...PLAN_PR, COVERAGE_CLASS: "" }],
  ["no changed file read", { ...PLAN_PR, COVERAGE_CLASS_COUNT: "0" }],
  ["an unread count", { ...PLAN_PR, COVERAGE_CLASS_COUNT: "" }],
  ["a push", { ...PLAN_PR, CLASS_EVENT: "push" }],
  ["a merge group", { ...PLAN_PR, CLASS_EVENT: "merge_group" }],
  ["a workflow dispatch", { ...PLAN_PR, CLASS_EVENT: "workflow_dispatch" }],
  ["no evidence at all", { RUN_HEAD_SHA: HEAD }],
];

test("W1-T13175 criterion 1: a skipped matrix behind a cancelled coverage ledger fails with the named line and the run's head", () => {
  const gate = gateStep();
  assert.equal(gate.env?.LEDGER_RESULT, "${{ needs.coverage-ledger.result }}", "the gate is told the ledger job's own result");
  assert.equal(gate.env?.RUN_HEAD_SHA, "${{ github.event.pull_request.head.sha }}", "the head named is the pull request's");

  const r = runGate({ ...SOURCE_PR, SHARD_RESULT: "skipped", LEDGER_RESULT: "cancelled" });
  assert.equal(r.code, 1, `a cancelled ledger is still a red gate\n${r.out}`);
  assert.ok(r.out.split("\n").includes(tokenLine(HEAD)), `the named line, word for word, with the head\n${r.out}`);
  assert.doesNotMatch(r.out, NEVER_RAN, "the generic never-ran text is not printed for a cancelled ledger");
  assert.doesNotMatch(r.outputs, /not_applicable/, "nothing downstream is told to stand down");

  // The case the W1-T11161 suite no longer drives: every class and event that is not an evidenced PLAN_ONLY pull request.
  for (const [label, env] of NOT_PLAN_ONLY) {
    const c = runGate({ ...env, SHARD_RESULT: "skipped", LEDGER_RESULT: "cancelled" });
    assert.equal(c.code, 1, `${label}: still red\n${c.out}`);
    assert.ok(c.out.split("\n").includes(tokenLine(HEAD)), `${label}: names the cancellation\n${c.out}`);
    assert.doesNotMatch(c.out, NEVER_RAN, label);
    assert.doesNotMatch(c.out, /not applicable/, label);
  }

  const headless = runGate({ ...SOURCE_PR, RUN_HEAD_SHA: "", SHARD_RESULT: "skipped", LEDGER_RESULT: "cancelled" });
  assert.equal(headless.code, 1, headless.out);
  assert.ok(headless.out.split("\n").includes(tokenLine("unknown")), `an unread head is named, never left blank\n${headless.out}`);
});

test("W1-T13175 criterion 2: only the message changes — every exit holds, other ledgers keep the never-ran line, and the PLAN_ONLY pass is asked first", () => {
  // Any ledger result that is not a cancellation falls through to today's line, an empty or absent one included.
  for (const ledger of ["success", "failure", "skipped", "", undefined]) {
    const env: Record<string, string> = { ...SOURCE_PR, SHARD_RESULT: "skipped" };
    if (ledger !== undefined) env.LEDGER_RESULT = ledger;
    const r = runGate(env);
    assert.equal(r.code, 1, `ledger=${String(ledger)}: a skipped matrix stays red\n${r.out}`);
    assert.match(r.out, NEVER_RAN, `ledger=${String(ledger)}`);
    assert.doesNotMatch(r.out, TOKEN, `ledger=${String(ledger)}: only a cancellation is named`);
  }

  // The arm exits 1 whatever the ledger said, the cancellation included.
  for (const ledger of ["cancelled", "success", "failure", "skipped", ""]) {
    assert.equal(runGate({ ...SOURCE_PR, SHARD_RESULT: "skipped", LEDGER_RESULT: ledger }).code, 1, `ledger=${ledger}: the skipped arm exits 1`);
  }

  // W1-T11161's evidenced PLAN_ONLY pass is asked before the cancellation and is unchanged.
  const plan = runGate({ ...PLAN_PR, SHARD_RESULT: "skipped", LEDGER_RESULT: "cancelled" });
  assert.equal(plan.code, 0, plan.out);
  assert.match(plan.out, /coverage-ratchet: not applicable — class=PLAN_ONLY over 1 changed file\(s\) per scripts\/diff-class\.mjs; coverage-ledger=cancelled/);
  assert.match(plan.outputs, /^not_applicable=true$/m);
  assert.doesNotMatch(plan.out, TOKEN, "an evidenced plan-only diff is not applicable, not a cancellation");

  // A matrix that was not skipped never prints the token, and keeps its own exit.
  for (const env of [SOURCE_PR, PLAN_PR]) {
    for (const [shard, code] of [["success", 0], ["failure", 1], ["cancelled", 1], ["zzz", 1]] as const) {
      const r = runGate({ ...env, SHARD_RESULT: shard, LEDGER_RESULT: "cancelled" });
      assert.equal(r.code, code, `${env.COVERAGE_CLASS} matrix=${shard}\n${r.out}`);
      assert.doesNotMatch(r.out, TOKEN, `${env.COVERAGE_CLASS} matrix=${shard}: the token belongs to a skipped matrix only`);
    }
  }
});

test("W1-T13175 criterion 3: a skipped matrix behind a failed coverage ledger keeps the never-ran red on every class and event", () => {
  // Why `failure` is the other case: the matrix needs the ledger job and has no `if:`, and the ledger job needs nothing
  // and has no `if:`. So the matrix is skipped exactly when the ledger job did not succeed: `failure` or `cancelled`.
  const all = jobs();
  assert.deepEqual([all["coverage-ratchet"]?.needs].flat(), ["coverage-ledger"]);
  assert.equal(all["coverage-ratchet"]?.if, undefined);
  assert.equal(all["coverage-ledger"]?.needs, undefined);
  assert.equal(all["coverage-ledger"]?.if, undefined);

  for (const [label, env] of NOT_PLAN_ONLY) {
    const r = runGate({ ...env, SHARD_RESULT: "skipped", LEDGER_RESULT: "failure" });
    assert.equal(r.code, 1, `${label}: a skipped matrix behind a failed ledger stays red\n${r.out}`);
    assert.match(r.out, NEVER_RAN, label);
    assert.doesNotMatch(r.out, TOKEN, label);
    assert.doesNotMatch(r.out, /not applicable/, label);
    assert.doesNotMatch(r.outputs, /not_applicable/, label);
  }
});
