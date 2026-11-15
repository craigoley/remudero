import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
// The daemon and the live analytics cache import each other and the cache reads a daemon constant at load,
// so the cache loads first and the daemon (the module under test) finishes before the cache evaluates.
import "#src/lib/live-analytics-snapshot-cache.js";
import { compositeCatalogRevisionKey, runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { mergePlanBlobs, type Plan, type Task } from "#src/lib/plan.js";
import { type OpsCatalogShadowInput } from "#src/lib/ops-catalog-source.js";

// W1-T11769 criterion 1: the shadow reads its source on every tick and keys each row by both commits.
// Each case drives `runDaemon` over several ticks with fake seams and no network, clock or file.

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

/**
 * Every host reading `runDaemon` takes on this path, fixed: the memory governor (process RSS, swap and the
 * cgroup budget), V8 heap statistics, the wall clock and RMD_BOOT_CHECKOUT_BLOCKED. A case and its baseline
 * get the same values, so a busy or memory-limited host cannot change either ledger.
 */
const hostPins = (): Partial<DaemonDeps> => ({
  memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
  heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
  now: () => new Date(Date.UTC(2026, 0, 1)),
  bootCheckoutBlocked: "",
});

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
    ...hostPins(),
    ...deps,
  }, { max: opts.max ?? 3 });
  return { ran, merged: summary.merged, rows, ledger: JSON.stringify(other) };
}

test("W1-T11769: a pressured host cannot change what these cases compare", async (t) => {
  // The fake host has a one-megabyte memory budget and swap that doubles on every read.
  // An unpinned daemon would tighten, then exit on memory pressure.
  const reads: string[] = [];
  const real = fs.readFileSync as (...args: unknown[]) => unknown;
  let swapKb = 1_000_000;
  t.mock.method(fs, "readFileSync", ((...args: unknown[]) => {
    const path = String(args[0]);
    if (!path.startsWith("/sys/fs/cgroup/") && path !== "/proc/self/status") return real(...args);
    reads.push(path);
    swapKb *= 2;
    return path.endsWith("memory.max") ? "1048576\n" : path.endsWith("memory.high") ? "max\n" : `VmSwap:\t${swapKb} kB\n`;
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  let pressured: Run;
  try {
    pressured = await drive({ secondaryCatalogShadowSource: () => okSource(planOf([opsTask("OPS-1")])), primaryPlanCommit: () => PUBLIC_1 });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const quiet = await drive({});
  assert.deepEqual(pressured.ran, ["A", "B", "C"], "the pressured run dispatches all public work");
  assertSameDispatch(pressured, quiet, "pressured host");
  assert.deepEqual(reads, [], "no case reads the host's memory files");
});

/** The dispatch picks, worker spawns, merges and every other ledger row must equal a run with no seam. */
function assertSameDispatch(run: Run, baseline: Run, label: string): void {
  assert.deepEqual(run.ran, baseline.ran, `${label}: worker spawns`);
  assert.deepEqual(run.merged, baseline.merged, `${label}: merged tasks`);
  assert.equal(run.ledger, baseline.ledger, `${label}: every ledger row other than the shadow row`);
}

const counts = (row: Row): unknown[] => [row.outcome, row.primary_candidate_count, row.combined_candidate_count,
  row.secondary_candidate_count, row.displaced_primary_count];

test("W1-T11769 criterion 1: two runs with no seam write the same ledger", async () => {
  const [first, second] = [await drive({}), await drive({})];
  assert.deepEqual(first.ran, ["A", "B", "C"]);
  assert.equal(first.ledger, second.ledger, "with every host reading pinned, the whole ledger is equal and nothing is scrubbed");
  assert.ok(first.ledger.includes('"boot_at":"2026-01-01T00:00:00.000Z"'), "the ledger's times come from the pinned clock");
  assert.ok(first.ledger.includes('"dispatch.pick_scored",{"task":"A"'), "the ledger names each pick");
});

test("W1-T11769 criterion 1: an ops-commit change is observed on the next tick without a restart", async () => {
  const baseline = await drive({});
  let source = okSource(planOf([opsTask("OPS-1")]), OPS_1);
  let reads = 0;
  const run = await drive({
    secondaryCatalogShadowSource: () => { reads++; return source; },
    primaryPlanCommit: () => PUBLIC_1,
  }, { afterRun: (count) => { if (count === 1) source = okSource(planOf([opsTask("OPS-1")]), OPS_2); } });
  assert.deepEqual(run.rows.map((row) => row.revision_key_digest), [digestOf(PUBLIC_1, OPS_1), digestOf(PUBLIC_1, OPS_2)]);
  assert.ok(reads >= 3, `the source is read on every dispatching tick; got ${reads} reads`);
  assertSameDispatch(run, baseline, "ops commit change");
});

test("W1-T11769 criterion 1: either commit changing emits a new row at equal counts", async () => {
  const baseline = await drive({});
  const plan = planOf([opsTask("OPS-1")]);
  let opsCommit = OPS_1;
  let publicCommit = PUBLIC_1;
  const run = await drive({
    secondaryCatalogShadowSource: () => okSource(plan, opsCommit),
    primaryPlanCommit: () => publicCommit,
  }, { afterRun: (count) => { if (count === 1) opsCommit = OPS_2; else if (count === 2) publicCommit = PUBLIC_2; } });
  assert.equal(run.rows.length, 3, "one row per composite key");
  assert.deepEqual(run.rows.map(counts), Array.from({ length: 3 }, () => ["compared", 1, 1, 1, 1]), "the counts never change");
  assert.deepEqual(run.rows.map((row) => row.revision_key_digest),
    [digestOf(PUBLIC_1, OPS_1), digestOf(PUBLIC_1, OPS_2), digestOf(PUBLIC_2, OPS_2)]);
  assertSameDispatch(run, baseline, "either commit change");
});

test("W1-T11769 criterion 1: an unchanged composite key with equal counts emits one row", async () => {
  const baseline = await drive({});
  const plan = planOf([opsTask("OPS-1")]);
  const run = await drive({ secondaryCatalogShadowSource: () => okSource(plan), primaryPlanCommit: () => PUBLIC_1 });
  assert.equal(run.rows.length, 1);
  assert.equal(run.rows[0].revision_key_digest, digestOf(PUBLIC_1, OPS_1));
  assertSameDispatch(run, baseline, "unchanged key");
});

test("W1-T11769 criterion 1: an unknown primary commit is primary_revision_unknown and never a guessed key", async () => {
  const baseline = await drive({});
  const plan = planOf([opsTask("OPS-1")]);
  const unknown: Array<Partial<DaemonDeps>> = [
    {},
    { primaryPlanCommit: () => undefined },
    { primaryPlanCommit: () => "not-a-commit" },
  ];
  for (const deps of unknown) {
    const run = await drive({ secondaryCatalogShadowSource: () => okSource(plan), ...deps });
    assert.equal(run.rows.length, 1);
    assert.deepEqual(counts(run.rows[0]), ["primary_revision_unknown", 1, null, null, null]);
    assert.equal(run.rows[0].revision_key_digest, null);
    assertSameDispatch(run, baseline, "unknown primary commit");
  }
});

test("W1-T11769 criterion 1: a source with no completed state gives no row until it has one", async () => {
  const baseline = await drive({});
  let source: OpsCatalogShadowInput | undefined;
  const run = await drive({
    secondaryCatalogShadowSource: () => source,
    primaryPlanCommit: () => PUBLIC_1,
  }, { afterRun: (count) => { if (count === 2) source = okSource(planOf([opsTask("OPS-1")])); } });
  assert.equal(run.rows.length, 1, "the first two ticks have nothing to compare");
  assert.equal(run.rows[0].revision_key_digest, digestOf(PUBLIC_1, OPS_1));
  assertSameDispatch(run, baseline, "late source");
});

test("W1-T11769 criterion 4: compositeCatalogRevisionKey( in src/lib/daemon.ts names both commits and only its digest is logged", async () => {
  assert.notEqual(compositeCatalogRevisionKey(PUBLIC_1, OPS_1), compositeCatalogRevisionKey(OPS_1, PUBLIC_1));
  assert.notEqual(compositeCatalogRevisionKey(PUBLIC_1, OPS_1), compositeCatalogRevisionKey(PUBLIC_1, OPS_2));
  assert.notEqual(compositeCatalogRevisionKey(PUBLIC_1, OPS_1), compositeCatalogRevisionKey(PUBLIC_2, OPS_1));
  const run = await drive({ secondaryCatalogShadowSource: () => okSource(planOf([opsTask("OPS-1")])), primaryPlanCommit: () => PUBLIC_1 });
  const text = JSON.stringify(run.rows);
  assert.equal(text.includes(OPS_1), false, "the ops commit is never logged");
  assert.equal(text.includes(compositeCatalogRevisionKey(PUBLIC_1, OPS_1)), false, "the key is never logged");
});

test("W1-T11769 criterion 1: the per-tick source replaces the fixed snapshot and the one-shot target read", async () => {
  const plan = planOf([opsTask("OPS-1")]);
  let targetReads = 0;
  const run = await drive({
    secondaryCatalogShadowSource: () => okSource(plan),
    primaryPlanCommit: () => PUBLIC_1,
    secondaryPlanForShadow: null,
    opsCatalogTarget: { repository: "acme/ops" },
    opsCatalogApi: async () => { targetReads++; throw new Error("the tick must not fetch"); },
  });
  assert.deepEqual(run.rows.map((row) => row.outcome), ["compared"]);
  assert.equal(targetReads, 0, "a tick with a per-tick source never awaits a snapshot read");
});

test("W1-T11769 criterion 1: a fixed snapshot with no per-tick source keeps its W1-T11600 row shape", async () => {
  const run = await drive({ secondaryPlanForShadow: planOf([opsTask("OPS-1")]), primaryPlanCommit: () => PUBLIC_1 });
  assert.equal(run.rows.length, 1);
  assert.deepEqual(Object.keys(run.rows[0]).sort(), ["basis", "combined_candidate_count", "displaced_primary_count",
    "outcome", "primary_candidate_count", "secondary_candidate_count"]);
});
