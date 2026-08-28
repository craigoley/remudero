import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RETAINED_LINES_PER_STEP, ledgerExceedsRotationCeiling, rotateLedger } from "../src/lib/ledger.js";
import {
  DEFAULT_MAX_TASK_DISPATCHES,
  createDispatchBreakerCache,
  evaluateDispatchBreakerDetailed,
} from "../src/lib/status.js";

// ── W1-T2425: the anti-rotation guard is PROCESS-LOCAL while the hazard CROSSES PROCESSES.
//
// `evaluateDispatchBreakerDetailed` reads the live file by a deliberate, marked choice
// (`ledger-read-intent: live`) and that read must not change: `run.start` reads 569 distinct over
// the archive-plus-live union against 207 live on the fleet, so a union read would count runs a
// task made weeks ago and never clear again for any task that has ever gone five runs without a
// PR. Its regression guard — `priorCount !== undefined && freshCount < priorCount &&
// !hasNewOwnedPr` — is the right refusal, but `priorCount` comes from `cache.lastCounts`, an
// in-memory Map `breakerGateFor` rebuilds PER INVOCATION. `breakerGateFor`'s own doc scopes its
// claim honestly to a SAME-PROCESS rotation; a rotation plus a daemon restart was never covered.
//
// MEASURED ON THE FLEET (2026-08-27, three-form union, per-form read control `dispatch.skipped`
// at 10 live + 2,075 rotated): W1-T1279 was refused every tick for 84h; a rotation stamped
// `ledger.2026-08-27T20-18-33-155Z.ndjson` dropped its two oldest `run.start` rows; the daemon
// restarted (DAEMON-1787856970963 -> DAEMON-1787863181387) across the same gap; the fresh process
// read `freshCount 3 < 5` and dispatched, with no line anywhere recording a reset.
//
// The existing `test/breaker-survives-rotation.test.ts` already asserts a fresh cache reads back
// TRIPPED after a real rotation — and it passes, because its fixture holds 5 `run.start` rows,
// far under PASS 4's per-step cap, so rotation retains every one of them. THAT TEST IS SILENT ON
// THE CAP. These tests drive the population past it, which is where the defect actually lives.

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-breaker-guard-"));
}

/** A ledger whose `run.start` population EXCEEDS the per-step cap, with `taskId`'s runs oldest —
 *  so PASS 4 keeps the newest `MAX_RETAINED_LINES_PER_STEP` and drops this task's rows first. */
function ledgerWithTaskRunsOldest(dir: string, taskId: string, taskRuns: number, otherRuns: number): string {
  const ledgerPath = join(dir, "ledger.ndjson");
  const lines: string[] = [];
  for (let i = 0; i < taskRuns; i++) {
    lines.push(JSON.stringify({ ts: `2026-08-24T0${i}:00:00.000Z`, step: "run.start", task_id: taskId, run_id: `${taskId}-${i}` }));
  }
  for (let i = 0; i < otherRuns; i++) {
    lines.push(JSON.stringify({ ts: `2026-08-25T00:00:00.${String(i).padStart(3, "0")}Z`, step: "run.start", task_id: `W1-OTHER-${i}`, run_id: `o-${i}` }));
  }
  writeFileSync(ledgerPath, lines.join("\n") + "\n");
  return ledgerPath;
}

function appendLine(ledgerPath: string, line: Record<string, unknown>): void {
  writeFileSync(ledgerPath, JSON.stringify(line) + "\n", { flag: "a" });
}

/** The row the breaker itself already writes at refusal time, carrying the count it decided on. */
function circuitBrokenRow(taskId: string, freshCount: number, ts: string): Record<string, unknown> {
  return {
    ts,
    step: "dispatch.circuit_broken",
    task_id: "DAEMON",
    task: taskId,
    lane: "daemon",
    freshCount,
    maxDispatches: DEFAULT_MAX_TASK_DISPATCHES,
    hasNewOwnedPr: false,
    ledgerState: "tripped",
    state: "tripped",
  };
}

/** Rotate the way the fleet actually does. `rotateLedger`'s convergence invariant sheds the
 *  OLDEST retained lines by `ts` until the live file is under 90% of the ceiling, so an
 *  unrealistically small ceiling sheds the retained core too and would test the shed rather than
 *  PASS 4's per-step cap. Pad with steps PASS 1 archives (the same `ci.polling` noise
 *  `test/breaker-survives-rotation.test.ts` uses) so the file crosses the ceiling on NOISE and the
 *  core is bounded by the cap alone. */
const ROTATION_CEILING_BYTES = 200_000;

function rotatePastCap(ledgerPath: string): void {
  let n = 0;
  while (!ledgerExceedsRotationCeiling(ledgerPath, ROTATION_CEILING_BYTES)) {
    const noise = Array.from({ length: 200 }, () =>
      JSON.stringify({ ts: "2026-08-26T00:00:00.000Z", step: "ci.polling", run_id: `noise-${n++}`, detail: "x".repeat(96) }),
    ).join("\n");
    writeFileSync(ledgerPath, noise + "\n", { flag: "a" });
  }
  const result = rotateLedger(ledgerPath, { ceilingBytes: ROTATION_CEILING_BYTES });
  assert.equal(result.rotated, true, "test setup sanity: the rotation actually ran");
  assert.ok(
    !readFileSync(ledgerPath, "utf8").includes("ledger.rotation_shed"),
    "test setup sanity: the convergence shed must NOT have fired — this fixture tests the per-step cap",
  );
}

test("W1-T2425: a tripped breaker stays tripped across a rotation that drops its oldest run rows", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-TROT";
    const ledgerPath = ledgerWithTaskRunsOldest(dir, taskId, DEFAULT_MAX_TASK_DISPATCHES, MAX_RETAINED_LINES_PER_STEP);
    const trip = evaluateDispatchBreakerDetailed(ledgerPath, taskId, createDispatchBreakerCache());
    assert.equal(trip.state, "tripped", "setup: five runs with no owned PR trips at the default bound");
    appendLine(ledgerPath, circuitBrokenRow(taskId, trip.freshCount, "2026-08-24T09:40:38.142Z"));

    rotatePastCap(ledgerPath);
    const survivingRuns = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.includes(`"task_id":"${taskId}"`) && l.includes("run.start")).length;
    assert.ok(
      survivingRuns < DEFAULT_MAX_TASK_DISPATCHES,
      `setup: the per-step cap must actually have dropped this task's rows (kept ${survivingRuns})`,
    );

    // A BRAND-NEW PROCESS: empty in-memory cache, exactly what breakerGateFor builds per invocation.
    const after = evaluateDispatchBreakerDetailed(ledgerPath, taskId, createDispatchBreakerCache());
    assert.notEqual(after.state, "clear", "a rotated-away streak must never read as forward progress");
    assert.equal(after.state, "indeterminate", "the count regressed with nothing in the ledger to explain it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2425: the regression arm is reachable across a restart WITH the on-disk row and unreachable WITHOUT it", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-TBOTH";
    // WITH the row on disk.
    const withRow = ledgerWithTaskRunsOldest(dir, taskId, DEFAULT_MAX_TASK_DISPATCHES, MAX_RETAINED_LINES_PER_STEP);
    appendLine(withRow, circuitBrokenRow(taskId, DEFAULT_MAX_TASK_DISPATCHES, "2026-08-24T09:40:38.142Z"));
    rotatePastCap(withRow);
    const seeded = evaluateDispatchBreakerDetailed(withRow, taskId, createDispatchBreakerCache());
    assert.equal(seeded.priorCount, DEFAULT_MAX_TASK_DISPATCHES, "the fresh cache learned the prior count from disk");
    assert.equal(seeded.state, "indeterminate", "the guard fires across the restart");

    // WITHOUT it — TODAY'S BEHAVIOUR, preserved verbatim: no row, nothing to seed from, the arm
    // cannot fire and the regressed count reads clear. This is the control that proves the fix is
    // the ROW and not some unrelated widening of the read.
    const dir2 = tmpDir();
    try {
      const bare = ledgerWithTaskRunsOldest(dir2, taskId, DEFAULT_MAX_TASK_DISPATCHES, MAX_RETAINED_LINES_PER_STEP);
      rotatePastCap(bare);
      const unseeded = evaluateDispatchBreakerDetailed(bare, taskId, createDispatchBreakerCache());
      assert.equal(unseeded.priorCount, undefined, "nothing on disk to seed from");
      assert.equal(unseeded.state, "clear", "unchanged: with no prior baseline the regression arm cannot fire");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2425: a genuine reset by a fresh owned PR still clears the streak exactly as it does today", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-TRESET";
    const ledgerPath = ledgerWithTaskRunsOldest(dir, taskId, DEFAULT_MAX_TASK_DISPATCHES, 0);
    appendLine(ledgerPath, circuitBrokenRow(taskId, DEFAULT_MAX_TASK_DISPATCHES, "2026-08-24T09:40:38.142Z"));
    appendLine(ledgerPath, { ts: "2026-08-27T21:11:57.575Z", step: "pr.opened", task_id: taskId, pr_url: "u" });

    const after = evaluateDispatchBreakerDetailed(ledgerPath, taskId, createDispatchBreakerCache());
    assert.equal(after.freshCount, 0, "pr.opened resets the streak");
    assert.equal(after.hasNewOwnedPr, true, "the reset is visible in the same read");
    assert.equal(after.state, "clear", "forward progress still clears — the seed must never outrank a real reset");
    assert.equal(after.priorCount, undefined, "a circuit_broken row OLDER than the reset seeds nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2425: the breaker still reads the live file alone and opens no archive", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-TLIVE";
    const ledgerPath = ledgerWithTaskRunsOldest(dir, taskId, DEFAULT_MAX_TASK_DISPATCHES, MAX_RETAINED_LINES_PER_STEP);
    appendLine(ledgerPath, circuitBrokenRow(taskId, DEFAULT_MAX_TASK_DISPATCHES, "2026-08-24T09:40:38.142Z"));
    rotatePastCap(ledgerPath);

    const opened: string[] = [];
    const recordingFs = {
      existsSync: (p: string) => {
        opened.push(p);
        return true;
      },
      readFileSync: (p: string) => {
        opened.push(p);
        return readFileSync(p, "utf8");
      },
    };
    const detail = evaluateDispatchBreakerDetailed(ledgerPath, taskId, createDispatchBreakerCache(), {
      ledgerFs: recordingFs,
    });
    assert.equal(detail.state, "indeterminate", "sanity: the seeded guard still fires under the injected fs");
    assert.deepEqual([...new Set(opened)], [ledgerPath], "exactly one path opened — the live ledger, never an archive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2425: the circuit-broken row survives rotation and is bounded by the same per-step cap as its neighbours", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const over = MAX_RETAINED_LINES_PER_STEP + 37;
    const lines: string[] = [];
    for (let i = 0; i < over; i++) {
      lines.push(JSON.stringify(circuitBrokenRow(`W1-T${i}`, DEFAULT_MAX_TASK_DISPATCHES, `2026-08-2${i % 8}T00:00:00.000Z`)));
    }
    writeFileSync(ledgerPath, lines.join("\n") + "\n");
    rotatePastCap(ledgerPath);

    const retained = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.includes('"dispatch.circuit_broken"')).length;
    assert.equal(
      retained,
      MAX_RETAINED_LINES_PER_STEP,
      "retained, not archived — and capped exactly like run.start/pr.opened, never unbounded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2425: the retention cap stays two hundred and the dispatch bound stays five", () => {
  assert.equal(MAX_RETAINED_LINES_PER_STEP, 200, "this task must not raise the per-step retention cap");
  assert.equal(DEFAULT_MAX_TASK_DISPATCHES, 5, "this task must not raise the dispatch bound");
});
