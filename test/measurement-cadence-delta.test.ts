import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildMeasurementCadenceRow, runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function writeCadenceLedger(stateDir: string, rows: readonly Record<string, unknown>[]): void {
  mkdirSync(stateDir, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(stateDir, "ledger.2026-09-09T00-00-00-000Z.ndjson"), body);
}

function row(step: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-09-09T00:00:00.000Z",
    run_id: "R",
    task_id: "T",
    step,
    ...over,
  };
}

function gitDump(taskIds: readonly string[]): string {
  return taskIds
    .map((taskId, index) => {
      const sha = `${index + 1}`.repeat(40);
      const ts = `2026-09-09T0${index}:00:00+00:00`;
      const body = `body\n\nRemudero-Task: ${taskId}\n`;
      return `\x02${sha}\x00${ts}\x00feat: merge ${taskId}\x00${body}\x01src/${taskId}.ts\n`;
    })
    .join("");
}

function runFire(stateDir: string, taskIds: readonly string[], now: string) {
  return buildMeasurementCadenceRow(
    runMeasurementCadenceReport({
      stateDir,
      cwd: REPO_ROOT,
      escalate: false,
      gitLog: () => ({ dump: gitDump(taskIds), ref: "test" }),
      now: new Date(now),
    }),
  );
}

test("measurement cadence deltas: first fire carries null and the second fire reports exact change", () => {
  const root = tmp("rmd-mc-delta-");
  try {
    const stateDir = join(root, "state");
    writeCadenceLedger(stateDir, [
      row("ci.stalled", { task_id: "C1" }),
      row("verdict", { task_id: "V1", verdict: "blocked_ci" }),
      row("verdict", { task_id: "V2", verdict: "merged" }),
      row("automerge.armed", { task_id: "T1" }),
    ]);

    const first = runFire(stateDir, ["T1"], "2026-09-09T00:00:00.000Z");
    assert.equal((first.rule_efficacy as Record<string, unknown>).repeatIncidentRate, 1);
    assert.equal((first.rule_efficacy as Record<string, unknown>).delta_vs_previous, null);
    assert.equal((first.verdict_calibration as Record<string, unknown>).blocked_ci_share, 0.5);
    assert.equal((first.verdict_calibration as Record<string, unknown>).delta_vs_previous, null);
    assert.equal((first.autonomy_rate as Record<string, unknown>).zeroTouchRate, 1);
    assert.equal((first.autonomy_rate as Record<string, unknown>).delta_vs_previous, null);

    writeCadenceLedger(stateDir, [
      row("verdict", { task_id: "V1", verdict: "blocked_ci" }),
      row("verdict", { task_id: "V2", verdict: "merged" }),
      row("verdict", { task_id: "V3", verdict: "merged" }),
      row("verdict", { task_id: "V4", verdict: "merged" }),
      row("automerge.armed", { task_id: "T1" }),
    ]);

    const second = runFire(stateDir, ["T1", "T2"], "2026-09-09T06:00:00.000Z");
    assert.equal((second.rule_efficacy as Record<string, unknown>).repeatIncidentRate, 0);
    assert.equal((second.rule_efficacy as Record<string, unknown>).delta_vs_previous, -1);
    assert.equal((second.verdict_calibration as Record<string, unknown>).blocked_ci_share, 0.25);
    assert.equal((second.verdict_calibration as Record<string, unknown>).delta_vs_previous, -0.25);
    assert.equal((second.autonomy_rate as Record<string, unknown>).zeroTouchRate, 0.5);
    assert.equal((second.autonomy_rate as Record<string, unknown>).delta_vs_previous, -0.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measurement cadence deltas: an unchanged second window reports zero change", () => {
  const root = tmp("rmd-mc-delta-zero-");
  try {
    const stateDir = join(root, "state");
    writeCadenceLedger(stateDir, [
      row("verdict", { task_id: "V1", verdict: "blocked_ci" }),
      row("verdict", { task_id: "V2", verdict: "merged" }),
      row("automerge.armed", { task_id: "T1" }),
    ]);

    runFire(stateDir, ["T1"], "2026-09-09T00:00:00.000Z");
    const second = runFire(stateDir, ["T1"], "2026-09-09T06:00:00.000Z");

    assert.equal((second.rule_efficacy as Record<string, unknown>).delta_vs_previous, 0);
    assert.equal((second.verdict_calibration as Record<string, unknown>).delta_vs_previous, 0);
    assert.equal((second.autonomy_rate as Record<string, unknown>).delta_vs_previous, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measurement cadence deltas: a stale prior fire reports null instead of an old trend", () => {
  const root = tmp("rmd-mc-delta-stale-");
  try {
    const stateDir = join(root, "state");
    writeCadenceLedger(stateDir, [
      row("verdict", { task_id: "V1", verdict: "blocked_ci" }),
      row("verdict", { task_id: "V2", verdict: "merged" }),
      row("automerge.armed", { task_id: "T1" }),
    ]);

    runFire(stateDir, ["T1"], "2026-09-07T00:00:00.000Z");
    const second = runFire(stateDir, ["T1"], "2026-09-09T00:00:01.000Z");

    assert.equal((second.rule_efficacy as Record<string, unknown>).delta_vs_previous, null);
    assert.equal((second.verdict_calibration as Record<string, unknown>).delta_vs_previous, null);
    assert.equal((second.autonomy_rate as Record<string, unknown>).delta_vs_previous, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
