import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel, readModelDigest } from "../src/lib/ledger-projector.js";
import {
  READ_MODEL_REBUILT_STEP,
  READ_MODEL_SWITCH_STEP,
  readModelCommand,
  readModelStatus,
  readModelSwitchesPath,
  readReadModelSwitches,
} from "../src/lib/read-model-cli.js";
import { runConsistencyCheck } from "../src/lib/read-model-consistency.js";
import { acquireLease, openReadModel, readModelPath, withWriteTransaction } from "../src/lib/read-model-db.js";
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

test("a rebuild swaps in a new file only after its own consistency check passes", (t) => {
  const { stateDir } = coreState(t);
  const expected = cleanDigest(t, stateDir);
  // A running worker holds the live file's lease, and its copy has drifted.
  const worker = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => worker.close());
  const held = acquireLease(worker, { holder: "worker", clock });
  assert.ok(held.ok);
  createLedgerProjector({ ledgerDir: stateDir, db: worker, lease: held.lease, clock }).tick();
  worker.exec("DELETE FROM fact");
  assert.notEqual(readModelDigest(worker), expected);

  const r = run(stateDir, ["rebuild"]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join(), /swapped in \(took the lease from worker\)/);
  assert.throws(() => withWriteTransaction(worker, held.lease, () => undefined), "the displaced worker can no longer commit");
  const fresh = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => fresh.close());
  assert.equal(readModelDigest(fresh), expected, "the live path now holds the rebuilt store");
  assert.equal(fresh.prepare("SELECT count(*) AS n FROM lease").get()?.n, 0, "the new file carries no lease, so the worker takes it on reopen");
  assert.deepEqual(readdirSync(join(stateDir, "read-model")).filter((n) => n.startsWith("rebuild-")), [], "the side directory is gone");
  const rebuilt = rowsOf(stateDir, READ_MODEL_REBUILT_STEP);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0]!.displaced_lease, "worker");
  assert.equal(rowsOf(stateDir, "read_model.consistency")[0]!.outcome, "agree");
});

test("a rebuild whose own check disagrees leaves the live file untouched", (t) => {
  const { stateDir } = coreState(t);
  const live = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => live.close());
  live.exec("INSERT INTO meta(k, v) VALUES('marker', 'old')");
  // A writer stalled mid-line: the projector waits for its newline, the union reads it anyway.
  writeFileSync(join(stateDir, LIVE), `${readFileSync(join(stateDir, LIVE), "utf8")}${row(T0 + 20_000, "run.start")}`);
  const r = run(stateDir, ["rebuild"]);
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /failed its own consistency check \(drift: \{"missing":1/);
  assert.equal(live.meta("marker"), "old");
  assert.deepEqual(readdirSync(join(stateDir, "read-model")).filter((n) => n.startsWith("rebuild-")), []);
});

test("a rebuild of an empty window is refused as blind and names the remedy", (t) => {
  const { stateDir } = coreState(t);
  const err: string[] = [];
  const code = readModelCommand(["rebuild", "--window-days", "1"], { stateDir, clock: fixedClock(NOW + 30 * 86_400_000), out: () => {}, error: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join(), /could not see its corpus; an idle instance needs a wider --window-days\): .*read zero ledger rows/);
  assert.equal(existsSync(readModelPath(stateDir, "core", 1)), false, "no file was swapped in");
});

test("a rebuild refuses a swap while a reader pins the live file and hands the lease back", (t) => {
  const { stateDir } = coreState(t);
  const worker = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => worker.close());
  const held = acquireLease(worker, { holder: "worker", clock });
  assert.ok(held.ok);
  createLedgerProjector({ ledgerDir: stateDir, db: worker, lease: held.lease, clock }).tick();
  const reader = openReadModel({ stateDir, instance: "core", schemaVersion: 1, readOnly: true });
  t.after(() => reader.close());
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) AS n FROM seen").get();
  const r = run(stateDir, ["rebuild"]);
  reader.exec("COMMIT");
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /could not be checkpointed/);
  assert.equal(worker.prepare("SELECT count(*) AS n FROM lease").get()?.n, 0, "the rebuild handed its lease back");
});

test("a rebuild of a new instance creates its file and a non-core instance needs its ledger dir", (t) => {
  const { stateDir } = coreState(t);
  const other = scratch(t, "read-model-cli-state");
  assert.equal(run(other, ["rebuild", "--instance", "console"]).code, 2);
  const r = run(other, ["rebuild", "--instance", "console", "--ledger-dir", stateDir, "--window-days", "2"]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.doesNotMatch(r.out.join(), /took the lease/);
  assert.ok(existsSync(readModelPath(other, "console", 1)));
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
  runConsistencyCheck({ db, ledgerDir: stateDir, instance: "core", metricLedgerPath: join(scratch(t, "metric"), LIVE), lease: held.lease, clock });
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "core.v0.sqlite"), "");

  const [old, core] = readModelStatus(stateDir, clock).sort((a, b) => a.schemaVersion - b.schemaVersion);
  assert.deepEqual(old, { instance: "core", schemaVersion: 0, current: false, dbBytes: 0 });
  assert.deepEqual(core!.rows, { seen: 12, fact: 6, quarantine: 1 });
  assert.equal(core!.newestAppliedTs, new Date(T0 + 50_000).toISOString(), "the healed row is the newest applied");
  assert.equal(core!.lagMs, NOW - T0 - 50_000);
  assert.ok(core!.liveBytesBehind! > 0, "the row appended after the tick is behind");
  assert.ok(core!.dbBytes > 0);
  assert.deepEqual(core!.lease && [core.lease.holder, core.lease.live], ["worker", true]);
  assert.equal(core!.lastCheck?.outcome, "healed");

  const text = run(stateDir, ["status"]).out.join("\n");
  assert.match(text, /core v1: seen 12 fact 6 quarantine 1/);
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
