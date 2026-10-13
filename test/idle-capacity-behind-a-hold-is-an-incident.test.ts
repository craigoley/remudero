import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { evaluateFleetFlowDetectors, type FleetFlowRow } from "../src/lib/fleet-flow-detectors.js";
import { ALL_CAUSE_IDLE_POPULATION, idleCapacityDetector } from "../src/lib/idle-capacity-detector.js";
import { aggregateIncidents, SRE_LANE_DETECTORS } from "../src/lib/sre-lane.js";
import { incidentSubject } from "../src/lib/sre-runbooks.js";

const at = (iso: string) => Date.parse(iso);

function changed(iso: string, fields: Record<string, unknown>): FleetFlowRow {
  return { ts: iso, step: "lane.idle_changed", at_ms: at(iso), capacity: 3, ...fields };
}

function stateWith(population: string, samples: number[], nowMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-idle-capacity-"));
  writeFileSync(join(dir, "fleet-flow-detectors.json"), JSON.stringify({
    detectors: {
      "idle-capacity": {
        history: samples.map((measured, i) => ({ population, measured, ts: nowMs - 86_400_000 + i })),
        emitted: [],
      },
    },
  }));
  return dir;
}

async function run(stateDir: string, rows: FleetFlowRow[], nowMs: number) {
  return evaluateFleetFlowDetectors({ stateDir, detectors: [idleCapacityDetector("core")], nowMs, readRows: () => rows });
}

test("W1-T8238: the recycle-drain replay fires and names its hold", async () => {
  // 2026-10-11 16:16:08 - 17:08:02: refill held "fleet PAUSE hold: ... container recycle" with work queued.
  const now = at("2026-10-11T17:08:02Z");
  const hold = { reason: "fleet PAUSE hold: container recycle", pid: 4242 };
  const rows = [changed("2026-10-11T16:16:08Z", { cause: "recycle_drain", idle_slots: 2, dispatchable: 9, hold })];
  const found = await run(stateWith("recycle_drain", [3, 4, 4, 5, 3, 4], now), rows, now);
  assert.equal(found.length, 1);
  const [event] = found;
  assert.equal(event.name, "idle-capacity:recycle_drain");
  assert.equal(event.population, "recycle_drain");
  assert.equal(event.bound, 5);
  assert.ok((event.measured as number) > 100, `52 minutes on two slots is about 104 slot-minutes, got ${String(event.measured)}`);
  assert.equal(event.subject, "instance=core hold=fleet_PAUSE_hold:_container_recycle setter=4242");
  assert.match(String(event.message), /since=2026-10-11T16:16:08\.000Z/);
  assert.match(String(event.message), /dispatchable=9/);
  assert.match(String(event.message), /^instance=core hold=\S+ setter=4242 /, "the runbook subject leads the message");
});

test("W1-T8238: the operator-pause replay fires and names its setter", async () => {
  // 2026-10-11 11:46:29 - 12:29:30: a supervised serve-restoration window, the setter recorded as a session id.
  const now = at("2026-10-11T12:29:00Z");
  const hold = {
    reason: "maintenance: supervised serve restoration window (core only)",
    session_id: "operator-serve-restoration-20261011-supervised-v4", actor: "unknown",
  };
  const rows = [changed("2026-10-11T11:46:29Z", { cause: "operator_pause", idle_slots: 2, dispatchable: 14, hold })];
  const found = await run(stateWith("operator_pause", [4, 6, 5, 8, 7], now), rows, now);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "idle-capacity:operator_pause");
  const [incident] = aggregateIncidents(found.map((row) => ({
    fingerprint: String(row.fingerprint), name: String(row.name), kind: String(row.kind),
    message: String(row.message), ts: now, instance: "core",
  })));
  assert.equal(incidentSubject(incident, "setter"), "operator-serve-restoration-20261011-supervised-v4");
  assert.equal(incidentSubject(incident, "instance"), "core");
  assert.match(incidentSubject(incident, "hold") ?? "", /^maintenance:_supervised_serve_restoration/);
  assert.match(incidentSubject(incident, "since") ?? "", /^2026-10-11T11:46:29/);
});

test("W1-T8238: a recycle within its own history is silent", async () => {
  // 2026-10-11 18:09 - 18:15: a six-minute recycle against a history of short recycles is the normal cost of one.
  const now = at("2026-10-11T18:15:00Z");
  const hold = { reason: "fleet PAUSE hold: container recycle", pid: 4242 };
  const rows = [changed("2026-10-11T18:09:00Z", { cause: "recycle_drain", idle_slots: 1, dispatchable: 6, hold })];
  const stateDir = stateWith("recycle_drain", [4, 5, 6, 7, 8, 6], now);
  assert.deepEqual(await run(stateDir, rows, now), []);
  // Same hold, same duration, on a history that is shorter than it: it fires, so the silence above is the bound's.
  const tight = stateWith("recycle_drain", [1, 2, 2, 3, 2, 1], now);
  assert.equal((await run(tight, rows, now)).length, 1);
});

test("W1-T8238: a first-seen cause is judged against all idle history", async () => {
  const now = at("2026-10-11T12:29:00Z");
  const hold = { reason: "maintenance: first of its kind", session_id: "operator-session-1" };
  const rows = [changed("2026-10-11T11:49:00Z", { cause: "operator_pause", idle_slots: 1, dispatchable: 4, hold })];
  // No operator_pause history at all; the fleet's idle population says a few slot-minutes is normal.
  const found = await run(stateWith(ALL_CAUSE_IDLE_POPULATION, [1, 2, 3, 2, 4, 3], now), rows, now);
  assert.equal(found.length, 1);
  assert.equal(found[0].population, ALL_CAUSE_IDLE_POPULATION);
  assert.equal(found[0].bound, 4);
  // A fleet with no idle history at all is still warming up: silent, but learning.
  assert.deepEqual(await run(stateWith(ALL_CAUSE_IDLE_POPULATION, [], now), rows, now), []);
  // A cause WITH enough history of its own is judged on that, not on the all-cause population.
  const own = stateWith("operator_pause", [60, 70, 80, 90, 100], now);
  assert.deepEqual(await run(own, rows, now), []);
});

test("W1-T8238: the detector is registered in the SRE lane", () => {
  assert.ok(SRE_LANE_DETECTORS.some((d) => d.id === "idle-capacity"));
  const detector = idleCapacityDetector();
  assert.deepEqual([...detector.inputs], ["lane.idle_changed", "lane.idle_summary"]);
});

test("W1-T8238: a hold with no idle slot or no queued work measures nothing", async () => {
  const now = at("2026-10-11T17:00:00Z");
  const hold = { reason: "fleet PAUSE hold: container recycle", pid: 1 };
  const rows = [
    changed("2026-10-11T16:00:00Z", { cause: "recycle_drain", idle_slots: 0, dispatchable: 9, hold }),
    changed("2026-10-11T16:30:00Z", { cause: null, idle_slots: 0, dispatchable: 0, hold: null }),
  ];
  assert.deepEqual(await run(stateWith("recycle_drain", [1, 1, 1, 1, 1], now), rows, now), []);
});
