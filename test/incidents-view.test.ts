// W1-T5054 (arch Phase 4 P4-T15): the `incidents` view. Its store part must equal GET /v1/incidents over the
// same store, each instance's emergency stops must equal GET /v1/operator-agent/emergency/status over the same
// ledger (taken from the agent view's panel fold), and the liveness band must hold the ETag still across beats.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { buildIncidentsRoute, incidentLifecycleStorePath, writeIncidentLifecycleStore, type IncidentLifecycleRecord } from "../src/lib/incident-lifecycle.js";
import { createIncidentsView, INCIDENTS_VIEW_NAME, INCIDENTS_VIEW_VERSION, type IncidentsViewData } from "../src/lib/incidents-view.js";
import { INSTANCE_LIVENESS_BOUND_MS } from "../src/lib/instances-view.js";
import { EMERGENCY_STOP_CLEARED_LEDGER_STEP, EMERGENCY_STOP_ISSUED_LEDGER_STEP } from "../src/lib/ledger.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { buildOperatorAgentRoutes } from "../src/lib/operator-agent.js";
import { createAgentFolds, type ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { viewEtag, type ViewSource } from "../src/lib/views.js";
import { get, listen } from "./helpers/operator-agent-corpus.js";

type T = { after: (fn: () => void) => void };
// The projector stamps rows on the real clock, so the fixture's times are real ones too.
const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();
const state = (instance = "core"): ReadModelInstanceState => ({ instance, generation: 1, lease: "held", failures: 0, newestTs: null, tickedAt: NOW });

function stop(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "emergency-stop-v1", id, scope: "fleet", reason: `drill ${id}`, issuedBy: "operator", issuedAt: iso(NOW - 600_000), clearPolicy: "explicit-clear-required",
    affectedCapabilities: "*", affectedDelegationClasses: "*", incidentReceiptId: `incident-${id}`, ...extra };
}

/** Three stops: one active, one cleared, one past its expiry; only the first is active. */
const STOP_ROWS = [
  { ts: iso(NOW - 600_000), step: EMERGENCY_STOP_ISSUED_LEDGER_STEP, task_id: "estop-live", stop: stop("estop-live") },
  { ts: iso(NOW - 590_000), step: EMERGENCY_STOP_ISSUED_LEDGER_STEP, task_id: "estop-cleared", stop: stop("estop-cleared") },
  { ts: iso(NOW - 580_000), step: EMERGENCY_STOP_CLEARED_LEDGER_STEP, task_id: "estop-cleared", stop_id: "estop-cleared" },
  { ts: iso(NOW - 570_000), step: EMERGENCY_STOP_ISSUED_LEDGER_STEP, task_id: "estop-expired", stop: stop("estop-expired", { clearPolicy: "expires", expiresAt: iso(NOW - 60_000) }) },
];

function record(fingerprint: string, lastSeenMs: number): IncidentLifecycleRecord {
  return { fingerprint, title: `incident ${fingerprint}`, source: "daemon", kind: "invariant", status: "filed", firstSeenMs: lastSeenMs - 60_000, lastSeenMs, count24h: 1, feedbackId: null, pr: null };
}

/** Core's state dir with `rows` in its live ledger, projected by a ticker the test keeps until it ends. */
function fixture(t: T, rows: Array<Record<string, unknown>>): { stateDir: string; db: ReadModelDb; append(more: Array<Record<string, unknown>>): void } {
  const stateDir = makeTempDir("incidents-view-");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.ndjson"), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [], holder: "incidents-view-test", post: () => {} });
  const project = () => {
    for (let i = 0; i < 5; i++) ticker.tick();
  };
  project();
  const db = openProjectorReadModel(stateDir, "core");
  t.after(() => {
    db.close();
    ticker.release();
  });
  return { stateDir, db, append: (more) => (appendFileSync(join(stateDir, "ledger.ndjson"), more.map((row) => `${JSON.stringify(row)}\n`).join("")), project()) };
}

function build(view: ReturnType<typeof createIncidentsView>, db: ReadModelDb, now = NOW): { data: IncidentsViewData; sources: ViewSource[] } {
  const instances = [{ state: state(), db }];
  assert.equal(view.prepare({ instances }, () => true), true);
  const [body] = view.materialize({ now, instances });
  assert.ok(body, "the view built a body");
  return body;
}

const etag = (data: IncidentsViewData): string => viewEtag(INCIDENTS_VIEW_NAME, INCIDENTS_VIEW_VERSION, false, data);

test("W1-T5054: an emergency stop row appears in the incidents view", async (t) => {
  const { stateDir, db } = fixture(t, STOP_ROWS);
  const view = createIncidentsView({ instances: [{ name: "core", ledgerDir: stateDir }], ledgerSource, folds: createAgentFolds() });
  const { data } = build(view, db);
  assert.deepEqual(data.instances[0]!.emergency.active.map((s) => s.id), ["estop-live"], JSON.stringify(data));
  // PARITY: exactly what the emergency status route answers as `active` over the same ledger at the same instant.
  const base = await listen(t, buildOperatorAgentRoutes({ ledgerPath: join(stateDir, "ledger.ndjson"), now: () => NOW }));
  const route = (await get(base, "/v1/operator-agent/emergency/status")).body as { active: unknown[] };
  assert.equal(route.active.length, 1, "control: the route sees the active stop");
  assert.deepEqual(data.instances[0]!.emergency.active, route.active);
});

test("W1-T5054: a heartbeat inside its band leaves the incidents view etag unchanged", (t) => {
  const { stateDir, db, append } = fixture(t, [{ ts: iso(NOW - 120_000), step: "daemon.tick" }]);
  const view = createIncidentsView({ instances: [{ name: "core", ledgerDir: stateDir }], ledgerSource, folds: createAgentFolds() });
  const first = build(view, db).data;
  assert.deepEqual(first.instances[0]!.liveness, { state: "up" });
  append([{ ts: iso(NOW - 30_000), step: "daemon.tick" }]);
  const second = build(view, db).data;
  assert.equal(etag(second), etag(first), "a second beat inside the band is the same body");
  assert.equal(second, first, "and the same object, so its build record stays put");
  // CONTROL: the ETag can move -- past the band the instance is down, stamped with the newest beat's own time.
  const down = build(view, db, NOW + INSTANCE_LIVENESS_BOUND_MS + 1).data;
  assert.deepEqual(down.instances[0]!.liveness, { state: "down", since: iso(NOW - 30_000) });
  assert.notEqual(etag(down), etag(first));
});

test("W1-T5054: the incidents view store equals the incidents route over the same store", async (t) => {
  const { stateDir, db } = fixture(t, []);
  const view = createIncidentsView({ instances: [{ name: "core", ledgerDir: stateDir }], ledgerSource, folds: createAgentFolds() });
  const route = buildIncidentsRoute({ stateDir, clock: fixedClock(NOW) });
  const base = await listen(t, [route]);
  // No store yet: the route's healthy empty list, with no as-of.
  const empty = build(view, db);
  assert.deepEqual(empty.data.store, { state: "ok", incidents: [] });
  assert.deepEqual(empty.sources[0], { name: "incidents-store:core", asOf: null, state: "fresh" });
  writeIncidentLifecycleStore(stateDir, { a: record("a", NOW - 5_000), b: record("b", NOW - 1_000) });
  const listed = build(view, db).data;
  const answered = (await get(base, "/v1/incidents")).body as { incidents: unknown[] };
  assert.equal(answered.incidents.length, 2, "control: the route lists both records");
  assert.deepEqual(listed.store, { state: "ok", incidents: answered.incidents });
  // An unreadable store is the route's 503 reason, never an empty list.
  writeFileSync(incidentLifecycleStorePath(stateDir), "{not json");
  const broken = build(view, db);
  const refused = await get(base, "/v1/incidents");
  assert.equal(refused.status, 503);
  assert.deepEqual(broken.data.store, { state: "unavailable", reason: (refused.body as { reason: string }).reason });
  assert.equal(broken.sources[0]!.state, "unavailable");
});

test("W1-T5054: the incidents view equals its shadow legacy side over the same ledger and store", (t) => {
  const { stateDir, db } = fixture(t, [...STOP_ROWS, { ts: iso(NOW - 10_000), step: "daemon.tick" }]);
  writeIncidentLifecycleStore(stateDir, { a: record("a", NOW - 5_000) });
  const view = createIncidentsView({ instances: [{ name: "core", ledgerDir: stateDir }], ledgerSource, folds: createAgentFolds() });
  const { data, sources } = build(view, db);
  const legacy = view.legacy("", NOW, data);
  assert.ok(legacy, "the legacy side answers for a body this view built");
  assert.deepEqual(legacy.data, data);
  assert.equal(legacy.asOfMs, NOW);
  assert.deepEqual(legacy.paired, { store: { source: "incidents-store:core", asOf: sources[0]!.asOf } }, "legacy read the store the body read");
  assert.deepEqual(view.legacy("", NOW, data)?.data, data, "a second sample reuses the rotation memo");
  assert.equal(view.legacy("", NOW, { store: data.store, instances: [] }), undefined, "a body this view never built has no legacy side");
});

test("W1-T5054: the incidents view builds nothing with no instance to read", () => {
  const view = createIncidentsView({ instances: [], ledgerSource });
  assert.deepEqual(view.materialize({ now: NOW, instances: [] }), []);
  assert.equal(view.legacy("", NOW, { store: { state: "ok", incidents: [] }, instances: [] }), undefined);
});
