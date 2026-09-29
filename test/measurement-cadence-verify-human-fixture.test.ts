import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildMeasurementCadenceDaemonHooks } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("W1-T4757 criterion 1: the daemon hook can isolate human verification without replacing its producer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-verify-human-fixture-"));
  try {
    let calls = 0;
    let seamRead = false;
    let configReads = 0;
    const hooks = buildMeasurementCadenceDaemonHooks({
      // The run reads config once for its state root and again for the human verifier's
      // argument. On the old tree the second read precedes the live default verifier;
      // refuse there, before the fixture can launch unrelated work. The new seam is read
      // first, so the same config getter admits the injected verifier.
      get config() {
        if (++configReads > 1 && !seamRead) throw new Error("verify-human seam was not read before the live verifier");
        return { root } as Config;
      },
      now: () => new Date("2026-08-25T12:00:00Z"),
      get verifyHumanCadenceResult() {
        seamRead = true;
        return async (checkout: string, config: Config, runId: string) => {
          calls++;
          assert.equal(checkout, repoRoot);
          assert.equal(config.root, root);
          assert.match(runId, /^VERIFY-HUMAN-CADENCE-/);
          throw new Error("fixture verify-human stop before unrelated cadence work");
        };
      },
    } as Parameters<typeof buildMeasurementCadenceDaemonHooks>[0]);

    await assert.rejects(hooks.runMeasurementCadence(), /fixture verify-human stop/);
    assert.equal(calls, 1, "the injected cadence must be the one the daemon hook calls");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
