// The fleet promotes its own changes with no person in the loop: config-gardener canaries, judge cash moves and model
// switches, the judge shadow pool, the skill-eval gate. The numbers that decide those promotions were TypeScript
// constants any PR could loosen silently. They now live in scripts/promotion-{floors,ceilings}-baseline.json, which
// src/lib/promotion-bars.ts reads and the required baseline-monotonic check holds against origin/main.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CANARY_DENOMINATOR_FLOOR, JUDGE_CASH_BAR, JUDGE_SWITCH_BAR } from "#src/lib/config-gardener.js";
import { CANARY_GUARD_BAR, cohortGuardMetrics } from "#src/lib/experiment-promotion.js";
import { JUDGE_SHADOW_POOL_BAR, judgeReplayPoolRefusal } from "#src/lib/judge-shadow.js";
import {
  PROMOTION_BARS_ROOT, PROMOTION_CEILING_FIELDS, PROMOTION_CEILINGS_PATH, PROMOTION_FLOOR_FIELDS, PROMOTION_FLOORS_PATH, readPromotionBars,
} from "#src/lib/promotion-bars.js";
import { localPrDiffAsync } from "#src/lib/pr-diff.js";
import { INSTRUMENT_ALIGN_CELLS, classifyInstrumentChange } from "#src/lib/review.js";
import { SKILL_EVAL_HELD_OUT_TASKS, SKILL_EVAL_MIN_MEAN_GAIN, SKILL_EVAL_TRIALS_PER_ARM } from "#src/lib/skill-eval.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Direction = "increase" | "decrease";
type Row = { path: string; field: string; direction: Direction };
type Plan = { has: (ref: string) => boolean; unreadable?: string };
/** The JavaScript gate has no declaration file. Keep its real import visible to test placement. */
// @ts-expect-error The script is outside the repository's TypeScript project.
const check = await import("#scripts/baseline-monotonic-check.mjs") as {
  SCORE_TABLE: Row[];
  evaluateRow: (entry: Row, oldJson: Record<string, unknown> | undefined, newJson: Record<string, unknown>, plan?: Plan, prs?: Plan) => { status: string; detail: string };
  planTasks: (root: string) => Plan;
  knownPrs: (root: string, base: string, current?: string) => Plan;
  currentPrFromRef: (ref: string | undefined) => string | undefined;
  main: (argv: string[]) => number;
};
/** This checkout's plan: W1-T2906 (the baseline-monotonic task) is a real task no promotion rationale cites yet. */
const PLAN = check.planTasks(REPO_ROOT);
/** A PR record holding #20999, the PR the fixtures below cite as the reviewed one. */
const PRS: Plan = { has: (ref) => ref === "#20999" };

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as Record<string, unknown>;
const FILES: Array<{ path: string; fields: readonly string[]; direction: Direction }> = [
  { path: PROMOTION_FLOORS_PATH, fields: PROMOTION_FLOOR_FIELDS, direction: "increase" },
  { path: PROMOTION_CEILINGS_PATH, fields: PROMOTION_CEILING_FIELDS, direction: "decrease" },
];
/** One step the wrong way for `direction`: a floor drops, a ceiling rises. */
const loosen = (value: number, direction: Direction): number => (direction === "increase" ? value - 1 : value + 1);

/** A fresh tree holding a COPY of this checkout's src/ (Node resolves a symlinked module to its real path, so only a
 *  copy makes src/lib/promotion-bars.ts find another checkout), the plan/policy.yaml worker.ts reads at import and,
 *  when `scripts` is given, this checkout's scripts/ with those baseline files written over it. */
function treeWith(t: TestContext, scripts?: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-promotion-bars-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const copied = scripts === undefined ? ["src"] : ["src", "scripts", "packages/api-client/src", ".remudero"];
  for (const dir of copied) cpSync(join(REPO_ROOT, dir), join(root, dir), { recursive: true });
  mkdirSync(join(root, "plan"));
  for (const file of ["package.json", "tsconfig.json", "plan/policy.yaml"]) copyFileSync(join(REPO_ROOT, file), join(root, file));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  for (const [path, body] of Object.entries(scripts ?? {})) writeFileSync(join(root, path), JSON.stringify(body));
  return root;
}

/** The one JSON line `code`, run as an ES module under tsx in `root`, prints. `load(path)` imports `root`'s own file. */
function printedIn(root: string, code: string): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: undefined };
  delete env.NODE_TEST_CONTEXT;
  const preamble = 'import { pathToFileURL } from "node:url";\nconst load = (path) => import(pathToFileURL(path).href);\n';
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", preamble + code], { cwd: root, encoding: "utf8", env });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

test("loosening a promotion bar without a fresh rationale is refused by the baseline check", (t) => {
  for (const { path, fields, direction } of FILES) {
    const base = readJson(path);
    for (const field of fields) {
      const row = check.SCORE_TABLE.find((r) => r.path === path && r.field === field);
      assert.ok(row, `${path}'s ${field} is read by src/lib/promotion-bars.ts but has no SCORE_TABLE row`);
      assert.equal(row.direction, direction, `${path}'s ${field} is held in the wrong direction`);
      const value = base[field] as number;
      const head = { ...base, [field]: loosen(value, direction) };
      assert.equal(check.evaluateRow(row, base, head).status, "regressed", `${field} loosened with base's own rationale`);
      assert.equal(check.evaluateRow(row, base, { ...head, bumpRationale: "loosened because it seemed fine" }).status, "regressed",
        `${field} loosened under a rationale that names no PR or task`);
      assert.equal(check.evaluateRow(row, base, { ...head, bumpRationale: "Loosened by W1-T2906 after a reviewed replay." }, PLAN).status,
        "reviewed-bump", `${field} loosened under a fresh, task-naming rationale`);
      assert.equal(check.evaluateRow(row, base, { ...head, bumpRationale: "Loosened by W1-T2906 after a reviewed replay." }).status,
        "regressed", `${field}: with no plan to check it against, a task reference fails closed`);
      const tightened = { ...base, [field]: direction === "increase" ? value + 1 : value / 2 };
      assert.equal(check.evaluateRow(row, base, tightened).status, "ok", `${field} tightened needs no rationale`);
    }
  }

  // A stale rationale padded or extended reviews nothing new (PR #20033's review: 0.98 -> 0.90 plus one space). Only
  // a PR or task the previous rationale did not name makes it fresh.
  const floors = readJson(PROMOTION_FLOORS_PATH);
  const agree = check.SCORE_TABLE.find((r) => r.path === PROMOTION_FLOORS_PATH && r.field === "judgeMinAgreeShare");
  assert.ok(agree);
  const previous = String(floors.bumpRationale);
  assert.match(previous, /W1-T12187/, "positive control: the base rationale names the reference the restatement below repeats");
  const lowered = { ...floors, judgeMinAgreeShare: 0.9 };
  for (const stale of [`${previous} `, `${previous}\n`, `${previous} Reviewed again.`, `${previous} See W1-T12187 again.`,
    "Restated: W1-T4113, W1-T12187 and W1-T12417."]) {
    assert.equal(check.evaluateRow(agree, floors, { ...lowered, bumpRationale: stale }).status, "regressed", JSON.stringify(stale));
  }
  assert.equal(check.evaluateRow(agree, floors, { ...lowered, bumpRationale: `${previous} Lowered by #20999 after a reviewed replay.` }, PLAN, PRS).status,
    "reviewed-bump", "appending a reference the previous rationale did not name is a fresh review");
  // A PR reference must name a PR (PR #20033's fourth review: `#999999999999999999999999999999` passed as a review).
  const bogus = check.evaluateRow(agree, floors, { ...lowered, bumpRationale: "No review was performed. #999999999999999999999999999999" }, PLAN, PRS);
  assert.equal(bogus.status, "regressed", "a number no PR ever held reviews nothing");
  assert.match(bogus.detail, /#999999999999999999999999999999 cannot count: neither a merged PR in the base's history nor this PR/);
  const noRecord = check.evaluateRow(agree, floors, { ...lowered, bumpRationale: `${previous} Lowered by #20999.` }, PLAN);
  assert.equal(noRecord.status, "regressed", "with no PR record to check it against, a PR reference fails closed");
  assert.match(noRecord.detail, /#20999 cannot count: no PR record was given/);

  // References compare as NUMBERS, and a task must exist (PR #20033's second review: `W1-T012187` and `#0` passed).
  const verdict = (old: Record<string, unknown>, bumpRationale: string, plan: Plan = PLAN) =>
    check.evaluateRow(agree, old, { ...old, judgeMinAgreeShare: 0.9, bumpRationale }, plan, PRS);
  assert.ok(PLAN.has("W1-T12187") && PLAN.has("W1-T2906"), "positive control: the plan holds the cited task and the fresh one");
  for (const stale of [`${previous} W1-T012187`, `${previous} W1-T0012187.`, `${previous} #0`, `${previous} #00 and W1-T0.`]) {
    assert.equal(verdict(floors, stale).status, "regressed", JSON.stringify(stale));
  }
  assert.equal(verdict({ ...floors, bumpRationale: "Reviewed in #7." }, "Lowered in #007.").status, "regressed", "#007 is #7");
  const unknownTask = verdict(floors, `${previous} Lowered by W1-T99999999.`);
  assert.equal(unknownTask.status, "regressed", "a task the plan does not hold reviews nothing");
  assert.match(unknownTask.detail, /W1-T99999999 cannot count: no plan\/tasks\.d shard declares it/);
  assert.equal(verdict(floors, `${previous} Lowered by W1-T2906.`).status, "reviewed-bump", "an existing task the old rationale did not cite");
  assert.equal(verdict(floors, `${previous} Lowered by W1-T02906.`).status, "reviewed-bump", "zero padding still names the task");
  const unreadable = verdict(floors, `${previous} Lowered by W1-T2906.`, check.planTasks(join(REPO_ROOT, "no-such-tree")));
  assert.equal(unreadable.status, "regressed", "an unreadable plan counts no task reference");
  assert.match(unreadable.detail, /W1-T2906 cannot count: cannot list plan\/tasks\.d under /);

  // A reference counts only as a whole word (PR #20033's third review: `W1-T2906bogus` named W1-T2906 and passed). A
  // format character renders as nothing, so it joins the word it sits in.
  assert.equal(verdict(floors, "W1-T2906bogus").status, "regressed", "the reviewed rationale, verbatim");
  for (const glued of ["W1-T2906bogus", "xW1-T2906", "W1-T2906_x", "W1-T2906é", "W1-T2906​bogus", "#20999abc", "PR#20999", "#20999_1"]) {
    const lowered = verdict(floors, `${previous} Lowered by ${glued}.`);
    assert.equal(lowered.status, "regressed", JSON.stringify(glued));
    assert.doesNotMatch(lowered.detail, /cannot count/, `${JSON.stringify(glued)} names no reference at all`);
  }
  for (const word of ["(W1-T2906)", "W1-T2906's", "W1-T2906-reviewed", "#20999,", "#20999"]) {
    assert.equal(verdict(floors, `${previous} Lowered by ${word}`).status, "reviewed-bump", `positive control: ${JSON.stringify(word)}`);
  }

  // The real CLI over the production rows, against a fixture repo whose HEAD holds today's two files and whose
  // working tree raises one ceiling: exit 1, naming the field.
  const repo = gitRepo({ scope: t, kind: "promotion-bars" });
  mkdirSync(join(repo.dir, "scripts"));
  for (const { path } of FILES) copyFileSync(join(REPO_ROOT, path), join(repo.dir, path));
  repo.git("add", ".");
  repo.git("commit", "--quiet", "-m", "base: the promotion bars as they stand");
  const ceilings = readJson(PROMOTION_CEILINGS_PATH);
  writeFileSync(join(repo.dir, PROMOTION_CEILINGS_PATH), JSON.stringify({ ...ceilings, poolMaxRejectedShare: 0.5 }));
  const table = join(repo.dir, "table.json");
  writeFileSync(table, JSON.stringify(check.SCORE_TABLE.filter((r) => FILES.some((f) => f.path === r.path))));
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  t.mock.method(console, "log", () => {});
  assert.equal(check.main(["--root", repo.dir, "--base", "HEAD", "--table", table]), 1);
  assert.deepEqual(errors.filter((line) => line.includes("BLOCKED")).map((line) => /: (\w+) moved/.exec(line)?.[1]), ["poolMaxRejectedShare"]);

  // The CLI checks a task reference against the plan of the tree it runs on: none in the fixture, then one.
  const fresh = { ...ceilings, poolMaxRejectedShare: 0.5, bumpRationale: `${String(ceilings.bumpRationale)} Raised by W1-T2906.` };
  writeFileSync(join(repo.dir, PROMOTION_CEILINGS_PATH), JSON.stringify(fresh));
  errors.length = 0;
  assert.equal(check.main(["--root", repo.dir, "--base", "HEAD", "--table", table]), 1);
  assert.match(errors.join("\n"), /W1-T2906 cannot count: cannot list plan\/tasks\.d under /);
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T2906-fixture.yaml"), "- id: W1-T2906\n");
  errors.length = 0;
  assert.equal(check.main(["--root", repo.dir, "--base", "HEAD", "--table", table]), 0, errors.join("\n"));

  // The reviewed case through the same CLI: judgeMinAgreeShare 0.98 -> 0.90 under `W1-T2906bogus`, W1-T2906 in the plan.
  writeFileSync(join(repo.dir, PROMOTION_FLOORS_PATH), JSON.stringify({ ...floors, judgeMinAgreeShare: 0.9, bumpRationale: "W1-T2906bogus" }));
  errors.length = 0;
  assert.equal(check.main(["--root", repo.dir, "--base", "HEAD", "--table", table]), 1);
  assert.deepEqual(errors.filter((line) => line.includes("BLOCKED")).map((line) => /: (\w+) moved/.exec(line)?.[1]), ["judgeMinAgreeShare"]);

  // A PR reference through the same CLI counts only for a PR the base's history merged, or the PR under check.
  const ref = process.env.GITHUB_REF;
  t.after(() => { if (ref === undefined) delete process.env.GITHUB_REF; else process.env.GITHUB_REF = ref; });
  delete process.env.GITHUB_REF;
  repo.git("commit", "--quiet", "--allow-empty", "-m", "fix(scripts): a merged change (#4242)");
  const cite = (rationale: string) =>
    writeFileSync(join(repo.dir, PROMOTION_FLOORS_PATH), JSON.stringify({ ...floors, judgeMinAgreeShare: 0.9, bumpRationale: rationale }));
  const run = (...extra: string[]) => {
    errors.length = 0;
    return check.main(["--root", repo.dir, "--base", "HEAD", "--table", table, ...extra]);
  };
  cite("No review was performed. #999999999999999999999999999999");
  assert.equal(run(), 1, "the reviewed case: a number no PR held");
  assert.match(errors.join("\n"), /#999999999999999999999999999999 cannot count: neither a merged PR/);
  cite("Lowered after the replay reviewed in #4242.");
  assert.equal(run(), 0, `a PR the base's history merged\n${errors.join("\n")}`);
  cite("Lowered by #4343, this PR.");
  assert.equal(run(), 1, "an open PR is unknown until the run names it");
  assert.equal(run("--pr", "4343"), 0, `--pr names the PR under check\n${errors.join("\n")}`);
  process.env.GITHUB_REF = "refs/pull/4343/merge";
  assert.equal(run(), 0, `a pull_request run names it through GITHUB_REF\n${errors.join("\n")}`);
  assert.equal(run("--pr", "43x"), 2, "a --pr that is not a PR number is a measurement failure");
  assert.deepEqual(["refs/pull/12/merge", "refs/pull/12/head", "refs/heads/main", "refs/pull/0/merge", undefined].map(check.currentPrFromRef),
    ["12", "12", undefined, undefined, undefined]);
  const unreadPrs = check.knownPrs(repo.dir, "no-such-ref");
  assert.equal(unreadPrs.has("#4242"), false, "an unreadable history counts no PR");
  assert.match(String(unreadPrs.unreadable), /cannot read the merged PRs in no-such-ref's history/);
});

test("the promotion bars the gardener, judge shadow pool and skill eval use are the baseline values", (t) => {
  const floors = readJson(PROMOTION_FLOORS_PATH);
  const ceilings = readJson(PROMOTION_CEILINGS_PATH);
  assert.equal(CANARY_DENOMINATOR_FLOOR, floors.canaryMinTasksPerSide);
  assert.deepEqual([JUDGE_CASH_BAR.minPaired, JUDGE_CASH_BAR.minAgreeShare, JUDGE_CASH_BAR.maxNoAnswerShare],
    [floors.judgeMinPaired, floors.judgeMinAgreeShare, ceilings.judgeMaxNoAnswerShare]);
  assert.deepEqual([JUDGE_SWITCH_BAR.minCompared, JUDGE_SWITCH_BAR.minAgreeShare, JUDGE_SWITCH_BAR.maxNoAnswerShare, JUDGE_SWITCH_BAR.maxBrier],
    [floors.judgeMinPaired, floors.judgeMinAgreeShare, ceilings.judgeMaxNoAnswerShare, ceilings.judgeMaxBrier]);
  assert.deepEqual([JUDGE_SHADOW_POOL_BAR.maxRejectedShare, JUDGE_SHADOW_POOL_BAR.maxMedianCaseUsd],
    [ceilings.poolMaxRejectedShare, ceilings.poolMaxMedianCaseUsd]);
  assert.deepEqual([CANARY_GUARD_BAR.maxMergeRateDrop, CANARY_GUARD_BAR.maxCostRatio], [ceilings.canaryMaxMergeRateDrop, ceilings.canaryMaxCostRatio]);
  assert.deepEqual(cohortGuardMetrics().map((m) => m.abortThreshold), [ceilings.canaryMaxMergeRateDrop, ceilings.canaryMaxCostRatio]);
  assert.deepEqual([SKILL_EVAL_HELD_OUT_TASKS, SKILL_EVAL_TRIALS_PER_ARM, SKILL_EVAL_MIN_MEAN_GAIN],
    [floors.skillEvalHeldOutTasks, floors.skillEvalTrialsPerArm, floors.skillEvalMinMeanGain]);

  // The pool's refusal reads the bar it names: a replay just over the rejected-share ceiling is kept out, one at it is not.
  const sent = 1000;
  const at = Math.round((ceilings.poolMaxRejectedShare as number) * sent);
  const replay = { corpus: "fixture", sent, medianCaseUsd: 0, finishedAt: "2026-11-21T00:00:00.000Z" };
  assert.equal(judgeReplayPoolRefusal({ ...replay, rejected: at }), undefined);
  assert.match(judgeReplayPoolRefusal({ ...replay, rejected: at + 1 }) ?? "", /rejected/);

  // Behaviour is unchanged: the files hold, verbatim, the constants they replaced.
  assert.deepEqual(readPromotionBars(PROMOTION_BARS_ROOT, PROMOTION_FLOORS_PATH, PROMOTION_FLOOR_FIELDS), {
    canaryMinTasksPerSide: 5, judgeMinPaired: 200, judgeMinAgreeShare: 0.98, skillEvalHeldOutTasks: 3, skillEvalTrialsPerArm: 2, skillEvalMinMeanGain: 0,
  });
  assert.deepEqual(readPromotionBars(PROMOTION_BARS_ROOT, PROMOTION_CEILINGS_PATH, PROMOTION_CEILING_FIELDS), {
    judgeMaxNoAnswerShare: 0.02, judgeMaxBrier: 0.1, poolMaxRejectedShare: 0.1, poolMaxMedianCaseUsd: 0.003, canaryMaxCostRatio: 1.25, canaryMaxMergeRateDrop: 0.15,
  });

  // The discriminating half: a constant that merely equals today's file passes everything above. In a tree whose
  // files hold different numbers, every module must hold those numbers instead.
  const moved = {
    floors: { canaryMinTasksPerSide: 7, judgeMinPaired: 300, judgeMinAgreeShare: 0.99, skillEvalHeldOutTasks: 4, skillEvalTrialsPerArm: 4, skillEvalMinMeanGain: 0.05 },
    ceilings: { judgeMaxNoAnswerShare: 0.01, judgeMaxBrier: 0.05, poolMaxRejectedShare: 0.05, poolMaxMedianCaseUsd: 0.002, canaryMaxCostRatio: 1.1, canaryMaxMergeRateDrop: 0.1 },
  };
  const root = treeWith(t, { [PROMOTION_FLOORS_PATH]: { ...floors, ...moved.floors }, [PROMOTION_CEILINGS_PATH]: { ...ceilings, ...moved.ceilings } });
  assert.deepEqual(printedIn(root, `
    const gardener = await load('src/lib/config-gardener.ts');
    const promotion = await load('src/lib/experiment-promotion.ts');
    const shadow = await load('src/lib/judge-shadow.ts');
    const evals = await load('src/lib/skill-eval.ts');
    console.log(JSON.stringify({
      floors: { canaryMinTasksPerSide: gardener.CANARY_DENOMINATOR_FLOOR, judgeMinPaired: gardener.JUDGE_CASH_BAR.minPaired,
        judgeMinAgreeShare: gardener.JUDGE_SWITCH_BAR.minAgreeShare, skillEvalHeldOutTasks: evals.SKILL_EVAL_HELD_OUT_TASKS,
        skillEvalTrialsPerArm: evals.SKILL_EVAL_TRIALS_PER_ARM, skillEvalMinMeanGain: evals.SKILL_EVAL_MIN_MEAN_GAIN },
      ceilings: { judgeMaxNoAnswerShare: gardener.JUDGE_CASH_BAR.maxNoAnswerShare, judgeMaxBrier: gardener.JUDGE_SWITCH_BAR.maxBrier,
        poolMaxRejectedShare: shadow.JUDGE_SHADOW_POOL_BAR.maxRejectedShare, poolMaxMedianCaseUsd: shadow.JUDGE_SHADOW_POOL_BAR.maxMedianCaseUsd,
        canaryMaxCostRatio: promotion.cohortGuardMetrics()[1].abortThreshold, canaryMaxMergeRateDrop: promotion.cohortGuardMetrics()[0].abortThreshold },
    }));
  `), moved);
});

test("a promotion bar file that is missing, not JSON or carries a non-number fails loudly, never with a default", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-promotion-bars-"));
  try {
    const read = () => readPromotionBars(root, "bars.json", ["minPaired"]);
    assert.throws(read, /promotion-bars: cannot read bars\.json under .*the automatic-promotion bars live there/);
    writeFileSync(join(root, "bars.json"), "{ not json");
    assert.throws(read, /promotion-bars: bars\.json is not valid JSON/);
    const notNumbers: Array<[string, string]> = [['{ "minPaired": "200" }', '"200"'], ['{ "minPaired": null }', "null"], ["[]", "undefined"], ["null", "undefined"]];
    for (const [body, shown] of notNumbers) {
      writeFileSync(join(root, "bars.json"), body);
      assert.throws(read, (error: Error) => error.message === `promotion-bars: bars.json's "minPaired" is not a finite number (${shown})`, body);
    }
    writeFileSync(join(root, "bars.json"), '{ "minPaired": 200, "unread": "x" }');
    assert.deepEqual(read(), { minPaired: 200 });
    assert.ok(Object.isFrozen(read()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raising a promotion floor reads as tightening to the reviewer, lowering one as loosening", async (t) => {
  const diffOf = (file: string, body: string) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1,8 +1,8 @@", body].join("\n");
  const classify = (file: string, body: string) => classifyInstrumentChange(diffOf(file, body), [file], file);
  assert.equal(classify(PROMOTION_FLOORS_PATH, '-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 400,\n'), "tightening");
  assert.equal(classify(PROMOTION_FLOORS_PATH, '-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 100,\n'), "loosening");
  assert.equal(classify(PROMOTION_CEILINGS_PATH, '-  "judgeMaxBrier": 0.1,\n+  "judgeMaxBrier": 0.05,\n'), "tightening");
  assert.equal(classify(PROMOTION_CEILINGS_PATH, '-  "judgeMaxBrier": 0.1,\n+  "judgeMaxBrier": 0.2,\n'), "loosening");

  // Any valid JSON number is read at its true value (PR #20033's review: a lowered 0.98 written `9e-1` read as 9).
  assert.equal(classify(PROMOTION_FLOORS_PATH, '-  "judgeMinAgreeShare": 0.98,\n+  "judgeMinAgreeShare": 9e-1,\n'), "loosening");
  assert.equal(classify(PROMOTION_FLOORS_PATH, '-  "judgeMinAgreeShare": 0.98,\n+  "judgeMinAgreeShare": 9.9E-1,\n'), "tightening");
  assert.equal(classify(PROMOTION_FLOORS_PATH, '-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 1e+2,\n'), "loosening");
  assert.equal(classify(PROMOTION_CEILINGS_PATH, '-  "canaryMaxCostRatio": 1.25,\n+  "canaryMaxCostRatio": 1e1,\n'), "loosening");
  assert.equal(classify(PROMOTION_CEILINGS_PATH, '-  "judgeMaxBrier": 0.1,\n+  "judgeMaxBrier": 5e-2,\n'), "tightening");
  // A token that is not a whole JSON number is never read as its prefix: the file stays undetermined.
  assert.equal(classify(PROMOTION_FLOORS_PATH, '-  "judgeMinAgreeShare": 0.98,\n+  "judgeMinAgreeShare": 0.99.5,\n'), "undetermined");

  // A key and its value on different lines are one pair (PR #20033's second review: both moves read `undetermined`).
  const below = (from: string, to: string) => ` {\n   "judgeMinAgreeShare":\n-    ${from},\n+    ${to},\n   "skillEvalHeldOutTasks": 3,\n`;
  assert.equal(classify(PROMOTION_FLOORS_PATH, below("0.98", "0.99")), "tightening");
  assert.equal(classify(PROMOTION_FLOORS_PATH, below("0.98", "0.90")), "loosening");
  assert.equal(classify(PROMOTION_FLOORS_PATH, below("0.98", "9e-1")), "loosening");
  const ceilingBelow = (to: string) => `   "judgeMaxBrier"\n-    : 0.1,\n+    : ${to},\n`;
  assert.equal(classify(PROMOTION_CEILINGS_PATH, ceilingBelow("0.05")), "tightening");
  assert.equal(classify(PROMOTION_CEILINGS_PATH, ceilingBelow("0.2")), "loosening");
  // The key outside the hunk (git cut it from the context; PR #20033's fourth review). Every number in a floors file is
  // a floor, so a lowered one loosens whatever key holds it. A raise proves nothing without its key: still undetermined.
  assert.equal(classify(PROMOTION_FLOORS_PATH, "-    0.98,\n+    0.99,\n"), "undetermined");
  assert.equal(classify(PROMOTION_FLOORS_PATH, "-    0.98,\n+    0.90,\n"), "loosening");
  assert.equal(classify(PROMOTION_CEILINGS_PATH, "-    0.1,\n+    0.2,\n"), "loosening");
  assert.equal(classify(PROMOTION_FLOORS_PATH, '-    "0.98",\n+    "0.90",\n'), "undetermined", "a digit inside a string is text");

  // Real git hunks between two real versions of the floors file, read through the reviewer's own diff source
  // (src/lib/pr-diff.ts). A line holding no JSON token, or a change that moves tokens without changing one, cannot
  // move the verdict (PR #20033's third review: 0.98 -> 0.99 plus one blank line read `undetermined`).
  const repo = gitRepo({ scope: t, kind: "promotion-floor-diff" });
  mkdirSync(join(repo.dir, "scripts"));
  const reviewerReads = async (base: string, head: string): Promise<string> => {
    writeFileSync(join(repo.dir, PROMOTION_FLOORS_PATH), base);
    repo.git("add", ".");
    repo.git("commit", "--quiet", "--allow-empty", "-m", "base");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(repo.dir, PROMOTION_FLOORS_PATH), head);
    repo.git("commit", "--quiet", "--allow-empty", "-am", "head");
    const diff = await localPrDiffAsync(repo.dir, repo.git("rev-parse", "HEAD"));
    return classifyInstrumentChange(diff, [PROMOTION_FLOORS_PATH], PROMOTION_FLOORS_PATH);
  };
  const text = readFileSync(join(REPO_ROOT, PROMOTION_FLOORS_PATH), "utf8");
  const agree = '  "judgeMinAgreeShare": 0.98,\n';
  assert.ok(text.includes(agree), "positive control: the floor the edits below move");
  const moveTo = (value: string) => text.replace(agree, `  "judgeMinAgreeShare": ${value},\n`);
  // The reviewer's layout: the key split from its value by four blank lines, so git's three-line context drops the key.
  const split = (value: string) => text.replace(agree, `  "judgeMinAgreeShare":\n\n\n\n\n    ${value},\n`);
  assert.equal(await reviewerReads(split("0.98"), split("0.90")), "loosening", "a split key's lowered floor loosens");
  assert.notEqual(await reviewerReads(split("0.98"), split("0.99")), "loosening", "a split key's raised floor is no loosening");
  assert.equal(await reviewerReads(text, moveTo("0.99")), "tightening", "control: the raise alone");
  assert.equal(await reviewerReads(text, moveTo("0.90")), "loosening", "control: the lowering alone");
  const reorder = (s: string, ...order: string[]) => {
    const json = JSON.parse(s) as Record<string, unknown>;
    return `${JSON.stringify(Object.fromEntries(order.map((k) => [k, json[k]])), null, 2)}\n`;
  };
  const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
  const layouts: Array<[string, (s: string) => string, ((s: string) => string)?]> = [
    ["a blank line added", (s) => s.replace(/("judgeMinAgreeShare": [^\n]*\n)/, "$1\n")],
    ["an indentation-only line added", (s) => s.replace(/("judgeMinAgreeShare": [^\n]*\n)/, "$1    \t\n")],
    ["a blank line removed", (s) => s, (s) => s.replace(/("judgeMinPaired": [^\n]*\n)/, "$1\n")],
    ["re-indentation, the closing brace too", (s) => s.replace(/^ {2}"/gm, '    "').replace(/^}$/m, "  }")],
    ["a trailing comma moved to the next line", (s) => s.replace(/("judgeMinAgreeShare": [^,\n]*),\n {2}"/, '$1\n  , "')],
    ["a trailing comma moved by swapping the last two keys", (s) => reorder(s, ...keys.slice(0, -2), ...keys.slice(-2).reverse())],
    ["a key reordered with its value unchanged", (s) => reorder(s, "skillEvalHeldOutTasks", ...keys.filter((k) => k !== "skillEvalHeldOutTasks"))],
    ["the final newline removed", (s) => s.replace(/\n$/, "")],
  ];
  for (const [layout, head, base = (s: string) => s] of layouts) {
    assert.equal(await reviewerReads(base(text), head(moveTo("0.99"))), "tightening", `0.98 -> 0.99 with ${layout}`);
    assert.equal(await reviewerReads(base(text), head(moveTo("0.90"))), "loosening", `0.98 -> 0.90 with ${layout}`);
    assert.equal(await reviewerReads(base(text), head(text)), "undetermined", `${layout} alone moves no bar, so tightens none`);
  }
});

test("an instrument diff pairs each value with its own key, whatever the hunk's layout", () => {
  const F = PROMOTION_FLOORS_PATH;
  const diffOf = (...hunks: string[]) => [`diff --git a/${F} b/${F}`, `--- a/${F}`, `+++ b/${F}`, ...hunks.flatMap((h) => ["@@ -1,8 +1,8 @@", h])].join("\n");
  const classify = (...hunks: string[]) => classifyInstrumentChange(diffOf(...hunks), [F], F);
  // The key and the colon both changed, the value a context line: the rename is a new key, judged at the added line.
  assert.equal(classify('-  "judgeMinPaired":\n+  "judgeMinPairedX":\n     200,\n'), "undetermined");
  assert.equal(classify('-  "judgeMinPaired"\n+  "judgeMinPaired"\n   :\n-  200\n+  300\n'), "tightening");
  // A key never pairs across a hunk boundary, so a raise there proves no tightening. A lowered number in a floors file
  // still loosens, whatever key holds it (PR #20033's fourth review).
  assert.equal(classify('   "judgeMinPaired":\n', "-    200,\n+    300,\n"), "undetermined");
  assert.equal(classify('   "judgeMinPaired":\n', "-    200,\n+    100,\n"), "loosening");
  // Prose over two lines is still prose; any other string, container or literal value is unaccountable.
  assert.equal(classify('-  "capturedAt":\n+  "capturedAt":\n+    "2026-12-01",\n-    "2026-11-21",\n-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 250,\n'), "tightening");
  assert.equal(classify('+  "path":\n+    "src/lib/x.ts",\n-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 250,\n'), "undetermined");
  for (const value of ["{ }", "[200]", "true", "null"]) {
    assert.equal(classify(`-  "judgeMinPaired": 200,\n+  "judgeMinPaired": ${value},\n`), "undetermined", value);
  }
  // A value is judged under its own parent: both lines rewritten, but only a's `legacy` lowered, reads as that lowering.
  assert.equal(classify('-  "a": { "legacy": 9 },\n-  "b": { "legacy": 1 },\n+  "a": { "legacy": 3 },\n+  "b": { "legacy": 1 },\n'), "loosening");
  // A key moved into another object, or out of an unwrapped one, is a new key there, never a reordering.
  assert.equal(classify('-  "a": { "legacy": 9 },\n-  "b": { },\n+  "a": { },\n+  "b": { "legacy": 9 },\n-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 250,\n'), "undetermined");
  assert.equal(classify('-  "x": { "judgeMinPaired": 200 },\n+  "judgeMinPaired": 200,\n-  "judgeMinAgreeShare": 0.98\n+  "judgeMinAgreeShare": 0.99\n'), "undetermined");
  // One path with two removed values (two hunks, each cut below its parent) cannot say which one an added value replaces,
  // so two raises there prove no tightening. A line lowered in place still loosens (PR #20033's fourth review).
  assert.equal(classify('-    "legacy": 1,\n+    "legacy": 3,\n', '-    "legacy": 2,\n+    "legacy": 4,\n'), "undetermined");
  assert.equal(classify('-    "legacy": 9,\n+    "legacy": 3,\n', '-    "legacy": 1,\n+    "legacy": 2,\n'), "loosening");
  // A structural line re-indented or an array re-flowed moves no token; reordering an array's entries moves some.
  assert.equal(classify('   "nested": {\n-    "judgeMinPaired": 200\n-  },\n+      "judgeMinPaired": 250\n+    },\n'), "tightening");
  const exempt = (from: string, to: string) => `-  "exempt": ${from},\n+  "exempt": ${to},\n-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 250,\n`;
  assert.equal(classify(exempt('["a.ts", "b.ts"]', '[\n+    "a.ts",\n+    "b.ts"\n+  ]')), "tightening");
  assert.equal(classify(exempt('["a.ts", "b.ts"]', '["b.ts", "a.ts"]')), "undetermined");
  // A key moved whole, whatever its value, is a reordering, in its hunk or another, even one that starts inside an
  // object; a moved container whose contents changed is not.
  const moved = (exempt: string) => `-  "path": "src/a.ts",\n-  "exempt": ["a.ts"],\n   "judgeMinPaired": 200,\n-  "judgeMinAgreeShare": 0.98\n` +
    `+  "judgeMinAgreeShare": 0.99,\n+  "exempt": ${exempt},\n+  "path": "src/a.ts"\n`;
  assert.equal(classify(moved('["a.ts"]')), "tightening");
  assert.equal(classify(moved('[\n+    "a.ts"\n+  ]')), "tightening");
  assert.equal(classify(moved('["a.ts", "b.ts"]')), "undetermined");
  assert.equal(classify('-  "exempt": ["a.ts"],\n-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 250,\n', '   }\n+  , "exempt": ["a.ts"]\n'), "tightening");
  assert.equal(classify('-  "judgeMinPaired": 200,\n', '   }\n+  , "judgeMinPaired": 250\n'), "tightening");
  assert.equal(classify('-  "judgeMinPaired": 200,\n', '   }\n+  , "judgeMinPaired": 150\n'), "loosening");
  // Past INSTRUMENT_ALIGN_CELLS a change block's tokens stay unaligned, read line by line: re-indented array entries
  // beside the same two raises read `tightening` in a block under the budget and `undetermined` in one over it, where
  // only a whole keyed pair can still be found moved and the entries' own brackets cannot.
  const block = (entries: number) => {
    const rows = (indent: string, raise: number) => Array.from({ length: entries }, (_, i) =>
      `${indent}{ "k${i}": ${i === 0 || i === entries - 1 ? i + raise : i} }${i === entries - 1 ? "" : ","}`).join("\n");
    return `   "list": [\n${rows("-    ", 0)}\n${rows("+      ", 1)}\n   ]\n`;
  };
  assert.ok((6 * 50) ** 2 < INSTRUMENT_ALIGN_CELLS && (6 * 1000 - 4) ** 2 > INSTRUMENT_ALIGN_CELLS, "positive control: the two blocks straddle it");
  assert.equal(classify(block(50)), "tightening");
  assert.equal(classify(block(1000)), "undetermined");
  // Tokens no pair holds: an array element, a bare string, a colon with no key, a stray literal, a non-JSON run.
  for (const line of ["+  200,", '+  "orphan",', "+  : 200,", "+  true,", '+  "judgeMinPaired" 200,', '+  "judgeMinPaired": : 200,',
    "+  200 // was 100", '+  "judgeMinPaired": 2_00,', '+  "a" { },', '+  "a" true,', '+  "a": "\\q",']) {
    assert.equal(classify(`-  "judgeMinPaired": 100,\n${line}\n`), "undetermined", line);
  }
  // An added structural line holds no pair, as before: a bracket the old side did not have refuses.
  assert.equal(classify('-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 250,\n+  },\n'), "undetermined");
  assert.equal(classify('-  "judgeMinPaired": 200,\n+  "judgeMinPaired": 250\n+  }\n'), "undetermined");
  assert.equal(classify('-  "judgeMinPaired": 200, "judgeMinAgreeShare": 0.98\n+  "judgeMinPaired": 250, "judgeMinAgreeShare": 0.99\n'), "tightening");
});

test("a source-only tree still loads the judge shadow pool and the canary guard, and names the missing bar file on first use", (t) => {
  // child-entry-argv.ts names this consumer shape: src/ without scripts/, as
  // test/a-machine-lane-never-opens-a-plan-pr-that-is-already-red.test.ts builds it. About a hundred src modules reach
  // judge-shadow.ts or experiment-promotion.ts through their imports, so those two read their bars through getters,
  // never at import.
  const { pool, canary } = printedIn(treeWith(t), `
    const shadow = await load('src/lib/judge-shadow.ts');
    const promotion = await load('src/lib/experiment-promotion.ts');
    const firstUse = (read) => { try { return String(read()); } catch (error) { return error.message; } };
    console.log(JSON.stringify({
      pool: firstUse(() => shadow.JUDGE_SHADOW_POOL_BAR.maxRejectedShare),
      canary: firstUse(() => promotion.CANARY_GUARD_BAR.maxCostRatio),
    }));
  `);
  for (const message of [pool, canary]) assert.match(String(message), /promotion-bars: cannot read scripts\/promotion-ceilings-baseline\.json under /);
});
