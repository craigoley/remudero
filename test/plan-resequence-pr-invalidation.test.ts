/**
 * test/plan-resequence-pr-invalidation.test.ts — W1-T3585.
 *
 * Replay of #5545/W1-T3558 (2026-09-14): a worker was admitted while W1-T3558 was runnable, opened
 * draft PR #5545 at 14:22Z, and the plan resequence (#5537, merged 14:15:55Z) had already added an
 * unmet W1-T3570 dependency to W1-T3558's own record before the PR existed. At reconciliation the
 * sweep saw only the ordinary dirty-merge-state/conflict stand-down — it had no current-plan
 * eligibility predicate for an already-open, task-owned PR whose task current dispatch will never
 * rebuild. This is the regression lock for the current-plan invalidation guard that closes it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildOpenPrViews } from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-14T15:00:00.000Z");
const PR_NUMBER = 5545;
const TASK_ID = "W1-T3558";
const DEP_ID = "W1-T3570";

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "the resequenced worker",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

/** The exact incident shape: W1-T3558 gained an unmet W1-T3570 dependency AFTER admission. */
function planWithUnmetDependency(): Plan {
  const dep: Task = baseTask({ id: DEP_ID, title: "the resequenced predecessor", depends_on: [] });
  const task = baseTask({ depends_on: [DEP_ID] });
  return { tasks: [task, dep], byId: new Map([[task.id, task], [dep.id, dep]]) };
}

/** The SAME task, still runnable — its dependency (if any) already merged. */
function planStillRunnable(): Plan {
  const task = baseTask({ depends_on: [] });
  return { tasks: [task], byId: new Map([[task.id, task]]) };
}

function planWithBlocked(): Plan {
  const task = baseTask({ status: "blocked", note: "paused for review" });
  return { tasks: [task], byId: new Map([[task.id, task]]) };
}

const NOTHING_MERGED = () => false;
const EVERYTHING_MERGED = () => true;

function projectedView(opts: {
  readMainPlan?: () => Plan;
  isMerged?: (task: Task) => boolean;
  ledger?: Array<Record<string, unknown>>;
  changedFiles?: string[];
} = {}): OpenPrView {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-resequence-pr-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const prUrl = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
  writeFileSync(ledgerPath, (opts.ledger ?? []).map((row) => JSON.stringify(row)).join("\n"));
  const fetch = (args: string[]): unknown => {
    const path = args.at(-1) ?? "";
    if (/state=open/.test(path)) {
      return [
        {
          number: PR_NUMBER,
          html_url: prUrl,
          head: { ref: "run-W1-T3558-1789232400000", sha: "b".repeat(40) },
          updated_at: "2026-09-14T14:59:00.000Z",
          body: `Remudero-Task: ${TASK_ID}`,
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/\/files\?/.test(path)) return (opts.changedFiles ?? ["src/lib/sweep.ts"]).map((filename) => ({ filename }));
    if (/\/pulls\/5545$/.test(path)) return { mergeable: false, mergeable_state: "dirty" };
    if (/check-runs/.test(path)) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
    if (/\/status$/.test(path)) return { statuses: [{ context: "remudero-review", state: "success" }] };
    return [];
  };
  try {
    const [view] = buildOpenPrViews("craigoley", "remudero", ledgerPath, {
      fetch,
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => [],
      readMainPlan: () => opts.readMainPlan?.() ?? planWithUnmetDependency(),
      isMerged: opts.isMerged,
    });
    assert.ok(view, "precondition: the real full-sweep producer returned the #5545-shaped PR");
    return view;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function conflictDisposition(over: Partial<OpenPrView> = {}) {
  return deriveDisposition(
    {
      prNumber: PR_NUMBER,
      prUrl: `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`,
      taskId: TASK_ID,
      reviewState: "success",
      checksState: "green",
      unmetCriteria: [],
      priorStrikes: 0,
      lastActivityAt: "2026-09-14T14:59:00.000Z",
      headSha: "b".repeat(40),
      autoMergeArmed: false,
      mergeState: "dirty",
      isPlanFiling: false,
      planFilingSource: "not-plan-only",
      ...over,
    },
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
}

test("W1-T3585 plan resequence closes the invalidated task-owned PR", () => {
  // (a) the exact #5545/W1-T3558 replay: an unmet dependency ADDED by the resequence.
  const unmet = projectedView({ readMainPlan: () => planWithUnmetDependency(), isMerged: NOTHING_MERGED });
  assert.equal(unmet.taskId, TASK_ID, "precondition: the exact trailer resolves to the invalidated task");
  assert.equal(unmet.isPlanFiling, false, "precondition: this is an implementation diff, not a plan filing");
  assert.equal(unmet.planFilingSource, "not-plan-only");
  assert.equal(unmet.mergeState, "dirty", "precondition: the incident's own conflict state is still present");
  assert.match(unmet.planResequenceIneligible ?? "", new RegExp(DEP_ID), "the unmet dependency names W1-T3570");

  const unmetResult = deriveDisposition(unmet, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(unmetResult.disposition, "stale", "the plan invalidation must win before the conflict/red row");
  assert.match(unmetResult.reason, new RegExp(`task ${TASK_ID}.*${DEP_ID}`));

  // (b) the SAME task explicitly blocked by the current plan (no retirement ruling attached).
  const blocked = projectedView({ readMainPlan: () => planWithBlocked(), isMerged: NOTHING_MERGED });
  assert.match(blocked.planResequenceIneligible ?? "", /blocked in the current plan/);
  const blockedResult = deriveDisposition(blocked, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(blockedResult.disposition, "stale");
  assert.match(blockedResult.reason, new RegExp(`task ${TASK_ID}.*blocked`));
});

test("W1-T3585 plan invalidation fails closed and preserves eligible PRs", () => {
  // An otherwise identical, genuinely still-runnable task (no unmet dependency) closes nothing.
  const runnable = projectedView({ readMainPlan: () => planStillRunnable(), isMerged: NOTHING_MERGED });
  assert.equal(runnable.planResequenceIneligible, undefined, "a still-runnable task is never closure authority");
  assert.equal(conflictDisposition(runnable).disposition, "blocked-ambiguous");

  // The SAME unmet-dependency plan, but the dependency has since merged — no longer unmet.
  const nowMerged = projectedView({ readMainPlan: () => planWithUnmetDependency(), isMerged: EVERYTHING_MERGED });
  assert.equal(nowMerged.planResequenceIneligible, undefined, "a merged dependency is no longer unmet");
  assert.equal(conflictDisposition(nowMerged).disposition, "blocked-ambiguous");

  // An unreadable current plan cannot manufacture an ineligibility verdict.
  const unreadablePlan = projectedView({
    readMainPlan: () => {
      throw new Error("plan unreadable");
    },
    isMerged: NOTHING_MERGED,
  });
  assert.equal(unreadablePlan.planResequenceIneligible, undefined, "an unreadable plan fails closed");
  assert.equal(conflictDisposition(unreadablePlan).disposition, "blocked-ambiguous");

  // An absent merged-task-set resolver fails closed even though the plan itself is readable and the
  // dependency truly is unmet — darkness on ONE input is darkness on the whole verdict.
  const noResolver = projectedView({ readMainPlan: () => planWithUnmetDependency(), isMerged: undefined });
  assert.equal(noResolver.planResequenceIneligible, undefined, "an absent merged-task-set resolver fails closed");
  assert.equal(conflictDisposition(noResolver).disposition, "blocked-ambiguous");

  // A task id that resolves to no record in the current plan (retired/removed, or simply absent).
  const missingRecord = projectedView({
    readMainPlan: () => ({ tasks: [], byId: new Map() }),
    isMerged: NOTHING_MERGED,
  });
  assert.equal(missingRecord.planResequenceIneligible, undefined, "a missing task record is darkness, not evidence");
  assert.equal(conflictDisposition(missingRecord).disposition, "blocked-ambiguous");

  // No exact task identity at all (synthetic/foreign PR) — a bare string is never enough to close.
  const noTask = conflictDisposition({ taskId: undefined, planResequenceIneligible: "blocked in the current plan" });
  assert.equal(noTask.disposition, "blocked-ambiguous", "an ineligibility string without an exact task id never closes");

  // A proven plan filing (its diff is the resequence itself) must never be closed by this row.
  const githubFiling = projectedView({
    readMainPlan: () => planWithUnmetDependency(),
    isMerged: NOTHING_MERGED,
    changedFiles: ["plan/tasks.d/W1-T3585.yaml"],
  });
  assert.equal(githubFiling.isPlanFiling, true);
  assert.equal(githubFiling.planFilingSource, "github-files");
  assert.equal(conflictDisposition(githubFiling).disposition, "blocked-ambiguous", "a plan filing is never closed by this row");
});
