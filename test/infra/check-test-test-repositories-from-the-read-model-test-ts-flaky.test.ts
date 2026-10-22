import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "#src/lib/ledger-projector.js";
import {
  currentReadModelPath,
  flushReadModelTransactions,
  openReadModel,
  READ_MODEL_DB_DIR_ENV,
  readModelTransactionDir,
} from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";

// PR #13122's round: with its DB mapped onto a scratch disk, the read-model's transaction
// diagnostics still publish beside the STATE dir, from a worker thread, after close() returns.
// A per-test rmSync of that state root raced the late write and threw ENOTEMPTY (hookFailed).
// #13136 made the fixture await flushReadModelTransactions() before removing scratch; this pins
// that the barrier really settles the writer, so the race is prevented rather than retried.
test("W1-T10312: check:test:test/repositories-from-the-read-model.test.ts:flaky is prevented, not retried", async () => {
  const saved = process.env[READ_MODEL_DB_DIR_ENV];
  const roots: string[] = [];
  try {
    for (let round = 0; round < 5; round++) {
      const stateRoot = makeTempDir("w1-t10312-state");
      const scratchRoot = makeTempDir("w1-t10312-nvme");
      roots.push(stateRoot, scratchRoot);
      const stateDir = join(stateRoot, "state");
      process.env[READ_MODEL_DB_DIR_ENV] = `${stateDir}:${join(scratchRoot, "read-model")}`;
      const db = openReadModel({ stateDir, instance: "core", schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION });
      const path = currentReadModelPath(stateDir, "core", LEDGER_PROJECTOR_SCHEMA_VERSION);
      // The DB lives on the scratch disk, but its diagnostics are published under the state root:
      // the directory the flaky hook removed.
      assert.ok(path.startsWith(scratchRoot), `db on scratch: ${path}`);
      assert.ok(readModelTransactionDir(path).startsWith(stateRoot), "diagnostics publish to the state disk");
      db.close();

      await flushReadModelTransactions();
      assert.ok(existsSync(readModelTransactionDir(path)), "the barrier waits for the diagnostic writer's publication");
      assert.doesNotThrow(() => rmSync(stateRoot, { recursive: true, force: true }));
      assert.doesNotThrow(() => rmSync(scratchRoot, { recursive: true, force: true }));

      // A settled writer has nothing left in flight that could resurrect a removed root.
      await flushReadModelTransactions();
      assert.equal(existsSync(stateRoot), false, "a settled writer must not recreate the state root");
      assert.equal(existsSync(scratchRoot), false, "a settled writer must not recreate the scratch root");
    }
  } finally {
    if (saved === undefined) delete process.env[READ_MODEL_DB_DIR_ENV];
    else process.env[READ_MODEL_DB_DIR_ENV] = saved;
    await flushReadModelTransactions();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
