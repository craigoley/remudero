import assert from "node:assert/strict";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, createReadModelWorker, readModelStatusView, runReadModelWorker, type ReadModelView, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { legacyRepositories, repositoriesSourcesPath } from "../src/lib/repositories-view.js";
import { makeTempDir } from "../src/lib/tmp.js";
import {
  VIEW_SHADOW_DIFF_STEP,
  classifyShadowDiff,
  createShadowSampler,
  createViewShadow,
  diffViewData,
  legacyRowIndex,
  legacyViewSampler,
  movedIds,
  memberEntities,
  sumEntities,
  readShadowEvidence,
  shadowReadiness,
  sqliteShadowStore,
  withViewShadow,
  type ShadowEvidence,
  type ShadowLatest,
  type ShadowRequest,
} from "../src/lib/view-shadow.js";
import { buildReadModelViewRoutes, type ViewBodyEntry, type ViewDefinition } from "../src/lib/views.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function steppedClock(start = T0): Clock & { advance(ms: number): void } {
  let ms = start;
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString(), advance: (by) => void (ms += by) };
}

function row(ms: number, step: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date(ms).toISOString(), step, ...extra });
}

/** A projected read model whose ledger names W1-T1 long ago, W1-T2 in the last hour, and W1-T3 twice. */
function evidenceDb(t: TestCtx): ReadModelDb {
  const dir = scratch(t, "shadow-rows");
  const lines = [
    row(T0 - 30 * DAY, "run.start", { task_id: "W1-T1", run_id: "a" }),
    row(T0 - 30 * 60_000, "run.start", { task_id: "W1-T2", run_id: "b" }),
    row(T0 - 20 * 60_000, "worker.activity", { note: "unnamed" }),
    row(T0 - 2 * DAY, "run.start", { task_id: "W1-T3", run_id: "c" }),
  ];
  writeFileSync(join(dir, "ledger.ndjson"), `${lines.join("\n")}\n`);
  const clock = fixedClock(T0);
  const db = openProjectorReadModel(scratch(t, "shadow-state"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  createLedgerProjector({ ledgerDir: dir, db, lease: got.lease, clock }).tick();
  return db;
}

const NONE: ShadowEvidence = {
  legacyAsOfMs: T0, viewAsOfMs: T0, named: new Set(), namedBeforeHorizon: new Set(), namedInGap: new Set(), rowsInGap: 0, duplicateIds: new Set(), duplicateRows: 0,
};

test("a shadow diff names the differing fields and its classification", (t) => {
  const db = evidenceDb(t);
  const logged: Array<[string, Record<string, unknown>]> = [];
  const shadow = createViewShadow({ clock: fixedClock(T0), log: (step, extra) => logged.push([step, extra]), evidence: (input) => readShadowEvidence([db], input) });
  const legacy = { board: { tasks: [{ taskId: "W1-T9", status: "queued" }], counts: { running: 1 } }, generatedAt: "then" };
  const view = { board: { tasks: [{ taskId: "W1-T9", status: "running" }], counts: { running: 1 } }, generatedAt: "now" };
  const result = shadow.compare({ view: "now", key: "instance=core", requests: 1, legacy: { data: legacy, asOfMs: T0 }, body: { data: view, asOf: new Date(T0).toISOString() } });
  assert.deepEqual(result.diffs.map((d) => [d.path, d.classification]), [["board.tasks[taskId=W1-T9].status", "real"]]);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]![0], VIEW_SHADOW_DIFF_STEP);
  assert.deepEqual(logged[0]![1].diffs, result.diffs.map((d) => ({ ...d, legacy: '"queued"', view: '"running"' })), "a real diff's row carries both sides");
  assert.deepEqual(logged[0]![1].classes, { legacy_horizon: 0, timing: 0, dedupe: 0, real: 1 });
  assert.equal(logged[0]![1].view, "now");
  assert.equal(logged[0]![1].key, "instance=core");
});

test("a diff about a task only a row older than the legacy horizon names is legacy_horizon", (t) => {
  const db = evidenceDb(t);
  const diffs = diffViewData({ groups: { blocked: [] } }, { groups: { blocked: ["W1-T1"] } });
  assert.deepEqual(diffs.map((d) => [d.path, d.ids]), [["groups.blocked", ["W1-T1"]]]);
  const ev = readShadowEvidence([db], { ids: diffs[0]!.ids, legacyAsOfMs: T0, viewAsOfMs: T0, legacyHorizonMs: T0 - DAY });
  assert.equal(classifyShadowDiff(diffs[0]!, ev).classification, "legacy_horizon");
  const noHorizon = readShadowEvidence([db], { ids: diffs[0]!.ids, legacyAsOfMs: T0, viewAsOfMs: T0 });
  assert.equal(classifyShadowDiff(diffs[0]!, noHorizon).classification, "real", "without a horizon the same diff is a bug");
});

test("a diff about a task a row between the two sources' ages names is timing", (t) => {
  const db = evidenceDb(t);
  const [diff] = diffViewData({ tasks: [{ taskId: "W1-T2", status: "queued" }] }, { tasks: [{ taskId: "W1-T2", status: "running" }] });
  const ev = readShadowEvidence([db], { ids: diff!.ids, legacyAsOfMs: T0 - HOUR, viewAsOfMs: T0 });
  assert.equal(ev.rowsInGap, 2);
  assert.equal(classifyShadowDiff(diff!, ev).classification, "timing");
  const sameAge = readShadowEvidence([db], { ids: diff!.ids, legacyAsOfMs: T0, viewAsOfMs: T0 });
  assert.equal(classifyShadowDiff(diff!, sameAge).classification, "real", "equal ages explain nothing");
  const [old] = diffViewData({ tasks: [{ taskId: "W1-T1", status: "queued" }] }, { tasks: [{ taskId: "W1-T1", status: "running" }] });
  const olderTask = readShadowEvidence([db], { ids: old!.ids, legacyAsOfMs: T0 - HOUR, viewAsOfMs: T0 });
  assert.equal(classifyShadowDiff(old!, olderTask).classification, "real", "a busy gap does not explain a task no gap row names");
  assert.equal(classifyShadowDiff({ path: "health.lastPollAgeMs", legacy: 1, view: 2, ids: [] }, { ...NONE, legacyAsOfMs: T0 - 1 }).classification, "timing");
  assert.equal(classifyShadowDiff({ path: "counts.running", legacy: 1, view: 2, ids: [] }, { ...NONE, legacyAsOfMs: T0 - 1, rowsInGap: 3 }).classification, "real", "a busy gap does not explain a count no member names");
});

test("a diff where legacy counted duplicate rows is dedupe", (t) => {
  const db = evidenceDb(t);
  const [list] = diffViewData({ ids: ["a", "b", "a"] }, { ids: ["a", "b"] });
  assert.equal(classifyShadowDiff(list!, NONE).classification, "dedupe");
  const [count] = diffViewData({ repos: [{ id: "W1-T3", runs7d: 3 }] }, { repos: [{ id: "W1-T3", runs7d: 1 }] });
  const ev = readShadowEvidence([db], { ids: count!.ids, legacyAsOfMs: T0, viewAsOfMs: T0, duplicates: { rows: 2, ids: ["W1-T3"] } });
  assert.equal(classifyShadowDiff(count!, ev).classification, "dedupe");
  assert.equal(classifyShadowDiff(count!, readShadowEvidence([db], { ids: count!.ids, legacyAsOfMs: T0, viewAsOfMs: T0 })).classification, "real");
  assert.equal(classifyShadowDiff({ path: "count", legacy: 5, view: 3, ids: [] }, { ...NONE, duplicateRows: 2 }).classification, "real", "duplicates legacy read elsewhere do not explain a count with no members");
});

/** Classifies one count diff the way `compare` does: its members attached and their differing ids looked up. */
function countClass(db: ReadModelDb, legacy: string[], view: string[], extra: { legacyAsOfMs?: number; legacyHorizonMs?: number } = {}): { classification: string; reason: string } {
  const [diff] = diffViewData({ counts: { queued: legacy.length } }, { counts: { queued: view.length } });
  const members = { legacy, view };
  const ev = readShadowEvidence([db], { ids: memberEntities(members), legacyAsOfMs: extra.legacyAsOfMs ?? T0, viewAsOfMs: T0, legacyHorizonMs: extra.legacyHorizonMs ?? T0 - DAY });
  return classifyShadowDiff({ ...diff!, members }, ev);
}

test("a count diff whose differing members only pre-horizon rows name is legacy_horizon", (t) => {
  const db = evidenceDb(t);
  const got = countClass(db, ["W1-T2"], ["W1-T2", "W1-T1", "W1-T3"]);
  assert.equal(got.classification, "legacy_horizon", got.reason);
  assert.match(got.reason, /2 legacy_horizon/);
  assert.equal(countClass(db, ["W1-T1", "W1-T2"], ["W1-T2"]).classification, "legacy_horizon", "legacy counting a task it cannot see the end of");
  assert.equal(countClass(db, [], ["W1-T1"], { legacyHorizonMs: T0 - 40 * DAY }).classification, "real", "a member legacy could see is not a horizon effect");
  const gap = countClass(db, [], ["W1-T2"], { legacyAsOfMs: T0 - HOUR });
  assert.equal(gap.classification, "timing", gap.reason);
});

test("a count diff whose extra members legacy counted twice is dedupe", (t) => {
  const db = evidenceDb(t);
  const got = countClass(db, ["W1-T9", "W1-T9", "W1-T8", "W1-T8", "W1-T8"], ["W1-T9", "W1-T8"]);
  assert.equal(got.classification, "dedupe", got.reason);
  assert.match(got.reason, /3 dedupe/);
  assert.equal(countClass(db, ["W1-T9"], ["W1-T9", "W1-T9"]).classification, "real", "the view counting a task twice is a view bug");
});

test("a count diff with an unexplained member is real even when part of it is explained", (t) => {
  const db = evidenceDb(t);
  const got = countClass(db, ["W1-T8", "W1-T8"], ["W1-T8", "W1-T1", "W1-T9"]);
  assert.equal(got.classification, "real", got.reason);
  assert.match(got.reason, /no measured row explains W1-T9 \(1 legacy_horizon, 1 dedupe, 1 real\)/);
  const [diff] = diffViewData({ n: 2 }, { n: 3 });
  const short = classifyShadowDiff({ ...diff!, members: { legacy: ["W1-T1"], view: ["W1-T1", "W1-T3"] } }, NONE);
  assert.equal(short.classification, "real");
  assert.match(short.reason, /do not account for 2 vs 3/);
});

test("compare attaches the legacy side's members to a count diff", (t) => {
  const db = evidenceDb(t);
  const shadow = createViewShadow({ clock: fixedClock(T0), log: () => {}, evidence: (input) => readShadowEvidence([db], input) });
  const legacy = { data: { counts: { queued: 1 } }, asOfMs: T0, horizonMs: T0 - DAY, members: { "counts.queued": { legacy: ["W1-T2"], view: ["W1-T2", "W1-T1"] } } };
  const result = shadow.compare({ view: "now", key: "", requests: 1, legacy, body: { data: { counts: { queued: 2 } }, asOf: new Date(T0).toISOString() } });
  assert.deepEqual(result.diffs.map((d) => [d.path, d.classification]), [["counts.queued", "legacy_horizon"]]);
  const bare = shadow.compare({ view: "now", key: "", requests: 1, legacy: { ...legacy, members: {} }, body: { data: { counts: { queued: 2 } }, asOf: new Date(T0).toISOString() } });
  assert.deepEqual(bare.diffs.map((d) => d.classification), ["real"], "the same count without members stays real");
});

/** Classifies one sum diff the way `compare` does: its rows attached and their entities looked up. */
function sumClass(db: ReadModelDb, legacy: Array<[string, number]>, view: Array<[string, number]>, extra: { legacyAsOfMs?: number; precision?: number } = {}): { classification: string; reason: string } {
  const total = (rows: Array<[string, number]>): number => rows.reduce((acc, [, x]) => acc + x, 0);
  const [diff] = diffViewData({ cost: total(legacy) }, { cost: total(view) });
  const sum = { legacy, view, ...(extra.precision !== undefined ? { precision: extra.precision } : {}) };
  const ev = readShadowEvidence([db], { ids: sumEntities(sum), legacyAsOfMs: extra.legacyAsOfMs ?? T0, viewAsOfMs: T0, legacyHorizonMs: T0 - DAY });
  return classifyShadowDiff({ ...diff!, sum }, ev);
}

test("a sum diff is judged by the rows each side added", (t) => {
  const db = evidenceDb(t);
  const dup = sumClass(db, [["W1-T3#a", 5], ["W1-T3#a", 5], ["W1-T8#b", 2]], [["W1-T3#a", 5], ["W1-T8#b", 2]]);
  assert.equal(dup.classification, "dedupe", dup.reason);
  assert.match(dup.reason, /dedupe 5/);
  assert.equal(sumClass(db, [], [["W1-T1#a", 3]]).classification, "legacy_horizon", "a row whose task only pre-horizon rows name");
  assert.equal(sumClass(db, [], [["W1-T2#a", 3]], { legacyAsOfMs: T0 - HOUR }).classification, "timing", "a row between the two ages");
  const residual = sumClass(db, [["W1-T3#a", 5], ["W1-T3#a", 5]], [["W1-T3#a", 5], ["W1-T9#c", 1.5]]);
  assert.equal(residual.classification, "real", residual.reason);
  assert.match(residual.reason, /a residual of 1.5 no measured row explains \(W1-T9#c; dedupe 5, real 1.5\)/);
  assert.equal(sumClass(db, [["W1-T3#a", 5]], [["W1-T3#a", 6]]).classification, "real", "one row with two amounts is not a duplicate");
  assert.equal(sumClass(db, [["W1-T3#a", 5]], [["W1-T3#a", 5], ["W1-T3#a", 5]]).classification, "real", "the view adding a row twice is a view bug");
  const [cash] = diffViewData({ cash: 1.26 }, { cash: 1.25 });
  const rounded = classifyShadowDiff({ ...cash!, sum: { legacy: [["W1-T3#a", 1.254], ["W1-T3#a", 1.254]], view: [["W1-T3#a", 1.254]], precision: 0.01 } }, NONE);
  assert.match(rounded.reason, /do not account for 1.26 vs 1.25/, "two copies of 1.254 sum past the value legacy reports");
  const [within] = diffViewData({ cash: 2.51 }, { cash: 1.25 });
  assert.equal(classifyShadowDiff({ ...within!, sum: { legacy: [["W1-T3#a", 1.254], ["W1-T3#a", 1.254]], view: [["W1-T3#a", 1.254]], precision: 0.01 } }, NONE).classification, "dedupe", "rounding to the cent is not a residual");
});

test("a latest-time diff is explained only by the later side's own row", (t) => {
  const db = evidenceDb(t);
  const at = (ms: number): string => new Date(ms).toISOString();
  const classify = (latest: { legacy: string | null; view: string | null }, legacyAsOfMs = T0): string => {
    const [diff] = diffViewData({ last_run: at(T0 - 2 * HOUR) }, { last_run: at(T0 - 30 * 60_000) });
    const ev = readShadowEvidence([db], { ids: [latest.legacy, latest.view].flatMap((r) => (r ? [r.split("#")[0]!] : [])), legacyAsOfMs, viewAsOfMs: T0, legacyHorizonMs: T0 - DAY });
    return classifyShadowDiff({ ...diff!, latest }, ev).classification;
  };
  assert.equal(classify({ legacy: "W1-T3#x", view: "W1-T2#y" }, T0 - HOUR), "timing");
  assert.equal(classify({ legacy: "W1-T3#x", view: "W1-T1#y" }), "legacy_horizon");
  assert.equal(classify({ legacy: "W1-T3#x", view: "W1-T9#y" }), "real");
  assert.equal(classify({ legacy: "W1-T3#x", view: null }), "real");
});

test("a rate computed from two counts is explained only when a count it reads is", (t) => {
  const db = evidenceDb(t);
  const shadow = createViewShadow({ clock: fixedClock(T0), log: () => {}, evidence: (input) => readShadowEvidence([db], input) });
  const derived = { rate: ["ok", "bad"] };
  const compare = (legacyData: unknown, members: Record<string, { legacy: string[]; view: string[] }>) =>
    shadow.compare({ view: "r", key: "", requests: 1, legacy: { data: legacyData, asOfMs: T0, members, derived }, body: { data: { ok: 1, bad: 1, rate: 0.5 }, asOf: null } }).diffs;
  const explained = compare({ ok: 1, bad: 2, rate: 2 / 3 }, { bad: { legacy: ["W1-T3#a", "W1-T3#a"], view: ["W1-T3#a"] } });
  assert.deepEqual(explained.map((d) => [d.path, d.classification]), [["bad", "dedupe"], ["rate", "dedupe"]]);
  const unexplained = compare({ ok: 2, bad: 2, rate: 0.5 + 1e-9 }, { ok: { legacy: ["W1-T3#o", "W1-T3#o"], view: ["W1-T3#o"] }, bad: { legacy: ["W1-T3#a", "W1-T9#b"], view: ["W1-T3#a"] } });
  assert.deepEqual(unexplained.map((d) => [d.path, d.classification]), [["bad", "real"], ["ok", "dedupe"], ["rate", "real"]], "one explained input does not explain the rate");
  const alone = compare({ ok: 1, bad: 1, rate: 0.4 }, {});
  assert.deepEqual(alone.map((d) => [d.path, d.classification]), [["rate", "real"]]);
});

test("a structural diff matches array items by id and ignores build stamps", () => {
  assert.deepEqual(diffViewData({ a: 1, generated_at: "x" }, { a: 1, generated_at: "y" }), []);
  assert.deepEqual(diffViewData([{ id: 1, v: 1 }, { id: 2, v: 2 }], [{ id: 2, v: 2 }, { id: 1, v: 3 }]).map((d) => d.path), ["[id=1].v"]);
  assert.deepEqual(diffViewData({ l: [{ id: 1 }] }, { l: [{ id: 1 }, { id: 2 }] }).map((d) => [d.path, d.legacy, d.ids]), [["l[id=2]", undefined, ["2"]]]);
  assert.deepEqual(diffViewData([[1], [2]], [[1], [3]]).map((d) => d.path), ["[1]"]);
  assert.deepEqual(diffViewData([{ v: 1 }, { v: 1 }], [{ v: 2 }]).map((d) => d.path), [""]);
  assert.deepEqual(diffViewData({ a: { b: 1 } }, { a: [1] }).map((d) => d.path), ["a"]);
});

test("readiness flips only on sustained zero real diffs over a day of measured traffic", () => {
  const clock = steppedClock();
  let real = false;
  const shadow = createViewShadow({ clock, log: () => {}, evidence: () => NONE });
  const sample = (requests: number): void => void shadow.compare({ view: "nav-badge", key: "", requests, legacy: { data: { n: real ? 1 : 2 }, asOfMs: T0 }, body: { data: { n: 2 }, asOf: null } });
  sample(10);
  assert.equal(shadow.readiness()[0]!.ready, false);
  assert.match(shadow.readiness()[0]!.reason, /traffic not yet observed over a full day/);
  for (let i = 0; i < 24; i++) {
    clock.advance(HOUR);
    sample(10);
  }
  let r = shadow.readiness()[0]!;
  assert.equal(r.requestsPerDay, 250, "250 requests over the first day");
  assert.equal(r.requiredSamples, 750, "3 x requests per day: the rule of three");
  assert.equal(r.ready, false, "25 samples cannot bound a 250-a-day view");
  assert.match(r.reason, /25 of 750 samples/);
  const every = DAY / 250;
  for (let i = 0; i < 725; i++) {
    clock.advance(every);
    sample(1);
  }
  r = shadow.readiness()[0]!;
  assert.equal(r.streakSamples, 750);
  assert.equal(r.ready, true, r.reason);
  real = true;
  sample(1);
  real = false;
  r = shadow.readiness()[0]!;
  assert.equal(r.ready, false);
  assert.equal(r.diffs.real, 1);
  assert.match(r.reason, /a real diff within the last day/);
  let steps = 0;
  for (r = shadow.readiness()[0]!; r.streakSamples < r.requiredSamples!; r = shadow.readiness()[0]!) {
    assert.equal(r.ready, false, `not ready at ${r.streakSamples} of ${r.requiredSamples}`);
    clock.advance(every);
    sample(1);
    steps++;
  }
  assert.equal(r.ready, true, r.reason);
  assert.ok(steps >= 750, `the streak restarted from zero after the real diff (${steps} samples)`);
  const busy = shadowReadiness("busy", { ...r, streakSamples: 1_000_000, streakSinceMs: clock.now() - HOUR }, clock.now());
  assert.equal(busy.ready, false, "any number of samples inside one hour is not sustained");
  assert.match(busy.reason, /a real diff within the last day/);
  const quiet = shadowReadiness("quiet", { ...r, requests: 3, firstRequestMs: clock.now() - DAY, streakSamples: 9, streakSinceMs: clock.now() - DAY, lastRealMs: null }, clock.now());
  assert.equal(quiet.requiredSamples, 9, "a quiet view needs fewer samples");
  assert.equal(quiet.ready, true);
  const fresh = shadowReadiness("fresh", { ...quiet, streakSinceMs: clock.now() - HOUR }, clock.now());
  assert.match(fresh.reason, /zero real diffs, but for under a day/);
});

test("the sampler passes one request per minute per key and counts the rest", () => {
  const clock = steppedClock();
  const queue: Array<() => void> = [];
  const sent: Array<{ view: string; key: string; requests: number }> = [];
  const observe = createShadowSampler({ clock, defer: (run) => queue.push(run), send: ({ view, key, requests }) => sent.push({ view, key, requests }) });
  for (let i = 0; i < 5; i++) observe("v", "", new URLSearchParams());
  observe("v", "k=1", new URLSearchParams("k=1"));
  assert.equal(sent.length, 0, "nothing runs before the deferred turn");
  queue.splice(0).forEach((run) => run());
  clock.advance(60_000);
  observe("v", "", new URLSearchParams());
  queue.splice(0).forEach((run) => run());
  assert.deepEqual(sent, [{ view: "v", key: "", requests: 1 }, { view: "v", key: "k=1", requests: 1 }, { view: "v", key: "", requests: 5 }]);
});

function serve(t: TestCtx, handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server: Server = createServer(handler);
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function fetchBody(port: number, path: string): Promise<{ res: IncomingMessage; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ res, body }));
    }).on("error", reject);
  });
}

test("the shadow comparator adds no work to the request path", async (t) => {
  const events: string[] = [];
  const legacy: ViewDefinition = { name: "nav-badge", version: 1, compute: () => {
    events.push("legacy computed");
    return { data: { count: 1 }, sources: [{ name: "inbox", asOf: new Date(T0).toISOString(), state: "fresh" }] };
  } };
  const entry: ViewBodyEntry = { view: "nav-badge", key: "", version: 1, generation: 1, etag: 'W/"x"',
    body: { view: "nav-badge", version: 1, generatedAt: "", asOf: null, stale: false, sources: [], data: { count: 2 } } };
  const posted: ShadowRequest[] = [];
  const queue: Array<() => void> = [];
  const observe = legacyViewSampler({ legacy: [legacy], clock: fixedClock(T0), defer: (run) => queue.push(run), post: (request) => posted.push(request) });
  const [route] = buildReadModelViewRoutes({
    legacy: [legacy],
    readModel: { body: () => entry, judge: (sources) => [...sources], switches: () => ({ views: { "nav-badge": "shadow" } }) },
    shadow: (view, key, params) => {
      events.push("shadow noted");
      observe(view, key, params);
    },
  });
  const port = await serve(t, (req, res) => {
    res.once("finish", () => events.push("response finished"));
    route!.handler(req, res, {} as never);
    events.push("handler returned");
  });
  const { body } = await fetchBody(port, "/v1/views/nav-badge");
  assert.equal(JSON.parse(body).data.count, 1, "shadow is legacy primary: the request is answered by the legacy computation");
  assert.deepEqual(events, ["legacy computed", "handler returned", "response finished", "shadow noted"], "the comparison's legacy side is not computed on the request");
  queue.splice(0).forEach((run) => run());
  assert.deepEqual(events.at(-1), "legacy computed");
  assert.deepEqual(posted, [{ view: "nav-badge", key: "", requests: 1, legacy: { data: { count: 1 }, asOfMs: T0 } }]);
});

test("a view without a legacy body on serve's side is posted for the worker to compute", () => {
  const posted: ShadowRequest[] = [];
  const failing: ViewDefinition = { name: "bad", version: 1, compute: () => ({ error: "nope" }) };
  const stampless: ViewDefinition = { name: "stampless", version: 1, compute: () => ({ data: 1, sources: [] }) };
  const observe = legacyViewSampler({ legacy: [failing, stampless], clock: fixedClock(T0), defer: (run) => run(), post: (request) => posted.push(request) });
  observe("repositories", "", new URLSearchParams());
  observe("bad", "", new URLSearchParams());
  observe("stampless", "", new URLSearchParams());
  const expected: ShadowRequest[] = [{ view: "repositories", key: "", requests: 1 }, { view: "bad", key: "", requests: 1 }, { view: "stampless", key: "", requests: 1, legacy: { data: 1, asOfMs: T0 } }];
  assert.deepEqual(posted, expected);
  const opts = { legacy: [stampless] };
  assert.equal(withViewShadow(undefined, opts), opts);
  const attached = withViewShadow({ shadow: (request: ShadowRequest) => void posted.push(request) }, { ...opts, clock: fixedClock(T0) });
  assert.equal(typeof attached.shadow, "function");
});

test("counters persist in the home read model across a restart", (t) => {
  const clock = fixedClock(T0);
  const db = openProjectorReadModel(scratch(t, "shadow-store"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  const first = createViewShadow({ clock, log: () => {}, evidence: () => NONE, store: sqliteShadowStore(db, got.lease) });
  first.compare({ view: "v", key: "", requests: 4, legacy: { data: 1, asOfMs: T0 }, body: { data: 2, asOf: null } });
  const again = createViewShadow({ clock, log: () => {}, evidence: () => NONE, store: sqliteShadowStore(db, got.lease) });
  const [r] = again.readiness();
  assert.equal(r!.requests, 4);
  assert.equal(r!.diffs.real, 1);
});

test("the legacy repositories side is each instance's summary route computed in the worker", (t) => {
  const stateDir = scratch(t, "shadow-repos");
  const path = repositoriesSourcesPath(stateDir);
  assert.equal(legacyRepositories(path, T0), undefined, "no published sources and no legacy side");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(path, JSON.stringify({ instances: [
    { instanceId: "core", options: { root: stateDir, instanceRepository: { owner: "o", repo: "r" } } },
    { instanceId: "broken", options: { root: stateDir, instanceRepository: { owner: "o", repo: "b" }, ledgerPath: stateDir } },
  ] }));
  const legacy = legacyRepositories(path, T0)!;
  const data = legacy.data as { instances: Array<{ instanceId: string; summary?: unknown; reason?: string }> };
  assert.equal(data.instances[0]!.instanceId, "core");
  assert.ok(data.instances[0]!.summary);
  assert.match(data.instances[1]!.reason!, /ledger read failed/);
  const grouped = legacy.data as { projects: Array<{ project: string; worst: { state: string } }>; projectsReason?: string };
  assert.deepEqual(grouped.projects.map((p) => [p.project, p.worst.state]), [["r", "unknown"], ["b", "unavailable"]], "legacy groups like the view, so grouping is not a diff");
  assert.equal(grouped.projectsReason, "no instance names a registry");
});

test("the worker compares a shadow sample off the main thread and the status view shows readiness", (t) => {
  const stateDir = scratch(t, "shadow-worker");
  const ledgerDir = scratch(t, "shadow-worker-rows");
  writeFileSync(join(ledgerDir, "ledger.ndjson"), `${row(T0 - 1_000, "run.start", { task_id: "W1-T1" })}\n`);
  const clock = steppedClock();
  const posted: ReadModelWorkerMessage[] = [];
  const badge: ReadModelView = { name: "nav-badge", version: 1, materialize: () => [{ key: "", data: { count: 2 }, sources: [] }] };
  const broken: ReadModelView = { name: "broken", version: 1, materialize: () => [{ key: "", data: 1, sources: [] }] };
  const status = (): Record<string, unknown> | undefined => posted.flatMap((m) => (m.type === "body" && m.entry.view === "read-model" ? [m.entry.body.data as Record<string, unknown>] : [])).at(-1);
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock, post: (m) => posted.push(m), views: [badge, broken, readModelStatusView] });
  t.after(() => ticker.release());
  assert.equal(ticker.shadow({ view: "nav-badge", key: "", requests: 1, legacy: { data: { count: 1 }, asOfMs: T0 } }), false, "no body before the first tick");
  ticker.tick();
  assert.equal(ticker.shadow({ view: "nav-badge", key: "", requests: 3, legacy: { data: { count: 1 }, asOfMs: T0 } }), true);
  assert.equal(ticker.shadow({ view: "repositories", key: "", requests: 1 }), false, "no repositories body to compare");
  assert.equal(ticker.shadow({ view: "nav-badge", key: "", requests: 1 }), false, "no legacy side for nav-badge in the worker");
  const diffs = posted.filter((m) => m.type === "log" && m.step === VIEW_SHADOW_DIFF_STEP);
  assert.equal(diffs.length, 1);
  clock.advance(1_000);
  ticker.tick();
  const shown = status()!.shadow as Array<{ view: string; requests: number; ready: boolean }>;
  assert.deepEqual(shown.map((s) => [s.view, s.requests, s.ready]), [["nav-badge", 3, false]]);
  const failing = ticker.shadow({ view: "broken", key: "", requests: 1, legacy: { get data(): unknown { throw new Error("boom"); }, asOfMs: T0 } });
  assert.equal(failing, false);
  assert.ok(posted.some((m) => m.type === "log" && m.step === "view.shadow_failed"));
});

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i++) await sleep(10);
  assert.ok(done(), what);
}

test("the worker branch hands a shadow message to its comparator", async (t) => {
  const stateDir = scratch(t, "shadow-branch");
  const ledgerDir = scratch(t, "shadow-branch-rows");
  writeFileSync(join(ledgerDir, "ledger.ndjson"), `${row(T0, "run.start", { task_id: "W1-T1" })}\n`);
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  const signal = new SharedArrayBuffer(8);
  const port = { on: (_event: "message", run: (msg: { type?: string }) => void) => void (onMessage = run), postMessage: (m: unknown) => void posted.push(m as ReadModelWorkerMessage), close: () => {} };
  runReadModelWorker(port, { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 5, signal });
  t.after(() => onMessage?.({ type: "stop" }));
  await until(() => posted.some((m) => m.type === "body" && m.entry.view === "read-model"), "the status view materialized");
  onMessage?.({ type: "shadow", view: "read-model", key: "", requests: 2, legacy: { data: { instances: [] }, asOfMs: T0 } } as { type: string });
  assert.ok(posted.some((m) => m.type === "log" && m.step === VIEW_SHADOW_DIFF_STEP && m.extra.view === "read-model"));
});

test("serve posts a shadow sample to a real worker thread which writes the diff row", async (t) => {
  const stateDir = scratch(t, "shadow-thread");
  const ledgerDir = scratch(t, "shadow-thread-rows");
  writeFileSync(join(ledgerDir, "ledger.ndjson"), `${row(T0, "run.start", { task_id: "W1-T1" })}\n`);
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 20, log: (step, extra) => void logs.push([step, extra]) });
  t.after(() => handle.stop());
  handle.shadow({ view: "read-model", key: "", requests: 1 });
  handle.start();
  await until(() => handle.body("read-model") !== undefined, "the worker posted its status body");
  handle.shadow({ view: "read-model", key: "", requests: 1, legacy: { data: { instances: [] }, asOfMs: T0 } });
  await until(() => logs.some(([step]) => step === VIEW_SHADOW_DIFF_STEP), "the worker compared the sample");
  const [, extra] = logs.find(([step]) => step === VIEW_SHADOW_DIFF_STEP)!;
  assert.equal(extra?.view, "read-model");
  await until(() => Array.isArray((handle.body("read-model")?.body.data as { shadow?: unknown }).shadow), "the status view shows readiness");
});

/**
 * Captured on the host, 2026-10-01T06:33Z: `now?instance=console` `board.groups.queued` classified `real`
 * with the same 167 ids on both sides. UI-T36 and UI-T35 sort by a `sweep.disposed` row the live file's
 * compaction pruned (09-21T16:03, 09-20T21:13), newer than its oldest row (09-14T01:14), so legacy
 * dated them by their merge; UI-T37 swapped places with UI-T35 as a result.
 */
const CONSOLE_SAMPLE_MS = Date.parse("2026-10-01T06:33:28.040Z");
const CONSOLE_HORIZON_MS = Date.parse("2026-09-14T01:14:47.493Z");
const QUEUED_LEGACY = ["UI-T54", "API-T55", "UI-T53", "UI-T50", "UI-T51", "API-T53", "API-T54", "API-T51", "API-T52", "API-T39", "UI-T38", "UI-T47", "UI-T49", "UI-T45", "CONSOLE-T34", "UI-T44", "API-T48", "API-T50", "API-T47", "API-T49", "API-T45", "API-T41", "API-T46", "API-T42", "UI-T40", "API-T34", "API-T40", "UI-T37", "UI-T36", "UI-T35", "API-T37"];
const QUEUED_VIEW = ["UI-T54", "API-T55", "UI-T36", "UI-T53", "UI-T50", "UI-T51", "API-T53", "API-T54", "API-T51", "API-T52", "API-T39", "UI-T38", "UI-T47", "UI-T49", "UI-T45", "CONSOLE-T34", "UI-T44", "API-T48", "API-T50", "API-T47", "API-T49", "API-T45", "API-T41", "API-T46", "API-T42", "UI-T40", "API-T34", "API-T40", "UI-T35", "UI-T37", "API-T37"];

/** The console's live rows for the three tasks, and each one's sort-key row on each side. */
const CONSOLE_LIVE = legacyRowIndex([
  { ts: "2026-09-14T01:14:47.493Z", step: "dispatch.starvation.escalated", task_id: "daemon" },
  { ts: "2026-09-20T20:28:12.102Z", step: "verdict.merged", task_id: "UI-T35" },
  { ts: "2026-09-20T20:28:13.999Z", step: "verdict.merged", task_id: "UI-T36" },
  { ts: "2026-09-20T20:47:36.765Z", step: "verdict.merged", task_id: "UI-T37" },
]);

function queuedClass(sortKeys: Record<string, ShadowLatest>, rows?: ReturnType<typeof legacyRowIndex>): { classification: string; reason: string } {
  const diff = diffViewData({ queued: QUEUED_LEGACY }, { queued: QUEUED_VIEW })[0]!;
  assert.deepEqual(diff.ids, [], "the same ids on both sides: nothing to read rows for");
  const ev = readShadowEvidence([], { ids: diff.ids, legacyAsOfMs: CONSOLE_SAMPLE_MS, viewAsOfMs: CONSOLE_SAMPLE_MS, legacyHorizonMs: CONSOLE_HORIZON_MS, ...(rows ? { legacyRows: rows } : {}) });
  return classifyShadowDiff({ ...diff, sortKeys }, ev);
}

const keyed = (id: string, legacy: string, view: string): [string, ShadowLatest] => [id, { legacy: `${id}#${legacy}`, view: `${id}#${view}` }];

test("a group listing the same ids in another order is explained by rows the live file pruned", () => {
  const sortKeys = Object.fromEntries([
    keyed("UI-T36", "2026-09-20T20:28:13.999Z", "2026-09-21T16:03:10.652Z"),
    keyed("UI-T35", "2026-09-20T20:28:12.102Z", "2026-09-20T21:13:00.205Z"),
    keyed("UI-T37", "2026-09-20T20:47:36.765Z", "2026-09-20T20:47:36.765Z"),
  ]);
  const got = queuedClass(sortKeys, CONSOLE_LIVE);
  assert.equal(got.classification, "legacy_horizon", got.reason);
  assert.match(got.reason, /2 legacy_horizon/);
  assert.equal(queuedClass(sortKeys).classification, "real", "without legacy's own rows a pruned row newer than its oldest one is invisible");
  const held = { ...CONSOLE_LIVE, "UI-T36": [...CONSOLE_LIVE["UI-T36"]!, `${Date.parse("2026-09-21T16:03:10.652Z")}|sweep.disposed`] };
  assert.equal(queuedClass(sortKeys, held).classification, "real", "a sort-key row legacy held explains nothing: the view's row must be one it lacks");
});

test("an order diff whose moved id nothing explains is real", () => {
  const sortKeys = Object.fromEntries([
    keyed("UI-T36", "2026-09-20T20:28:13.999Z", "2026-09-21T16:03:10.652Z"),
    keyed("UI-T35", "2026-09-20T20:28:12.102Z", "2026-09-20T20:28:12.102Z"),
  ]);
  const got = queuedClass(sortKeys, CONSOLE_LIVE);
  assert.equal(got.classification, "real", got.reason);
  assert.match(got.reason, /no measured row explains UI-T3[57]/);
  assert.deepEqual(movedIds(["a", "b", "c", "d"], ["d", "a", "b", "c"]), ["d"]);
  const gap = classifyShadowDiff({ path: "q", legacy: ["a", "b"], view: ["b", "a"], ids: [], sortKeys: Object.fromEntries([keyed("b", "2026-10-01T06:00:00.000Z", "2026-10-01T06:30:00.000Z")]) },
    readShadowEvidence([], { ids: [], legacyAsOfMs: CONSOLE_SAMPLE_MS, viewAsOfMs: Date.parse("2026-10-01T06:20:00.000Z") }));
  assert.equal(gap.classification, "timing", "a sort-key row between the two ages");
});

test("a group member only one side lists is judged on its own rows and never by a neighbour", (t) => {
  const db = evidenceDb(t);
  const ev = (ids: string[]): ShadowEvidence => readShadowEvidence([db], { ids, legacyAsOfMs: T0, viewAsOfMs: T0, legacyHorizonMs: T0 - DAY });
  const one = diffViewData({ blocked: ["W1-T1"] }, { blocked: ["W1-T1", "W1-T3"] })[0]!;
  assert.equal(classifyShadowDiff(one, ev(one.ids)).classification, "legacy_horizon");
  const two = diffViewData({ blocked: [] }, { blocked: ["W1-T3", "W1-T2"] })[0]!;
  const got = classifyShadowDiff(two, ev(two.ids));
  assert.equal(got.classification, "real", "W1-T3's horizon row does not explain W1-T2");
  assert.match(got.reason, /no measured row explains W1-T2 \(1 legacy_horizon, 1 real\)/);
  const dup = diffViewData({ blocked: ["W1-T3", "W1-T3"] }, { blocked: ["W1-T3", "W1-T3"] });
  assert.deepEqual(dup, []);
  const viewDup = classifyShadowDiff({ path: "blocked", legacy: ["W1-T3"], view: ["W1-T3", "W1-T3"], ids: [] }, ev([]));
  assert.equal(viewDup.classification, "real", viewDup.reason);
  const typed = classifyShadowDiff({ path: "blocked", legacy: [1], view: ["1"], ids: [] }, ev([]));
  assert.equal(typed.classification, "real", typed.reason);
});

test("a member legacy read after the view's age is timing by legacy's own row before the projector ingests it", (t) => {
  // Captured 2026-10-01T05:47:09Z after serve recycled at 05:42:08: board.counts.running read real for W1-T4810,
  // whose dispatch.claim (05:46:25.298Z) legacy's live file held and the read model had not yet ingested.
  const db = evidenceDb(t);
  const claim = { ts: "2026-10-01T05:46:25.298Z", step: "dispatch.claim", task_id: "W1-T4810", run_id: "W1-T4810-1790831583056" };
  const input = { ids: ["W1-T4810"], legacyAsOfMs: Date.parse("2026-10-01T05:47:09.082Z"), viewAsOfMs: Date.parse("2026-10-01T05:42:08.142Z"), legacyHorizonMs: T0 - DAY };
  const members = { legacy: ["W1-T4810"], view: [] };
  const diff = { path: "board.counts.running", legacy: 1, view: 0, ids: [], members };
  const seen = classifyShadowDiff(diff, readShadowEvidence([db], { ...input, legacyRows: legacyRowIndex([claim]) }));
  assert.equal(seen.classification, "timing", seen.reason);
  assert.equal(classifyShadowDiff(diff, readShadowEvidence([db], input)).classification, "real", "the read model alone holds no row for it yet");
  const pr = readShadowEvidence([db], { ...input, ids: ["8280"], legacyRows: legacyRowIndex([{ ts: "2026-10-01T05:46:30.000Z", step: "sweep.disposed", pr_number: 8280 }]) });
  assert.ok(pr.namedInGap.has("8280"), "a pull request's row names its number");
});

test("a member named only by a row compaction pruned after legacy's horizon is legacy_horizon", (t) => {
  // Measured on core 2026-10-01T07:2xZ: W1-T3741 has 39 fact rows since the live file's oldest row (09-25T16:50:54Z),
  // and the live file holds 10 of them; its 09-28 run.start is gone from it, so legacy and the view disagree on it.
  const dir = scratch(t, "shadow-pruned");
  const kept = [
    { ts: "2026-09-25T16:50:54.561Z", step: "daemon.boot", task_id: "daemon" },
    { ts: "2026-09-28T07:51:51.578Z", step: "verdict", task_id: "W1-T3741", verdict: "failed" },
  ];
  const pruned = { ts: "2026-09-28T07:47:25.515Z", step: "run.start", task_id: "W1-T3741" };
  writeFileSync(join(dir, "ledger.ndjson"), [...kept, pruned].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const clock = fixedClock(Date.parse("2026-10-01T06:36:51.199Z"));
  const db = openProjectorReadModel(scratch(t, "shadow-pruned-state"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  createLedgerProjector({ ledgerDir: dir, db, lease: got.lease, clock }).tick();
  const input = { ids: ["W1-T3741"], legacyAsOfMs: clock.now(), viewAsOfMs: clock.now(), legacyHorizonMs: Date.parse("2026-09-25T16:50:54.561Z") };
  const diff = { path: "board.counts.blocked", legacy: 0, view: 1, ids: [], members: { legacy: [], view: ["W1-T3741"] } };
  const seen = classifyShadowDiff(diff, readShadowEvidence([db], { ...input, legacyRows: legacyRowIndex(kept) }));
  assert.equal(seen.classification, "legacy_horizon", seen.reason);
  assert.equal(classifyShadowDiff(diff, readShadowEvidence([db], input)).classification, "real", "every row of it is newer than legacy's oldest one");
  const whole = classifyShadowDiff(diff, readShadowEvidence([db], { ...input, legacyRows: legacyRowIndex([...kept, pruned]) }));
  assert.equal(whole.classification, "real", "a live file holding every row explains nothing");
});
