import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  DECISION_RELEVANT_LEDGER_STEPS,
  MAX_RETAINED_LINES_PER_STEP,
  ledgerExceedsRotationCeiling,
  rotateLedger,
} from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";

test("W1-T7814: the decision-relevant step set registers dispatch_memory_observed", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("dispatch_memory_observed"));
});

test("W1-T7814: rotation keeps dispatch_memory_observed rows and archives a telemetry row of the same age", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-dispatch-memory-retention-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const now = new Date("2030-01-02T00:00:00.000Z");
    const ts = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const observations = Array.from({ length: MAX_RETAINED_LINES_PER_STEP + 50 }, (_, marker) => ({
      ts,
      run_id: `memory-${marker}`,
      task_id: "GOVERNOR",
      step: "dispatch_memory_observed",
      observed_available_mib: 2048 + marker,
      memory_floor_mib: 2300,
      deferred: 2048 + marker < 2300,
      marker,
    }));
    const telemetry = { ts, run_id: "telemetry", task_id: "GOVERNOR", step: "ci.polling" };
    const content = [...observations, telemetry].map((row) => JSON.stringify(row) + "\n").join("");
    const expected = observations.slice(-MAX_RETAINED_LINES_PER_STEP);
    const retainedBytes = Buffer.byteLength(expected.map((row) => JSON.stringify(row) + "\n").join(""));
    const ceilingBytes = Math.floor((retainedBytes + Buffer.byteLength(content)) / 2);
    writeFileSync(ledgerPath, content);

    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceilingBytes));
    const result = rotateLedger(ledgerPath, { ceilingBytes, now: () => now });
    assert.equal(result.rotated, true);
    const live = readLedgerLines(ledgerPath);
    const retained = live.filter((row) => row.step === "dispatch_memory_observed");
    assert.equal(retained.length, MAX_RETAINED_LINES_PER_STEP);
    assert.deepEqual(retained, expected, "the newest bounded observations retain their full payload");
    assert.ok(!live.some((row) => row.step === telemetry.step));

    assert.ok(result.archivePath);
    const archiveBytes = readFileSync(result.archivePath);
    const archiveText = (result.archivePath.endsWith(".gz") ? gunzipSync(archiveBytes) : archiveBytes).toString("utf8");
    const archived = archiveText.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(archived.find((row) => row.step === telemetry.step), telemetry);
    assert.deepEqual(archived.filter((row) => row.step === "dispatch_memory_observed"), observations);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
