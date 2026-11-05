import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { createAnalysisEvidenceReader, nativeAnalysisEvidenceWithinBounds } from "#src/lib/model-canary-analysis-evidence-adapter.js";

function ownerDb(directory: string, receipt?: string) {
  const path = join(directory, "model-canary-slots.sqlite");
  closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE canary_slots_v1 (
    id TEXT PRIMARY KEY, binding TEXT NOT NULL, owner TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('started','terminal')), receipt TEXT);
    CREATE UNIQUE INDEX canary_one_active_v1
    ON canary_slots_v1((1)) WHERE phase='started';`);
  if (receipt) db.prepare("INSERT INTO canary_slots_v1(id,binding,owner,phase,receipt) VALUES(?,?,?,?,?)")
    .run("a".repeat(64), "binding", "owner", "terminal", receipt);
  db.close();
}
function receipt() {
  return JSON.stringify({
    slot: { id: "a".repeat(64), caseId: "case-1", pin: { model: "m", route: "r", effort: "e",
      suiteHash: "b".repeat(64), billing: "subscription" } },
    run: { id: "run-1", caseId: "case-1", suiteHash: "b".repeat(64), model: "m", route: "r", effort: "e",
      family: "general", executionSource: "native-provider-execution", verified: true, totalDurationMs: 10, attempts: [] },
    grade: { passed: true, reason: "ok", schemaValid: true }, state: "scored", reason: "ok",
    privateTrace: { finalText: "private prompt and answer must not escape" },
  });
}

test("analysis evidence reader consumes existing same-owner terminal rows read-only", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-canary-owner-`));
  try {
    ownerDb(directory, receipt());
    const result = createAnalysisEvidenceReader(directory)();
    assert.equal(result.state, "available");
    if (result.state === "available") {
      assert.equal(result.evidence.receipts.length, 1);
      assert.equal(result.evidence.receipts[0]!.run.verified, true);
      assert.equal(JSON.stringify(result).includes("private prompt and answer"), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("analysis evidence reader refuses missing owner state without creating a database", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-canary-owner-missing-`));
  try {
    const result = createAnalysisEvidenceReader(directory)();
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "canary-owner-db-not-private");
    assert.equal(existsSync(join(directory, "model-canary-slots.sqlite")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("analysis evidence reader refuses an oversized aggregate corpus before loading receipt rows", () => {
  assert.equal(nativeAnalysisEvidenceWithinBounds(2, 1024), true);
  assert.equal(nativeAnalysisEvidenceWithinBounds(2, 64 * 1024 * 1024 + 1), false);
  assert.equal(nativeAnalysisEvidenceWithinBounds(100_001, 1), false);
});
