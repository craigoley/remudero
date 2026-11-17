import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { type FleetFlowRow } from "#src/lib/fleet-flow-detectors.js";
import { evaluateIdleCapacityDetectors, idleCapacityDetector } from "#src/lib/idle-capacity-detector.js";
import { selectionHoldForStep, selectionRefusalReason } from "#src/lib/idle-lane-accounting.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

/** The slice of a run result this suite's refused dispatch never produces; importing run-task's type would add a reach importer. */
type RunResult = never;

// ── W1-T10423: a selection_empty slot names why selection found nothing ─────────────────────
//
// Incident c9de468bdb48 fired idle-capacity:selection_empty with dispatchable=3 and hold `selection_empty:unnamed`:
// selection ran, found nothing, and recorded no reason. These drive the REAL runDaemon into that state and the REAL
// detector over the row it writes.

const MIN = 60_000;

async function idleTicks(taskCount: number, deps: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selection-empty-`));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, Array.from({ length: taskCount }, (_, i) => task(`T${i + 1}`)).join(""));
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const startMs = Date.parse("2026-10-15T04:12:00.000Z");
  let nowMs = startMs;
  let sleeps = 0;
  await runDaemon(loadPlan(f), {
    refreshMerged: () => () => false,
    runOne: async (id: string): Promise<RunResult> => { throw new Error(`unexpected dispatch of ${id}`); },
    now: () => new Date(nowMs),
    sleep: async () => { sleeps++; nowMs += 5 * MIN; },
    checkStop: () => (sleeps >= 3 ? "operator stop" : undefined),
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra: extra ?? {} }),
    ...deps,
  } as unknown as DaemonDeps, { laneCount: 3 });
  return { rows, startMs };
}

async function incidentFor(changed: Record<string, unknown>, startMs: number) {
  const nowMs = startMs + 60 * MIN;
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selection-empty-state-`));
  writeFileSync(join(stateDir, "fleet-flow-detectors.json"), JSON.stringify({
    detectors: { "idle-capacity": {
      history: [3, 4, 4, 5, 3, 4].map((measured, i) => ({ population: "selection_empty", measured, ts: nowMs - 86_400_000 + i })),
      emitted: [],
    } },
  }));
  const row: FleetFlowRow = { ts: new Date(startMs).toISOString(), step: "lane.idle_changed", ...changed };
  return evaluateIdleCapacityDetectors({ stateDir, detectors: [idleCapacityDetector("core")], nowMs, readRows: () => [row] });
}

test("a selection_empty idle slot names why selection found nothing", async () => {
  // Three queued tasks, each with an open PR: selection returns empty while three are dispatchable.
  const { rows, startMs } = await idleTicks(3, { isOpenPr: () => 123 });
  const changed = rows.filter((r) => r.step === "lane.idle_changed");
  assert.equal(changed.length, 1, `one transition row, got ${JSON.stringify(changed.map((r) => r.extra))}`);
  const extra = changed[0]!.extra;
  assert.equal(extra.cause, "selection_empty");
  assert.equal(extra.dispatchable, 3);
  assert.deepEqual(extra.hold, { reason: "selection refused: open-pr=3" });

  const found = await incidentFor(extra, startMs);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.name, "idle-capacity:selection_empty");
  assert.match(String(found[0]!.subject), /hold=selection_refused:_open-pr=3 /);
  assert.doesNotMatch(String(found[0]!.subject), /unnamed/);
  assert.match(String(found[0]!.message), /dispatchable=3/);
});

test("a selection_empty slot with no recorded refusal still reads unnamed", async () => {
  const found = await incidentFor({ cause: "selection_empty", idle_slots: 3, dispatchable: 3, hold: null }, Date.parse("2026-10-15T04:12:00.000Z"));
  assert.equal(found.length, 1);
  assert.match(String(found[0]!.subject), /hold=selection_empty:unnamed /);
});

test("a tick that selection filtered by tallied reasons names them by count", async () => {
  // Two tasks wait on a blocked dependency and three have an open PR: the filter tally and the skips both ride the hold.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selection-empty-tally-`));
  const f = join(dir, "tasks.yaml");
  const base = "  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n";
  writeFileSync(f,
    `- id: P\n  title: p\n${base}  depends_on: [Z]\n  files: [src/p.ts]\n` +
    `- id: Q\n  title: q\n${base}  depends_on: [Z]\n  files: [src/q.ts]\n` +
    `- id: R\n  title: r\n${base}  depends_on: []\n  files: [src/r.ts]\n` +
    `- id: S\n  title: s\n${base}  depends_on: []\n  files: [src/s.ts]\n` +
    `- id: W\n  title: w\n${base}  depends_on: []\n  files: [src/w.ts]\n` +
    `- id: Z\n  title: z\n  repo: remudero\n  type: implement\n  verify: auto\n  status: blocked\n  depends_on: []\n  files: [src/z.ts]\n`);
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let nowMs = Date.parse("2026-10-15T04:12:00.000Z");
  let sleeps = 0;
  await runDaemon(loadPlan(f), {
    refreshMerged: () => () => false,
    runOne: async (id: string): Promise<RunResult> => { throw new Error(`unexpected dispatch of ${id}`); },
    now: () => new Date(nowMs),
    sleep: async () => { sleeps++; nowMs += 5 * MIN; },
    isOpenPr: (id: string) => (["R", "S", "W"].includes(id) ? 7 : undefined),
    checkStop: () => (sleeps >= 2 ? "operator stop" : undefined),
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra: extra ?? {} }),
  } as unknown as DaemonDeps, { laneCount: 3 });
  const hold = rows.find((r) => r.step === "lane.idle_changed")?.extra.hold as { reason?: string } | null | undefined;
  assert.match(String(hold?.reason), /^selection refused: /);
  assert.match(String(hold?.reason), /unmet-deps=2/);
  assert.match(String(hold?.reason), /blocked=1/);
  assert.match(String(hold?.reason), /open-pr=3/);
});

test("selection refusals are summarised by count per reason", () => {
  assert.equal(selectionRefusalReason({ "unmet-deps": 2, blocked: 0, "open-pr": 1 }), "selection refused: unmet-deps=2, open-pr=1");
  assert.equal(selectionRefusalReason({ blocked: 0 }), undefined, "nothing recorded stays nothing");
  assert.equal(selectionRefusalReason({}, "no disjoint runnable task within the lane budget"), "no disjoint runnable task within the lane budget");
  assert.deepEqual(selectionHoldForStep("dispatch.lane_refill_held", { reason: "no disjoint runnable task within the lane budget" }),
    { reason: "no disjoint runnable task within the lane budget" });
  assert.deepEqual(selectionHoldForStep("dispatch.lane_refill_held", { reason: "priority reservation: A deferred for waiting B" }),
    { reason: "priority reservation: A deferred for waiting B" });
  assert.equal(selectionHoldForStep("dispatch.lane_refill_held", { reason: "phase bound" }), undefined);
  assert.equal(selectionHoldForStep("dispatch.lane_refill_held", {}), undefined);
  assert.equal(selectionHoldForStep("daemon.idle", { reason: "no disjoint runnable task" }), undefined);
});
