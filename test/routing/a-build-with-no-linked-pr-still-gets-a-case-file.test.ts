/**
 * W1-T14989 — A BUILD WITH NO LINKED PR STILL GETS A CASE FILE.
 *
 * OBSERVED 2026-11-26 on the host: 675 build calls (lane run-task) had no case file, because the nightly case-file build
 * selected only tasks linked to a PR. A build that ended without opening one then read "case-file-missing" in the
 * verified outcome instead of ended-without-PR. A called task the full PR listing credits no PR to now gets a case
 * file whose PR read found none; a failed listing or an ambiguous credit is not an observed absence and selects nothing.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { joinVerifiedTaskOutcomes } from "#src/lib/benchmark-verified-outcome.js";
import { buildFieldTrialsCaseFiles, caseLedgerWindowDays, type FieldTrialsCaseFilePlan, type ListPrsPage, type ViewPr }
  from "#src/lib/field-trials-case-files.js";
import type { FlowRow } from "#src/lib/field-trials-flow.js";
import type { Task } from "#src/lib/plan.js";
import { caseFileCommand, parseCasePrSnapshot } from "#src/lib/report-commands.js";
import type { StatusProjection } from "#src/lib/status.js";
import { readTaskCaseLedgers, type TaskCaseFile } from "#src/lib/task-case-file.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const now = "2026-11-24T04:00:00.000Z";
const sha = "e".repeat(40);
const LINKED = "W1-T14001";
const UNLINKED = "W1-T14002";
const PR = 51001;
const taskOf = (id: string) => ({ id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "low", status: "queued", attempts: 0 }) as Task;

function flow(partial: Partial<FlowRow>): FlowRow {
  return { fingerprint: Math.random().toString(16), ts: null, step: "", host: null, actor: null, taskId: null, runId: null,
    assignmentId: null, requestedModel: null, selectedModel: null, servedModel: null, prRepo: null, prNumber: null,
    ...partial } as FlowRow;
}
const prRaw = (number: number) => ({ number, url: `https://github.com/craigoley/remudero/pull/${number}`, state: "MERGED",
  headRefOid: sha, headRefName: `run-${LINKED}-1`, body: `Remudero-Task: ${LINKED}`, mergedAt: "2026-11-21T00:00:00Z",
  statusCheckRollup: [] });

/** The ledger the case files read: a linked build that opened a PR and an unlinked build that failed without one. */
function buildCallRows(withUnlinked: boolean): Record<string, unknown>[] {
  const build = (taskId: string, i: number) => [
    { ts: `2026-11-20T0${i}:00:00.000Z`, step: "run.start", task_id: taskId, run_id: `${taskId}-1795000000000` },
    { ts: `2026-11-20T0${i}:00:01.000Z`, step: "worker.assignment", lane: "run-task", task_id: taskId, run_id: `${taskId}-1795000000000`,
      worker_assignment: { id: `assign-${taskId}`, selected: { provider: "claude", model: "claude-sonnet-5-5" } } },
  ];
  return [
    ...build(LINKED, 1),
    { ts: "2026-11-20T01:30:00.000Z", step: "pr.opened", task_id: LINKED, run_id: `${LINKED}-1795000000000`,
      pr_url: `https://github.com/craigoley/remudero/pull/${PR}` },
    { ts: "2026-11-20T01:40:00.000Z", step: "verdict", task_id: LINKED, run_id: `${LINKED}-1795000000000`, verdict: "awaiting_merge" },
    ...(withUnlinked ? [...build(UNLINKED, 2),
      { ts: "2026-11-20T02:40:00.000Z", step: "verdict", task_id: UNLINKED, run_id: `${UNLINKED}-1795000000000`, verdict: "failed" }] : []),
  ];
}

/** The nightly script's build (scripts/private-field-trials-case-files.mjs) over fakes: one caseFileCommand batch. */
async function nightly(t: TestContext, opts: { withUnlinked: boolean; listing?: ListPrsPage }) {
  const ledger = writeLedger(buildCallRows(opts.withUnlinked), { scope: t });
  const ids = opts.withUnlinked ? [LINKED, UNLINKED] : [LINKED];
  const rows = [
    ...ids.map((id) => flow({ step: "worker.assignment", taskId: id, runId: `${id}-1795000000000`, ts: "2026-11-20T00:00:00.000Z" })),
    flow({ step: "pr.opened", taskId: LINKED, prRepo: "craigoley/remudero", prNumber: PR, ts: "2026-11-20T01:30:00.000Z" }),
  ];
  const viewPr: ViewPr = async (number) => prRaw(number);
  return buildFieldTrialsCaseFiles({ rows, planIds: new Set(ids), carry: undefined }, opts.listing ?? (async () => []), viewPr,
    { nowIso: () => now, sleep: async () => {} },
    async (plan: FieldTrialsCaseFilePlan): Promise<TaskCaseFile[]> => {
      let printed = "";
      const code = await caseFileCommand(["--tasks", plan.selected.join(","), "--json"], {
        stateDir: ledger.dir, nowIso: () => now, resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
        readTask: (id) => (ids.includes(id) ? taskOf(id) : undefined),
        // As the script reads: back to the oldest selected call, so no called run falls outside its case file.
        readLedgers: (dir, taskIds, asOf) => readTaskCaseLedgers(dir, taskIds, asOf,
          { windowDays: caseLedgerWindowDays(asOf, plan.oldestCallTs) }),
        // As the script projects: a linked task carries its PR number; an unlinked one carries none.
        readProjection: (task) => ({ taskId: task.id, status: plan.prNumbers.has(task.id) ? "merged" : "blocked",
          merged: plan.prNumbers.has(task.id), source: plan.prNumbers.has(task.id) ? "trailer" : "none",
          prNumber: plan.prNumbers.get(task.id) }) as StatusProjection,
        readPr: (number, _owner, _repo, readAt) => parseCasePrSnapshot(prRaw(number), readAt),
        out: (line) => { printed = line; }, err: () => {},
      });
      assert.equal(code, 0);
      return JSON.parse(printed) as TaskCaseFile[];
    });
}

const assignment = (taskId: string) => ({ assignmentId: `assign-${taskId}`, taskId, runId: `${taskId}-1795000000000`,
  assignedAt: "2026-11-20T00:00:01.000Z", taskClass: "src", selectedModel: "claude-sonnet-5-5", servedModel: null,
  billingMode: null, costUsd: null, attempted: true });

test("W1-T14989 criterion 1: a build with no linked PR gets an ended-without-PR case file", async (t) => {
  const result = await nightly(t, { withUnlinked: true });
  assert.deepEqual(result.files.map((file) => file.taskId).sort(), [LINKED, UNLINKED], "both called tasks get a case file");
  assert.equal(result.summary.selectedWithoutPr, 1);
  assert.equal(result.summary.withoutPr, 1, "the unlinked task is still counted as having no PR");
  const file = result.files.find((entry) => entry.taskId === UNLINKED)!;
  assert.equal(file.pr.state, "unavailable");
  assert.equal(file.pr.state === "unavailable" && file.pr.reason, "no-pr-in-current-projection");
  const join = joinVerifiedTaskOutcomes([assignment(UNLINKED)], result.files, now);
  assert.deepEqual([join.coverage.endedWithoutCompletion, join.coverage.unavailable, join.coverage.reasons],
    [1, 0, { "ended-without-pr:failed": 1 }], "the failed build reads as ended without a PR, not unavailable");
  // A listing that failed proves no absence: the unlinked task is not selected, and the summary says why.
  const blind = await nightly(t, { withUnlinked: true, listing: async () => { throw new Error("gh: HTTP 502"); } });
  assert.deepEqual(blind.files.map((entry) => entry.taskId), [LINKED]);
  assert.equal(blind.summary.selectedWithoutPr, 0);
  assert.equal(blind.summary.unlinkedListingFailed, 1);
});

test("W1-T14989 criterion 2: a PR-linked build's case file is unchanged", async (t) => {
  const alone = (await nightly(t, { withUnlinked: false })).files;
  const beside = (await nightly(t, { withUnlinked: true })).files;
  assert.equal(alone.length, 1);
  const linked = beside.find((file) => file.taskId === LINKED);
  assert.deepEqual(linked, alone[0], "the linked build's case file is byte-for-byte the one it had alone");
  assert.equal(linked!.pr.state === "observed" && linked!.pr.value.number, PR);
});
