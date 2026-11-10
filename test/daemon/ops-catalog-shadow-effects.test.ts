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
import { OPS_CATALOG_OUTCOMES, type OpsCatalogOutcome, type OpsCatalogShadowInput } from "#src/lib/ops-catalog-source.js";
import { inspect } from "node:util";

// W1-T11769 criterion 3: no source outcome and no composer outcome changes what the daemon dispatches.
// Each shadow row holds counts, one outcome code and one digest. It holds no private title, path, body, ID or commit.

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

const ROW_KEYS = ["basis", "combined_candidate_count", "displaced_primary_count", "outcome", "primary_candidate_count",
  "revision_key_digest", "secondary_candidate_count"];
const SENTINELS = ["PRIVATE_TITLE_SENTINEL", "PRIVATE_PATH_SENTINEL", "PRIVATE_BODY_SENTINEL", "PRIVATE_ERROR_SENTINEL",
  "PRIVATE_OUTCOME_SENTINEL", "OPS-", "acme-private", "ops-secret-slug", OPS_1, OPS_2];
const emitted: Array<{ label: string; row: Row }> = [];

/** Run one case and a run with no seam on the same plan. Their dispatch must match. Keep the rows for the sweep. */
async function shadowCase(label: string, deps: Partial<DaemonDeps>, plan?: () => Plan): Promise<Row[]> {
  const baseline = await drive({}, { plan: plan?.() });
  assert.equal(baseline.rows.length, 0, "a run with no seam emits no shadow row");
  assert.ok(baseline.ran.length === 3, "the baseline dispatches public work");
  const run = await drive({ primaryPlanCommit: () => PUBLIC_1, ...deps }, { plan: plan?.() });
  assertSameDispatch(run, baseline, label);
  for (const id of run.ran) assert.equal(id.startsWith("OPS-"), false, `${label}: an ops task reached a worker`);
  for (const row of run.rows) emitted.push({ label, row });
  return run.rows;
}
const outcomes = (rows: Row[]): unknown[] => [...new Set(rows.map((row) => row.outcome))];
const opsCatalog = (): Plan => planOf([opsTask("OPS-1"), opsTask("OPS-2")]);

test("W1-T11769 criterion 3: every refused source outcome passes through with null counts and unchanged dispatch", async () => {
  const refusals = OPS_CATALOG_OUTCOMES.filter((outcome): outcome is Exclude<OpsCatalogOutcome, "ok"> => outcome !== "ok");
  assert.equal(refusals.length, 7, "the source's closed outcome set");
  for (const outcome of refusals) {
    // A refused source must carry no plan. This one carries a plan to prove the daemon ignores it.
    const rows = await shadowCase(`source ${outcome}`, { secondaryCatalogShadowSource: () => ({ outcome, plan: opsCatalog(), opsCommit: OPS_1 }) });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      outcome, basis: "cached_projection", primary_candidate_count: 1, combined_candidate_count: null,
      secondary_candidate_count: null, displaced_primary_count: null, revision_key_digest: null,
    });
  }
});

test("W1-T11769 criterion 3: every composer outcome leaves dispatch equal to a run without the seam", async () => {
  const source = (plan: Plan): Partial<DaemonDeps> => ({ secondaryCatalogShadowSource: () => okSource(plan) });
  // The ops tasks hold priority 0, so one that reached the dispatch candidates would run before public work.
  assert.deepEqual(outcomes(await shadowCase("compared", source(opsCatalog()))), ["compared"]);
  assert.deepEqual(outcomes(await shadowCase("duplicate", source(planOf([{ ...opsTask("OPS-1"), id: "A" }])))), ["duplicate_task_id"]);
  assert.deepEqual(outcomes(await shadowCase("dangling edge", source(planOf([opsTask("OPS-1", { depends_on: ["NOWHERE-9"] })])))),
    ["invalid_cross_catalog_dependency"]);
  assert.deepEqual(outcomes(await shadowCase("public edge", source(opsCatalog()),
    () => planOf(primaryPlan().tasks.map((task) => (task.id === "C" ? { ...task, depends_on: ["B", "OPS-1"] } : task))))),
  ["invalid_cross_catalog_dependency"]);
  assert.deepEqual(outcomes(await shadowCase("deferred", source(planOf([
    opsTask("OPS-1", { precondition: { read: ["status"], expect: "clean" } }),
  ])))), ["comparison_deferred"]);
  assert.deepEqual(outcomes(await shadowCase("malformed plan", source({ tasks: [opsTask("OPS-1")], byId: new Map() }))), ["malformed"]);
  assert.deepEqual(outcomes(await shadowCase("unknown primary", { ...source(opsCatalog()), primaryPlanCommit: () => undefined })),
    ["primary_revision_unknown"]);
});

test("W1-T11769 criterion 3: a hostile or broken source fails closed to a code and cannot stop the tick", async () => {
  const broken: Array<[string, () => OpsCatalogShadowInput | undefined, string]> = [
    ["throwing source", () => { throw new Error("PRIVATE_ERROR_SENTINEL"); }, "comparison_failed"],
    ["unlisted outcome", () => ({ outcome: "PRIVATE_OUTCOME_SENTINEL" as OpsCatalogOutcome }), "malformed"],
    ["ok without a plan", () => ({ outcome: "ok", opsCommit: OPS_1 }), "malformed"],
    ["ok without a commit", () => ({ outcome: "ok", plan: opsCatalog() }), "malformed"],
    ["ok with a commit that is not a sha", () => ({ outcome: "ok", plan: opsCatalog(), opsCommit: "PRIVATE_OUTCOME_SENTINEL" }), "malformed"],
    ["throwing plan", () => okSource(new Proxy({}, { get() { throw new Error("PRIVATE_ERROR_SENTINEL"); } }) as Plan), "malformed"],
  ];
  for (const [label, read, outcome] of broken) {
    const rows = await shadowCase(label, { secondaryCatalogShadowSource: read });
    assert.deepEqual(outcomes(rows), [outcome], label);
  }
  const rows = await shadowCase("throwing primary commit", {
    secondaryCatalogShadowSource: () => okSource(opsCatalog()),
    primaryPlanCommit: () => { throw new Error("PRIVATE_ERROR_SENTINEL"); },
  });
  assert.deepEqual(outcomes(rows), ["comparison_failed"]);
});

test("W1-T11769 criterion 3: a ledger that refuses the shadow row cannot change dispatch", async () => {
  const baseline = await drive({});
  const merged = new Set<string>();
  const ran: string[] = [];
  let refusedRows = 0;
  const summary = await runDaemon(primaryPlan(), {
    refreshMerged: () => (id) => merged.has(id),
    targetRepo: "remudero",
    secondaryCatalogShadowSource: () => okSource(opsCatalog()),
    primaryPlanCommit: () => PUBLIC_1,
    runOne: async (id) => { ran.push(id); merged.add(id); return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }; },
    sleep: async () => {},
    ...hostPins(),
    log: (step) => { if (step === "dispatch.secondary_catalog_shadow") { refusedRows++; throw new Error("ledger unavailable"); } },
  }, { max: 3 });
  assert.equal(refusedRows, 1, "the refused row is not retried every tick");
  assert.deepEqual(ran, baseline.ran);
  assert.deepEqual(summary.merged, baseline.merged);
});

test("W1-T11769 criterion 3: a source whose plan and commit are hidden from serializers is still compared", async () => {
  const hidden = Object.defineProperties({ outcome: "ok" as const, identityDigest: "d".repeat(64) }, {
    plan: { value: opsCatalog() }, opsCommit: { value: OPS_1 },
  }) as OpsCatalogShadowInput;
  assert.equal(JSON.stringify(hidden).includes("OPS-"), false, "the fixture mirrors the W1-T11768 source result");
  const rows = await shadowCase("hidden handles", { secondaryCatalogShadowSource: () => hidden });
  assert.deepEqual(outcomes(rows), ["compared"]);
  assert.equal(rows[0].secondary_candidate_count, 1);
});

test("W1-T11769 criterion 3: every emitted row carries only counts, a code and a digest", () => {
  assert.ok(emitted.length >= 20, `the earlier cases feed this sweep; got ${emitted.length} rows`);
  const codes = new Set<unknown>();
  for (const { label, row } of emitted) {
    assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `${label}: row keys`);
    codes.add(row.outcome);
    assert.equal(row.basis, "cached_projection");
    for (const key of ["primary_candidate_count", "combined_candidate_count", "secondary_candidate_count", "displaced_primary_count"]) {
      assert.ok(row[key] === null || Number.isSafeInteger(row[key]), `${label}: ${key} is a count or null`);
    }
    assert.ok(row.revision_key_digest === null || /^[0-9a-f]{64}$/.test(String(row.revision_key_digest)), `${label}: digest`);
    const text = [JSON.stringify(row), inspect(row, { showHidden: true, depth: null })].join("\n");
    for (const sentinel of SENTINELS) assert.equal(text.includes(sentinel), false, `${label}: row carries ${sentinel}`);
    assert.equal(text.includes(compositeCatalogRevisionKey(PUBLIC_1, OPS_1)), false, `${label}: row carries the key`);
  }
  for (const code of codes) assert.match(String(code), /^[a-z_]+$/, "an outcome is a stable code");
  assert.deepEqual([...codes].sort(), ["auth_missing", "compared", "comparison_deferred", "comparison_failed", "duplicate_task_id",
    "invalid_cross_catalog_dependency", "malformed", "primary_revision_unknown", "ref_moved", "source_absent", "stale",
    "unreadable"], "the sweep saw every source outcome and every composer outcome");
});
