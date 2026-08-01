import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { projectPlan, type GitHub, type PrRef } from "../src/lib/status.js";

/**
 * W1-T283: NEEDS ME's render set was `for (const task of plan.tasks) ...` alone (status.ts's
 * `projectPlan`) — an escalation whose ledger `task_id` names no plan task (a triage/mount-probe
 * id minted outside the plan) had no row to attach to and could never render, however long it
 * stayed open. These tests drive `projectPlan` itself — the SAME projection every real consumer
 * (board.ts's GET /v1/status, run-task.ts's CLI counts, panel-graph.ts) already reaches through —
 * never a helper nothing calls.
 */

/** A minimal task; fields not under test get sensible defaults. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T1",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

/** A fake GitHub gateway that only needs to answer `issueByUrl` for these tests. */
function fakeGithub(issuesByUrl: Record<string, { state: string; title?: string } | null>): GitHub {
  return {
    readFailed: () => false,
    issueReadFailed: () => false,
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [],
    headRefName: () => undefined,
    prBody: () => undefined,
    autoMergeArmed: () => false,
    issueByUrl: (url: string) => issuesByUrl[url] ?? null,
  } as GitHub;
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-needs-me-taskless-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

test("W1-T283: an escalation whose task id is not a plan task renders as a NEEDS ME row", () => {
  const issueUrl = "https://github.com/o/r/issues/501";
  const plan = planOf([task({ id: "W1-T1" })]);
  const github = fakeGithub({ [issueUrl]: { state: "OPEN", title: "[MOUNTPROBE] T-MOUNTPROBE: stuck" } });
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "T-MOUNTPROBE", step: "escalation.issue_opened", issue_url: issueUrl, class: "MOUNTPROBE" },
  ]);

  const byId = projectPlan(plan, { ledgerPath, github });

  assert.equal(byId.get("T-MOUNTPROBE")?.needsHuman, true, "the task-less escalation gets its own row");
  assert.equal(byId.get("T-MOUNTPROBE")?.escalationIssueUrl, issueUrl);
  assert.equal(byId.get("T-MOUNTPROBE")?.escalationTitle, "[MOUNTPROBE] T-MOUNTPROBE: stuck");
  assert.equal(byId.get("T-MOUNTPROBE")?.merged, false);
  // The real plan task's own row is untouched by the second source.
  assert.equal(byId.get("W1-T1")?.needsHuman, undefined);
});

test("W1-T283: an escalation belonging to a plan task still renders exactly once", () => {
  const issueUrl = "https://github.com/o/r/issues/502";
  const plan = planOf([task({ id: "W1-T1" })]);
  const github = fakeGithub({ [issueUrl]: { state: "OPEN", title: "[BLOCKED] W1-T1: stuck" } });
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-T1", step: "run.start" },
    { run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" },
  ]);

  const byId = projectPlan(plan, { ledgerPath, github });

  assert.equal(byId.size, 1, "no extra task-less row is minted for an escalation the plan already owns");
  assert.equal(byId.get("W1-T1")?.needsHuman, true);
  assert.equal(byId.get("W1-T1")?.escalationIssueUrl, issueUrl);
});

test("W1-T283: a closed escalation is absent from the rows whether or not it owns a plan task", () => {
  const ownedUrl = "https://github.com/o/r/issues/503";
  const tasklessUrl = "https://github.com/o/r/issues/504";
  const plan = planOf([task({ id: "W1-T1" })]);
  const github = fakeGithub({
    [ownedUrl]: { state: "CLOSED", title: "[BLOCKED] W1-T1: stuck" },
    [tasklessUrl]: { state: "CLOSED", title: "[MOUNTPROBE] T-MOUNTPROBE: stuck" },
  });
  const ledgerPath = ledgerFile([
    { run_id: "r1", task_id: "W1-T1", step: "run.start" },
    { run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", issue_url: ownedUrl, class: "BLOCKED" },
    { run_id: "r1", task_id: "T-MOUNTPROBE", step: "escalation.issue_opened", issue_url: tasklessUrl, class: "MOUNTPROBE" },
  ]);

  const byId = projectPlan(plan, { ledgerPath, github });

  assert.equal(byId.get("W1-T1")?.needsHuman, undefined, "a confirmed-closed owned escalation clears the row");
  assert.equal(byId.has("T-MOUNTPROBE"), false, "a confirmed-closed task-less escalation never gets a row at all");
});
