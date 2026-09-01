// W1-T2557: A RUNAWAY WORKER IS INVISIBLE UNTIL IT HAS FINISHED SPENDING — mid-flight the fleet
// sampled LIVENESS (worker.state, working/quiet/unknown) but never COST, and every cost signal
// that exists (scope_guard.overrun, budget.warning, cost.anomaly) fired AFTER implement.done. This
// proves the fix: a running turn count observable from the ledger WHILE a spawn is still in
// flight, and a non-fatal, OBSERVE-ONLY runaway signal sized against an observed class
// distribution — never a source literal, and never a lowered `max_turns` cliff.
//
// Seven acceptance claims, all proven here:
//   1. a worker's turn count is observable from the ledger WHILE the spawn is still in flight
//   2. the mid-flight row is emitted before the spawn settles, not only at implement.done
//   3. a normal-length run emits no runaway signal — the bound does not fire on a healthy population
//   4. the runaway threshold is derived from an observed class distribution, never a source literal
//   5. max_turns stays a flat 400 runaway cliff — no ceiling is lowered by this change
//   6. no worker is killed or deferred by this change: it observes and never acts
//   7. removing the mid-flight emission makes the in-flight visibility assertion fail

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import { loadMounts, mountsPath, resolveMount } from "../src/lib/mounts.js";
import {
  buildWorkerStateSensor,
  deriveRunawayTurnBound,
  ledgerPathFor,
  WORKER_RUNAWAY_TURNS_LEDGER_STEP,
  WORKER_TURNS_LEDGER_STEP,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-${prefix}-`));
}

function fakeConfig(root: string): Config {
  return { root } as Config;
}

// ── acceptance 1 & 2: turn count observable from the ledger WHILE the spawn is in flight ────

test("a worker's turn count is observable from the ledger while the spawn is still in flight — never gated behind settle", () => {
  const root = tmpRoot("runaway-visible-mid-flight");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  const runId = "T-run-mid-flight";
  const taskId = "T-task-mid-flight";
  const sensor = buildWorkerStateSensor({ ledgerPath, runId, taskId, root });

  // Simulate a spawn IN FLIGHT: repeated observer() calls, exactly what collectWorkerResult
  // drives per assistant message — no `.finally`/settle call of any kind, no verdict, no
  // `implement.done`. Anything visible in the ledger at this point was visible WHILE the run
  // was still happening, by construction.
  for (let turn = 1; turn <= 5; turn++) {
    sensor.observer({ kind: "working", tsMs: turn * 1000, turnsSoFar: turn });
  }

  const rows = readLedgerLines(ledgerPath).filter((l) => l.step === WORKER_TURNS_LEDGER_STEP);
  assert.ok(rows.length > 0, "the turn count must already be in the ledger before the spawn ever settles");
  assert.equal(rows[rows.length - 1].turns_so_far, 5, "the LATEST mid-flight row must carry the running count");
  for (const r of rows) {
    assert.equal(r.run_id, runId);
    assert.equal(r.task_id, taskId);
  }
});

// ── acceptance 7: removing the mid-flight emission makes the in-flight visibility assertion fail ──

test("worker.turns rows are emitted on EVERY change in the running count — exactly one row per distinct count, not one at the end", () => {
  const root = tmpRoot("runaway-turns-per-change");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  const sensor = buildWorkerStateSensor({ ledgerPath, runId: "T-run-per-change", taskId: "T-task-per-change", root });

  // 8 distinct turn counts, some repeated (a message with both a text and a tool_use block
  // reports the SAME turnsSoFar twice — see worker.ts's collectWorkerResult) — the repeats must
  // NOT multiply the row count, and if the mid-flight emission were removed entirely the count
  // below would be 0 instead of 8, which is exactly what this assertion pins.
  const turnsSequence = [1, 1, 2, 3, 3, 3, 4, 5, 6, 7, 8];
  for (const t of turnsSequence) sensor.observer({ kind: "working", tsMs: t, turnsSoFar: t });

  const rows = readLedgerLines(ledgerPath).filter((l) => l.step === WORKER_TURNS_LEDGER_STEP);
  assert.deepEqual(
    rows.map((r) => r.turns_so_far),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "one row per distinct count, in order, never a duplicate for an unchanged count and never zero rows",
  );
});

test("a sensor whose observer never fires appends NO worker.turns row — mirrors the worker.state UNKNOWN polarity, never a fabricated zero", () => {
  const root = tmpRoot("runaway-turns-never-fired");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  buildWorkerStateSensor({ ledgerPath, runId: "T-run-never-fired", taskId: "T-task-never-fired", root });
  const rows = readLedgerLines(ledgerPath).filter((l) => l.step === WORKER_TURNS_LEDGER_STEP);
  assert.equal(rows.length, 0);
});

// ── acceptance 4: the runaway threshold is derived from an observed class distribution ──────

test("deriveRunawayTurnBound: a thin class (below minSamples) is silent — undefined, never a guessed threshold", () => {
  assert.equal(deriveRunawayTurnBound([40, 45], { multiplier: 3, minSamples: 5 }), undefined);
  assert.equal(deriveRunawayTurnBound([], { multiplier: 3, minSamples: 5 }), undefined);
});

test("deriveRunawayTurnBound: at/above minSamples, the bound is the OBSERVED median times the policy multiplier — never a source literal", () => {
  // 7 samples, minSamples 5 — median of [40,42,44,46,48,50,52] is 46 (the 4th of 7).
  const bound = deriveRunawayTurnBound([52, 40, 48, 44, 50, 42, 46], { multiplier: 3, minSamples: 5 });
  assert.equal(bound, 138);

  // A DIFFERENT observed distribution must move the bound — proving it is DERIVED from the
  // data, not a constant this module happens to also return 138 for.
  const higherBound = deriveRunawayTurnBound([80, 82, 84, 86, 88], { multiplier: 3, minSamples: 5 });
  assert.equal(higherBound, 252);
  assert.notEqual(higherBound, bound);
});

test("deriveRunawayTurnBound: an even-sized sample averages the two middle values, same median convention as cost-anomaly's own", () => {
  const bound = deriveRunawayTurnBound([10, 20, 30, 40], { multiplier: 2, minSamples: 4 });
  // sorted [10,20,30,40], median = (20+30)/2 = 25, *2 = 50.
  assert.equal(bound, 50);
});

// ── acceptance 3: a normal-length run emits no runaway signal ───────────────────────────────

test("a normal-length run — turn count staying under the observed-class bound — emits no worker.runaway_turns row", () => {
  const root = tmpRoot("runaway-healthy-population");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  const sensor = buildWorkerStateSensor({ ledgerPath, runId: "T-run-healthy", taskId: "T-task-healthy", root });

  // Same class history as the derivation test above: bound = 138.
  const bound = deriveRunawayTurnBound([52, 40, 48, 44, 50, 42, 46], { multiplier: 3, minSamples: 5 });
  sensor.setRunawayBound(bound);

  // A run that finishes in 45 turns — squarely typical, well under the 138 bound.
  for (let turn = 1; turn <= 45; turn++) sensor.observer({ kind: "working", tsMs: turn, turnsSoFar: turn });

  const runawayRows = readLedgerLines(ledgerPath).filter((l) => l.step === WORKER_RUNAWAY_TURNS_LEDGER_STEP);
  assert.equal(runawayRows.length, 0, "a healthy run must never trip the bound — no false alarm on ordinary variance");
});

test("a run with no bound configured (setRunawayBound never called, or a derivation failure left it undefined) never signals runaway, however many turns it takes", () => {
  const root = tmpRoot("runaway-no-bound");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  const sensor = buildWorkerStateSensor({ ledgerPath, runId: "T-run-no-bound", taskId: "T-task-no-bound", root });
  for (let turn = 1; turn <= 500; turn++) sensor.observer({ kind: "working", tsMs: turn, turnsSoFar: turn });
  const runawayRows = readLedgerLines(ledgerPath).filter((l) => l.step === WORKER_RUNAWAY_TURNS_LEDGER_STEP);
  assert.equal(runawayRows.length, 0, "no derived bound ⇒ never a guessed threshold, never a signal");
});

// ── acceptance 1 (runaway half) + 6: the runaway signal fires mid-flight, exactly once, and acts on nothing ──

test("a run that clears the bound gets EXACTLY ONE worker.runaway_turns row, mid-flight, never repeated", () => {
  const root = tmpRoot("runaway-fires-once");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  const sensor = buildWorkerStateSensor({ ledgerPath, runId: "T-run-fires-once", taskId: "T-task-fires-once", root });

  const bound = deriveRunawayTurnBound([52, 40, 48, 44, 50, 42, 46], { multiplier: 3, minSamples: 5 });
  sensor.setRunawayBound(bound);

  // 207 turns — this task's own measured fixture (W1-T2324-1787823430981) — well past bound=138.
  // No `implement.done`/verdict of any kind is ever appended here: everything below happens
  // strictly WHILE the spawn is in flight.
  for (let turn = 1; turn <= 207; turn++) sensor.observer({ kind: "working", tsMs: turn, turnsSoFar: turn });

  const runawayRows = readLedgerLines(ledgerPath).filter((l) => l.step === WORKER_RUNAWAY_TURNS_LEDGER_STEP);
  assert.equal(runawayRows.length, 1, "the signal must fire exactly once per run, never once per subsequent turn");
  assert.equal(runawayRows[0].bound_turns, bound);
  assert.ok(
    typeof runawayRows[0].turns_so_far === "number" && (runawayRows[0].turns_so_far as number) > (bound as number),
    "the row must carry the count that actually cleared the bound",
  );
});

test("no worker is killed or deferred by this change: buildWorkerStateSensor exposes no kill/abort/defer affordance, and observation continues normally past the bound", () => {
  const root = tmpRoot("runaway-observes-never-acts");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  const sensor = buildWorkerStateSensor({ ledgerPath, runId: "T-run-never-acts", taskId: "T-task-never-acts", root });

  // The sensor's public surface is exactly observation + configuration — no method this or any
  // caller could use to stop, defer, or otherwise steer the worker it is watching.
  assert.deepEqual(
    Object.keys(sensor).sort(),
    ["observer", "setRunawayBound", "startPolling"],
    "no kill/abort/defer affordance exists on the sensor to reach for, even by accident",
  );

  sensor.setRunawayBound(10);
  // Drive the count drastically past the bound and keep going — a real kill/defer path would
  // stop future ledgering (an aborted stream, a thrown error); this must not.
  for (let turn = 1; turn <= 300; turn++) {
    assert.doesNotThrow(() => sensor.observer({ kind: "working", tsMs: turn, turnsSoFar: turn }));
  }
  // Ordinary worker.state / worker.turns visibility must be completely unaffected by having
  // cleared the runaway bound — the run keeps being observed exactly as before.
  const turnsRows = readLedgerLines(ledgerPath).filter((l) => l.step === WORKER_TURNS_LEDGER_STEP);
  assert.equal(turnsRows[turnsRows.length - 1].turns_so_far, 300, "observation continues past the bound, unthrottled");
});

// ── acceptance 5: max_turns stays a flat 400 runaway cliff — no ceiling is lowered ───────────

test("max_turns stays a flat 400 runaway cliff for every worker-spending lane — this change lowers no ceiling", () => {
  const mounts = loadMounts(mountsPath(repoRoot));
  // Every lane this task's own rationale discusses (the runaway cliff, "a flat 400 across the
  // board" — recon is its own, deliberately DIFFERENT lane at 20, and is not part of this
  // task's own claim, so it is not asserted here).
  for (const lane of ["implement", "diagnose", "review", "reviewer", "fix", "manual"] as const) {
    for (const risk of ["low", "medium", "high"] as const) {
      let mount;
      try {
        mount = resolveMount(mounts, lane, risk);
      } catch {
        continue; // not every lane×risk combination is routed (e.g. review has no "low"/"high" for some rows) — skip, never fabricate.
      }
      assert.equal(mount.maxTurns, 400, `${lane}×${risk} must still carry the flat 400 runaway cliff`);
    }
  }
  assert.equal(mounts.architect.maxTurns, 400);
  assert.equal(mounts.judge.maxTurns, 400);
});
