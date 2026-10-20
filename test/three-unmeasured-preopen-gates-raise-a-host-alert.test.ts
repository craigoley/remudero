import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { appendLedger, rotateLedger } from "#src/lib/ledger.js";
import { drainEscalationSpool, escalationSpoolDir, type SpoolEntry } from "#src/lib/host-escalation-spool.js";
import { detectUnmeasuredPreopenStreak, PREOPEN_GATE_STEP, PREOPEN_UNMEASURED_ALERT_AT, updatePreopenGateAlert } from "#src/lib/preopen-gate.js";
import { readLedgerLines } from "#src/lib/status.js";

function fixture(t: TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-preopen-alert-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const clock = fixedClock(Date.now());
  const rows = () => readLedgerLines(ledgerPath);
  const log = (step: string, extra = {}) => appendLedger(ledgerPath, { step, run_id: "observer", task_id: "HARNESS", ...extra });
  const observe = () => updatePreopenGateAlert({ stateDir, readRows: rows, log, clock, host: "test-host" });
  let n = 0;
  const gate = (result: string) => {
    n++;
    appendLedger(ledgerPath, { step: PREOPEN_GATE_STEP, run_id: `run-${n}`, task_id: `task-${n}`, host: `host-${n % 3}`,
      result, reason: `unmeasured reason ${n}` }, { clock: fixedClock(clock.now() + n * 1000) });
    observe();
  };
  const pending = (): SpoolEntry[] => {
    try {
      return readdirSync(escalationSpoolDir(stateDir)).filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(readFileSync(join(escalationSpoolDir(stateDir), name), "utf8")) as SpoolEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  return { stateDir, ledgerPath, clock, rows, log, observe, gate, pending };
}

test("W1-T10042: three consecutive unmeasured pre-open gates spool one host alert", async t => {
  const f = fixture(t);
  assert.equal(PREOPEN_UNMEASURED_ALERT_AT, 3);
  f.gate("unmeasured");
  f.gate("unmeasured");
  assert.deepEqual(f.pending(), []);
  f.gate("unmeasured");
  const [entry] = f.pending();
  assert.equal(f.pending().length, 1);
  assert.equal(entry.kind, "escalate");
  if (entry.kind !== "escalate") assert.fail("expected escalation");
  const gates = f.rows().filter(row => row.step === PREOPEN_GATE_STEP);
  assert.match(entry.escalation.detail, /3 consecutive/);
  for (const value of [gates[0].ts, gates[2].ts, "run-1", "unmeasured reason 3"]) {
    assert.ok(entry.escalation.detail.includes(String(value)));
  }
  const alert = f.rows().find(row => row.step === `${PREOPEN_GATE_STEP}.alert`);
  assert.equal(alert?.action, "raised");
  assert.equal(alert?.consecutive, 3);
  assert.equal(alert?.streak_first_ts, gates[0].ts);
  f.gate("unmeasured");
  assert.equal(f.pending().length, 1);
  assert.equal(f.rows().filter(row => row.step === `${PREOPEN_GATE_STEP}.alert`).length, 1);
  let posted = 0;
  await drainEscalationSpool(f.stateDir, { clock: f.clock,
    escalate: async () => { posted++; return "https://example.test/issues/1"; },
    close: async () => {}, comment: async () => {} });
  f.gate("unmeasured");
  assert.equal(posted, 1);
  assert.deepEqual(f.pending(), []);
});

test("W1-T10042: a measured pre-open gate resets the streak and clears the alert", async t => {
  for (const measured of ["pass", "fail"]) {
    const f = fixture(t);
    f.gate("unmeasured");
    f.gate("unmeasured");
    f.gate(measured);
    assert.deepEqual(f.pending(), []);
    f.gate("unmeasured");
    f.gate("unmeasured");
    assert.deepEqual(f.pending(), []);
    f.gate("unmeasured");
    f.gate(measured);
    assert.deepEqual(f.pending(), []);
    assert.equal(detectUnmeasuredPreopenStreak(f.rows()).consecutive, 0);
    assert.deepEqual(f.rows().filter(row => row.step === `${PREOPEN_GATE_STEP}.alert`).map(row => row.action), ["raised", "cleared"]);
    f.gate("unmeasured");
    f.gate("unmeasured");
    f.gate("unmeasured");
    const posted: string[] = [];
    await drainEscalationSpool(f.stateDir, { clock: f.clock,
      escalate: async () => { posted.push("raised"); return "https://example.test/issues/1"; },
      close: async () => {}, comment: async () => {} });
    assert.deepEqual(posted, ["raised"]);
    f.gate(measured);
    assert.equal(f.pending()[0]?.kind, "close");
    f.gate(measured);
    assert.equal(f.rows().filter(row => row.step === `${PREOPEN_GATE_STEP}.alert` && row.action === "cleared").length, 2);
  }
});

test("W1-T10042: a streak across a rotation is one alert raised at the third row", t => {
  const f = fixture(t);
  for (let n = 1; n <= 22; n++) {
    f.gate("unmeasured");
    assert.equal(f.pending().length, n < 3 ? 0 : 1);
    if ([2, 4, 7, 10, 13, 16, 19].includes(n)) {
      writeFileSync(f.ledgerPath, JSON.stringify({ step: "noise", detail: "x".repeat(200_000) }) + "\n", { flag: "a" });
      assert.equal(rotateLedger(f.ledgerPath, { ceilingBytes: 100_000, smoothingWindowMs: 0 }).rotated, true);
    }
  }
  assert.equal(detectUnmeasuredPreopenStreak(f.rows()).consecutive, 22);
  const alerts = f.rows().filter(row => row.step === `${PREOPEN_GATE_STEP}.alert`);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].consecutive, 3);
  assert.equal(alerts[0].action, "raised");
  assert.equal(f.pending()[0].count, 1);
});

test("unrelated rows do not break the fleet streak and a custom threshold is honoured", () => {
  const rows = [
    { step: PREOPEN_GATE_STEP, result: "unmeasured", ts: "first", run_id: "a", reason: "sandbox" },
    { step: "unrelated", result: "pass" },
    { step: PREOPEN_GATE_STEP, result: "unmeasured", ts: "last", run_id: "b", reason: "backstop" },
  ];
  assert.deepEqual(detectUnmeasuredPreopenStreak(rows, 2), {
    alert: true, consecutive: 2, firstTs: "first", firstRunId: "a", newestTs: "last", reason: "backstop",
  });
  assert.equal(detectUnmeasuredPreopenStreak(rows).alert, false);
});

test("an alert failure is logged without throwing into the build path", t => {
  const f = fixture(t);
  updatePreopenGateAlert({ stateDir: f.stateDir, readRows: () => { throw new Error("ledger unreadable"); }, log: f.log });
  assert.match(String(f.rows().at(-1)?.reason), /ledger unreadable/);
  f.gate("unmeasured");
  f.gate("unmeasured");
  writeFileSync(join(f.stateDir, "escalation-spool"), "blocked");
  f.gate("unmeasured");
  assert.equal(f.rows().at(-1)?.action, "failed");
  assert.match(String(f.rows().at(-1)?.reason), /EEXIST|ENOTDIR/);
  rmSync(join(f.stateDir, "escalation-spool"));
  f.gate("unmeasured");
  assert.equal(f.pending().length, 1);
  assert.equal(f.rows().at(-1)?.consecutive, 4);
  assert.equal(f.rows().at(-1)?.action, "raised");
});
