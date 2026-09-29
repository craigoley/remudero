import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildMeasurementCadenceDaemonHooks } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("W1-T4757 criterion 1: the daemon hook can isolate human verification without replacing its producer", async () => {
  // Refuse before calling the real hook if the injection point disappears: a red-before run
  // must never launch the production verifier as a fallback.
  const source = readFileSync(join(repoRoot, "src/run-task.ts"), "utf8");
  assert.match(source, /deps\.verifyHumanCadenceResult\s*\?\?\s*defaultVerifyHumanCadenceResult/);
  const root = mkdtempSync(join(tmpdir(), "rmd-verify-human-fixture-"));
  try {
    let calls = 0;
    const hooks = buildMeasurementCadenceDaemonHooks({
      config: { root } as Config,
      now: () => new Date("2026-08-25T12:00:00Z"),
      verifyHumanCadenceResult: async (checkout: string, config: Config, runId: string) => {
        calls++;
        assert.equal(checkout, repoRoot);
        assert.equal(config.root, root);
        assert.match(runId, /^VERIFY-HUMAN-CADENCE-/);
        throw new Error("fixture verify-human stop before unrelated cadence work");
      },
    } as Parameters<typeof buildMeasurementCadenceDaemonHooks>[0]);

    await assert.rejects(hooks.runMeasurementCadence(), /fixture verify-human stop/);
    assert.equal(calls, 1, "the injected cadence must be the one the daemon hook calls");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
