/**
 * test/retired-task-open-pr-disposition.test.ts — W1-T3445.
 *
 * Replay of #5202: W1-T3331 was explicitly retired in the current plan after W1-T3422 merged,
 * but its old, green, merge-conflicted implementation PR reached `blocked-ambiguous` forever.
 * The only new close authority below is the parsed current-plan retirement record plus a complete
 * observed non-plan-only diff classification. Every missing or unreadable input keeps the old
 * conflict path.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildOpenPrViews } from "../src/run-task.js";
import { RETIREMENT_REASONS, type Plan, type RetirementReason, type Task } from "../src/lib/plan.js";
import { auditProducerCompleteness } from "../src/lib/producer-completeness.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-12T17:00:00.000Z");
const PR_NUMBER = 5202;
const TASK_ID = "W1-T3331";
const REPO = fileURLToPath(new URL("..", import.meta.url));

function planWith(retirement: RetirementReason | undefined): Plan {
  const task: Task = {
    id: TASK_ID,
    title: "the retired predecessor",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "blocked",
    attempts: 0,
    ...(retirement === undefined ? {} : { retirement }),
  };
  return { tasks: [task], byId: new Map([[task.id, task]]) };
}

function projectedView(opts: {
  readMainPlan?: () => Plan;
  ledger?: Array<Record<string, unknown>>;
  changedFiles?: string[];
} = {}): OpenPrView {
  const dir = mkdtempSync(join(tmpdir(), "rmd-retired-task-pr-"));
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
          head: { ref: "run-W1-T3331-1789232400000", sha: "a".repeat(40) },
          updated_at: "2026-09-12T16:59:00.000Z",
          body: `Remudero-Task: ${TASK_ID}`,
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/\/files\?/.test(path)) return (opts.changedFiles ?? ["src/lib/sweep.ts"]).map((filename) => ({ filename }));
    if (/\/pulls\/5202$/.test(path)) return { mergeable: false, mergeable_state: "dirty" };
    if (/check-runs/.test(path)) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
    if (/\/status$/.test(path)) return { statuses: [{ context: "remudero-review", state: "success" }] };
    return [];
  };
  try {
    const [view] = buildOpenPrViews("craigoley", "remudero", ledgerPath, {
      fetch,
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => [],
      readMainPlan: () => opts.readMainPlan?.() ?? planWith("retired"),
    });
    assert.ok(view, "precondition: the real full-sweep producer returned the #5202-shaped PR");
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
      lastActivityAt: "2026-09-12T16:59:00.000Z",
      headSha: "a".repeat(40),
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

test("W1-T3445 criterion 1: every legal current-plan retirement closes the green conflicted implementation PR before conflict handling", () => {
  for (const retirement of RETIREMENT_REASONS) {
    const view = projectedView({ readMainPlan: () => planWith(retirement) });
    assert.equal(view.taskId, TASK_ID, "precondition: the exact trailer resolves to the retired task");
    assert.equal(view.taskRetirement, retirement, "the full-sweep producer carries the parsed retirement ruling");
    assert.equal(view.isPlanFiling, false, "precondition: this is an implementation diff");
    assert.equal(view.planFilingSource, "not-plan-only", "the negative diff classification is complete and observed");
    assert.equal(view.mergeState, "dirty", "precondition: the incident's conflict state is still present");

    const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(result.disposition, "stale", `${retirement} must win before the conflict row`);
    assert.match(result.reason, new RegExp(`task ${TASK_ID}.*${retirement}`));
    assert.doesNotMatch(result.reason, /merged by/i, "retirement is terminal queue evidence, never a merge credit");
  }
});

test("W1-T3445 criterion 2: missing or unreadable retirement evidence and proven plan filings keep the existing conflict disposition", () => {
  const readableRetirement = projectedView({ readMainPlan: () => planWith("retired") });
  assert.equal(
    readableRetirement.taskRetirement,
    "retired",
    "precondition: the same full-sweep projection distinguishes a readable operator ruling from every fail-closed absence below",
  );

  const unreadablePlan = projectedView({
    readMainPlan: () => {
      throw new Error("plan unreadable");
    },
  });
  assert.equal(unreadablePlan.taskRetirement, undefined, "an unreadable current plan cannot manufacture a retirement ruling");
  assert.equal(conflictDisposition(unreadablePlan).disposition, "blocked-ambiguous");

  const noRetirement = projectedView({ readMainPlan: () => planWith(undefined) });
  assert.equal(noRetirement.taskRetirement, undefined);
  assert.equal(conflictDisposition(noRetirement).disposition, "blocked-ambiguous");

  const noTask = conflictDisposition({ taskId: undefined, taskRetirement: "retired" });
  assert.equal(noTask.disposition, "blocked-ambiguous", "a retirement string without an exact task is never enough to close");

  const emitterFiling = projectedView({
    ledger: [{ step: "pr.opened", pr_url: `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`, plan_only: true }],
  });
  assert.equal(emitterFiling.isPlanFiling, true);
  assert.equal(emitterFiling.planFilingSource, "emitter-ledger");
  assert.equal(conflictDisposition(emitterFiling).disposition, "blocked-ambiguous");

  const githubFiling = projectedView({ changedFiles: ["plan/tasks.d/W1-T3445.yaml"] });
  assert.equal(githubFiling.isPlanFiling, true);
  assert.equal(githubFiling.planFilingSource, "github-files");
  assert.equal(conflictDisposition(githubFiling).disposition, "blocked-ambiguous");

  assert.equal(
    conflictDisposition({ taskRetirement: "retired", planFilingSource: "unreadable" }).disposition,
    "blocked-ambiguous",
    "a failed file read is darkness, not evidence that a retirement may close the PR",
  );
});

test("W1-T3445 criterion 3: both OpenPrView producers declare taskRetirement and the producer-completeness audit stays green", () => {
  const fullSweepView = projectedView();
  assert.equal(fullSweepView.taskRetirement, "retired", "the production full-sweep builder carries the current-plan field");

  const audit = auditProducerCompleteness({
    srcRoot: join(REPO, "src"),
    interfaceFile: join(REPO, "src", "lib", "sweep.ts"),
    interfaceName: "OpenPrView",
  });
  assert.equal(audit.producers.length, 2, "the full-sweep and single-PR view builders are both audited");
  assert.equal(audit.unwired.some((field) => field.name === "taskRetirement"), false);
  assert.deepEqual(audit.unresolvableSpreads, []);
});
