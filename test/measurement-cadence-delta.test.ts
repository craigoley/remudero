import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildMeasurementCadenceRow, runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T2925: the cadence reported the LATEST value of every metric and nothing else, so no
// surface could say whether the loop was converging. `delta_vs_previous` is that direction, and
// this file is its falsifier: the SECOND fire must carry the exact arithmetic difference against
// the previous `measurement_cadence.ran` row, the FIRST fire — with no previous row to compare
// against — must carry `null` rather than a fabricated 0, and a fire over an IDENTICAL window
// must carry a real 0. The middle case is the one that matters: a null and a zero mean opposite
// things ("nothing to compare" vs "measured, unchanged") and a delta that cannot tell them apart
// reports a converged loop on its very first fire.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function tmp(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}`));
}

function trailerMergeDump(taskIds: readonly string[]): string {
  return taskIds
    .map((taskId, index) => {
      const sha = `${index + 1}`.repeat(40);
      const ts = `2026-09-09T0${index}:00:00+00:00`;
      const body = `body\n\nRemudero-Task: ${taskId}\n`;
      return `\x02${sha}\x00${ts}\x00feat: merge ${taskId}\x00${body}\x01src/${taskId}.ts\n`;
    })
    .join("");
}

/** The window every case below measures. It computes, deterministically:
 *  repeatIncidentRate 1, blocked_ci_share 0.25, zeroTouchRate 0.5. */
const WINDOW_ROWS: readonly Record<string, unknown>[] = [
  { ts: "2026-09-09T00:00:00.000Z", step: "ci.stalled", run_id: "R1", task_id: "C1" },
  { ts: "2026-09-09T00:00:00.000Z", step: "ci.stalled", run_id: "R2", task_id: "C2" },
  { ts: "2026-09-09T00:00:00.000Z", step: "verdict", run_id: "R3", task_id: "V1", verdict: "blocked_ci" },
  { ts: "2026-09-09T00:00:00.000Z", step: "verdict", run_id: "R4", task_id: "V2", verdict: "merged" },
  { ts: "2026-09-09T00:00:00.000Z", step: "verdict", run_id: "R5", task_id: "V3", verdict: "merged" },
  { ts: "2026-09-09T00:00:00.000Z", step: "verdict", run_id: "R6", task_id: "V4", verdict: "merged" },
  { ts: "2026-09-09T00:00:00.000Z", step: "automerge.armed", run_id: "R7", task_id: "T1" },
];

/** A previous `measurement_cadence.ran` row carrying the three metric values given. */
function previousFire(values: { repeatIncidentRate: number; blockedCiShare: number; zeroTouchRate: number }): Record<string, unknown> {
  return {
    ts: "2026-09-08T18:00:00.000Z",
    run_id: "R0",
    task_id: "DAEMON",
    step: "measurement_cadence.ran",
    rule_efficacy: { status: "measured", repeatIncidentRate: values.repeatIncidentRate },
    verdict_calibration: { status: "measured", blocked_ci_share: values.blockedCiShare },
    autonomy_rate: { status: "measured", zeroTouchRate: values.zeroTouchRate },
  };
}

/** Fires the cadence once over `rows` and returns the ledger row it would write. */
function fireOver(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const root = tmp("mc-delta-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "ledger.2026-09-09T00-00-00-000Z.ndjson"),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    return buildMeasurementCadenceRow(
      runMeasurementCadenceReport({
        stateDir,
        cwd: REPO_ROOT,
        escalate: false,
        gitLog: () => ({ dump: trailerMergeDump(["T1", "T2"]), ref: "test" }),
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function deltaOf(row: Record<string, unknown>, family: string): unknown {
  return (row[family] as Record<string, unknown>).delta_vs_previous;
}

function valueOf(row: Record<string, unknown>, family: string, key: string): unknown {
  return (row[family] as Record<string, unknown>)[key];
}

test("W1-T2925: the second fire reports the exact delta against the previous measurement_cadence.ran row", () => {
  const row = fireOver([previousFire({ repeatIncidentRate: 0.25, blockedCiShare: 0.5, zeroTouchRate: 0.75 }), ...WINDOW_ROWS]);

  // The current window's own values, pinned — a delta is only meaningful if the minuend is.
  assert.equal(valueOf(row, "rule_efficacy", "repeatIncidentRate"), 1);
  assert.equal(valueOf(row, "verdict_calibration", "blocked_ci_share"), 0.25);
  assert.equal(valueOf(row, "autonomy_rate", "zeroTouchRate"), 0.5);

  // ...and the exact arithmetic difference against the previous fire, sign included.
  assert.equal(deltaOf(row, "rule_efficacy"), 0.75);
  assert.equal(deltaOf(row, "verdict_calibration"), -0.25);
  assert.equal(deltaOf(row, "autonomy_rate"), -0.25);
});

test("W1-T2925: the first fire reports null — with nothing to compare against, never a fabricated 0", () => {
  const row = fireOver(WINDOW_ROWS); // no previous measurement_cadence.ran row anywhere in the union

  // Same window, so the values are identical to the case above...
  assert.equal(valueOf(row, "rule_efficacy", "repeatIncidentRate"), 1);
  assert.equal(valueOf(row, "verdict_calibration", "blocked_ci_share"), 0.25);
  assert.equal(valueOf(row, "autonomy_rate", "zeroTouchRate"), 0.5);

  // ...and every delta is null, NOT 0. `assert.equal(x, null)` would pass for undefined too, so
  // each is checked strictly: a missing key and a deliberate null are different facts.
  for (const family of ["rule_efficacy", "verdict_calibration", "autonomy_rate"]) {
    assert.strictEqual(deltaOf(row, family), null, `${family} delta on the first fire`);
    assert.notStrictEqual(deltaOf(row, family), 0, `${family} must not report 0 with no previous fire`);
  }
});

test("W1-T2925: CONTROL — an identical window reports 0, so null and 0 are provably distinguishable", () => {
  // The previous row carries exactly what this window computes. If the delta could not tell
  // "unchanged" from "nothing to compare", this case and the one above would agree; they must not.
  const row = fireOver([previousFire({ repeatIncidentRate: 1, blockedCiShare: 0.25, zeroTouchRate: 0.5 }), ...WINDOW_ROWS]);

  assert.strictEqual(deltaOf(row, "rule_efficacy"), 0);
  assert.strictEqual(deltaOf(row, "verdict_calibration"), 0);
  assert.strictEqual(deltaOf(row, "autonomy_rate"), 0);
});
