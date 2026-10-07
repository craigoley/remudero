// W1-T6253: every now build's snapshot stage ran computeBoardSnapshot -> buildStatusBoard, which indexed the
// whole ledger once per section (the circuit breaker and the queue head), and `dayCostRows` rescanned the same
// rows; the views worker spent 10.5 s of a 150 s profile in buildLedgerIndex and 10.0 s in windowCostRows. The
// ledger is now indexed once per status-board build, and once per ROW GENERATION across now builds.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { systemClock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, NOW_REFRESH_MS, type NowViewContext } from "../src/lib/now-view.js";
import { loadPlan, loadPlanFromYaml } from "../src/lib/plan.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { buildLedgerIndex, DEFAULT_MAX_TASK_DISPATCHES, type GitHub, type LedgerIndex } from "../src/lib/status.js";
import { buildStatusBoard } from "../src/lib/status-board.js";
import { makeTempDir } from "../src/lib/tmp.js";

const github = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
} as unknown as GitHub;

/** An index builder that counts how many times a ledger was indexed. */
function countingIndexer(): { build: (rows: ReadonlyArray<Record<string, unknown>>) => LedgerIndex; count: () => number } {
  let n = 0;
  return { build: (rows) => (n++, buildLedgerIndex(rows)), count: () => n };
}

test("W1-T6253: one status-board build indexes the ledger once", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const plan = loadPlanFromYaml("- id: T1\n  title: a task\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n", "fixture");
  const lines = Array.from({ length: DEFAULT_MAX_TASK_DISPATCHES }, (_, i) => ({ run_id: `r${i}`, task_id: "T1", ts: new Date(now - 1000).toISOString(), step: "run.start" }));
  const indexer = countingIndexer();
  const model = buildStatusBoard("/nonexistent/root", "/nonexistent/ledger", {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo", now: () => now, resolveOriginMainSha: () => undefined, isPidAlive: () => true,
    plan, github, readLedger: () => lines, buildLedgerIndex: indexer.build,
  });
  // Both sections ran over the plan: the breaker names the tripped task and the queue head reached its refusal row.
  assert.deepEqual(model.blockers.rows.filter((r) => r.kind === "circuit_broken").map((r) => r.kind === "circuit_broken" && r.taskId), ["T1"]);
  assert.equal(model.queueHead.unknownReason, undefined, "the queue head section ran, so it needed an index too");
  assert.equal(indexer.count(), 1, "the breaker and the queue head share one index");
});

/** One instance whose projector, ledger and plan this test owns. */
function nowOf(t: { after: (fn: () => void) => void }, indexer: ReturnType<typeof countingIndexer>) {
  const base = makeTempDir("now-index-once");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = join(base, "state");
  mkdirSync(state, { recursive: true });
  const planPath = join(base, "tasks.yaml");
  writeFileSync(planPath, "- id: T1\n  title: a task\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const ledger = join(state, "ledger.ndjson");
  writeFileSync(ledger, "");
  const clock = systemClock;
  const db = openProjectorReadModel(join(base, "read-model-home"), "core", clock);
  t.after(() => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir: state, db, lease: acquired.lease, clock });
  let dayScans = 0;
  const view = createNowView({
    instances: [{ name: "core", ledgerDir: state }], coreInstance: "core", clock,
    readPlan: () => loadPlan(planPath),
    github: () => ({ github, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 1, diskFree: () => 1 },
    indexLedger: indexer.build,
    scanDayCosts: () => (dayScans++, []),
  });
  const T0 = clock.now();
  let tick = 0;
  /** One build at the ledger's current generation, `refreshes` refresh periods after T0 (so it is due). */
  const build = (): void => {
    projector.tick();
    const ctx: NowViewContext = {
      now: T0 + ++tick * NOW_REFRESH_MS, switches: { views: { now: "serve" } },
      instances: [{ state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db }],
    };
    assert.ok(view.materialize(ctx).find((b) => b.key === "instance=core"), "the build published a body");
  };
  const append = (row: Record<string, unknown>): void => appendFileSync(ledger, `${JSON.stringify({ ts: new Date(clock.now()).toISOString(), ...row })}\n`);
  return { build, append, dayScans: () => dayScans, generation: () => Number(db.meta("generation")) };
}

test("W1-T6253: an unchanged row generation is indexed once across now builds", (t) => {
  const indexer = countingIndexer();
  const f = nowOf(t, indexer);
  f.append({ step: "run.start", task_id: "T1", run_id: "r1", cost_usd: 0.5 });
  f.build();
  const generation = f.generation();
  assert.equal(indexer.count(), 1, "the first build indexes the ledger");
  assert.equal(f.dayScans(), 1, "and scans the day's costs");
  f.build();
  f.build();
  assert.equal(f.generation(), generation, "nothing was appended between the builds");
  assert.equal(indexer.count(), 1, "later builds over the same generation reuse the index");
  assert.equal(f.dayScans(), 1, "and the day's cost scan");
});

test("W1-T6253: a new row generation rebuilds the index", (t) => {
  const indexer = countingIndexer();
  const f = nowOf(t, indexer);
  f.append({ step: "run.start", task_id: "T1", run_id: "r1", cost_usd: 0.5 });
  f.build();
  const before = f.generation();
  f.append({ step: "run.start", task_id: "T1", run_id: "r2", cost_usd: 0.25 });
  f.build();
  assert.notEqual(f.generation(), before, "the append moved the generation");
  assert.equal(indexer.count(), 2, "the new generation is indexed afresh");
  assert.equal(f.dayScans(), 2, "and its costs scanned afresh");
});
