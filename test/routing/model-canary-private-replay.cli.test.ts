/** Real CLI-child controls for the explicit synthetic replay path; no provider fake is injected. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import { buildCanarySchedule } from "#src/lib/model-canary-schedule.js";
import { canarySuiteDigest, commonCanarySuite, type CanaryCase } from "#src/lib/model-canary-suite.js";
import type { PrivateCanaryBundleV1, PrivateCanaryCaseV1 } from "#src/lib/model-canary-private-corpus.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DAY = "2026-11-03";
function privateTempRoot(): string {
  const candidates = [tmpdir(), dirname(REPO_ROOT)];
  for (const candidate of candidates) {
    let parent = realpathSync(candidate), unsafe = false;
    for (;;) {
      if (existsSync(join(parent, ".git"))) { unsafe = true; break; }
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
    if (!unsafe) {
      const root = mkdtempSync(join(realpathSync(candidate), "rmd-private-replay-"));
      chmodSync(root, 0o700);
      return root;
    }
  }
  throw new Error("private-replay-test-root-unavailable");
}
function privateDir(path: string): void { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); }
function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600);
}
function fixture(): { bundle: PrivateCanaryBundleV1; item: CanaryCase } {
  const item = { ...commonCanarySuite()[0]!, id: "private-replay-development-control" };
  const other = { ...item, id: "private-replay-unplanned-control" };
  const row = (caseItem: CanaryCase, family: string): PrivateCanaryCaseV1 => ({ item: caseItem,
    provenance: { sourceFamilyId: family, incidentRootId: `${family}-root`, sourceDigest: sha(`${family}-source`),
      observedAt: "2026-11-02T12:00:00.000Z", splitId: "cli-replay-fixture-v1", split: "development", role: "worker" },
    expectedToolTrace: [], scorerVersion: "exact-json-and-application-trace-v1" });
  return { item, bundle: { version: "model-canary-private-bundle-v1",
    development: { version: "model-canary-private-payload-v1", split: "development",
      cases: [row(item, "fixture-family"), row(other, "unplanned-family")] } } };
}
function cli(args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src/lib/model-canary-command.ts"), ...args],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 });
}
function child(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src/lib/model-canary-command.ts"), ...args],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 });
}
function script(item: CanaryCase, seed: string, mode: "pass" | "denied" | "incomplete-denied") {
  const toolCalls = mode === "pass" ? [] : mode === "denied"
    ? [{ name: "unlisted-tool", args: {} }]
    : [{ name: "unlisted-tool", args: {} }, { name: "unlisted-tool", args: { body: "x".repeat(33 * 1024) } }];
  return { version: "model-canary-private-replay-v1", caseId: item.id, day: DAY, seed,
    responses: [{ text: JSON.stringify(item.expected), toolCalls }] };
}
function seedOwner(ownerDir: string): void { privateDir(ownerDir); new CanarySlotOwner(ownerDir).close(); }
function queryOwner(ownerDir: string, slotId: string): { id: string; binding: string; phase: string; receipt: string | null } | undefined;
function queryOwner(ownerDir: string): { count: number };
function queryOwner(ownerDir: string, slotId?: string) {
  const db = new DatabaseSync(join(ownerDir, "model-canary-slots.sqlite"), { readOnly: true });
  try {
    if (slotId) return db.prepare("SELECT id,binding,phase,receipt FROM canary_slots_v1 WHERE id=?").get(slotId) as
      { id: string; binding: string; phase: string; receipt: string | null } | undefined;
    return db.prepare("SELECT COUNT(*) AS count FROM canary_slots_v1").get() as { count: number };
  } finally { db.close(); }
}
function malformedOwner(root: string, name: string, tableSql: string, indexSql: string) {
  const ownerDir = join(root, name);
  privateDir(ownerDir);
  const dbPath = join(ownerDir, "model-canary-slots.sqlite");
  const db = new DatabaseSync(dbPath);
  try { db.exec(tableSql); db.exec(indexSql); }
  finally { db.close(); }
  chmodSync(dbPath, 0o600);
  return ownerDir;
}
function ownerSchema(ownerDir: string): string {
  const db = new DatabaseSync(join(ownerDir, "model-canary-slots.sqlite"), { readOnly: true });
  try {
    return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all());
  } finally { db.close(); }
}
function ownerRows(ownerDir: string): number | null {
  const db = new DatabaseSync(join(ownerDir, "model-canary-slots.sqlite"), { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='canary_slots_v1'").get();
    return exists ? Number((db.prepare("SELECT COUNT(*) AS count FROM canary_slots_v1").get() as { count: number }).count) : null;
  } finally { db.close(); }
}
function assertReplayRejectedUnchanged(corpusPath: string, replayPath: string, ownerDir: string, expectedRows: number | null) {
  const before = ownerSchema(ownerDir);
  const result = child(["replay-private", corpusPath, replayPath, ownerDir]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(ownerRows(ownerDir), expectedRows);
  assert.equal(ownerSchema(ownerDir), before, "failed owner preflight must leave schema unchanged");
}
function inputFiles(root: string, suffix: string, bundle: PrivateCanaryBundleV1, replay: unknown) {
  const corpusPath = join(root, `corpus-${suffix}.json`), replayPath = join(root, `replay-${suffix}.json`);
  privateJson(corpusPath, bundle); privateJson(replayPath, replay);
  return { corpusPath, replayPath };
}
function runReplay(root: string, mode: "pass" | "denied" | "incomplete-denied") {
  const { bundle, item } = fixture(), seed = `fixture-${mode}`;
  const ownerDir = join(root, `owner-${mode}`), gradeDir = join(root, `grade-${mode}`);
  seedOwner(ownerDir); privateDir(gradeDir);
  const replayInput = script(item, seed, mode), { corpusPath, replayPath } = inputFiles(root, mode, bundle, replayInput);
  const replay = JSON.parse(cli(["replay-private", corpusPath, replayPath, ownerDir]));
  assert.equal(replay.state, "synthetic-control-replay");
  assert.equal(replay.executionSource, "synthetic-control-replay");
  assert.equal(replay.providerCalls, 0);
  assert.equal(replay.providerIdentity, null); assert.equal(replay.usage, null); assert.equal(replay.cost, null);
  assert.equal(replay.caseId, item.id);
  assert.ok(replay.runId); assert.ok(replay.caseId); assert.ok(replay.binding);
  const slotId = replay.slotId ?? replay.slot?.id;
  assert.ok(slotId);
  assert.equal(JSON.stringify(replay).includes(item.prompt), false, "CLI does not emit the private prompt");
  assert.equal(JSON.stringify(replay).includes(JSON.stringify(item.expected)), false, "CLI does not emit expected output");
  const stored = queryOwner(ownerDir, slotId);
  assert.ok(stored); assert.equal(stored.phase, "terminal"); assert.ok(stored.receipt);
  const ownerReceipt = JSON.parse(stored.receipt!);
  const storedRun = ownerReceipt.run as Record<string, unknown>;
  assert.equal(storedRun.executionSource, "synthetic-control-replay", "source marker is durable in the owner row");
  assert.equal((storedRun.sourceActivity as { kind: string }).kind, "synthetic-canary");
  assert.equal(storedRun.id, replay.runId);
  const gradeInputPath = join(root, `grade-input-${mode}.json`);
  privateJson(gradeInputPath, { version: "model-canary-private-grade-input-v1",
    slot: ownerReceipt.slot, binding: replay.binding });
  const grade = JSON.parse(cli(["grade-private", gradeDir, corpusPath, ownerDir, gradeInputPath]));
  const gradeFile = JSON.parse(readFileSync(join(gradeDir, "model-canary-private-grade.json"), "utf8"));
  return { replay, stored, storedRun, grade, gradeFile, ownerDir, corpusPath, replayPath, replayInput, item };
}

test("real private replay CLI runs recorded responses and trusted owner regrade without provider evidence", () => {
  const root = privateTempRoot();
  try {
    const passing = runReplay(root, "pass");
    assert.equal(passing.grade.gradeState, "scored"); assert.equal(passing.grade.passed, true);
    assert.equal(passing.gradeFile.observedUnauthorizedAction, false);
    const denied = runReplay(root, "denied");
    assert.equal(denied.grade.gradeState, "scored"); assert.equal(denied.grade.passed, false);
    assert.equal(denied.gradeFile.observedUnauthorizedAction, true);
    const incomplete = runReplay(root, "incomplete-denied");
    assert.equal(incomplete.replay.grade.state, "unavailable");
    assert.equal(incomplete.replay.observedUnauthorizedAction, true);
    const trace = incomplete.stored.receipt ? JSON.parse(incomplete.stored.receipt).privateTrace : null;
    assert.equal(trace.complete, false);
    assert.equal(trace.events.some((event: { denied: boolean }) => event.denied), true);
    assert.equal(incomplete.grade.gradeState, "unavailable"); assert.equal(incomplete.grade.passed, null);
    assert.equal(incomplete.gradeFile.observedUnauthorizedAction, true);

    const projectionDir = join(root, "projection"); privateDir(projectionDir);
    const runFile = join(root, "synthetic-runs.json"); privateJson(runFile, [JSON.parse(incomplete.stored.receipt!).run]);
    const projected = JSON.parse(cli(["project", projectionDir, runFile]));
    const metrics = JSON.parse(readFileSync(join(projectionDir, "model-canary-metrics.json"), "utf8"));
    assert.equal(projected.state, "private-projection");
    assert.equal(metrics.groups.length, 1);
    assert.equal(metrics.groups[0].executionSource, "synthetic-control-replay");
    assert.equal(metrics.groups.some((group: { executionSource: string }) => group.executionSource === "native-provider-execution"), false,
      "synthetic-control results never enter native provider quality denominators");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay CLI refuses imported tool results and excess responses before claiming a slot", () => {
  const root = privateTempRoot();
  try {
    const { bundle, item } = fixture(), ownerDir = join(root, "owner-invalid"); seedOwner(ownerDir);
    const corpusPath = join(root, "corpus.json"); privateJson(corpusPath, bundle);
    const forged = script(item, "forged-result", "denied") as Record<string, unknown>;
    const response = (forged.responses as Array<Record<string, unknown>>)[0]!;
    response.executionSource = "native-provider-execution";
    response.toolCalls = [{ name: "unlisted-tool", args: {}, denied: false, result: { authorized: true } }];
    const forgedPath = join(root, "forged.json"); privateJson(forgedPath, forged);
    const refused = child(["replay-private", corpusPath, forgedPath, ownerDir]);
    assert.notEqual(refused.status, 0, "serialized execution/source/tool results cannot claim authority");
    assert.equal(queryOwner(ownerDir).count, 0, "invalid script is rejected before a slot is claimed");

    const excessPath = join(root, "excess.json");
    privateJson(excessPath, { version: "model-canary-private-replay-v1", caseId: item.id, day: DAY, seed: "excess",
      responses: Array.from({ length: 4 }, () => ({ text: "{}", toolCalls: [] })) });
    const excess = child(["replay-private", corpusPath, excessPath, ownerDir]);
    assert.notEqual(excess.status, 0);
    assert.equal(queryOwner(ownerDir).count, 0, "over-bound response scripts do not consume a slot");

    const unknownPath = join(root, "unknown-case.json");
    privateJson(unknownPath, { ...script(item, "unknown-case", "pass"), caseId: "not-in-private-corpus" });
    const unknown = child(["replay-private", corpusPath, unknownPath, ownerDir]);
    assert.notEqual(unknown.status, 0, "a plan case absent from validated private custody is rejected");
    assert.equal(queryOwner(ownerDir).count, 0, "unknown plan cases are refused before claiming a slot");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay CLI rejects owner databases with lookalike schema before mutation", () => {
  const root = privateTempRoot();
  try {
    const { bundle, item } = fixture();
    const corpusPath = join(root, "schema-corpus.json"); privateJson(corpusPath, bundle);
    const replayPath = join(root, "schema-replay.json"); privateJson(replayPath, script(item, "schema-check", "pass"));
    const table = `CREATE TABLE canary_slots_v1 (
      id TEXT PRIMARY KEY, binding TEXT NOT NULL, owner TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('started','terminal')), receipt TEXT)`;
    const activeByOwner = `CREATE UNIQUE INDEX canary_one_active_v1
      ON canary_slots_v1(owner) WHERE phase='started'`;
    const wrongIndexOwner = malformedOwner(root, "owner-wrong-active-index", table, activeByOwner);
    const wrongIndexSchema = ownerSchema(wrongIndexOwner);
    const wrongIndexRun = child(["replay-private", corpusPath, replayPath, wrongIndexOwner]);
    assert.notEqual(wrongIndexRun.status, 0, "a same-name index on owner does not enforce one active slot globally");
    assert.equal(wrongIndexRun.stdout, "");
    assert.equal(ownerRows(wrongIndexOwner), 0);
    assert.equal(ownerSchema(wrongIndexOwner), wrongIndexSchema, "preflight leaves the malformed owner schema untouched");

    const missingConstraints = `CREATE TABLE canary_slots_v1 (
      id TEXT, binding TEXT NOT NULL, owner TEXT NOT NULL, phase TEXT NOT NULL, receipt TEXT)`;
    const expectedIndex = `CREATE UNIQUE INDEX canary_one_active_v1
      ON canary_slots_v1((1)) WHERE phase='started'`;
    const unconstrainedOwner = malformedOwner(root, "owner-missing-constraints", missingConstraints, expectedIndex);
    const unconstrainedSchema = ownerSchema(unconstrainedOwner);
    const unconstrainedRun = child(["replay-private", corpusPath, replayPath, unconstrainedOwner]);
    assert.notEqual(unconstrainedRun.status, 0, "column names and an active index do not replace primary-key and phase constraints");
    assert.equal(unconstrainedRun.stdout, "");
    assert.equal(ownerRows(unconstrainedOwner), 0);
    assert.equal(ownerSchema(unconstrainedOwner), unconstrainedSchema, "preflight neither repairs nor claims the owner database");

    for (const predicate of ["terminal", "STARTED", "sta rted"]) {
      const indexOwner = malformedOwner(root, `owner-predicate-${predicate.replace(/[^A-Za-z]/g, "-")}`, table,
        `CREATE UNIQUE INDEX canary_one_active_v1 ON canary_slots_v1((1)) WHERE phase='${predicate}'`);
      assertReplayRejectedUnchanged(corpusPath, replayPath, indexOwner, 0);
    }

    const extraIndexOwner = malformedOwner(root, "owner-extra-index", table,
      `${expectedIndex}; CREATE INDEX canary_extra_index ON canary_slots_v1(id)`);
    assertReplayRejectedUnchanged(corpusPath, replayPath, extraIndexOwner, 0);

    const commentedPredicateOwner = malformedOwner(root, "owner-commented-predicate", table,
      "CREATE UNIQUE INDEX canary_one_active_v1 ON canary_slots_v1((1)) WHERE phase /* unsupported dialect */ ='started'");
    assertReplayRejectedUnchanged(corpusPath, replayPath, commentedPredicateOwner, 0);

    const missingTable = malformedOwner(root, "owner-missing-table", "CREATE TABLE unrelated (id TEXT)",
      "CREATE INDEX unrelated_idx ON unrelated(id)");
    assertReplayRejectedUnchanged(corpusPath, replayPath, missingTable, null);

    const missingIndex = malformedOwner(root, "owner-missing-index", table, "CREATE INDEX unrelated_idx ON canary_slots_v1(id)");
    assertReplayRejectedUnchanged(corpusPath, replayPath, missingIndex, 0);

    const triggerOwner = malformedOwner(root, "owner-extra-trigger", table, `${expectedIndex};
      CREATE TRIGGER canary_extra_trigger AFTER INSERT ON canary_slots_v1
      BEGIN SELECT RAISE(IGNORE); END`);
    assertReplayRejectedUnchanged(corpusPath, replayPath, triggerOwner, 0);

    const directoryModeOwner = malformedOwner(root, "owner-directory-mode", table, expectedIndex);
    const directoryModeSchema = ownerSchema(directoryModeOwner);
    chmodSync(directoryModeOwner, 0o750);
    const directoryRefusal = child(["replay-private", corpusPath, replayPath, directoryModeOwner]);
    assert.notEqual(directoryRefusal.status, 0); assert.equal(directoryRefusal.stdout, "");
    assert.equal(ownerRows(directoryModeOwner), 0);
    chmodSync(directoryModeOwner, 0o700);
    assert.equal(ownerSchema(directoryModeOwner), directoryModeSchema);

    const fileModeOwner = malformedOwner(root, "owner-file-mode", table, expectedIndex);
    const filePath = join(fileModeOwner, "model-canary-slots.sqlite"), fileModeSchema = ownerSchema(fileModeOwner);
    chmodSync(filePath, 0o640);
    const fileRefusal = child(["replay-private", corpusPath, replayPath, fileModeOwner]);
    assert.notEqual(fileRefusal.status, 0); assert.equal(fileRefusal.stdout, "");
    chmodSync(filePath, 0o600);
    assert.equal(ownerRows(fileModeOwner), 0);
    assert.equal(ownerSchema(fileModeOwner), fileModeSchema);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replay CLI uses the existing owner for busy and duplicate-slot refusal", () => {
  const root = privateTempRoot();
  try {
    const { bundle, item } = fixture(), seed = "reused-slot", ownerDir = join(root, "owner-serial"); seedOwner(ownerDir);
    const replayInput = script(item, seed, "pass"), { corpusPath, replayPath } = inputFiles(root, "serial", bundle, replayInput);
    const pin = { model: "offline-replay-control", route: "synthetic-control", effort: "fixture",
      suiteHash: canarySuiteDigest([item]), billing: "subscription" as const };
    const slot = buildCanarySchedule(DAY, seed, [item], [pin]).slots[0]!;
    const owner = new CanarySlotOwner(ownerDir);
    try { assert.equal(owner.claim(slot), "claimed"); } finally { owner.close(); }
    const busy = child(["replay-private", corpusPath, replayPath, ownerDir]);
    assert.notEqual(busy.status, 0, "an already-started owner slot fails closed before replay output");
    assert.equal(busy.stdout, "");
    const row = queryOwner(ownerDir, slot.id);
    assert.ok(row); assert.equal(row.phase, "started"); assert.equal(row.receipt, null);

    const duplicateOwner = join(root, "owner-duplicate"); seedOwner(duplicateOwner);
    const first = child(["replay-private", corpusPath, replayPath, duplicateOwner]);
    assert.equal(first.status, 0, String(first.stderr));
    const duplicate = child(["replay-private", corpusPath, replayPath, duplicateOwner]);
    assert.notEqual(duplicate.status, 0, "a terminal schedule slot fails closed before replay output");
    assert.equal(duplicate.stdout, "");
    assert.equal(queryOwner(duplicateOwner).count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
