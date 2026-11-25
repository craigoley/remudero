/**
 * W1-T14644 — each dispatch selection pass's timing row splits the refreshMerged probe into its phases: the ledger
 * and credit reads, the projection of records already credited merged, the projection of open records, and the
 * GitHub reads, each with the number of records it handled.
 *
 * INVARIANT measuring-changes-no-decision: the merged set, every projection and every dispatch choice are identical
 * with and without the phase timing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon } from "#src/lib/daemon.js";
import { loadPlanFromYaml, type Plan, type Task } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { projectPlan, type GitHub, type PrRef, type ProjectPlanPhases, type StatusProjection } from "#src/lib/status.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const timingStep = "dispatch.selection_timing";
const phaseNames = ["ledger_credit_reads", "credited_merged", "open", "github_reads"] as const;

// ── projectPlan: the phases themselves ────────────────────────────────────────────────────────────

const task = (id: string): Task =>
  ({ id, title: id, repo: "remudero", type: "implement", depends_on: [], status: "queued" }) as unknown as Task;
const planOf = (ids: string[]): Plan => ({ tasks: ids.map(task) }) as unknown as Plan;
const pr = (number: number, taskId: string, state: "MERGED" | "OPEN"): PrRef => ({
  number, url: `https://github.com/craigoley/remudero/pull/${number}`, state, title: `build ${taskId}`,
  headRefName: `run-${taskId}-1795300000000`, body: "",
}) as PrRef;
const ledgerFile = (rows: number): string => {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-t14644-")), "ledger.ndjson");
  writeFileSync(path, Array.from({ length: rows }, (_, i) => JSON.stringify({ ts: "2026-11-25T00:00:00.000Z", task_id: `W1-T9${i}`, step: "noise" })).join("\n") + "\n");
  return path;
};
// Pull requests that belong to no plan task, so they are read and counted but decide nothing.
const gateway = (): GitHub => ({
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
  listMergedHeadBranches: () => [pr(901, "W1-T98", "MERGED"), pr(902, "W1-T97", "MERGED")],
  listOpenHeadBranches: () => [pr(903, "W1-T99", "OPEN")],
}) as unknown as GitHub;
const creditedProjection = { taskId: "W1-T11", merged: true, prState: "MERGED" } as unknown as StatusProjection;
const reuseCredited = (t: Task) => (t.id === "W1-T11" ? creditedProjection : undefined);

test("W1-T14644 criterion 1: a projection names its ledger and credit reads, credited, open and GitHub phases, each with its records", () => {
  let now = 0;
  let phases: ProjectPlanPhases | undefined;
  projectPlan(planOf(["W1-T11", "W1-T12", "W1-T13"]), {
    ledgerPath: ledgerFile(4), github: gateway(), reuseProjection: reuseCredited,
    // Every reading moves the clock by 10, so each phase's ms counts the readings that bracket it.
    phaseClock: () => (now += 10), observePhases: (seen) => { phases = seen; },
  });
  assert.ok(phases, "the pass reported its phases");
  assert.deepEqual(phases, {
    ledger_credit_reads: { ms: 10, records: 4 },
    credited_merged: { ms: 0, records: 1 },
    open: { ms: 20, records: 2 },
    github_reads: { ms: 20, records: 3 },
  });
});

test("W1-T14644 criterion 2: no observer, no clock reading; the projections are identical either way", () => {
  const ids = ["W1-T11", "W1-T12", "W1-T13"];
  const ledgerPath = ledgerFile(4);
  let readings = 0;
  const now = () => 1_795_300_000_000;
  const unobserved = projectPlan(planOf(ids), { ledgerPath, github: gateway(), now, phaseClock: () => { readings++; return 0; } });
  assert.equal(readings, 0, "a pass that nobody observes clocks nothing");
  let phases: ProjectPlanPhases | undefined;
  const observed = projectPlan(planOf(ids), { ledgerPath, github: gateway(), now, observePhases: (seen) => { phases = seen; } });
  assert.ok(phases);
  assert.deepEqual([...observed.entries()], [...unobserved.entries()]);
  for (const name of phaseNames) assert.ok(phases![name].ms >= 0 && Number.isFinite(phases![name].ms), name);
  assert.equal(phases!.credited_merged.records + phases!.open.records, ids.length, "every task falls in exactly one projection phase");
});

// ── the selection-timing row ──────────────────────────────────────────────────────────────────────

const ids = ["W1-T11", "W1-T12", "W1-T13"] as const;
const [first, sibling, next] = ids;
const plan = loadPlanFromYaml(ids.map((id) =>
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  files: [src/${id}.ts]\n  type: implement\n  status: queued\n`,
).join(""), "fixture");
const merged = (id: string): RunResult => ({ taskId: id, runId: id, merged: true, verdict: "merged", costUsd: 0 });
const refreshPhases: ProjectPlanPhases = {
  ledger_credit_reads: { ms: 5, records: 40 },
  credited_merged: { ms: 11, records: 2 },
  open: { ms: 17, records: 1 },
  github_reads: { ms: 23, records: 9 },
};

async function dispatch(phases: ProjectPlanPhases | undefined, selectionTiming?: boolean) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const started: string[] = [];
  const finished = new Set<string>();
  let finishSibling!: (result: RunResult) => void;
  const siblingResult = new Promise<RunResult>((resolve) => { finishSibling = resolve; });
  const sleepers: Array<() => void> = [];
  let ms = Date.parse("2026-11-25T12:00:00Z");
  let stopped = false;
  let pending: ProjectPlanPhases | undefined;
  const isMerged = (id: string) => finished.has(id);
  const summary = await runDaemon(plan, {
    ...hostIndependentDaemonDeps(),
    now: () => new Date(ms),
    selectionTimingNow: () => ms,
    sleep: () => stopped ? Promise.resolve() : new Promise<void>((resolve) => sleepers.push(resolve)),
    checkStop: () => stopped ? "fixture finished" : undefined,
    refreshMerged: () => isMerged,
    // The refresh reports its phases the way the daemon's refresher does: held once, taken once.
    refreshMergedAsync: async () => { await Promise.resolve(); ms += 47; pending = phases; return isMerged; },
    takeRefreshMergedPhases: () => { const taken = pending; pending = undefined; return taken; },
    reloadPlan: async () => null,
    log: (step, fields = {}) => {
      rows.push({ step, fields });
      if (step === "dispatch.lane_refill_held") setImmediate(() => finishSibling(merged(sibling)));
      if (step === "dispatch.settled_set") {
        stopped = true;
        for (const wake of sleepers.splice(0)) wake();
      }
    },
    runOne: async (id) => {
      started.push(id);
      // The sibling lane is released once the picks behind it have run, so the tick always settles.
      if (id === next) setImmediate(() => finishSibling(merged(sibling)));
      const outcome = id === sibling ? await siblingResult : merged(id);
      finished.add(id);
      return outcome;
    },
  }, { laneCount: 2, selectionTiming });
  return { rows, started, stopReason: summary.stopReason };
}

test("W1-T14644 criterion 1: a refill's timing row splits the refreshMerged probe into its four phases", async () => {
  const { rows } = await dispatch(refreshPhases);
  const timings = rows.filter(({ step }) => step === timingStep).map(({ fields }) => fields);
  const refills = timings.filter(({ site, probe_ms }) => site === "lane-refill" && "refreshMerged" in (probe_ms as object));
  assert.ok(refills.length > 0, "a lane refilled through the refreshMerged probe");
  for (const row of refills) {
    assert.deepEqual(row.refresh_merged_phases, refreshPhases);
    assert.equal((row.probe_ms as Record<string, number>).refreshMerged, 47, "the probe's own total is unchanged");
  }
  assert.ok(timings.filter(({ site }) => site === "tick").every((row) => !("refresh_merged_phases" in row)),
    "a pass that ran no refreshMerged probe names no phases");
});

test("W1-T14644 criterion 1: a refresh that measured nothing adds no phases to the row", async () => {
  const { rows } = await dispatch(undefined);
  const timings = rows.filter(({ step }) => step === timingStep).map(({ fields }) => fields);
  assert.ok(timings.some(({ site, probe_ms }) => site === "lane-refill" && "refreshMerged" in (probe_ms as object)));
  assert.ok(timings.every((row) => !("refresh_merged_phases" in row)));
});

test("W1-T14644 invariant measuring-changes-no-decision: the same picks, holds and merged set with and without the phases", async () => {
  const withoutTiming = await dispatch(refreshPhases, false);
  assert.deepEqual(withoutTiming.started, [first, sibling, next]);
  assert.equal(withoutTiming.rows.filter(({ step }) => step === timingStep).length, 0);
  const unmeasured = await dispatch(undefined, true);
  const measured = await dispatch(refreshPhases, true);
  const decisions = (run: typeof measured) => ({ ...run, rows: run.rows.filter(({ step }) => step !== timingStep) });
  assert.deepEqual(decisions(measured), decisions(withoutTiming));
  assert.deepEqual(decisions(unmeasured), decisions(withoutTiming));
});
