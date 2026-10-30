import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { preopenGateHealth, readPreopenGateRows } from "#src/lib/preopen-gate-health.js";
import { defaultRunGate, PREOPEN_GATE_STEP, preopenGateLedgerFields, runPreopenGate, updatePreopenGateAlert } from "#src/lib/preopen-gate.js";
import { escalationSpoolDir, type SpoolEntry } from "#src/lib/host-escalation-spool.js";
import { appendLedger, rotateLedger } from "#src/lib/ledger.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";

const now = Date.UTC(2026, 9, 28);
const day = 24 * 60 * 60_000;
type Row = Record<string, unknown>;
function gate(result: string, offset: number, extra: Row = {}): Row {
  return { step: PREOPEN_GATE_STEP, result, ts: new Date(now + offset).toISOString(), duration_ms: 600_000, ...extra };
}
function history(passes = 46, failures = 53): Row[] {
  return [...Array.from({ length: failures }, (_, i) => gate("fail", -day + i)),
    ...Array.from({ length: passes }, (_, i) => gate("pass", -day / 2 + i))];
}
function stopped(): Row[] {
  return [...history(), ...Array.from({ length: 30 }, (_, i) => gate(i % 2 ? "unmeasured" : "fail", -1000 + i,
    { failed: ["typecheck"], failed_detail: { typecheck: "tsc failed: fixture diagnostic" } }))];
}
function state(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-preopen-health-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("W1-T10921: the backstop is learned from the gate s own measured runs", () => {
  const rows = [gate("pass", -500, { duration_ms: 4_000_000 }),
    ...Array.from({ length: 98 }, (_, i) => gate("fail", -400 + i, { duration_ms: 400_000 + i * 10_000 })),
    gate("unmeasured", -1, { duration_ms: 9_000_000 }),
    gate("pass", -8 * day, { duration_ms: 20_000_000 }),
    { step: "other", result: "pass", ts: new Date(now).toISOString(), duration_ms: 99_000_000 }];
  const health = preopenGateHealth(rows, now);
  assert.equal(health.backstopBasis, "measured-p95-plus-iqr");
  assert.ok(health.backstopMs >= 4_000_000, "even a pass above P95 plus spread remains protected");
  assert.ok(health.backstopMs < 9_000_000);
  const slower = preopenGateHealth(rows.map(row => ({ ...row, duration_ms: Number(row.duration_ms) * 2 })), now);
  assert.equal(slower.backstopMs, health.backstopMs * 2);
  const stored = gate("skipped", -8 * day, { backstop_ms: health.backstopMs, backstop_basis: health.backstopBasis });
  assert.equal(preopenGateHealth([stored], now).backstopMs, health.backstopMs);
  assert.equal(preopenGateHealth([stored], now).backstopBasis, "persisted");
  assert.equal(preopenGateHealth([], now).backstopBasis, "cold-start");
  assert.equal(preopenGateHealth([], now).backstopMs, 900_000);
  assert.equal(preopenGateHealth([gate("fail", -1, { duration_ms: NaN })], now).backstopBasis, "cold-start");
});

test("W1-T10921: a gate that stopped passing against its own history is unhealthy", () => {
  const failures = Array.from({ length: 8 }, (_, i) => gate("fail", -100 + i));
  assert.equal(preopenGateHealth([...history(90, 10), ...failures], now).state, "unhealthy");
  assert.equal(preopenGateHealth([...history(10, 90), ...failures], now).state, "healthy");
  const unhealthy = preopenGateHealth(stopped(), now);
  assert.equal(unhealthy.state, "unhealthy");
  assert.equal(unhealthy.nonPassStreak, 15);
  assert.equal(preopenGateHealth(stopped(), now + 30 * day).state, "unhealthy", "aging cannot erase a broken gate's history");
  assert.equal(preopenGateHealth(failures, now).state, "unknown", "never passed: no invented baseline");
  assert.equal(preopenGateHealth([...stopped(), gate("pass", 0)], now).state, "healthy");
});

test("W1-T10921: an unhealthy gate stands down behind one canary", async t => {
  const stateDir = state(t);
  const rows = stopped();
  let finish!: (value: { exitCode: number }) => void;
  let runs = 0;
  const deps = {
    clock: fixedClock(now), history: { readRows: () => rows, stateDir },
    runGate: async () => { runs++; return await new Promise<{ exitCode: number }>(resolve => { finish = resolve; }); },
    runPushGate: async () => ({ kind: "skipped" as const, reason: "fixture" }), scanProcfsWrites: () => [],
  };
  const canary = runPreopenGate("/fixture", deps);
  const skipped = await runPreopenGate("/another-fixture", deps);
  assert.equal(skipped.kind, "skipped");
  assert.ok(skipped.kind === "skipped" && skipped.reason === "gate-unhealthy");
  assert.equal(skipped.durationMs, 0);
  assert.equal(runs, 1);
  finish({ exitCode: 0 });
  const passed = await canary;
  assert.equal(passed.kind, "pass");
  assert.equal(preopenGateLedgerFields(passed).canary, true);
  assert.ok(Number(preopenGateLedgerFields(passed).backstop_ms) > 0);
  assert.equal(typeof preopenGateLedgerFields(passed).backstop_basis, "string");
  rows.push(gate(passed.kind, 0, preopenGateLedgerFields(passed)));
  const recovered = await runPreopenGate("/fixture", { ...deps, runGate: async () => ({ exitCode: 0 }) });
  assert.equal(recovered.kind, "pass");
  assert.equal(preopenGateLedgerFields(recovered).canary, false);
  const failed = await runPreopenGate("/fixture", { ...deps, history: { readRows: stopped, stateDir },
    runGate: async () => ({ exitCode: 1, summary: { failedSteps: ["typecheck"] } }) });
  assert.equal(failed.kind, "fail");
  const retried = await runPreopenGate("/fixture", { ...deps, history: { readRows: stopped, stateDir },
    runGate: async () => ({ exitCode: 0 }) });
  assert.equal(retried.kind, "pass", "a failed canary releases its slot");
});

test("W1-T10921: only a pass clears the unhealthy gate alert", t => {
  const stateDir = state(t);
  const rows = stopped();
  const log = (step: string, extra: Row = {}) => { rows.push({ step, ...extra }); };
  const observe = () => updatePreopenGateAlert({ stateDir, readRows: () => rows, log, clock: fixedClock(now) });
  const pending = (): SpoolEntry[] => readdirSync(escalationSpoolDir(stateDir)).filter(n => n.endsWith(".json"))
    .map(n => JSON.parse(readFileSync(join(escalationSpoolDir(stateDir), n), "utf8")) as SpoolEntry);
  observe();
  const entry = pending()[0];
  assert.equal(entry.kind, "escalate");
  if (entry.kind !== "escalate") assert.fail("expected escalation");
  assert.match(entry.escalation.detail, /15.*non-passes/);
  assert.ok(entry.escalation.detail.includes(String(history().at(-1)?.ts)));
  assert.match(entry.escalation.detail, /typecheck.*tsc failed: fixture diagnostic/);
  rows.push(gate("fail", 0));
  observe();
  rows.push(gate("skipped", 0, { reason: "gate-unhealthy" }));
  observe();
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].count, 1);
  assert.deepEqual(rows.filter(r => r.step === `${PREOPEN_GATE_STEP}.alert`).map(r => r.action), ["raised"]);
  rows.push(gate("pass", 0));
  observe();
  assert.equal(pending().length, 0);
  assert.deepEqual(rows.filter(r => r.step === `${PREOPEN_GATE_STEP}.alert`).map(r => r.action), ["raised", "cleared"]);
});

test("an existing unmeasured alert gains the unhealthy gate diagnostics once", t => {
  const stateDir = state(t);
  const rows = [...history(), ...Array.from({ length: 3 }, (_, i) => gate("unmeasured", -2000 + i))];
  const log = (step: string, extra: Row = {}) => { rows.push({ step, ...extra }); };
  const observe = () => updatePreopenGateAlert({ stateDir, readRows: () => rows, log, clock: fixedClock(now) });
  const pending = (): SpoolEntry[] => readdirSync(escalationSpoolDir(stateDir)).filter(n => n.endsWith(".json"))
    .map(n => JSON.parse(readFileSync(join(escalationSpoolDir(stateDir), n), "utf8")) as SpoolEntry);
  observe();
  const original = pending()[0];
  assert.equal(original.kind, "escalate");
  rows.push(...stopped().slice(history().length));
  observe();
  const [updated] = pending();
  assert.equal(pending().length, 1);
  assert.equal(updated.key, original.key);
  assert.equal(updated.kind, "escalate");
  if (updated.kind !== "escalate") assert.fail("expected escalation");
  assert.match(updated.escalation.detail, /15.*non-passes/);
  assert.match(updated.escalation.detail, /typecheck.*tsc failed: fixture diagnostic/);
  assert.ok(updated.escalation.detail.includes(String(history().at(-1)?.ts)));
  const count = updated.count;
  rows.push(gate("fail", 0));
  observe();
  assert.equal(pending()[0].count, count, "further failures do not repeat the alert update");
  rows.push(gate("pass", 0));
  observe();
  assert.equal(pending().length, 0);
});

test("history and canary admission failures are unmeasured with their reason", async t => {
  const stateDir = state(t);
  const runGate = async () => { assert.fail("must not launch without admission"); };
  const unreadable = await runPreopenGate("/fixture", { runGate, history: { stateDir, readRows: () => { throw new Error("history unavailable"); } } });
  assert.ok(unreadable.kind === "unmeasured" && unreadable.reason.includes("history unavailable"));
  const corruptHistory = state(t);
  writeFileSync(join(corruptHistory, "ledger.2026-10-01.ndjson.gz"), "not gzip");
  assert.throws(() => readPreopenGateRows(corruptHistory), /pre-open gate history unreadable:.*ledger\.2026-10-01/);
  writeFileSync(join(stateDir, "preopen-canary"), "blocked");
  const blocked = await runPreopenGate("/fixture", { runGate, clock: fixedClock(now), history: { stateDir, readRows: stopped } });
  assert.ok(blocked.kind === "unmeasured" && /EEXIST|ENOTDIR/.test(blocked.reason));
});

test("gate health reads passes and alert identity across a real ledger rotation", t => {
  const stateDir = state(t);
  const ledger = join(stateDir, LEDGER_FILENAME);
  for (const row of stopped()) appendLedger(ledger, { run_id: "fixture", task_id: "HARNESS", step: PREOPEN_GATE_STEP, ...row }, { clock: fixedClock(Date.parse(String(row.ts))) });
  appendLedger(ledger, { run_id: "observer", task_id: "HARNESS", step: `${PREOPEN_GATE_STEP}.alert`, action: "raised", health_state: "unhealthy" }, { clock: fixedClock(now) });
  appendLedger(ledger, { run_id: "noise", task_id: "HARNESS", step: "noise", detail: "x".repeat(200_000) });
  assert.equal(rotateLedger(ledger, { ceilingBytes: 100_000, smoothingWindowMs: 0 }).rotated, true);
  const rows = readPreopenGateRows(stateDir);
  assert.equal(preopenGateHealth(rows, now).state, "unhealthy");
  assert.equal(rows.filter(row => row.step === `${PREOPEN_GATE_STEP}.alert`).length, 1);
  appendLedger(ledger, { run_id: "recovered", task_id: "HARNESS", step: PREOPEN_GATE_STEP, ...gate("pass", 0) }, { clock: fixedClock(now) });
  const recovered = readPreopenGateRows(stateDir);
  assert.equal(preopenGateHealth(recovered, now).state, "healthy");
  assert.ok(recovered.some(row => row.result === "pass"), "positive control: the union contains measured gates");
});

test("the real deadline runner accepts the learned backstop", async t => {
  const cwd = state(t);
  const backstopMs = preopenGateHealth([gate("pass", -1, { duration_ms: 5000 })], now).backstopMs;
  const result = await defaultRunGate(cwd, process.execPath, undefined, { backstopMs }, {
    contain: () => ({ mode: "sandboxed", file: process.execPath, argv: ["-e", "process.exit(0)", "--"] }),
  });
  assert.equal(result.exitCode, 0, "the deadline runner really spawned the contained child");
});
