import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { DEFAULT_SWEEP_POLICY, runSweep } from "./helpers/sweep-test.js";

// W1-T5996 — runSweep's W1-T4817 block used to catch readFleetState's refusal and only log it, so
// the fleet-state reconciler refused on every full pass with no incident. The first refusal for a
// reason now raises one incident.event naming the path and the remedy; repeats only log.

const STATE_DIR = "/home/node/Remudero/state";
const BAK = `${STATE_DIR}/ledger.ndjson.bak`;

function harness() {
  const ledger: Record<string, unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  let reason = `fleet reconciliation history unreadable: ${BAK}`;
  const pass = () => runSweep([], {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: `${STATE_DIR}/ledger.ndjson`, runId: "t5996",
    readLedger: () => [...ledger], appendLine: (_p, e) => { ledger.push(e); },
    readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set<string>(), runningLong: new Set<string>() }),
    readFleetState: async () => { throw new Error(reason); },
    log: (step, data) => { logs.push({ step, ...data }); },
  }, DEFAULT_SWEEP_POLICY);
  const incidents = () => ledger.filter((e) => e.step === "incident.event" && e.name === "reconcile.unreadable");
  return { ledger, logs, pass, incidents, setReason: (r: string) => { reason = r; } };
}

test("a fleet reconciler that cannot read its history raises one incident naming the unreadable path, and repeated passes with the same reason raise no second one", async () => {
  const h = harness();
  for (let cycle = 0; cycle < 3; cycle++) await h.pass();

  const incidents = h.incidents();
  assert.equal(incidents.length, 1, "one incident for the first refusal, none for its repeats");
  const [incident] = incidents;
  const reason = `fleet reconciliation history unreadable: ${BAK}`;
  assert.equal(incident?.kind, "invariant");
  assert.equal(incident?.task_id, "INCIDENT");
  assert.equal(incident?.source, "daemon");
  assert.equal(incident?.run_id, "t5996");
  assert.equal(incident?.fingerprint, createHash("sha256").update(reason).digest("hex"));
  assert.ok(String(incident?.message).includes(BAK), "the incident names the unreadable path");
  assert.match(String(incident?.message), /move .* out of the state dir/i, "the incident names the remedy");
  assert.ok(String(incident?.message).includes(STATE_DIR), "the remedy names the state dir");

  const refusals = h.logs.filter((e) => e.step === "reconcile.unreadable" && e.reason === reason);
  assert.equal(refusals.length, 3, "every pass still logs its refusal");
});

test("a new unreadable reason raises a new incident, and its repeats raise none", async () => {
  const h = harness();
  await h.pass();
  await h.pass();
  const other = `fleet reconciliation history unreadable: ${STATE_DIR}/ledger.ndjson.old, ${BAK}`;
  h.setReason(other);
  await h.pass();
  await h.pass();

  const incidents = h.incidents();
  assert.equal(incidents.length, 2);
  assert.equal(incidents[1]?.fingerprint, createHash("sha256").update(other).digest("hex"));
  assert.ok(String(incidents[1]?.message).includes(`${STATE_DIR}/ledger.ndjson.old`));
  assert.notEqual(incidents[0]?.fingerprint, incidents[1]?.fingerprint);
});

test("a dry run or light pass that never reads the fleet history raises no unreadable incident", async () => {
  const ledger: Record<string, unknown>[] = [];
  for (const [dryRun, light] of [[true, false], [false, true]] as const) {
    await runSweep([], {
      arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
      ledgerPath: `${STATE_DIR}/ledger.ndjson`, runId: "t5996", dryRun,
      repairAdmissionSurface: light ? "light" : undefined,
      readLedger: () => [...ledger], appendLine: (_p, e) => { ledger.push(e); },
      readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set<string>(), runningLong: new Set<string>() }),
      readFleetState: async () => { throw new Error(`fleet reconciliation history unreadable: ${BAK}`); },
    }, DEFAULT_SWEEP_POLICY);
  }
  assert.equal(ledger.filter((e) => e.step === "incident.event").length, 0);
});
