import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { type FleetFlowRow } from "../src/lib/fleet-flow-detectors.js";
import { ALL_CAUSE_IDLE_POPULATION, evaluateIdleCapacityDetectors, idleCapacityDetector } from "../src/lib/idle-capacity-detector.js";
import { aggregateIncidents, runSreLanePass, SRE_LANE_DETECTORS } from "../src/lib/sre-lane.js";
import { fixedClock } from "../src/lib/clock.js";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import { incidentSubject } from "../src/lib/sre-runbooks.js";

const at = (iso: string) => Date.parse(iso);

test("test/idle-capacity-behind-a-hold-is-an-incident.test.ts", () => {
  assert.equal(idleCapacityDetector().id, "idle-capacity");
});

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
  return evaluateIdleCapacityDetectors({ stateDir, detectors: [idleCapacityDetector("core")], nowMs, readRows: () => rows });
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
  assert.equal(event.subject, "instance=core hold=fleet_PAUSE_hold:_container_recycle setter=4242 since=2026-10-11T16:16:08.000Z");
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

function summaries(now: number, cause: string, samples: number[]): FleetFlowRow[] {
  return samples.map((measured, i) => {
    const end = now - (samples.length - i + 1) * 3_600_000;
    return {
      ts: fixedClock(end).iso(), step: "lane.idle_summary",
      window_start_ms: end - 3_600_000, window_end_ms: end,
      slot_minutes_by_cause: { [cause]: measured },
    };
  });
}

async function srePass(stateDir: string, rows: FleetFlowRow[], now: number) {
  const events: FleetFlowRow[] = [];
  await runSreLanePass({
    stateDir, root: stateDir, clock: fixedClock(now), mergedLastDay: () => 0,
    readFlowRows: () => rows, writeFlowEvent: (row) => events.push(row), readEvents: () => [],
    hasOpenTask: () => false, framesFor: () => [], mergedPrsSince: () => [], log: () => {},
  });
  return events;
}

test("W1-T8238: summary windows teach the cause bound once and live polls do not", async () => {
  const now = at("2026-10-11T17:08:02Z");
  const state = stateWith("recycle_drain", [], now);
  const rows = [
    ...summaries(now, "recycle_drain", [3, 4, 4, 5, 3, 4]),
    changed("2026-10-11T16:16:08Z", {
      cause: "recycle_drain", idle_slots: 2, dispatchable: 9,
      hold: { reason: "fleet PAUSE hold: container recycle", pid: 4242 },
    }),
  ];
  assert.equal((await srePass(state, rows, now))[0]?.bound, 5);
  await srePass(state, rows, now + 60_000);
  const store = JSON.parse(readFileSync(join(state, "fleet-flow-detectors.json"), "utf8"));
  assert.deepEqual(store.detectors["idle-capacity"].history.filter(
    (s: { population: string }) => s.population === "recycle_drain",
  ).map((s: { measured: number }) => s.measured), [3, 4, 4, 5, 3, 4]);
});

test("W1-T8238: all-cause summary history judges a first operator pause", async () => {
  const now = at("2026-10-11T12:29:00Z");
  const state = stateWith("operator_pause", [], now);
  const rows = [
    ...summaries(now, "recycle_drain", [1, 2, 3, 2, 4, 3]),
    changed("2026-10-11T11:49:00Z", {
      cause: "operator_pause", idle_slots: 1, dispatchable: 4,
      hold: { reason: "first operator pause", session_id: "operator-session-1" },
    }),
  ];
  const [event] = await srePass(state, rows, now);
  assert.equal(event?.population, ALL_CAUSE_IDLE_POPULATION);
  assert.equal(event?.bound, 4);
});

test("W1-T8238: malformed summaries never teach a healthy zero-cost window", async () => {
  const now = at("2026-10-11T12:29:00Z");
  const hold = changed("2026-10-11T12:19:00Z", {
    cause: "operator_pause", idle_slots: 1, dispatchable: 4,
    hold: { reason: "first operator pause", session_id: "operator-session-1" },
  });
  const invalid = [{}, ...["unknown", null, -1, Infinity].map((value) => ({
    recycle_drain: 0, operator_pause: value,
  }))];
  for (const values of invalid) {
    const rows = summaries(now, "recycle_drain", [0, 0, 0, 0, 0]).map((row) => ({
      ...row, slot_minutes_by_cause: values,
    }));
    const state = stateWith(ALL_CAUSE_IDLE_POPULATION, [], now);
    assert.deepEqual(await run(state, [...rows, hold], now), []);
    const store = JSON.parse(readFileSync(join(state, "fleet-flow-detectors.json"), "utf8"));
    assert.deepEqual(store.detectors["idle-capacity"].history, []);
  }
  const valid = stateWith(ALL_CAUSE_IDLE_POPULATION, [], now);
  const [event] = await run(valid, [...summaries(now, "recycle_drain", [0, 0, 0, 0, 0]), hold], now);
  assert.equal(event?.bound, 0, "recorded zero-cost windows are real history");
  assert.equal(event?.measured, 10);
});

test("W1-T8238: repeated passes at one timestamp retain long-window measurements", () => {
  const now = at("2026-10-11T17:00:00Z");
  const rows = [changed("2026-10-11T16:35:00Z", {
    cause: "recycle_drain", idle_slots: 2, dispatchable: 9, hold: { pid: 1 },
  })];
  const detector = idleCapacityDetector("core");
  assert.equal(detector.evaluate(rows, now, [])[0]?.measured, 50);
  detector.evaluate([], now, []);
  assert.equal(detector.evaluate(rows, now, [])[0]?.measured, 50);
});

test("W1-T8238: a steady hold survives a detector restart and an hourly boundary", async () => {
  const start = at("2026-10-11T16:16:08Z");
  const now = start + 10 * 60_000;
  const state = stateWith("recycle_drain", [3, 4, 4, 5, 3, 4], now);
  const change = changed(fixedClock(start).iso(), {
    cause: "recycle_drain", idle_slots: 2, dispatchable: 9,
    hold: { reason: "fleet PAUSE hold: container recycle", pid: 4242 },
  });
  const first = await run(state, [change], now);
  const second = await run(state, [], start + 90 * 60_000);
  assert.equal(second.length, 1);
  assert.equal(second[0].measured, 120);
  assert.equal(second[0].subject, first[0].subject);
  assert.match(String(second[0].message), /since=2026-10-11T16:16:08\.000Z/);
});

test("W1-T8238: a released hold has no short-window confirmation", async () => {
  const now = at("2026-10-11T17:08:02Z");
  const state = stateWith("recycle_drain", [1, 2, 2, 3, 2, 1], now);
  const rows = [
    changed("2026-10-11T16:16:08Z", {
      cause: "recycle_drain", idle_slots: 2, dispatchable: 9, hold: { pid: 1 },
    }),
    changed("2026-10-11T17:00:00Z", { cause: null, idle_slots: 0, dispatchable: 9 }),
  ];
  assert.deepEqual(await run(state, rows, now), []);
});

test("W1-T8238: the default ledger reader learns summary history and emits a named incident", async () => {
  const now = at("2026-10-11T17:08:02Z");
  const state = stateWith("recycle_drain", [], now);
  const rows = [
    ...summaries(now, "recycle_drain", [3, 4, 4, 5, 3, 4]),
    changed("2026-10-11T16:16:08Z", {
      cause: "recycle_drain", idle_slots: 2, dispatchable: 9, instance: "core",
      hold: { reason: "fleet PAUSE hold: container recycle", session_id: "recycle-session" },
    }),
  ];
  const ledger = join(state, LEDGER_FILENAME);
  writeFileSync(join(state, "ledger.2026-10-11T16-15-00-000Z.ndjson.gz"),
    gzipSync(rows.slice(0, -1).map((r) => JSON.stringify(r)).join("\n") + "\n"));
  writeFileSync(ledger, JSON.stringify(rows.at(-1)) + "\n");
  const [event] = await evaluateIdleCapacityDetectors({
    stateDir: state, detectors: [idleCapacityDetector()], nowMs: now,
  });
  assert.equal(event?.bound, 5);
  assert.match(String(event?.subject), /instance=core hold=fleet_PAUSE_hold:_container_recycle setter=recycle-session/);
  const written = readFileSync(ledger, "utf8").trim().split("\n").map((r) => JSON.parse(r));
  assert.equal(written.at(-1).name, "idle-capacity:recycle_drain");
});

test("W1-T8238: changing slot counts preserves the hold subject in both windows", async () => {
  const now = at("2026-10-11T17:08:02Z");
  const state = stateWith("recycle_drain", [1, 2, 2, 3, 2, 1], now);
  const hold = { reason: "fleet PAUSE hold: container recycle", pid: 4242 };
  const rows = [
    changed("2026-10-11T16:16:08Z", { cause: "recycle_drain", idle_slots: 2, dispatchable: 9, hold }),
    changed("2026-10-11T17:02:00Z", { cause: "recycle_drain", idle_slots: 1, dispatchable: 9, hold }),
  ];
  const [event] = await run(state, rows, now);
  assert.match(String(event?.subject), /since=2026-10-11T16:16:08\.000Z/);
  assert.equal(event?.measured, 97.77);
});

test("W1-T8238: corrupt detector state is visibly refused", async () => {
  const now = at("2026-10-11T17:08:02Z");
  const state = stateWith("recycle_drain", [], now);
  writeFileSync(join(state, "fleet-flow-detectors.json"), '{"detectors": []}');
  await assert.rejects(run(state, [], now), /Invalid fleet-flow history/);
});

test("W1-T8238: an unreadable archive fails visibly instead of reporting healthy idle capacity", async () => {
  const now = at("2026-10-11T17:08:02Z");
  const state = stateWith("recycle_drain", [], now);
  writeFileSync(join(state, "ledger.2026-10-11T16-15-00-000Z.ndjson.gz"), "corrupt gzip");
  await assert.rejects(evaluateIdleCapacityDetectors({
    stateDir: state, detectors: [idleCapacityDetector()], nowMs: now,
  }), /Idle-capacity ledger unreadable/);
});

test("W1-T8238: a missing hold stays explicitly unrecorded and malformed rows measure nothing", async () => {
  const now = at("2026-10-11T17:00:00Z");
  const state = stateWith("recycle_drain", [1, 2, 2, 3, 2, 1], now);
  const rows: FleetFlowRow[] = [
    { ts: "invalid", step: "lane.idle_changed", cause: "recycle_drain", idle_slots: 2, dispatchable: 9 },
    { ts: "2026-10-11T16:30:00Z", step: "lane.idle_changed", cause: "recycle_drain", idle_slots: 1, dispatchable: 9 },
    changed("2026-10-11T17:01:00Z", { cause: null, idle_slots: 0, dispatchable: 0 }),
  ];
  const [event] = await run(state, rows, now);
  assert.equal(event?.measured, 30);
  assert.match(String(event?.subject), /hold=recycle_drain:unnamed setter=unrecorded since=2026-10-11T16:30:00\.000Z/);
  const empty = stateWith("recycle_drain", [1, 2, 2, 3, 2, 1], now);
  assert.deepEqual(await run(empty, [changed("2026-10-11T16:30:00Z", {
    cause: "recycle_drain", idle_slots: 1, dispatchable: 0, hold: { actor: "operator" },
  })], now), []);
});
