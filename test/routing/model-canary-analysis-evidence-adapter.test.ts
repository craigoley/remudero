import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { createAnalysisEvidenceReader, nativeAnalysisEvidenceWithinBounds } from "#src/lib/model-canary-analysis-evidence-adapter.js";
import { CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import { buildCanarySchedule, type CanarySchedulePorts } from "#src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest } from "#src/lib/model-canary-suite.js";

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
      family: "general", executionSource: "native-provider-execution", verified: true, totalDurationMs: 10, attempts: [],
      executionWindow: { startedAt: "2026-11-01T00:00:00.000Z", completedAt: "2026-11-01T00:00:01.000Z" } },
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
      assert.deepEqual(result.evidence.receipts[0]!.executionWindow,
        { startedAt: "2026-11-01T00:00:00.000Z", completedAt: "2026-11-01T00:00:01.000Z" });
      assert.equal("executionWindow" in result.evidence.receipts[0]!.run, false);
      assert.equal("startedAt" in result.evidence.receipts[0]!.run, false);
      assert.equal("completedAt" in result.evidence.receipts[0]!.run, false);
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

test("analysis evidence reader leaves legacy receipts without an execution interval unverified", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-canary-owner-legacy-window-`));
  try {
    const legacy = JSON.parse(receipt()) as Record<string, unknown>;
    const run = legacy.run as Record<string, unknown>;
    delete run.executionWindow;
    ownerDb(directory, JSON.stringify(legacy));
    const result = createAnalysisEvidenceReader(directory)();
    assert.equal(result.state, "available");
    if (result.state === "available") assert.equal(result.evidence.receipts[0]!.executionWindow, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("analysis evidence reader refuses malformed or reversed native execution intervals", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-canary-owner-invalid-window-`));
  try {
    const malformed = JSON.parse(receipt()) as Record<string, unknown>;
    const malformedRun = malformed.run as Record<string, unknown>;
    malformedRun.executionWindow = { startedAt: "not-a-timestamp", completedAt: "2026-11-01T00:00:01.000Z" };
    ownerDb(directory, JSON.stringify(malformed));
    const result = createAnalysisEvidenceReader(directory)();
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "native-analysis-execution-window-invalid");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native owner persists a trusted execution interval that the private reader surfaces", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-canary-owner-timestamps-`));
  const cases = commonCanarySuite().slice(0, 1);
  const [slot] = buildCanarySchedule("2026-11-06", "native-time-control", cases,
    [{ model: "test-model", route: "test-route", effort: "medium",
      suiteHash: canarySuiteDigest(cases), billing: "subscription" }]).slots;
  const owner = new CanarySlotOwner(directory);
  type Outcome = Parameters<CanarySchedulePorts["terminal"]>[1];
  const outcome = { state: "unavailable" as const, reason: "transport-error", trace: [], grade: null,
    error: new Error("not persisted"), run: { id: "native-time-run", caseId: slot.caseId,
      suiteHash: slot.pin.suiteHash, model: slot.pin.model, route: slot.pin.route, effort: slot.pin.effort,
      family: "structured", verified: null, totalDurationMs: 1, attempts: [], outcomeReason: "transport-error" } } as Outcome;
  try {
    assert.equal(owner.claim(slot), "claimed");
    owner.terminal(slot, outcome);
  } finally { owner.close(); }
  try {
    const result = createAnalysisEvidenceReader(directory)();
    assert.equal(result.state, "available");
    if (result.state === "available") {
      const interval = result.evidence.receipts[0]!.executionWindow;
      assert.ok(interval);
      assert.ok(Date.parse(interval.startedAt) <= Date.parse(interval.completedAt));
      const db = new DatabaseSync(join(directory, "model-canary-slots.sqlite"), { readOnly: true });
      try {
        const raw = db.prepare("SELECT receipt FROM canary_slots_v1 WHERE id=?").get(slot.id) as { receipt: string };
        const stored = JSON.parse(raw.receipt) as Record<string, unknown>;
        assert.deepEqual(Object.keys(stored).sort(), ["grade", "reason", "run", "slot", "state"]);
        assert.deepEqual((stored.run as Record<string, unknown>).executionWindow, interval);
      } finally { db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("one-shot coding consumption preserves the owner-generated execution start timestamp", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-canary-owner-coding-window-`));
  const cases = commonCanarySuite().filter(item => item.family === "coding").slice(0, 1);
  const [slot] = buildCanarySchedule("2026-11-06", "native-coding-time-control", cases,
    [{ model: "test-model", route: "test-route", effort: "medium",
      suiteHash: canarySuiteDigest(cases), billing: "subscription" }]).slots;
  const owner = new CanarySlotOwner(directory);
  const input = { runId: "c0044072-86e2-4b85-b871-3735362cb490",
    canaryAttemptId: "d1044072-86e2-4b85-b871-3735362cb491",
    workerSpawnAttemptId: "e2044072-86e2-4b85-b871-3735362cb492", sourceDigest: "a".repeat(64) };
  try {
    assert.equal(owner.claim(slot), "claimed");
    assert.equal(owner.consumeCodingAttempt(slot, input).state, "consumed");
    assert.equal(owner.consumeCodingAttempt(slot, input).state, "already-consumed");
  } finally { owner.close(); }
  try {
    const db = new DatabaseSync(join(directory, "model-canary-slots.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT receipt FROM canary_slots_v1 WHERE id=?").get(slot.id) as { receipt: string };
      const stored = JSON.parse(row.receipt) as Record<string, unknown>;
      assert.equal(stored.version, "canary-coding-consumed-v1");
      assert.equal(typeof stored.startedAt, "string");
      assert.ok(Number.isFinite(Date.parse(stored.startedAt as string)));
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("coding consumption refuses a malformed owner start receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-canary-owner-bad-start-`));
  const cases = commonCanarySuite().filter(item => item.family === "coding").slice(0, 1);
  const [slot] = buildCanarySchedule("2026-11-06", "native-coding-bad-start-control", cases,
    [{ model: "test-model", route: "test-route", effort: "medium",
      suiteHash: canarySuiteDigest(cases), billing: "subscription" }]).slots;
  const owner = new CanarySlotOwner(directory);
  const input = { runId: "c0044072-86e2-4b85-b871-3735362cb490",
    canaryAttemptId: "d1044072-86e2-4b85-b871-3735362cb491",
    workerSpawnAttemptId: "e2044072-86e2-4b85-b871-3735362cb492", sourceDigest: "a".repeat(64) };
  try {
    assert.equal(owner.claim(slot), "claimed");
    const db = new DatabaseSync(join(directory, "model-canary-slots.sqlite"));
    try { db.prepare("UPDATE canary_slots_v1 SET receipt='not-json' WHERE id=?").run(slot.id); }
    finally { db.close(); }
    assert.equal(owner.consumeCodingAttempt(slot, input).state, "refused");
  } finally { owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
