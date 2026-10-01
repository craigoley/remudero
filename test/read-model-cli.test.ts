import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel, readModelDigest } from "../src/lib/ledger-projector.js";
import {
  READ_MODEL_GENERATION_GRACE_MS,
  READ_MODEL_REBUILT_STEP,
  READ_MODEL_SWITCH_STEP,
  readModelCommand,
  reapReadModelGenerations,
  readModelStatus,
  readModelSwitchesPath,
  readReadModelSwitches,
} from "../src/lib/read-model-cli.js";
import { runConsistencyCheck } from "../src/lib/read-model-consistency.js";
import {
  READ_MODEL_LEASE_TTL_MS,
  acquireLease,
  currentReadModelPath,
  openReadModel,
  readModelPointerPath,
  withWriteTransaction,
  type ReadModelDb,
} from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const LIVE = "ledger.ndjson";
const NOW = T0 + 3_600_000;
const clock = fixedClock(NOW);

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function row(ms: number, step: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date(ms).toISOString(), host: "h1", step, ...extra });
}

/** A core state dir whose ledger holds rows in a gzip archive and the live file. */
function coreState(t: TestCtx): { stateDir: string; lines: string[] } {
  const stateDir = scratch(t, "read-model-cli");
  const lines = Array.from({ length: 10 }, (_, i) => row(T0 + i * 1_000, i % 2 ? "run.start" : "worker.activity", { task_id: `W1-T${i}` }));
  writeFileSync(join(stateDir, `ledger.${new Date(T0 + 4_500).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(`${lines.slice(0, 5).join("\n")}\n`));
  writeFileSync(join(stateDir, LIVE), `${lines.slice(5).join("\n")}\n`);
  return { stateDir, lines };
}

function run(stateDir: string, rest: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = readModelCommand(rest, { stateDir, clock, out: (l) => out.push(l), error: (l) => err.push(l) });
  return { code, out, err };
}

function rowsOf(stateDir: string, step: string): Array<Record<string, unknown>> {
  return readFileSync(join(stateDir, LIVE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.step === step);
}

function cleanDigest(t: TestCtx, stateDir: string): string {
  const db = openProjectorReadModel(scratch(t, "read-model-clean"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  createLedgerProjector({ ledgerDir: stateDir, db, lease: got.lease, clock }).tick();
  return readModelDigest(db);
}

function sqliteFiles(stateDir: string): string[] {
  return readdirSync(join(stateDir, "read-model")).filter((n) => n.endsWith(".sqlite")).sort();
}

function integrity(db: ReadModelDb): unknown {
  return db.prepare("PRAGMA integrity_check").get()?.integrity_check;
}

test("a rebuild publishes a new generation only after its own consistency check passes", (t) => {
  const { stateDir } = coreState(t);
  const expected = cleanDigest(t, stateDir);
  // A running worker holds the live file's lease, and its copy has drifted.
  const worker = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => worker.close());
  const oldPath = worker.path;
  const held = acquireLease(worker, { holder: "worker", clock });
  assert.ok(held.ok);
  createLedgerProjector({ ledgerDir: stateDir, db: worker, lease: held.lease, clock }).tick();
  worker.exec("DELETE FROM fact");
  const drifted = readModelDigest(worker);
  assert.notEqual(drifted, expected);

  const r = run(stateDir, ["rebuild"]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join(), new RegExp(`now serving generation ${NOW} \\(fenced worker off the old one\\)`));
  assert.equal(readFileSync(readModelPointerPath(stateDir, "core", 1), "utf8").trim(), `core.v1.g${NOW}.sqlite`);
  assert.throws(() => withWriteTransaction(worker, held.lease, () => undefined), /lease_lost/, "the displaced worker can no longer commit");
  assert.equal(readModelDigest(worker), drifted, "the old file was never renamed over or rewritten");
  assert.deepEqual(sqliteFiles(stateDir), ["core.v1.g" + NOW + ".sqlite", "core.v1.sqlite"]);
  const fresh = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => fresh.close());
  assert.notEqual(fresh.path, oldPath, "a reopen by name resolves the pointer to the new generation");
  assert.equal(readModelDigest(fresh), expected);
  assert.equal(fresh.prepare("SELECT count(*) AS n FROM lease").get()?.n, 0, "the new generation carries no lease, so the worker takes it on reopen");
  const rebuilt = rowsOf(stateDir, READ_MODEL_REBUILT_STEP);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0]!.displaced_lease, "worker");
  assert.equal(rowsOf(stateDir, "read_model.consistency")[0]!.outcome, "agree");
});

test("a reader holding the old generation open while a rebuild flips the pointer sees no corruption and then moves to the new generation", (t) => {
  const { stateDir, lines } = coreState(t);
  assert.equal(run(stateDir, ["rebuild"]).code, 0);
  // The worker and a reader both hold the first generation, mid-use, with a WAL of their own.
  const worker = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => worker.close());
  const held = acquireLease(worker, { holder: "worker", clock });
  assert.ok(held.ok);
  withWriteTransaction(worker, held.lease, () => worker.exec("INSERT INTO meta(k, v) VALUES('in-wal', 'yes')"));
  const reader = openReadModel({ stateDir, instance: "core", schemaVersion: 1, readOnly: true });
  t.after(() => reader.close());
  reader.exec("BEGIN");
  const seenBefore = reader.prepare("SELECT count(*) AS n FROM seen").get()?.n;

  writeFileSync(join(stateDir, LIVE), `${readFileSync(join(stateDir, LIVE), "utf8")}${row(T0 + 30_000, "run.start")}\n`);
  const second = readModelCommand(["rebuild"], { stateDir, clock: fixedClock(NOW + 1), out: () => {}, error: () => {} });
  assert.equal(second, 0);
  assert.equal(reader.prepare("SELECT count(*) AS n FROM seen").get()?.n, seenBefore, "the reader's snapshot is unchanged");
  reader.exec("COMMIT");
  assert.equal(integrity(reader), "ok", "the old generation is intact under its open connections");
  assert.equal(integrity(worker), "ok");
  assert.equal(worker.meta("in-wal"), "yes", "its WAL was never shared with the new file");
  assert.throws(() => withWriteTransaction(worker, held.lease, () => undefined), /lease_lost/);

  const moved = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => moved.close());
  assert.equal(moved.path.endsWith(`core.v1.g${NOW + 1}.sqlite`), true);
  assert.equal(integrity(moved), "ok");
  assert.equal(moved.meta("in-wal"), undefined, "the new generation holds none of the old file's pages");
  // The first generation's rows, the first rebuild's two metric rows, and the row appended since.
  assert.equal(seenBefore, lines.length);
  assert.equal(moved.prepare("SELECT count(*) AS n FROM seen").get()?.n, lines.length + 3);
  const [status] = readModelStatus(stateDir, clock);
  assert.deepEqual([status!.file, status!.superseded], [`core.v1.g${NOW + 1}.sqlite`, [`core.v1.g${NOW}.sqlite`]]);
});

test("superseded generations are reaped only after the grace and once no live lease holds them", (t) => {
  const { stateDir } = coreState(t);
  assert.deepEqual(reapReadModelGenerations(stateDir, "core", clock), [], "no pointer yet: nothing to reap");
  assert.equal(run(stateDir, ["rebuild"]).code, 0);
  const old = openProjectorReadModel(stateDir, "core", clock);
  acquireLease(old, { holder: "straggler", clock });
  old.close();
  assert.equal(readModelCommand(["rebuild"], { stateDir, clock: fixedClock(NOW + 1), out: () => {}, error: () => {} }), 0);
  const dir = join(stateDir, "read-model");
  const aged = (NOW - 2 * READ_MODEL_GENERATION_GRACE_MS) / 1000;
  const later = () => fixedClock(NOW + READ_MODEL_LEASE_TTL_MS + 1);
  for (const name of sqliteFiles(stateDir)) utimesSync(join(dir, name), aged, aged);
  assert.deepEqual(reapReadModelGenerations(stateDir, "core", later()), [], "the pointer flipped inside the grace");
  utimesSync(readModelPointerPath(stateDir, "core", 1), aged, aged);
  assert.deepEqual(reapReadModelGenerations(stateDir, "core", fixedClock(NOW)), [], "a live lease still holds the old generation");
  assert.deepEqual(reapReadModelGenerations(stateDir, "core", later()), [`core.v1.g${NOW}.sqlite`]);
  assert.deepEqual(sqliteFiles(stateDir), [`core.v1.g${NOW + 1}.sqlite`], "only the current generation remains");
});

test("a rebuild whose own check disagrees leaves the live file untouched", (t) => {
  const { stateDir } = coreState(t);
  const live = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => live.close());
  live.exec("INSERT INTO meta(k, v) VALUES('marker', 'old')");
  // An archive named a month before its own rows: the projector applies them, the window's union
  // read skips an archive rotated before the window, so the store holds a row the ledger read lacks.
  // (A row past the projector's checkpoint, such as a writer stalled mid-line, is unsettled, not drift.)
  writeFileSync(join(stateDir, `ledger.${new Date(T0 - 30 * 86_400_000).toISOString().replace(/[:.]/g, "-")}.ndjson`), `${row(T0 + 20_000, "run.start")}\n`);
  const r = run(stateDir, ["rebuild"]);
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /failed its own consistency check \(escalated: \{"missing":0,"ledgerLost":1/);
  assert.equal(live.meta("marker"), "old");
  assert.deepEqual(sqliteFiles(stateDir), ["core.v1.sqlite"], "the unpublished generation is removed");
  assert.equal(existsSync(readModelPointerPath(stateDir, "core", 1)), false);
});

test("a rebuild of an empty window is refused as blind and names the remedy", (t) => {
  const { stateDir } = coreState(t);
  const err: string[] = [];
  const code = readModelCommand(["rebuild", "--window-days", "1"], { stateDir, clock: fixedClock(NOW + 30 * 86_400_000), out: () => {}, error: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join(), /could not see its corpus; an idle instance needs a wider --window-days\): .*read zero ledger rows/);
  assert.deepEqual(sqliteFiles(stateDir), [], "no generation was published or left behind");
});

test("a rebuild of a new instance creates its file and a non-core instance needs its ledger dir", (t) => {
  const { stateDir } = coreState(t);
  const other = scratch(t, "read-model-cli-state");
  assert.equal(run(other, ["rebuild", "--instance", "console"]).code, 2);
  const r = run(other, ["rebuild", "--instance", "console", "--ledger-dir", stateDir, "--window-days", "2"]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.doesNotMatch(r.out.join(), /fenced/);
  assert.ok(existsSync(currentReadModelPath(other, "console", 1)));
  assert.deepEqual(sqliteFiles(other), [`console.v1.g${NOW}.sqlite`]);
});

test("switch writes the file atomically and appends a read_model.switch row", (t) => {
  const stateDir = scratch(t, "read-model-cli-switch");
  assert.deepEqual(readReadModelSwitches(stateDir), { projector: "on", views: {} }, "no file means everything on");
  assert.equal(run(stateDir, ["switch", "now", "shadow"]).code, 0);
  assert.equal(run(stateDir, ["switch", "projector", "off"]).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(readModelSwitchesPath(stateDir), "utf8")), { projector: "off", views: { now: "shadow" } });
  assert.deepEqual(readdirSync(join(stateDir, "read-model")), ["switches.json"], "no staging file is left behind");
  const rows = rowsOf(stateDir, READ_MODEL_SWITCH_STEP);
  assert.deepEqual(rows.map((r) => [r.target, r.previous, r.mode]), [["now", "serve", "shadow"], ["projector", "on", "off"]]);
  assert.ok(typeof rows[0]!.actor === "string", "the row names its actor");

  assert.equal(run(stateDir, ["switch", "projector", "shadow"]).code, 2);
  assert.equal(run(stateDir, ["switch", "Bad View", "off"]).code, 2);
  writeFileSync(readModelSwitchesPath(stateDir), "{not json");
  const broken = run(stateDir, ["switch", "now", "off"]);
  assert.equal(broken.code, 1);
  assert.match(broken.err.join(), /is unreadable/);
});

test("status reports lag counts quarantine size lease and the last check per instance", (t) => {
  const { stateDir } = coreState(t);
  assert.match(run(stateDir, ["status"]).out.join(), /no read model under/);
  const db = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => db.close());
  const held = acquireLease(db, { holder: "worker", clock });
  assert.ok(held.ok);
  writeFileSync(join(stateDir, LIVE), `${readFileSync(join(stateDir, LIVE), "utf8")}${row(NOW + 3_600_000, "run.start")}\n`);
  createLedgerProjector({ ledgerDir: stateDir, db, lease: held.lease, clock }).tick();
  writeFileSync(join(stateDir, LIVE), `${readFileSync(join(stateDir, LIVE), "utf8")}${row(T0 + 50_000, "run.start")}\n`);
  // The appended row is past the checkpoint, so it is behind, not drift; a lost fact is the drift the check heals.
  db.exec("DELETE FROM fact WHERE seq = (SELECT max(seq) FROM fact)");
  runConsistencyCheck({ db, ledgerDir: stateDir, instance: "core", metricLedgerPath: join(scratch(t, "metric"), LIVE), lease: held.lease, clock });
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "core.v0.sqlite"), "");

  const [old, core] = readModelStatus(stateDir, clock).sort((a, b) => a.schemaVersion - b.schemaVersion);
  assert.deepEqual(old, { instance: "core", schemaVersion: 0, current: false, dbBytes: 0 });
  assert.deepEqual(core!.rows, { seen: 11, fact: 5, quarantine: 1 });
  assert.equal(core!.newestAppliedTs, new Date(T0 + 9_000).toISOString(), "the row appended after the tick is not applied");
  assert.equal(core!.lagMs, NOW - T0 - 9_000);
  assert.ok(core!.liveBytesBehind! > 0, "the row appended after the tick is behind");
  assert.ok(core!.dbBytes > 0);
  assert.deepEqual(core!.lease && [core.lease.holder, core.lease.live], ["worker", true]);
  assert.equal(core!.lastCheck?.outcome, "healed");

  const text = run(stateDir, ["status"]).out.join("\n");
  assert.match(text, /core v1: seen 11 fact 5 quarantine 1/);
  assert.match(text, /lease worker pid \d+ on /);
  assert.match(text, /last check healed at /);
  assert.match(text, /core v0: not the current schema/);
  const json = JSON.parse(run(stateDir, ["status", "--json"]).out.join("")) as { instances: unknown[] };
  assert.equal(json.instances.length, 2);
});

test("status of an empty store with an expired lease says so", (t) => {
  const stateDir = scratch(t, "read-model-cli-empty");
  const db = openProjectorReadModel(stateDir, "site", fixedClock(T0));
  t.after(() => db.close());
  acquireLease(db, { holder: "gone", clock: fixedClock(T0) });
  const text = run(stateDir, ["status"]).out.join("\n");
  assert.match(text, /lag n\/a \(empty\)/);
  assert.match(text, /\(expired\)/);
  assert.match(text, /last check never/);
});

test("a malformed read-model invocation is a usage error", (t) => {
  const stateDir = scratch(t, "read-model-cli-usage");
  assert.equal(run(stateDir, []).code, 2);
  assert.equal(run(stateDir, ["compact"]).code, 2);
  assert.equal(run(stateDir, ["status", "--bogus"]).code, 2);
  assert.equal(run(stateDir, ["rebuild", "--window-days", "zero"]).code, 2);
});

test("with no state dir given the command reads core's from the config", (t) => {
  const home = scratch(t, "read-model-cli-home");
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = saved;
  });
  const out: string[] = [];
  assert.equal(readModelCommand(["status"], { out: (l) => out.push(l) }), 0);
  assert.match(out.join(), new RegExp(`no read model under ${join(root, "state", "read-model")}`));
});
