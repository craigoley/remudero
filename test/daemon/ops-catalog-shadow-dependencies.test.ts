import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
// The daemon and the live analytics cache import each other and the cache reads a daemon constant at load,
// so the cache loads first and the daemon (the module under test) finishes before the cache evaluates.
import "#src/lib/live-analytics-snapshot-cache.js";
import {
  compareSecondaryCatalogShadow, compositeCatalogRevisionKey, runDaemon, type DaemonDeps, type SecondaryCatalogShadowResult,
} from "#src/lib/daemon.js";
import { mergePlanBlobs, type Plan, type Task } from "#src/lib/plan.js";
import { type OpsCatalogShadowInput } from "#src/lib/ops-catalog-source.js";
import { runnableCandidates, type MergedSet } from "#src/lib/drain.js";

// W1-T11769 criterion 2: a primary task must not depend on a secondary task, and a secondary dependency must exist.
// A secondary task may depend on a primary task. That edge resolves through the primary merged set.

const PRIMARY_YAML = ["A:", "B:A", "C:B", "D:"].map((spec) => {
  const [id, dep] = spec.split(":");
  return `- id: ${id}\n  title: public ${id}\n  repo: remudero\n  type: implement\n  depends_on: [${dep}]\n  status: queued\n`;
}).join("");
const primaryPlan = (): Plan => mergePlanBlobs([{ label: "primary.yaml", text: PRIMARY_YAML }]);
const planOf = (tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map((task) => [task.id, task])) });

/** One secondary task. Its title, path and body are sentinels that no row may carry. */
function opsTask(id: string, overrides: Partial<Task> = {}): Task {
  const text = `- id: ${id}\n  title: PRIVATE_TITLE_SENTINEL\n  repo: remudero\n  type: implement\n  verify: auto\n` +
    "  files: [private/PRIVATE_PATH_SENTINEL]\n  rationale: PRIVATE_BODY_SENTINEL\n  priority: 0\n";
  return { ...mergePlanBlobs([{ label: "ops.yaml", text }]).tasks[0], ...overrides };
}

const PUBLIC_1 = "1".repeat(40);
const PUBLIC_2 = "2".repeat(40);
const OPS_1 = "a".repeat(40);
const OPS_2 = "b".repeat(40);
const okSource = (plan: Plan, opsCommit = OPS_1): OpsCatalogShadowInput => ({ outcome: "ok", plan, opsCommit, identityDigest: "d".repeat(64) });
const digestOf = (publicCommit: string, opsCommit: string): string =>
  createHash("sha256").update(compositeCatalogRevisionKey(publicCommit, opsCommit)).digest("hex");

type Row = Record<string, unknown>;
interface Run { ran: string[]; merged: string[]; rows: Row[]; ledger: string }

/** Drive `runDaemon` for `max` worker runs. `afterRun` lets a case change its seams between two ticks. */
async function drive(deps: Partial<DaemonDeps>, opts: { max?: number; plan?: Plan; afterRun?: (count: number) => void } = {}): Promise<Run> {
  const merged = new Set<string>();
  const ran: string[] = [];
  const rows: Row[] = [];
  const other: Array<[string, Row]> = [];
  const summary = await runDaemon(opts.plan ?? primaryPlan(), {
    refreshMerged: () => (id) => merged.has(id),
    targetRepo: "remudero",
    runOne: async (id) => {
      ran.push(id);
      merged.add(id);
      opts.afterRun?.(ran.length);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: async () => {},
    log: (step, extra = {}) => {
      if (step === "dispatch.secondary_catalog_shadow") rows.push(extra);
      else other.push([step, extra]);
    },
    ...deps,
  }, { max: opts.max ?? 3 });
  return { ran, merged: summary.merged, rows, ledger: JSON.stringify(other.map(stableRow)) };
}

/** Keep what a ledger row says about dispatch. Drop the wall-clock and memory readings that differ between any two runs. */
function stableRow([step, extra]: [string, Row]): [string, Row] {
  if (step === "daemon.memory_pressure" || step === "dispatch.refill_bound") return [step, {}];
  return [step, Object.fromEntries(Object.entries(extra).filter(([key]) => !/(^|_)(ms|at)(_|$)/.test(key)))];
}

/** The dispatch picks, worker spawns, merges and every other ledger row must equal a run with no seam. */
function assertSameDispatch(run: Run, baseline: Run, label: string): void {
  assert.deepEqual(run.ran, baseline.ran, `${label}: worker spawns`);
  assert.deepEqual(run.merged, baseline.merged, `${label}: merged tasks`);
  assert.equal(run.ledger, baseline.ledger, `${label}: every ledger row other than the shadow row`);
}

const seams = (plan: Plan): Partial<DaemonDeps> => ({ secondaryCatalogShadowSource: () => okSource(plan), primaryPlanCommit: () => PUBLIC_1 });
/** The primary plan with one task's dependencies replaced. The strict parser would refuse an unknown ID. */
function primaryWith(id: string, dependsOn: string[]): Plan {
  return planOf(primaryPlan().tasks.map((task) => (task.id === id ? { ...task, depends_on: dependsOn } : task)));
}
const REFUSED = ["invalid_cross_catalog_dependency", 1, 1, 0, 0];
const shape = (row: Partial<SecondaryCatalogShadowResult> | undefined): unknown[] => [row?.outcome, row?.primary_candidate_count, row?.combined_candidate_count,
  row?.secondary_candidate_count, row?.displaced_primary_count];

test("W1-T11769 criterion 2: a remudero-to-ops dependency refuses the whole ops snapshot", async () => {
  const plan = primaryWith("D", ["OPS-1"]);
  const ops = planOf([opsTask("OPS-1"), opsTask("OPS-2")]);
  const baseline = await drive({}, { plan });
  const run = await drive(seams(ops), { plan });
  assert.ok(run.rows.length >= 1);
  for (const row of run.rows) assert.deepEqual(shape(row), REFUSED, "no ops task is admitted, not even the valid ones");
  assert.equal(run.rows[0].revision_key_digest, digestOf(PUBLIC_1, OPS_1), "the refusal is keyed like any comparison");
  assertSameDispatch(run, baseline, "remudero-to-ops edge");
  // Control: the same ops snapshot is compared once the public plan stops naming it.
  const control = await drive(seams(ops), { max: 1 });
  assert.deepEqual(shape(control.rows[0]), ["compared", 1, 1, 1, 1]);
});

test("W1-T11769 criterion 2: a dangling ops dependency refuses the whole ops snapshot", async () => {
  const baseline = await drive({});
  const ops = planOf([opsTask("OPS-1"), opsTask("OPS-2", { depends_on: ["NOWHERE-9"] })]);
  const run = await drive(seams(ops));
  assert.ok(run.rows.length >= 1);
  for (const row of run.rows) assert.deepEqual(shape(row), REFUSED, "the valid ops task is not partially admitted");
  assertSameDispatch(run, baseline, "dangling ops edge");
});

test("W1-T11769 criterion 2: an ops-to-remudero dependency is allowed and blocks until the public task merges", async () => {
  const baseline = await drive({});
  const run = await drive(seams(planOf([opsTask("OPS-CHILD", { depends_on: ["A"] })])));
  assert.deepEqual(run.rows.map(shape), [
    ["compared", 1, 1, 0, 0],
    ["compared", 1, 1, 1, 1],
  ], "the ops task waits for public task A, then resolves through the public merged set");
  assertSameDispatch(run, baseline, "ops-to-remudero edge");
});

test("W1-T11769 criterion 2: an ops-to-ops dependency is allowed", async () => {
  const baseline = await drive({});
  const run = await drive(seams(planOf([opsTask("OPS-1"), opsTask("OPS-2", { depends_on: ["OPS-1"] })])));
  assert.deepEqual(run.rows.map(shape), [["compared", 1, 1, 1, 1]]);
  assertSameDispatch(run, baseline, "ops-to-ops edge");
});

test("W1-T11769 criterion 2: duplicate ids across catalogs keep duplicate_task_id, ahead of the edge rule", async () => {
  const baseline = await drive({});
  const duplicate = planOf([{ ...opsTask("OPS-1"), id: "A" }, opsTask("OPS-2", { depends_on: ["NOWHERE-9"] })]);
  const run = await drive(seams(duplicate));
  assert.ok(run.rows.length >= 1);
  for (const row of run.rows) assert.deepEqual(shape(row), ["duplicate_task_id", 1, 1, 0, 0]);
  assertSameDispatch(run, baseline, "duplicate ids");
});

test("W1-T11769 criterion 5: invalid_cross_catalog_dependency in src/lib/daemon.ts is the composer's stable refusal code", () => {
  const opts = { targetRepo: "remudero" };
  const none: MergedSet = () => false;
  const primary = primaryPlan();
  const candidates = runnableCandidates(primary, none, 1, opts);
  const compare = (p: Plan, s: Plan, isMerged: MergedSet = none) =>
    shape(compareSecondaryCatalogShadow(p, s, runnableCandidates(p, isMerged, 1, opts), isMerged, 1, opts));
  assert.equal(candidates.length, 1);
  assert.deepEqual(compare(primaryWith("B", ["A", "OPS-1"]), planOf([opsTask("OPS-1")])), REFUSED);
  assert.deepEqual(compare(primary, planOf([opsTask("OPS-1", { depends_on: ["NOWHERE-9"] })])), REFUSED);
  const child = planOf([opsTask("OPS-CHILD", { depends_on: ["A"] })]);
  assert.deepEqual(compare(primary, child), ["compared", 1, 1, 0, 0]);
  assert.deepEqual(compare(primary, child, (id) => id === "A"), ["compared", 1, 1, 1, 1]);
  // A public dependency on an ID in neither catalog is the public plan's own matter, not a cross-catalog edge.
  assert.deepEqual(compare(primaryWith("D", ["NOWHERE-9"]), planOf([opsTask("OPS-1")])), ["compared", 1, 1, 1, 1]);
});
