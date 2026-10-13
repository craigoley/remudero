import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  evaluateFleetFlowDetectors,
  ownHistoryBound,
  type FleetFlowDetector,
  type FleetFlowHistory,
} from "../src/lib/fleet-flow-detectors.js";
import { fixedClock } from "../src/lib/clock.js";
import { listFeedback } from "../src/lib/feedback.js";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import { aggregateIncidents, runSreLanePass, SRE_LANE_DETECTORS } from "../src/lib/sre-lane.js";
import { incidentSubject } from "../src/lib/sre-runbooks.js";

const NOW = Date.parse("2026-10-11T19:00:00Z");
const POLICY = { minSamples: 3, maxSamples: 6, longMs: 120_000 };
const seed: FleetFlowHistory = [1, 2, 3].map((measured, i) => ({
  population: "held", measured, ts: NOW - 300_000 + i,
}));

function fixture(history = seed) {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-flow-detectors-"));
  writeFileSync(join(stateDir, "fleet-flow-detectors.json"), JSON.stringify({
    detectors: { fake: { history, emitted: [] } },
  }));
  const rows = [
    { ts: new Date(NOW - 60_000).toISOString(), step: "daemon.pause", measured: 7 },
    { ts: new Date(NOW - 1_000).toISOString(), step: "daemon.pause", measured: 9 },
  ];
  const detector: FleetFlowDetector = {
    id: "fake", inputs: ["daemon.pause"], policy: POLICY,
    evaluate: (window, _now, history) => window.map((row) => ({
      name: "held-pause", subject: "task=W1-T8236", population: "held",
      measured: Number(row.measured), bound: ownHistoryBound(history.map((s) => s.measured), POLICY),
      message: "task=W1-T8236 hold=recycle",
    })).slice(-1),
  };
  return { stateDir, rows, detector };
}

function events(stateDir: string) {
  return readFileSync(join(stateDir, LEDGER_FILENAME), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("test/the-sre-lane-evaluates-fleet-flow-detectors.test.ts", () => {
  assert.deepEqual(SRE_LANE_DETECTORS.map((d) => d.id), ["idle-capacity"]);
  assert.equal(ownHistoryBound([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], { minSamples: 3, maxSamples: 10 }), 9);
  assert.equal(ownHistoryBound([100, 100, 1, 2, 3], POLICY), 100);
  assert.equal(ownHistoryBound([100, 100, 1, 2, 3], { minSamples: 3, maxSamples: 3 }), 3);
});

test("W1-T8236: a detector finding becomes one flow incident event", async () => {
  const { stateDir, rows, detector } = fixture();
  const seen: string[] = [];
  const result = await runSreLanePass({
    stateDir, root: stateDir, mergedLastDay: () => 1, clock: fixedClock(NOW),
    detectors: [detector], readFlowRows: () => rows, readEvents: () => [],
    hasOpenTask: () => false, framesFor: () => [], mergedPrsSince: () => [], log: () => {},
    runbookPass: async (incident) => {
      seen.push(incident.name);
      return { outcome: "no_match", fileFeedback: true };
    },
  });
  const written = events(stateDir);
  assert.equal(written.length, 1);
  assert.deepEqual(written[0], {
    ...written[0], task_id: "INCIDENT", step: "incident.event", kind: "flow", source: "sre-lane",
    name: "held-pause", measured: 9, bound: 3, population: "held", subject: "task=W1-T8236",
    message: "task=W1-T8236 hold=recycle", ts: new Date(NOW).toISOString(),
  });
  assert.equal(result.filed, written[0].fingerprint);
  assert.deepEqual(seen, ["held-pause"]);
  assert.equal(listFeedback(stateDir).length, 1);
});

test("W1-T8236: a finding needs both windows over its own bound", async () => {
  for (const [long, short, expected] of [[7, 2, 0], [2, 7, 0], [7, 7, 1], [3, 7, 0]]) {
    const { stateDir, rows, detector } = fixture();
    detector.evaluate = (window) => [{
      name: "held-pause", subject: "task=W1-T8236", population: "held", message: "task=W1-T8236",
      measured: window.length === 2 ? long : short, bound: 0,
    }];
    const found = await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW, readRows: () => rows });
    assert.equal(found.length, expected, `long=${long}, short=${short}`);
    if (found.length) assert.equal(found[0].bound, 3, "the shared evaluator uses history, never the detector's claimed bound");
  }
  const { stateDir, rows, detector } = fixture(seed.map((s) => ({ ...s, measured: 20 })));
  assert.deepEqual(await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW, readRows: () => rows }), []);
});

test("W1-T8236: a thin population is silent", async () => {
  for (const history of [[], seed.slice(0, 2), seed.map((s) => ({ ...s, population: "other" }))]) {
    const { stateDir, rows, detector } = fixture(history);
    assert.deepEqual(await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW, readRows: () => rows }), []);
    const store = JSON.parse(readFileSync(join(stateDir, "fleet-flow-detectors.json"), "utf8"));
    assert.ok(store.detectors.fake.history.some((s: { population: string }) => s.population === "held"));
  }
  assert.equal(ownHistoryBound([1, NaN, Infinity], POLICY), undefined);
});

test("W1-T8236: a still-firing finding re-ledgers once per short window", async () => {
  const { stateDir, rows, detector } = fixture();
  detector.evaluate = (window) => window.length ? [{
    name: "held-pause", subject: "task=W1-T8236", measured: 100,
    bound: 0, population: "held", message: "task=W1-T8236",
  }] : [];
  const pass = (nowMs: number) => evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs, readRows: () => rows });
  assert.equal((await pass(NOW)).length, 1);
  assert.equal((await pass(NOW + 1)).length, 0);
  // Keep the baseline stationary while testing the dedupe clock across separate persisted passes.
  const path = join(stateDir, "fleet-flow-detectors.json");
  const store = JSON.parse(readFileSync(path, "utf8"));
  store.detectors.fake.history = seed;
  writeFileSync(path, JSON.stringify(store));
  rows[1].ts = new Date(NOW + POLICY.longMs / 12 - 1).toISOString();
  assert.equal((await pass(NOW + POLICY.longMs / 12)).length, 1);
  const written = events(stateDir);
  assert.equal(written.length, 2);
  assert.equal(written[0].fingerprint, written[1].fingerprint);
});

test("flow history stays bounded and same-class subjects share a fingerprint", async () => {
  const { stateDir, rows, detector } = fixture();
  detector.evaluate = () => ["task=a", "task=b", "task=c", "task=d"].map((subject) => ({
    name: "held-pause", subject, population: "held", measured: 9, bound: 0, message: "held",
  }));
  const found = await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW, readRows: () => rows });
  assert.equal(found.length, 4);
  const written = events(stateDir);
  assert.equal(aggregateIncidents(written.map((e) => ({ ...e, ts: Date.parse(e.ts), instance: "test" }))).length, 1);
  assert.equal(written[0].message, "task=a held");
  const store = JSON.parse(readFileSync(join(stateDir, "fleet-flow-detectors.json"), "utf8"));
  assert.equal(store.detectors.fake.history.length, POLICY.maxSamples);
  assert.deepEqual(store.detectors.fake.history.map((s: { measured: number }) => s.measured), [2, 3, 9, 9, 9, 9]);
});

test("the detector default reads recent plain and gzip rotations and the live ledger", async () => {
  const { stateDir, detector } = fixture();
  const row = (ts: number, measured: number) => JSON.stringify({ ts: new Date(ts).toISOString(), step: "daemon.pause", measured }) + "\n";
  writeFileSync(join(stateDir, "ledger.2026-10-11T18-59-30-000Z.ndjson"), row(NOW - 60_000, 7));
  writeFileSync(join(stateDir, "ledger.2026-10-11T18-59-59-000Z.ndjson.gz"), gzipSync(row(NOW - 1_000, 9)));
  writeFileSync(join(stateDir, LEDGER_FILENAME), row(NOW - 500, 10));
  const lengths: number[] = [];
  const evaluate = detector.evaluate;
  detector.evaluate = (rows, now, history) => { lengths.push(rows.length); return evaluate(rows, now, history); };
  assert.equal((await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW })).length, 1);
  assert.deepEqual(lengths, [3, 2]);
  // A warm union pass uses the same rotations without reporting this subject again.
  assert.deepEqual(await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW }), []);
  assert.deepEqual(lengths, [3, 2, 3, 2]);
});

test("flow evidence is recorded even when the lane has no feedback budget", async () => {
  const { stateDir, rows, detector } = fixture();
  const result = await runSreLanePass({
    stateDir, root: stateDir, mergedLastDay: () => 0, clock: fixedClock(NOW),
    detectors: [detector], readFlowRows: () => rows, readEvents: () => [],
    hasOpenTask: () => false, framesFor: () => [], mergedPrsSince: () => [], log: () => {},
  });
  assert.deepEqual(result, { room: 0 });
  assert.equal(events(stateDir).length, 1);
  assert.equal(listFeedback(stateDir).length, 0);
});

test("flow failures preserve unknown history and reject invalid policies", async () => {
  const { stateDir, rows, detector } = fixture();
  for (const policy of [
    { ...POLICY, minSamples: 0 }, { ...POLICY, maxSamples: 1 }, { ...POLICY, longMs: NaN },
  ]) {
    await assert.rejects(evaluateFleetFlowDetectors({
      stateDir, detectors: [{ ...detector, policy }], nowMs: NOW, readRows: () => rows,
    }), /Invalid fleet-flow policy: fake/);
  }
  const path = join(stateDir, "fleet-flow-detectors.json");
  for (const malformed of ["{", "{}", "null"]) {
    writeFileSync(path, malformed);
    await assert.rejects(evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW, readRows: () => rows }));
    assert.equal(readFileSync(path, "utf8"), malformed);
  }
  writeFileSync(path, JSON.stringify({ detectors: {} }));
  writeFileSync(join(stateDir, "ledger.2026-10-11T18-59-59-000Z.ndjson.gz"), "corrupt gzip");
  await assert.rejects(evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW }), /Fleet-flow ledger unreadable/);
});

test("only current matching subjects confirm a long-window measurement", async () => {
  const { stateDir, rows, detector } = fixture();
  rows.push({ ts: "invalid", step: "daemon.pause", measured: 99 });
  rows.push({ ts: new Date(NOW + 1).toISOString(), step: "daemon.pause", measured: 99 });
  rows.push({ ts: new Date(NOW).toISOString(), step: "unrelated", measured: 99 });
  rows.push({ ts: new Date(NOW - POLICY.longMs).toISOString(), step: "daemon.pause", measured: 99 });
  detector.evaluate = (window) => [{
    name: "held-pause", subject: window.length === 2 ? "task=a" : "task=b",
    population: "held", measured: 9, bound: 0, message: "held",
  }];
  assert.deepEqual(await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW, readRows: () => rows }), []);
});

test("a new population learns healthy observations before detecting a regression", async () => {
  const { stateDir, detector } = fixture();
  rmSync(join(stateDir, "fleet-flow-detectors.json"));
  for (const measured of [1, 2, 3, 9]) {
    const nowMs = NOW + measured;
    const found = await evaluateFleetFlowDetectors({
      stateDir, detectors: [detector], nowMs,
      readRows: () => [{ ts: new Date(nowMs - 1).toISOString(), step: "daemon.pause", measured }],
    });
    assert.equal(found.length, measured === 9 ? 1 : 0);
    if (found.length) assert.equal(found[0].bound, 3);
  }
});

test("flow rows already visible to the incident reader are aggregated once", async () => {
  const { stateDir, rows, detector } = fixture();
  const counts: number[] = [];
  await runSreLanePass({
    stateDir, root: stateDir, mergedLastDay: () => 1, clock: fixedClock(NOW),
    detectors: [detector], readFlowRows: () => rows,
    readEvents: () => events(stateDir).map((e) => ({ ...e, ts: Date.parse(e.ts), instance: "test" })),
    hasOpenTask: () => false, framesFor: () => [], mergedPrsSince: () => [], log: () => {},
    runbookPass: async (incident) => {
      counts.push(incident.count);
      return { outcome: "no_match", fileFeedback: true };
    },
  });
  assert.deepEqual(counts, [1]);
});

test("the lane evaluates a detector registered in its default registry", async () => {
  const { stateDir, rows, detector } = fixture();
  const registry = SRE_LANE_DETECTORS as FleetFlowDetector[];
  registry.push(detector);
  try {
    await runSreLanePass({
      stateDir, root: stateDir, mergedLastDay: () => 0, clock: fixedClock(NOW),
      readFlowRows: () => rows, readEvents: () => [], hasOpenTask: () => false,
      framesFor: () => [], mergedPrsSince: () => [], log: () => {},
    });
    assert.equal(events(stateDir)[0].kind, "flow");
  } finally {
    registry.splice(registry.indexOf(detector), 1);
  }
});

test("flow messages preserve the exact runbook subject when another value shares its prefix", async () => {
  const { stateDir, rows, detector } = fixture();
  detector.evaluate = () => [{
    name: "held-pause", subject: "task=a", population: "held", measured: 9, bound: 0,
    message: "held task=ab hold=recycle",
  }];
  const found = await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW, readRows: () => rows });
  const [incident] = aggregateIncidents(found.map((row) => ({
    fingerprint: String(row.fingerprint), name: String(row.name), kind: String(row.kind),
    message: String(row.message), ts: NOW, instance: "test",
  })));
  assert.equal(incidentSubject(incident, "task"), "a");
  assert.equal(incidentSubject(incident, "hold"), "recycle");
});

test("wildcard detector inputs read both rotation forms and ignore unrelated ledger steps", async () => {
  const { stateDir, detector } = fixture();
  detector.inputs = ["daemon.*", "*.held"];
  const row = (step: string, measured: number) => JSON.stringify({
    ts: new Date(NOW - 1_000).toISOString(), step, measured,
  }) + "\n";
  writeFileSync(join(stateDir, "ledger.2026-10-11T18-59-58-000Z.ndjson"),
    row("daemon.pause", 7) + row("unrelated", 99));
  writeFileSync(join(stateDir, "ledger.2026-10-11T18-59-59-000Z.ndjson.gz"),
    gzipSync(row("dispatch.held", 8) + row("unrelated", 99)));
  writeFileSync(join(stateDir, LEDGER_FILENAME), row("daemon.pause", 9) + row("unrelated", 99));
  const seen: string[][] = [];
  const evaluate = detector.evaluate;
  detector.evaluate = (rows, now, history) => {
    seen.push(rows.map((row) => String(row.step)));
    return evaluate(rows, now, history);
  };
  const found = await evaluateFleetFlowDetectors({ stateDir, detectors: [detector], nowMs: NOW });
  assert.equal(found.length, 1);
  assert.deepEqual(seen, [
    ["daemon.pause", "dispatch.held", "daemon.pause"],
    ["daemon.pause", "dispatch.held", "daemon.pause"],
  ]);
});
