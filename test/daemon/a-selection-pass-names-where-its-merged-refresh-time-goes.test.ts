import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon } from "#src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { buildBatchedGithub, projectionPhaseRecorder, projectPlan, type BatchedPr, type ProjectionPhases } from "#src/lib/status.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const ids = ["W1-T11", "W1-T12", "W1-T13"] as const;
const plan = loadPlanFromYaml(ids.map((id) =>
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  files: [src/${id}.ts]\n  type: implement\n  status: queued\n`,
).join(""), "fixture");
const timingStep = "dispatch.selection_timing";
const phases: ProjectionPhases = {
  ledger_credit_reads: { ms: 4, records: 120 },
  merged_projection: { ms: 9, records: 2 },
  open_projection: { ms: 15, records: 1 },
  github_reads: { ms: 21, records: 33 },
};

async function dispatch(readRefreshMergedPhases?: () => ProjectionPhases | undefined) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const finished = new Set<string>();
  const sleepers: Array<() => void> = [];
  let stopped = false;
  await runDaemon(plan, {
    ...hostIndependentDaemonDeps(),
    sleep: () => stopped ? Promise.resolve() : new Promise<void>((resolve) => sleepers.push(resolve)),
    checkStop: () => stopped ? "fixture finished" : undefined,
    refreshMerged: () => (id) => finished.has(id),
    refreshMergedAsync: async () => (id) => finished.has(id),
    ...(readRefreshMergedPhases ? { readRefreshMergedPhases } : {}),
    log: (step, fields = {}) => {
      rows.push({ step, fields });
      if (step === "dispatch.settled_set") {
        stopped = true;
        for (const wake of sleepers.splice(0)) wake();
      }
    },
    runOne: async (id): Promise<RunResult> => {
      finished.add(id);
      return { taskId: id, runId: id, merged: true, verdict: "merged", costUsd: 0 };
    },
  }, { laneCount: 2 });
  return rows.filter(({ step }) => step === timingStep).map(({ fields }) => fields);
}

test("a selection pass's timing row names the phases of its merged refresh, each with a record count", async () => {
  const rows = await dispatch(() => phases);
  assert.ok(rows.length > 0, "the run wrote timing rows");
  assert.ok(rows.some(({ site }) => site === "lane-refill"), "a refill pass wrote a row");
  for (const row of rows) assert.deepEqual(row.refresh_merged_phases, phases);
});

test("a selection pass whose merged refresh reports no phases writes a row without them", async () => {
  for (const rows of [await dispatch(), await dispatch(() => undefined), await dispatch(() => ({})), await dispatch(() => { throw new Error("unreadable"); })]) {
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal("refresh_merged_phases" in row, false);
  }
});

test("projectPlan times the ledger and credit reads, GitHub reads, merged and open projections with record counts", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}phase-`));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, [1, 2, 3].map((n) => JSON.stringify({ ts: `2026-11-0${n}T00:00:00Z`, step: "noise", task_id: "other" })).join("\n") + "\n");
    const rows: BatchedPr[] = [
      { number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED", mergedAt: "2026-11-01T00:00:00Z", headRefName: "run-W1-T11-1790000000001", headRefOid: "a7", body: "", title: "t11" },
      { number: 8, url: "https://github.com/o/r/pull/8", state: "OPEN", headRefName: "run-W1-T12-1790000000002", headRefOid: "a8", body: "", title: "t12" },
      { number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN", headRefName: "hand-branch", headRefOid: "a9", body: "", title: "hand" },
    ];
    const github = buildBatchedGithub("o", "r", {
      ttlMs: Number.MAX_SAFE_INTEGER, pacer: { wait(): void {}, recordResult(): void {} },
      fetchAll: () => rows.map((r) => ({ ...r })), fetchAllIssues: () => [],
      exec: () => { throw new Error("the fixture reads only its rows"); },
      commitTrailerIndex: () => new Map(),
      changedFilesCache: { lookup: () => [], settle: async () => {} },
    });
    let tick = 0;
    const recorder = projectionPhaseRecorder();
    const projection = projectPlan(plan, { ledgerPath, github, skipUncreditedBuildWarning: true, observePhase: recorder.observe, phaseNow: () => ++tick });
    const read = recorder.read();
    assert.deepEqual(Object.keys(read), ["ledger_credit_reads", "merged_projection", "open_projection", "github_reads"]);
    assert.equal(read.ledger_credit_reads!.records, 3);
    assert.equal(read.github_reads!.records, 3);
    const mergedCount = [...projection.values()].filter((p) => p.merged).length;
    assert.equal(read.merged_projection!.records, mergedCount);
    assert.equal(read.open_projection!.records, plan.tasks.length - mergedCount);
    for (const phase of Object.values(read)) assert.ok(phase.ms > 0, "each phase read the clock between its start and its end");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the phase recorder adds wall time across passes and keeps the latest pass's record count", () => {
  const recorder = projectionPhaseRecorder();
  recorder.observe("github_reads", 5, 10);
  recorder.observe("github_reads", 7, 12);
  assert.deepEqual(recorder.read(), { github_reads: { ms: 12, records: 12 } });
});
