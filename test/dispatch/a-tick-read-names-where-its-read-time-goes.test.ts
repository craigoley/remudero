/**
 * W1-T14883 — a tick read names where its read time goes: open-PR reads, each projection, file settles, open-PR
 * views, credit and escalation reads, behind-main probes and CI-failure reads.
 *
 * INVARIANT measuring-changes-no-decision: the published facts, every projection and every dispatch choice are
 * identical with and without the stage timing.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan, loadPlanFromYaml } from "#src/lib/plan.js";
import { freshReadGeneration, type ReadGeneration } from "#src/lib/read-plane.js";
import type { RunResult } from "#src/lib/run-result.js";
import type { ProjectPlanPhases } from "#src/lib/status.js";
import { createTickReadProducer, type TickReadOptions } from "#src/lib/tick-read-worker.js";
import { createGhCallPacer } from "#src/lib/github-transport.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

// ── the tick read itself ──────────────────────────────────────────────────────────────────────────

const T0 = "2026-11-25T00:00:00Z";
const pull = (number: number, merged = false) => ({
  number, html_url: `https://github.com/o/r/pull/${number}`, state: merged ? "closed" : "open",
  merged_at: merged ? T0 : null, closed_at: merged ? T0 : null, title: `fix(read): implement ${number}`,
  body: merged ? "" : "Remudero-Task: A", head: { ref: `run-A-${number}`, sha: `sha${number}` },
  base: { ref: "main" }, created_at: T0, updated_at: T0, draft: false, labels: [],
});
/** Scripted `gh api` answers, first match wins; every other read answers `[]`. */
const ROUTES: GhShimRoute[] = [
  { when: "state=open", stdout: JSON.stringify([pull(1), pull(2)]) },
  { when: "state=closed", stdout: JSON.stringify([pull(3, true)]) },
  { when: "/check-runs", stdout: JSON.stringify({ total_count: 0, check_runs: [] }) },
  { when: "/status", stdout: JSON.stringify({ state: "pending", statuses: [] }) },
  { when: "/files", stdout: JSON.stringify([{ filename: "src/a.ts" }]) },
  { when: "/actions/runs", stdout: JSON.stringify({ workflow_runs: [] }) },
  { when: "/compare/", stdout: JSON.stringify({ ahead_by: 2, behind_by: 1, files: [] }) },
  { when: "", stdout: "[]" },
];
const answerFor = (args: string[]): unknown => {
  const joined = args.join(" ");
  const route = ROUTES.find(({ when }) => joined.includes(when))!;
  return JSON.parse(route.stdout as string);
};

/** One isolated tree: a plan, an empty ledger, a config root. */
function tree(t: { after: (fn: () => void) => void }): { options: TickReadOptions; planPath: string; root: string } {
  const root = makeTempDir("t14883-tick-read");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, [
    "- {id: A, title: a, repo: r, type: implement, files: [src/a.ts], depends_on: [], status: queued}",
    "- {id: B, title: b, repo: r, type: implement, files: [src/b.ts], depends_on: [], status: queued}",
  ].join("\n") + "\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const options = { owner: "o", repo: "r", config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root } as unknown as TickReadOptions;
  return { options, planPath, root };
}

async function withShim<T>(run: () => Promise<T>): Promise<T> {
  const gh = ghShim(ROUTES, { kind: "t14883-tick-read" });
  const saved = process.env.PATH;
  process.env.PATH = `${gh.dir}:${saved}`;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
    rmSync(gh.dir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The async GitHub reads, answered from the routes; the open-PR list read stalls for `openStallMs`. */
const scriptedIo = (openStallMs: number) => ({
  pacer: createGhCallPacer({ minGapMs: 0 }),
  fetch: (args: string[]) => answerFor(args),
  fetchAsync: async (args: string[]) => {
    if (args.join(" ").includes("state=open")) await sleep(openStallMs);
    return answerFor(args);
  },
});

const NAMED_STAGES = [
  "open_pr_reads", "projection_warm", "projection_file_settle", "projection_settled", "open_pr_views",
  "credit_warm", "credit_file_settle", "credit_settled", "escalation_reads", "behind_main_probes", "ci_failure_reads",
] as const;

test("W1-T14883 criterion 1: a tick read publishes stage timings whose sum is within 5% of its own elapsed time", async (t) => {
  const { options, planPath } = tree(t);
  const { facts, elapsedMs } = await withShim(async () => {
    const read = createTickReadProducer(options, scriptedIo(400));
    const startedAt = Date.now();
    const facts = await read({ plan: loadPlan(planPath) });
    return { facts, elapsedMs: Date.now() - startedAt };
  });
  const stages = facts.readStageMs;
  for (const name of NAMED_STAGES) {
    assert.ok(Number.isFinite(stages[name]) && stages[name]! >= 0, `stage ${name} is named with its ms`);
  }
  assert.ok(facts.openPrRows && facts.openPrRows.length === 2, "positive control: the read saw both open pull requests");
  assert.ok(stages.open_pr_reads! >= 390, `the stalled open-PR read lands in its own stage; got ${stages.open_pr_reads}`);
  const sum = Object.values(stages).reduce((total, ms) => total + ms, 0);
  assert.ok(elapsedMs >= 400,`positive control: the read took at least the stall; got ${elapsedMs}`);
  assert.ok(Math.abs(elapsedMs - sum) <= elapsedMs * 0.05, `stages sum to ${sum} ms of a ${elapsedMs} ms read`);
});

test("W1-T14883 criterion 3: the published facts and every projection are identical however long each stage took", async (t) => {
  const fast = tree(t);
  const slow = tree(t);
  const portable = (facts: unknown, root: string): unknown =>
    JSON.parse(JSON.stringify(facts).split(root).join("<root>"),
      (key, value) => (key === "ageHours" || key === "projectionPhases" || key === "readStageMs" ? undefined : value));
  const [quick, stalled] = await withShim(async () => [
    await createTickReadProducer(fast.options, scriptedIo(0))({ plan: loadPlan(fast.planPath) }),
    await createTickReadProducer(slow.options, scriptedIo(300))({ plan: loadPlan(slow.planPath) }),
  ]);
  assert.ok(stalled.readStageMs.open_pr_reads! >= 290, "positive control: the stalled read measured its stall");
  assert.ok(stalled.readStageMs.open_pr_reads! > quick.readStageMs.open_pr_reads!, "positive control: the timings differ");
  assert.deepEqual(portable(stalled, slow.root), portable(quick, fast.root));
  assert.deepEqual(stalled.projection, quick.projection);
});

// ── the stale refusal row ─────────────────────────────────────────────────────────────────────────

const stagesMs = { open_pr_reads: 300, projection_warm: 40, projection_settled: 35, behind_main_probes: 125 };

test("W1-T14883 criterion 2: tick_read.stale_refused carries the read's stage timings beside read_ms", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  const published: ReadGeneration<{ readStageMs: Record<string, number> }> = {
    generation: 4, source: "worker", publishedAtMs: 1_000, settledAtMs: 1_500, facts: { readStageMs: stagesMs },
  };
  const served = freshReadGeneration(published, { consumer: "full_sweep", clock: { now: () => 1_000_000 } as never, log });
  assert.equal(served, undefined, "the old generation is refused");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, "tick_read.stale_refused");
  assert.equal(rows[0]!.extra!.read_ms, 500);
  assert.deepEqual(rows[0]!.extra!.tick_read_stages_ms, stagesMs);
  const bare: ReadGeneration<object> = { generation: 5, source: "worker", publishedAtMs: 1_000, settledAtMs: 1_500, facts: {} };
  const bareRows: typeof rows = [];
  freshReadGeneration(bare, { consumer: "full_sweep", clock: { now: () => 1_000_000 } as never,
    log: (step, extra) => { bareRows.push({ step, extra }); } });
  assert.equal(bareRows.length, 1);
  assert.equal("tick_read_stages_ms" in bareRows[0]!.extra!, false, "a read that measured nothing names no stages");
});

// ── the selection-timing row ──────────────────────────────────────────────────────────────────────

const timingStep = "dispatch.selection_timing";
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

async function dispatch(stages: Record<string, number> | undefined, selectionTiming?: boolean) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const started: string[] = [];
  const finished = new Set<string>();
  let finishSibling!: (result: RunResult) => void;
  const siblingResult = new Promise<RunResult>((resolve) => { finishSibling = resolve; });
  const sleepers: Array<() => void> = [];
  let ms = Date.parse("2026-11-25T12:00:00Z");
  let stopped = false;
  let pendingPhases: ProjectPlanPhases | undefined;
  let pendingStages: Record<string, number> | undefined;
  const isMerged = (id: string) => finished.has(id);
  const summary = await runDaemon(plan, {
    ...hostIndependentDaemonDeps(),
    now: () => new Date(ms),
    selectionTimingNow: () => ms,
    sleep: () => stopped ? Promise.resolve() : new Promise<void>((resolve) => sleepers.push(resolve)),
    checkStop: () => stopped ? "fixture finished" : undefined,
    refreshMerged: () => isMerged,
    // The refresh hands its phases and stages over the way the daemon's refresher does: held once, taken once.
    refreshMergedAsync: async () => { await Promise.resolve(); ms += 47; pendingPhases = refreshPhases; pendingStages = stages; return isMerged; },
    takeRefreshMergedPhases: () => { const taken = pendingPhases; pendingPhases = undefined; return taken; },
    takeTickReadStages: () => { const taken = pendingStages; pendingStages = undefined; return taken; },
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
      if (id === next) setImmediate(() => finishSibling(merged(sibling)));
      const outcome = id === sibling ? await siblingResult : merged(id);
      finished.add(id);
      return outcome;
    },
  }, { laneCount: 2, selectionTiming });
  return { rows, started, stopReason: summary.stopReason };
}

test("W1-T14883 criterion 2: the next dispatch.selection_timing row carries the stage timings beside refresh_merged_phases", async () => {
  const { rows } = await dispatch(stagesMs);
  const timings = rows.filter(({ step }) => step === timingStep).map(({ fields }) => fields);
  const refills = timings.filter(({ site, probe_ms }) => site === "lane-refill" && "refreshMerged" in (probe_ms as object));
  assert.ok(refills.length > 0, "a lane refilled through the refreshMerged probe");
  for (const row of refills) {
    assert.deepEqual(row.refresh_merged_phases, refreshPhases);
    assert.deepEqual(row.tick_read_stages_ms, stagesMs);
  }
  const unmeasured = await dispatch(undefined);
  assert.ok(unmeasured.rows.filter(({ step }) => step === timingStep).every(({ fields }) => !("tick_read_stages_ms" in fields)),
    "a read that measured nothing adds no stages");
});

test("W1-T14883 criterion 3: the same picks, holds and merged set with and without the stage timing", async () => {
  const withoutTiming = await dispatch(stagesMs, false);
  assert.deepEqual(withoutTiming.started, [first, sibling, next]);
  assert.equal(withoutTiming.rows.filter(({ step }) => step === timingStep).length, 0);
  const unmeasured = await dispatch(undefined, true);
  const measured = await dispatch(stagesMs, true);
  const decisions = (run: typeof measured) => ({ ...run, rows: run.rows.filter(({ step }) => step !== timingStep) });
  assert.deepEqual(decisions(measured), decisions(withoutTiming));
  assert.deepEqual(decisions(unmeasured), decisions(withoutTiming));
});
