import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlanReconcileCadenceInput, planReconcileCadence, type CreditedMergedIds } from "#src/lib/measurement-cadence.js";
import { PLAN_REVIEW_RECORDS_PER_PULL_REQUEST } from "#src/lib/feedback-landing.js";
import {
  PLAN_RECONCILE_LANDING_BODY_BUDGET,
  PLAN_RECONCILE_LANDING_FILE_LIMIT,
  PLAN_RECONCILE_LANDING_RECORD_LIMIT,
  planReconcileProofTemplate,
  planReconcilePrBody,
  takePlanReconcileBatch,
} from "#src/lib/plan-reconcile-batch.js";
import type { RevertedRequeue } from "#src/lib/plan-reconcile.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: criterion 2's subject is feedback-landing.ts's DEFINITION of its bound. Two
// literals that agree today are the same number at runtime, so only the definition text can tell
// "one constant" from "a separate literal" (the falsifier). Criteria 1 and 3 assert on behaviour only.

const ROOT = "/fixture";
const pathOf = (taskId: string): string => `plan/tasks.d/${taskId}.yaml`;
const merged = (taskId: string): string => `- id: ${taskId}\n  title: ${taskId} fixture\n  status: merged\n  attempts: 0\n`;
const reverted = (taskId: string): RevertedRequeue =>
  ({ taskId, merged: false, revertedCredit: { pr: 101, revertSha: "a".repeat(40), revertPr: 102 } });

test("W1-T14485 criterion 1: the cadence hands the lander at most the plan review bound and logs a re-queue row only for those", () => {
  // 200 merged shards whose credit a revert took back: every one is a re-queue, so every one would log a row.
  const ids = Array.from({ length: 200 }, (_, i) => `W1-T${i + 1}`);
  const lost: CreditedMergedIds = Object.assign(new Set<string>(), { requeue: ids.map(reverted) });
  const handed: string[][] = [];
  const rows: Array<{ step: string; task: unknown; file: unknown }> = [];
  const opts = buildPlanReconcileCadenceInput({
    checkoutRoot: ROOT,
    readShards: () => ids.map((taskId) => ({ taskId, path: join(ROOT, pathOf(taskId)), text: merged(taskId) })),
    creditedMergedIds: () => lost,
    lint: () => new Map(),
    log: (step, fields = {}) => rows.push({ step, task: fields.task, file: fields.file }),
    land: (inputs) => { handed.push(inputs.map((input) => input.relPath)); },
  });
  assert.equal(opts.requeue?.length, ids.length, "positive control: the fixture derives a re-queue for every shard");

  const report = planReconcileCadence(opts);
  assert.equal(report.status, "landed");
  assert.equal(handed.length, 1, "one landing per fire");
  assert.equal(handed[0]!.length, PLAN_REVIEW_RECORDS_PER_PULL_REQUEST, "the batch is cut at the plan review's record bound");
  assert.equal(handed[0]!.length, PLAN_RECONCILE_LANDING_RECORD_LIMIT);
  assert.deepEqual(handed[0], ids.slice(0, PLAN_RECONCILE_LANDING_RECORD_LIMIT).map(pathOf), "lowest task number first");
  assert.equal(rows.length, handed[0]!.length, "a re-queue row for each landed record and none for a record left out");
  assert.ok(rows.every((row) => row.step === "plan.reconcile.reverted_requeue"));
  assert.deepEqual(rows.map((row) => row.file), handed[0], "each row names a record that went into the landing");

  // The landed count the cadence reports names the same records.
  const again: string[][] = [];
  const direct = buildPlanReconcileCadenceInput({
    checkoutRoot: ROOT,
    readShards: () => ids.map((taskId) => ({ taskId, path: join(ROOT, pathOf(taskId)), text: merged(taskId) })),
    creditedMergedIds: () => lost,
    lint: () => new Map(),
    land: (inputs) => { again.push(inputs.map((input) => input.relPath)); },
  });
  const outcome = direct.land!(direct.requeue!);
  assert.ok(outcome);
  assert.equal(outcome.landed, again[0]!.length);
  assert.equal(outcome.landed, PLAN_RECONCILE_LANDING_RECORD_LIMIT);
});

test("W1-T14485 criterion 2: the lander's bound is the batch module's record limit, one constant", () => {
  assert.equal(PLAN_RECONCILE_LANDING_RECORD_LIMIT, 50);
  assert.equal(PLAN_REVIEW_RECORDS_PER_PULL_REQUEST, PLAN_RECONCILE_LANDING_RECORD_LIMIT);
  // Equal values cannot tell one constant from two literals that agree today; the definition can.
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "feedback-landing.ts"), "utf8");
  const definitions = source.split("\n").filter((line) => /\bPLAN_REVIEW_RECORDS_PER_PULL_REQUEST\s*=/.test(line));
  assert.deepEqual(definitions, ["export const PLAN_REVIEW_RECORDS_PER_PULL_REQUEST = PLAN_RECONCILE_LANDING_RECORD_LIMIT;"]);
  assert.match(source, /^import \{[^}]*\bPLAN_RECONCILE_LANDING_RECORD_LIMIT\b[^}]*\} from "\.\/plan-reconcile-batch\.js";$/m);
});

test("W1-T14485 criterion 3: takePlanReconcileBatch with no limits still cuts at the file limit (150) and the body budget", () => {
  assert.equal(PLAN_RECONCILE_LANDING_FILE_LIMIT, 150);
  const short = Array.from({ length: 200 }, (_, i) => ({ taskId: `W1-T${i + 1}`, file: pathOf(`W1-T${i + 1}`) }));
  const byCount = takePlanReconcileBatch(short, (item) => item.file);
  assert.equal(byCount.length, PLAN_RECONCILE_LANDING_FILE_LIMIT, "the default cuts at the file limit, not the record limit");
  assert.deepEqual(byCount.map((item) => item.taskId), short.slice(0, PLAN_RECONCILE_LANDING_FILE_LIMIT).map((item) => item.taskId));

  const longPath = (n: number) => `plan/tasks.d/W1-T${n}-${"x".repeat(160 - `plan/tasks.d/W1-T${n}-.yaml`.length)}.yaml`;
  const long = Array.from({ length: 400 }, (_, i) => ({ taskId: `W1-T${i + 1000}`, file: longPath(i + 1000) }));
  const byBudget = takePlanReconcileBatch(long, (item) => item.file);
  const body = planReconcilePrBody(byBudget.map((item) => item.file), planReconcileProofTemplate);
  assert.ok(body.length <= PLAN_RECONCILE_LANDING_BODY_BUDGET, `body ${body.length} within the budget`);
  assert.ok(byBudget.length > PLAN_RECONCILE_LANDING_RECORD_LIMIT && byBudget.length < PLAN_RECONCILE_LANDING_FILE_LIMIT,
    `the budget cut this batch at ${byBudget.length}`);
  const oneMore = planReconcilePrBody(long.slice(0, byBudget.length + 1).map((item) => item.file), planReconcileProofTemplate);
  assert.ok(oneMore.length > PLAN_RECONCILE_LANDING_BODY_BUDGET, "and one more record would pass it");
});
