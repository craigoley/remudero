import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, NOW_REFRESH_MS, type NowViewContext, type NowViewOptions } from "../src/lib/now-view.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-09T08:00:00.000Z");
const row = (step: string, extra: Record<string, unknown> = {}) => ({ ts: new Date(T0 - 60_000).toISOString(), step, ...extra });
const ndjson = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function fixture(t: TestContext) {
  const root = makeTempDir("now-warm-gates");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const archives = [
    ["ledger.2026-10-08.ndjson.gz", [row("daemon.boot", { head_sha: "abc1234" })]],
    ["ledger.2026-10-09T06-00-00-000Z.ndjson.gz", [row("daemon.freshness_not_stale", { arm: "up_to_date", origin_main_sha: "abc1234", code_sha: "abc1234" })]],
    ["ledger.2026-10-09T07-00-00-000Z.ndjson", [row("daemon.image_drift", { build_sha: "b1", baked_sha: "b2" }), row("heartbeat.tick")]],
  ] as const;
  for (const [name, rows] of archives) {
    const text = ndjson([...rows]);
    writeFileSync(join(ledgerDir, name), name.endsWith(".gz") ? gzipSync(text) : text);
  }
  const live = join(ledgerDir, "ledger.ndjson");
  writeFileSync(live, "");
  writeFileSync(join(ledgerDir, "DEPLOY_IMAGE_MANUAL"), "");
  const clock = fixedClock(T0);
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  t.after(() => db.close());
  const leased = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(leased.ok);
  createLedgerProjector({ ledgerDir, db, lease: leased.lease, clock }).tick();
  const ctx: NowViewContext = { now: T0, switches: { views: { now: "shadow" } }, instances: [{
    state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: T0, newestTs: null },
    db, lease: leased.lease,
  }] };
  const github = {
    readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
  } as unknown as GitHub;
  const counts: Array<Record<string, unknown>> = [];
  const options: NowViewOptions = {
    instances: [{ name: "core", ledgerDir, repo: "o/r" }], clock,
    readPlan: () => ({ tasks: [], byId: new Map() }),
    github: () => ({ github, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { readLive: () => [], diskFree: () => 1_000_000, rateLimit: () => 5_000 },
    dependencyGates: () => [], planBehind: () => ({ commits: 0 }),
    log: (step, extra) => { if (step === "read_model.now_gate_digests") counts.push(extra); },
  };
  const build = (view = createNowView(options)) => {
    const [body] = view.materialize(ctx);
    assert.ok(body, "the decisions body materialized");
    return body.data;
  };
  return { ledgerDir, live, archives, options, ctx, counts, build };
}

test("W1-T7391: a fresh now view reads the gate rows from durable rotation digests", (t) => {
  const f = fixture(t);
  appendFileSync(join(f.ledgerDir, f.archives[2][0]), "unrelated torn row\n");
  const first = f.build();
  assert.deepEqual(f.counts, [{ instance: "core", hits: 0, parsed: 3, writeFailed: 0, pruned: 0 }]);
  const directory = join(f.ledgerDir, "cache", "rotation-digests", "now%2Egate");
  for (const [name, rows] of f.archives) {
    const digest = JSON.parse(readFileSync(join(directory, name + ".json"), "utf8"));
    assert.equal(digest.holder, "now.gate");
    assert.equal(digest.reducerVersion, "1");
    assert.deepEqual(digest.read.rows, rows.filter((r) => r.step !== "heartbeat.tick"));
    assert.equal(digest.read.torn, name.endsWith(".ndjson") ? 1 : 0, "the durable digest retains all torn evidence");
  }
  const archiveReads: string[] = [];
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
    if (f.archives.some(([name]) => args[0] === join(f.ledgerDir, name))) archiveReads.push(String(args[0]));
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const fresh = createNowView(f.options);
  const second = f.build(fresh);
  assert.deepEqual(second.humanGates, first.humanGates);
  assert.equal(second.humanGates?.sources.find((s) => s.name === "reviewer-freshness")?.state, "complete");
  assert.ok(second.humanGates?.gates.some((g) => g.key === "operator_item:core:image-drift%3Ab1"));
  assert.deepEqual(f.counts.at(-1), { instance: "core", hits: 3, parsed: 0, writeFailed: 0, pruned: 0 });
  assert.deepEqual(archiveReads, []);
  appendFileSync(f.live, ndjson([row("daemon.image_drift", { ts: new Date(T0).toISOString(), build_sha: "b3", baked_sha: "b4" })]));
  f.ctx.now += NOW_REFRESH_MS;
  const updated = f.build(fresh);
  assert.ok(updated.humanGates?.gates.some((g) => g.key === "operator_item:core:image-drift%3Ab3"), "each build reads the live file");
  assert.deepEqual(f.counts.at(-1), { instance: "core", hits: 0, parsed: 0, writeFailed: 0, pruned: 0 }, "steady builds use the in-memory memo");
  assert.deepEqual(archiveReads, []);
});

test("now gate digests reparse damaged or stale caches and preserve incomplete evidence", (t) => {
  const f = fixture(t);
  const baseline = f.build();
  const digest = join(f.ledgerDir, "cache", "rotation-digests", "now%2Egate", f.archives[0][0] + ".json");
  const saved = readFileSync(digest, "utf8");
  for (const content of ["broken", saved.replace('"reducerVersion":"1"', '"reducerVersion":"old"')]) {
    writeFileSync(digest, content);
    assert.deepEqual(f.build().humanGates, baseline.humanGates);
    assert.deepEqual(f.counts.at(-1), { instance: "core", hits: 2, parsed: 1, writeFailed: 0, pruned: 0 });
  }
  const archive = join(f.ledgerDir, f.archives[2][0]);
  appendFileSync(archive, '\n{"step":"daemon.image_drift",broken\n');
  const incomplete = f.build();
  assert.equal(incomplete.humanGates?.sources.find((s) => s.name === "reviewer-freshness")?.state, "partial");
  assert.deepEqual(f.counts.at(-1), { instance: "core", hits: 2, parsed: 1, writeFailed: 0, pruned: 0 });
  const cachedIncomplete = f.build();
  assert.equal(cachedIncomplete.humanGates?.sources.find((s) => s.name === "reviewer-freshness")?.state, "partial");
  assert.deepEqual(f.counts.at(-1), { instance: "core", hits: 3, parsed: 0, writeFailed: 0, pruned: 0 });
  rmSync(f.live);
  assert.equal(f.build().humanGates?.sources.find((s) => s.name === "reviewer-freshness")?.state, "partial");
  writeFileSync(f.live, "");
  writeFileSync(archive, ndjson([...f.archives[2][1]]));
  writeFileSync(join(f.ledgerDir, "ledger.unknown"), "unclassified");
  assert.equal(f.build().humanGates?.sources.find((s) => s.name === "reviewer-freshness")?.state, "partial");
});

test("an unwritable now gate digest store still returns archived gates", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.ledgerDir, "cache"), "blocks the digest directory");
  for (let i = 0; i < 2; i++) {
    const body = f.build();
    assert.equal(body.humanGates?.sources.find((s) => s.name === "reviewer-freshness")?.state, "complete");
    assert.ok(body.humanGates?.gates.some((g) => g.key === "operator_item:core:image-drift%3Ab1"));
    assert.deepEqual(f.counts.at(-1), { instance: "core", hits: 0, parsed: 3, writeFailed: 3, pruned: 0 });
  }
});

test("an incomplete now gate read retains the last complete rows", (t) => {
  const f = fixture(t);
  const view = createNowView(f.options);
  f.build(view);
  appendFileSync(f.live, ndjson([row("daemon.image_drift", { ts: new Date(T0).toISOString(), build_sha: "new", baked_sha: "newer" })]) + '{"step":"daemon.boot",broken\n');
  f.ctx.now += NOW_REFRESH_MS;
  const body = f.build(view);
  assert.equal(body.humanGates?.sources.find((s) => s.name === "reviewer-freshness")?.state, "partial");
  assert.ok(body.humanGates?.gates.some((g) => g.key === "operator_item:core:image-drift%3Ab1"));
  assert.ok(!body.humanGates?.gates.some((g) => g.key === "operator_item:core:image-drift%3Anew"));
});
