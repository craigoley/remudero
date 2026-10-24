import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditedLifetimeTalliesFromArchives, MAX_LIFETIME_ARCHIVE_START_IDENTITIES } from "#test/helpers/run-task-test.js";

test("W1-T10228: lifetime history counts every identity through the approved backstop", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-lifetime-history-"));
  try {
    const count = MAX_LIFETIME_ARCHIVE_START_IDENTITIES;
    assert.equal(count, 4_096);
    const rows = Array.from({ length: count }, (_, n) => ({
      ts: "2026-09-17T00:00:00.000Z", task_id: `W1-T${n % 50}`, run_id: `run-${n}`, step: "run.start",
    }));
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(result.archiveCount, 1);
    assert.equal(result.records, count);
    assert.equal(result.unavailableReason, undefined);
    assert.ok(result.history);
    for (let task = 0; task < 50; task++) {
      assert.deepEqual(result.history.tallyFor(`W1-T${task}`), {
        starts: Math.floor(count / 50) + Number(task < count % 50), capacityBlocked: 0,
      });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T10228: lifetime history still refuses identity overflow", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-lifetime-overflow-"));
  try {
    const rows = Array.from({ length: MAX_LIFETIME_ARCHIVE_START_IDENTITIES + 1 }, (_, n) => ({
      task_id: "W1-T10228", run_id: `run-${n}`, step: "run.start",
    }));
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(result.archiveCount, 1);
    assert.equal(result.records, rows.length);
    assert.equal(result.unavailableReason, "start_identity_ceiling");
    assert.equal(result.history, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
