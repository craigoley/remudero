import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { canaryCommand, nativeCanaryExecutionWithinObservationWindow } from "#src/lib/model-canary-command.js";

test("native analysis CLI refuses absent source data without provisioning owner config or output state", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-analysis-no-provision-`));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = join(root, "home");
    const ownerDir = join(root, "owner"), fieldDir = join(root, "field");
    mkdirSync(ownerDir, { mode: 0o700 }); mkdirSync(fieldDir, { mode: 0o700 });
    chmodSync(ownerDir, 0o700); chmodSync(fieldDir, 0o700);
    const inputFile = join(root, "analysis.json"), corpusFile = join(root, "corpus.json");
    const analysis = { version: "model-canary-analysis-input-v1", seed: "seed",
      censusInput: {}, matrixOptions: { day: "2026-11-05", seed: "matrix-seed", replicates: 1 },
      matrixDigest: "a".repeat(64),
      design: { comparisons: [{ id: "compare-a", endpoints: ["correctness"], estimands: ["first-attempt"] }],
        splits: ["development", "sealed-holdout"] },
      comparisons: [{ id: "compare-a", endpoint: "correctness", leftConfigId: "left", rightConfigId: "right" }],
      observationWindow: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-08T00:00:00.000Z" } };
    writeFileSync(inputFile, JSON.stringify(analysis), { mode: 0o600 }); writeFileSync(corpusFile, "{}", { mode: 0o600 });
    const outDir = join(root, "out");
    assert.throws(() => canaryCommand(["analyze-private", outDir, ownerDir, inputFile, fieldDir, corpusFile]),
      /native-config-not-found/);
    assert.equal(existsSync(join(ownerDir, "model-canary-slots.sqlite")), false);
    assert.equal(existsSync(join(process.env.HOME, ".config", "remudero", "config.json")), false);
    assert.equal(existsSync(outDir), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native field joins require the entire verified execution interval inside the requested window", () => {
  const window = { start: "2026-11-01T00:00:00.000Z", end: "2026-11-08T00:00:00.000Z" };
  assert.equal(nativeCanaryExecutionWithinObservationWindow({
    startedAt: "2026-11-01T00:00:00.000Z", completedAt: "2026-11-07T23:59:59.999Z",
  }, window), true);
  assert.equal(nativeCanaryExecutionWithinObservationWindow({
    startedAt: "2026-10-31T23:59:59.999Z", completedAt: "2026-11-01T00:00:00.001Z",
  }, window), false);
  assert.equal(nativeCanaryExecutionWithinObservationWindow({
    startedAt: "2026-11-07T23:59:59.999Z", completedAt: "2026-11-08T00:00:00.000Z",
  }, window), false);
  assert.equal(nativeCanaryExecutionWithinObservationWindow(null, window), false);
});
