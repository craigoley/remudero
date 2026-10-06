// 2026-10-06 measurement: 171 of 237 `view.emitted` rows carried a rowTs AFTER their buildStartedAt, which no
// build input can do. rowTs was read from the sources as JUDGED AT EMIT TIME, and the read model's judge re-reads
// every `ledger:` source at the ledger's current head, so a body built from row T1 and emitted once the ledger
// reached T2 was ledgered as reflecting T2, faking "late start" gaps of 60-200 s in every push-latency number.
// These drive the real publisher with a judge that advances the ledger head, as the worker handle's does.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
// A namespace import, so a checkout without builtRow still loads this file and its tests fail on their assertions.
import * as viewEvents from "../src/lib/view-events.js";
import { viewEtag, type ViewBodyEntry, type ViewSource } from "../src/lib/views.js";

const T0 = Date.parse("2026-10-06T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** A `now` body built from `sources`, by a build that began at `startedMs`. */
function built(n: number, sources: ViewSource[], startedMs: number): ViewBodyEntry {
  const data = { n };
  return { view: "now", key: "instance=core", version: 1, generation: 1, etag: viewEtag("now", 1, false, data), buildStartedMs: startedMs,
    body: { view: "now", version: 1, generatedAt: iso(startedMs), asOf: null, stale: false, sources, data } };
}

const builtUpTo = (ms: number): ViewSource[] => [{ name: "ledger:core", asOf: iso(ms), state: "fresh" }];

/** A read-model handle whose judge, like the worker's, answers each `ledger:` source at the ledger's CURRENT head. */
function advancingReadModel() {
  const bodies = new Map<string, ViewBodyEntry>();
  const listeners = new Set<(e: ViewBodyEntry) => void>();
  const ledger = { headMs: T0, stalled: false };
  return {
    ledger,
    bodies,
    judge: (sources: readonly ViewSource[]) => sources.map((s) => (s.name.startsWith("ledger:")
      ? { ...s, asOf: iso(ledger.headMs), ...(ledger.stalled ? { state: "stale" as const, reason: "projector stalled" } : {}) }
      : s)),
    body: (view: string, key = "") => bodies.get(`${view}\u0000${key}`),
    switches: () => ({ projector: "on" as const, views: { now: "serve" as const }, push: "on" as const }),
    onBody: (listener: (e: ViewBodyEntry) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    post(e: ViewBodyEntry): void {
      bodies.set(`${e.view}\u0000${e.key}`, e);
      for (const l of listeners) l(e);
    },
  };
}

function subscriber() {
  const req = new EventEmitter() as IncomingMessage;
  Object.assign(req, { url: viewEvents.VIEW_EVENTS_PATH, headers: {} });
  const res = new EventEmitter() as ServerResponse;
  Object.assign(res, { writableEnded: false, writableLength: 0, writeHead: () => res, write: () => true, end: () => res });
  return { req, res };
}

async function publisher(rm: ReturnType<typeof advancingReadModel>) {
  let at = T0;
  const clock: Clock = { now: () => at, date: () => new Date(at), iso: () => iso(at) };
  const runs = new Map<number, () => void>();
  const rows: Array<Record<string, unknown>> = [];
  const events = viewEvents.createViewEvents({ names: ["now"], readModel: rm, clock, every: (run, ms) => (runs.set(ms, run), () => void runs.delete(ms)),
    log: (step, extra) => void (step === "view.emitted" && rows.push(extra!)) });
  const { req, res } = subscriber();
  await events.routes[0]!.handler(req, res, { params: {} });
  return { rows, setNow: (ms: number) => void (at = ms), sweep: () => runs.get(viewEvents.VIEW_EVENTS_SWEEP_MS)?.() };
}

test("a view.emitted row ledgers the row its body was built from as rowTs and the emit-time ledger head as judgedRowTs", async () => {
  const rm = advancingReadModel();
  // Seeded before anyone subscribes: built from row T0-30s; the ledger has since moved to T0-5s.
  rm.bodies.set("now\u0000instance=core", built(0, builtUpTo(T0 - 30_000), T0 - 29_000));
  rm.ledger.headMs = T0 - 5_000;
  const pub = await publisher(rm);
  // Built from row T1 = T0+1s by a build that began at T0+2s; emitted at T0+90s, when the ledger head is T2 = T0+80s.
  rm.ledger.headMs = T0 + 80_000;
  pub.setNow(T0 + 90_000);
  rm.post(built(1, builtUpTo(T0 + 1_000), T0 + 2_000));
  assert.equal(pub.rows.length, 1, "control: the emission was ledgered");
  const [row] = pub.rows;
  assert.equal(row!.rowTs, iso(T0 + 1_000), "rowTs is the row the body was built from, not the head the emit judged");
  assert.equal(row!.judgedRowTs, iso(T0 + 80_000), "the emit-time judgement is kept under its own name");
  assert.equal(row!.prevRowTs, iso(T0 - 30_000), "the previous event's row is ITS build row, not the head judged at subscribe");
  assert.ok(String(row!.rowTs) <= String(row!.buildStartedAt), `rowTs ${String(row!.rowTs)} is no later than buildStartedAt ${String(row!.buildStartedAt)}`);
  assert.equal("rowTsAbsent" in row!, false, "a body that names its row says nothing is absent");

  // A minute on the projector stalls: the sweep re-judges the same body, which reflects no new row.
  rm.ledger.headMs = T0 + 140_000;
  rm.ledger.stalled = true;
  pub.setNow(T0 + 150_001);
  pub.sweep();
  assert.equal(pub.rows.length, 2, "control: the judge emission was ledgered");
  assert.deepEqual({ cause: pub.rows[1]!.cause, rowTs: pub.rows[1]!.rowTs, prevRowTs: pub.rows[1]!.prevRowTs, judgedRowTs: pub.rows[1]!.judgedRowTs },
    { cause: "judge", rowTs: iso(T0 + 1_000), prevRowTs: iso(T0 + 1_000), judgedRowTs: iso(T0 + 140_000) },
    "a re-judged body carries its build row, so rowTs equals prevRowTs and the emission names no new row");
});

test("a view.emitted row whose body was built with no ledger row names rowTsAbsent instead of a row", async () => {
  const rm = advancingReadModel();
  const pub = await publisher(rm);
  rm.post(built(1, [{ name: "github", asOf: iso(T0 - 1_000), state: "fresh" }], T0 - 500));
  assert.equal(pub.rows.length, 1, "control: the emission was ledgered");
  const row = pub.rows[0]!;
  assert.deepEqual({ rowTs: row.rowTs, rowTsAbsent: row.rowTsAbsent, judgedRowTs: row.judgedRowTs },
    { rowTs: null, rowTsAbsent: "no_ledger_row_in_build_sources", judgedRowTs: null });
  assert.deepEqual(viewEvents.builtRow(built(2, [], T0)), { rowTs: null, rowTsAbsent: "no_ledger_row_in_build_sources" }, "a body with no sources at all names the same absence");
});

test("builtRow folds a decorated body's carried rowTs into the row it was built from", () => {
  const decorated = { ...built(1, builtUpTo(T0 - 60_000), T0), rowTs: iso(T0 - 10_000) };
  assert.deepEqual(viewEvents.builtRow(decorated), { rowTs: iso(T0 - 10_000) });
  assert.deepEqual(viewEvents.builtRow({ ...built(1, [], T0), rowTs: iso(T0 - 10_000) }), { rowTs: iso(T0 - 10_000) }, "a carried row alone is a row");
});
