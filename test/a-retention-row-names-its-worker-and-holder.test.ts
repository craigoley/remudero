import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildActionResultsRoute } from "../src/lib/action-results.js";
import { fixedClock } from "../src/lib/clock.js";
import { readReportedAnomalies } from "../src/lib/cost-anomaly.js";
import { createFollowUpHistoryReader } from "../src/lib/follow-up-policy.js";
import { createLedgerRotationMemo, setLedgerMemoRetentionContext } from "../src/lib/ledger-union.js";
import { createLatestMeasurementReader } from "../src/lib/measurement-cadence.js";
import { createNowView } from "../src/lib/now-view.js";
import { readModelWorkerLog, runReadModelViewWorker, type ReadModelViewsInput, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const keys = ["archives", "failedArchives", "holder", "instance", "lane", "rows", "thread", "tornRows"].sort();
const counts = { archives: 1, rows: 1, tornRows: 1, failedArchives: 0 };

test("test/a-retention-row-names-its-worker-and-holder.test.ts: unchanged counts never suppress a second worker, holder or instance", (t) => {
  t.after(() => setLedgerMemoRetentionContext(undefined));
  const messages: ReadModelWorkerMessage[] = [];
  const memo = createLedgerRotationMemo((rows) => rows, { holder: "now.legacy.rows", statKey: () => "fixed" });
  const pass = memo.pass({ parseMissing: true });
  pass.rotationRecords({ path: "private-archive-path", form: "plain" }, () => ({ rows: [{ secret: "credential" }], torn: 1, tornLines: ["private ledger text"] }));
  assert.equal(pass.complete(), true);
  for (const lane of ["fast", "heavy"] as const) {
    const log = readModelWorkerLog((m) => messages.push(m), true, lane);
    setLedgerMemoRetentionContext({ thread: "views", lane, log, instances: [{ name: "core", ledgerDir: "/private/core/state" }] });
    memo.reportRetention("/private/core/state");
    memo.reportRetention("/private/core/state");
  }
  const rows = messages.filter((m) => m.type === "log").map((m) => m.extra);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), keys);
    assert.deepEqual(row, { thread: "views", lane: row.lane, holder: "now.legacy.rows", instance: "core", ...counts });
  }
  assert.equal(rows[0]!.lane, "fast");
  assert.equal(rows[1]!.lane, "heavy");
  memo.reportRetention("/private/core/state", "other");
  const costs = createLedgerRotationMemo((rows) => rows, { holder: "now.legacy.costs", statKey: () => "fixed" });
  const costPass = costs.pass({ parseMissing: true });
  costPass.rotationRecords({ path: "/private/core/state/ledger.1.ndjson", form: "plain" }, () => ({ rows: [{ step: "fixture" }], torn: 0, tornLines: [] }));
  assert.equal(costPass.complete(), true);
  costs.reportRetention("/private/core/state");
  assert.equal(messages.length, 4);
  assert.equal((messages[2] as Extract<ReadModelWorkerMessage, { type: "log" }>).extra.instance, "other");
  assert.equal((messages[3] as Extract<ReadModelWorkerMessage, { type: "log" }>).extra.holder, "now.legacy.costs");
  assert.equal(memo.pass().complete(), true);
  memo.reportRetention("/private/core/state");
  assert.deepEqual((messages[4] as Extract<ReadModelWorkerMessage, { type: "log" }>).extra, { thread: "views", lane: "heavy", holder: "now.legacy.rows", instance: "core", archives: 0, rows: 0, tornRows: 0, failedArchives: 0 });
});

test("view-worker entry adds its real lane to forwarded log rows", async (t) => {
  t.after(() => setLedgerMemoRetentionContext(undefined));
  const root = makeTempDir("retention-worker");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const lane of ["fast", "heavy", undefined] as const) {
    const messages: ReadModelWorkerMessage[] = [];
    let send: ((m: ReadModelViewsInput) => void) | undefined;
    const port = { on: (_event: "message", cb: (m: ReadModelViewsInput) => void) => { send = cb; }, postMessage: (m: unknown) => messages.push(m as ReadModelWorkerMessage), close: () => {} };
    runReadModelViewWorker(port, { stateDir: root, instances: [], holder: "test", tickMs: 5, viewsModule: "file:///nonexistent/retention-views.mjs", ...(lane ? { lane } : {}) });
    send!({ type: "stop" });
    for (let n = 0; n < 100 && messages.length === 0; n++) await new Promise((r) => setTimeout(r, 5));
    const row = messages.find((m) => m.type === "log" && m.step === "read_model.views_module_failed");
    assert.ok(row?.type === "log");
    assert.equal(row.extra.thread, "views");
    assert.equal(row.extra.lane, lane);
    assert.equal(Object.hasOwn(row.extra, "lane"), lane !== undefined);
  }
  const messages: ReadModelWorkerMessage[] = [];
  readModelWorkerLog((m) => messages.push(m), false)("read_model.now_legacy_retention", { thread: "spoof", lane: "spoof", instance: "core" });
  assert.equal((messages[0] as Extract<ReadModelWorkerMessage, { type: "log" }>).extra.thread, "projector");
});

test("a different thread with the same holder, instance and absent lane gets its own row", (t) => {
  t.after(() => setLedgerMemoRetentionContext(undefined));
  const rows: Record<string, unknown>[] = [];
  const log = (_step: string, extra: Record<string, unknown>) => { rows.push(extra); };
  const memo = createLedgerRotationMemo((r) => r, { holder: "thread-fixture", statKey: () => "fixed" });
  const pass = memo.pass({ parseMissing: true });
  pass.rotationRecords({ path: "/private/core/state/ledger.1.ndjson", form: "plain" }, () => ({ rows: [{ step: "fixture" }], torn: 0, tornLines: [] }));
  assert.equal(pass.complete(), true);
  for (const thread of ["views", "projector"]) {
    setLedgerMemoRetentionContext({ thread, log, instances: [{ name: "core", ledgerDir: "/private/core/state" }] });
    memo.reportRetention("/private/core/state");
    memo.reportRetention("/private/core/state");
  }
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.thread), ["views", "projector"]);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), keys.filter((key) => key !== "lane"));
});

test("retention is reported only after a sink accepts it and a bare directory contributes only its name", () => {
  setLedgerMemoRetentionContext(undefined);
  const silent = createLedgerRotationMemo((r) => r, { holder: "silent", statKey: () => "fixed" });
  silent.reportRetention("/private/cache");
  const pass = silent.pass({ parseMissing: true });
  pass.rotationRecords({ path: "/private/cache/ledger.1.ndjson", form: "plain" }, () => ({ rows: [{ step: "fixture" }], torn: 0, tornLines: [] }));
  assert.equal(pass.complete(), true);
  const rows: Record<string, unknown>[] = [];
  silent.reportRetention("/private/cache", undefined, (_step, row) => { rows.push(row); });
  assert.equal(rows[0]!.instance, "cache");
  let attempts = 0;
  const retry = createLedgerRotationMemo((r) => r, { holder: "retry", writeRetention: (_path, row) => {
    if (++attempts === 1) throw new Error("fixture sink unavailable");
    rows.push(row);
  }, statKey: () => "fixed" });
  const retryPass = retry.pass({ parseMissing: true });
  retryPass.rotationRecords({ path: "/private/core/state/ledger.1.ndjson", form: "plain" }, () => ({ rows: [{ step: "fixture" }], torn: 0, tornLines: [] }));
  assert.equal(retryPass.complete(), true);
  assert.throws(() => retry.reportRetention("/private/core/state"), /fixture sink unavailable/);
  retry.reportRetention("/private/core/state");
  retry.reportRetention("/private/core/state");
  assert.equal(attempts, 2);
  assert.equal(rows.length, 2);
});

test("an empty first retention sample is silent, while a later transition back to empty is reported", () => {
  setLedgerMemoRetentionContext(undefined);
  const rows: Array<Record<string, unknown>> = [];
  const memo = createLedgerRotationMemo((r) => r, {
    holder: "empty-baseline",
    statKey: () => "fixed",
    writeRetention: (_path, row) => rows.push(row),
  });
  memo.reportRetention("/private/core/state");
  memo.reportRetention("/private/core/state");
  assert.equal(rows.length, 0);

  const loaded = memo.pass({ parseMissing: true });
  loaded.rotationRecords({ path: "/private/core/state/ledger.1.ndjson", form: "plain" }, () => ({ rows: [{ step: "fixture" }], torn: 0, tornLines: [] }));
  assert.equal(loaded.complete(), true);
  memo.reportRetention("/private/core/state");
  assert.deepEqual(rows.map(({ archives, rows: retained }) => [archives, retained]), [[1, 1]]);

  assert.equal(memo.pass().complete(), true);
  memo.reportRetention("/private/core/state");
  assert.deepEqual(rows.map(({ archives, rows: retained }) => [archives, retained]), [[1, 1], [0, 0]]);
});

test("now legacy reports both named memos and preserves the aggregate retention event", (t) => {
  setLedgerMemoRetentionContext(undefined);
  const root = makeTempDir("retention-now");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = fixedClock(Date.parse("2026-10-07T12:00:00.000Z"));
  const fx = writeLedger([], { dir: join(root, "core", "state"), rotations: [{ at: "2026-10-07T11:59:00.000Z", rows: [{ ts: "2026-10-07T11:58:00.000Z", step: "implement.done", cost_usd: 1, payload: "secret" }] }] });
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  t.after(() => db.close());
  const lease = acquireLease(db, { clock });
  assert.ok(lease.ok);
  createLedgerProjector({ ledgerDir: fx.dir, db, lease: lease.lease, clock }).tick();
  const messages: ReadModelWorkerMessage[] = [];
  for (const lane of ["fast", "heavy"] as const) {
    const log = readModelWorkerLog((m) => messages.push(m), true, lane);
    const view = createNowView({ instances: [{ name: "core", ledgerDir: fx.dir }], clock, log, readPlan: () => ({ tasks: [], byId: new Map() } as Plan), github: () => ({ github: { readFailed: () => false, listMergedHeadBranches: () => [], listOpenHeadBranches: () => [] } as unknown as GitHub, generation: "fixture", source: { asOf: null, state: "fresh" } }), hostProbe: { rateLimit: () => 1, diskFree: () => 1 } });
    const [body] = view.materialize({ now: clock.now(), switches: { views: { now: "shadow" } }, instances: [{ db, state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, newestTs: null } }] });
    assert.ok(body, JSON.stringify(messages));
    assert.ok(view.legacy("instance=core", clock.now(), body.data));
    view.legacy("instance=core", clock.now(), body.data);
  }
  const rows = messages.filter((m) => m.type === "log").filter((m) => m.step === "read_model.memo_retention").map((m) => m.extra);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => [r.lane, r.holder]), [["fast", "now.legacy.rows"], ["fast", "now.legacy.costs"], ["heavy", "now.legacy.rows"], ["heavy", "now.legacy.costs"]]);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), keys);
  const aggregate = messages.filter((m) => m.type === "log" && m.step === "read_model.now_legacy_retention");
  assert.equal(aggregate.length, 2);
  for (const message of aggregate) {
    assert.ok(message.type === "log");
    assert.deepEqual(Object.keys(message.extra).sort(), ["costs", "instance", "lane", "rows", "thread"]);
  }
});

test("all async holders emit real ledger rows once per retained count change", async (t) => {
  setLedgerMemoRetentionContext(undefined);
  const root = makeTempDir("retention-async");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = writeLedger([], { dir: join(root, "core", "state"), rotations: [{ at: "2026-10-07T11:00:00.000Z", gz: true, rows: [{ step: "cost.anomaly", run_id: "r1", secret: "private" }, { step: "external_effect.reconciled", secret: "private" }, { step: "measurement_cadence.ran", ts: "2026-10-07T10:00:00.000Z", secret: "private" }] }] });
  const follows = createFollowUpHistoryReader();
  const measurements = createLatestMeasurementReader();
  const actions = buildActionResultsRoute(fx.path);
  for (let n = 0; n < 2; n++) {
    assert.equal((await readReportedAnomalies(fx.dir, [])).complete, true);
    assert.deepEqual(await follows(fx.path), []);
    assert.equal((await measurements(fx.dir, 1)).status, "ok");
    let status = 0;
    await actions.handler({ url: "/v1/action-results" } as never, { writeHead: (code: number) => { status = code; }, end: () => {} } as never, {} as never);
    assert.equal(status, 200);
  }
  const rows = readFileSync(fx.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.holder).sort(), ["action-results", "cost-anomaly", "follow-up-policy", "measurement-cadence"]);
  for (const row of rows) {
    assert.equal(row.step, "read_model.memo_retention");
    assert.equal(row.thread, "main");
    assert.equal(row.instance, "core");
    assert.equal(row.archives, 1);
    assert.deepEqual(Object.keys(row).sort(), ["actor", "actor_pid", "archives", "failedArchives", "holder", "host", "instance", "rows", "run_id", "step", "task_id", "thread", "tornRows", "ts"].sort());
  }
});

test("failed and pruned archives change the reported counts without exposing their error text", async () => {
  setLedgerMemoRetentionContext(undefined);
  const rows: Record<string, unknown>[] = [];
  const memo = createLedgerRotationMemo((r) => r, { holder: "failed-fixture", statKey: () => "fixed", readFile: async () => { throw new Error("private credential and archive path"); } });
  await memo.load([{ path: "private", form: "plain" }]);
  memo.reportRetention("/private/core/state", "core", (_step, extra) => { rows.push(extra); });
  assert.deepEqual(rows, [{ thread: "main", holder: "failed-fixture", instance: "core", archives: 1, rows: 0, tornRows: 0, failedArchives: 1 }]);
});
