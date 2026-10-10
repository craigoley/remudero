// W1-T4565: the sweep closed PRs for an "unmet dependency" that had merged minutes earlier. The
// resequence close (W1-T3585) read only the daemon's per-tick projection, which lagged a real merge
// by 13-28 minutes and whose `indeterminate` flag it ignored. MEASURED in the core daemon's ledger:
// W1-T4567 merged as #7320 at 20:28:54Z, the sweep ITSELF wrote verdict.merged for it at 20:38:57
// (credit backfill), then closed #7333 at 20:42:26 for that dependency. #7023/#7025 died the same
// way on 2026-09-24 and were never rebuilt.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";
import { corroboratedIneligibilityReason, DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";
import { buildOpenPrViews, resequenceMergedResolver } from "../src/run-task.js";

const NOW = Date.parse("2026-09-26T20:42:26.000Z");
const PR_NUMBER = 7333;
const TASK_ID = "W1-T4576";
const DEP_ID = "W1-T4567";
const OTHER_DEP = "W1-T4568";

function task(over: Partial<Task> = {}): Task {
  return { id: TASK_ID, title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, ...over };
}

function planOf(...tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** The #7333 shape: the task depends on DEP_ID, which the projection has not caught up with. */
function planWithDependency(): Plan {
  return planOf(task({ depends_on: [DEP_ID] }), task({ id: DEP_ID }));
}

const NOTHING_MERGED = (): boolean => false;
const MERGE_CREDIT = { ts: "2026-09-26T20:38:57.688Z", step: "verdict.merged", verdict: "merged", task_id: DEP_ID, pr_number: 7320, source: "sweep.credit_backfill" };

/** The real full-sweep producer over one open, task-owned PR, with the ledger the test supplies. */
function view(plan: Plan, ledger: Array<Record<string, unknown>>): OpenPrView {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4565-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, ledger.map((row) => JSON.stringify(row)).join("\n"));
  const prUrl = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
  const fetch = (args: string[]): unknown => {
    const path = args.at(-1) ?? "";
    if (/state=open/.test(path)) {
      return [
        {
          number: PR_NUMBER,
          html_url: prUrl,
          head: { ref: "run-W1-T4576-1790454708597", sha: "b".repeat(40) },
          updated_at: "2026-09-26T20:40:00.000Z", // expiring-fixture: exempt -- deriveDisposition takes this suite's injected NOW, never the wall clock; 3/3 pass with Date.now shifted +8d and +30d
          body: `Remudero-Task: ${TASK_ID}`,
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/\/files\?/.test(path)) return [{ filename: "src/lib/serve.ts" }];
    if (/\/pulls\/7333$/.test(path)) return { mergeable: true, mergeable_state: "blocked" };
    if (/check-runs/.test(path)) return { check_runs: [{ name: "ci-gate", status: "in_progress", conclusion: null }] };
    if (/\/status$/.test(path)) return { statuses: [] };
    return [];
  };
  try {
    const [v] = buildOpenPrViews("craigoley", "remudero", ledgerPath, {
      fetch,
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => [],
      readMainPlan: () => plan,
      isMerged: NOTHING_MERGED,
    });
    assert.ok(v, "precondition: the producer returned the #7333-shaped PR");
    return v;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T4565: a dependency the ledger credits as merged is met, so the lagging projection cannot close the PR", () => {
  const replay = view(planWithDependency(), [MERGE_CREDIT]);
  assert.equal(replay.planResequenceIneligible, undefined, "ledger merge credit corroborates the dependency as met");
  assert.notEqual(deriveDisposition(replay, DEFAULT_SWEEP_POLICY, NOW).disposition, "stale", "the #7333 close does not happen");

  // The control: no credit anywhere, so the dependency really is unmet and the close keeps its authority.
  const uncredited = view(planWithDependency(), []);
  assert.match(uncredited.planResequenceIneligible ?? "", new RegExp(DEP_ID));
  assert.equal(deriveDisposition(uncredited, DEFAULT_SWEEP_POLICY, NOW).disposition, "stale");
});

test("W1-T4565: corroboration removes only the credited dependencies and never touches a blocked task", () => {
  const plan = planOf(task({ depends_on: [DEP_ID, OTHER_DEP] }), task({ id: DEP_ID }), task({ id: OTHER_DEP }));
  const asked: string[][] = [];
  const credited = (ids: readonly string[]): ReadonlySet<string> => {
    asked.push([...ids]);
    return new Set([DEP_ID]);
  };
  const reason = corroboratedIneligibilityReason(plan, plan.byId.get(TASK_ID)!, NOTHING_MERGED, credited);
  assert.match(reason ?? "", new RegExp(OTHER_DEP), "the still-uncredited dependency keeps the reason");
  assert.doesNotMatch(reason ?? "", new RegExp(DEP_ID), "the credited dependency is no longer named");
  assert.deepEqual(asked, [[DEP_ID, OTHER_DEP]], "the ledger is asked about exactly the unmet ids, once");

  const blocked = planOf(task({ status: "blocked", note: "paused" }));
  assert.match(corroboratedIneligibilityReason(blocked, blocked.byId.get(TASK_ID)!, NOTHING_MERGED, () => new Set([TASK_ID])) ?? "", /blocked in the current plan/);

  let calls = 0;
  const runnable = planOf(task());
  assert.equal(corroboratedIneligibilityReason(runnable, runnable.byId.get(TASK_ID)!, NOTHING_MERGED, () => (calls++, new Set())), undefined);
  assert.equal(calls, 0, "no close proposed, so no ledger walk");
});

test("W1-T4565: the close's resolver reads an indeterminate credit as met — indeterminate is DO NOT ACT", () => {
  const projection = new Map<string, StatusProjection>([
    ["A", { taskId: "A", merged: true } as StatusProjection],
    ["B", { taskId: "B", merged: false, indeterminate: true } as StatusProjection],
    ["C", { taskId: "C", merged: false } as StatusProjection],
  ]);
  const isMerged = resequenceMergedResolver(() => projection);
  const ask = (id: string) => isMerged(task({ id }));
  assert.equal(ask("A"), true);
  assert.equal(ask("B"), true, "a failed credit read grants no authority to close");
  assert.equal(ask("C"), false, "a determinate unmerged dependency still counts as unmet");
  assert.equal(ask("D"), false, "a task absent from the projection is not invented as merged");
  assert.equal(resequenceMergedResolver(() => undefined)(task({ id: "A" })), false, "no projection yet reads unmerged, as before");
});
