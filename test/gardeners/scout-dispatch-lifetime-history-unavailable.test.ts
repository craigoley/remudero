import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditedLifetimeTalliesFromArchives, MAX_LIFETIME_ARCHIVE_START_IDENTITIES } from "#src/run-task.js";

test("W1-T10228: dispatch.lifetime_history_unavailable no longer recurs", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-lifetime-history-"));
  try {
    // The live ledger had 5134 distinct run starts over 470 archives; the old 4096 ceiling fired on it.
    const count = 5_134;
    assert.ok(MAX_LIFETIME_ARCHIVE_START_IDENTITIES > count, "the backstop sits above a measured healthy history");
    const rows = Array.from({ length: count }, (_, n) => ({
      ts: "2026-09-17T00:00:00.000Z", task_id: `W1-T${n % 50}`, run_id: `run-${n}`, step: "run.start",
    }));
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(result.unavailableReason, undefined);
    assert.notEqual(result.history, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
