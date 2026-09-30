import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { compactRotations, rotateLedger } from "../src/lib/ledger.js";
import {
  FUTURE_ROW_TOLERANCE_MS,
  createLedgerProjector,
  isFactStep,
  ledgerLineIdentity,
  openProjectorReadModel,
  readModelDigest,
  type LedgerProjectorOptions,
} from "../src/lib/ledger-projector.js";
import { acquireLease, ReadModelError, type ReadModelDb } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const LIVE = "ledger.ndjson";

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function line(ms: number, step: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date(ms).toISOString(), host: "h1", step, ...extra });
}

function body(lines: string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function archiveName(ms: number, suffix = ""): string {
  return `ledger.${new Date(ms).toISOString().replace(/[:.]/g, "-")}${suffix}.ndjson`;
}

interface Store {
  db: ReadModelDb;
  tick: () => ReturnType<ReturnType<typeof createLedgerProjector>["tick"]>;
}

function store(t: TestCtx, ledgerDir: string, clock: Clock, extra: Partial<LedgerProjectorOptions> = {}, stateDir = scratch(t, "projector-state")): Store {
  const db = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error(`lease held by ${got.heldBy}`);
  const projector = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock, ...extra });
  return { db, tick: () => projector.tick() };
}

function count(db: ReadModelDb, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
}

function rebuildDigest(t: TestCtx, ledgerDir: string, clock: Clock, extra: Partial<LedgerProjectorOptions> = {}): { digest: string; seen: number; transactions: number } {
  const clean = store(t, ledgerDir, clock, extra);
  const { transactions } = clean.tick();
  return { digest: readModelDigest(clean.db), seen: count(clean.db, "seen"), transactions };
}

/** Every distinct line in the three rotation forms, read without the projector: the oracle. */
function distinctUnionLines(ledgerDir: string): Set<string> {
  const out = new Set<string>();
  for (const name of readdirSync(ledgerDir)) {
    if (!/^ledger\.(.+\.)?ndjson(\.gz)?$/.test(name)) continue; // the live file, then both archive forms
    const raw = readFileSync(join(ledgerDir, name));
    const text = (name.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    for (const l of text.split("\n")) if (l.trim()) out.add(l.trim());
  }
  return out;
}

test("the fact store keeps decision render and panel steps and a line's identity is keyed on its own ts", () => {
  assert.equal(isFactStep("run.start"), true);
  assert.equal(isFactStep("implement.done"), true);
  assert.equal(isFactStep("worker.assignment"), true);
  assert.equal(isFactStep("panel.operator_agent_proposal"), true);
  assert.equal(isFactStep("worker.activity"), false);
  const a = ledgerLineIdentity(line(T0, "run.start"));
  assert.equal(a.tsMs, T0);
  assert.equal(ledgerLineIdentity('{"step":"no.ts"}').tsMs, 0);
  assert.equal(ledgerLineIdentity('{"ts":"not a time","step":"x"}').tsMs, 0);
  assert.notEqual(a.h, ledgerLineIdentity(line(T0, "run.start", { task_id: "W1-T1" })).h);
});

test("duplicate lines across every rotation form land once", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const shared = [line(T0, "run.start", { task_id: "W1-T1", run_id: "r1" }), line(T0 + 1, "worker.activity", { task_id: "W1-T1" })];
  const own = (n: number) => line(T0 + 100 + n, "verdict", { task_id: `W1-T${n}`, verdict: "merged" });
  writeFileSync(join(ledgerDir, `${archiveName(T0 + 10)}.gz`), gzipSync(body([...shared, own(1)])));
  writeFileSync(join(ledgerDir, archiveName(T0 + 20)), body([...shared, own(2)]));
  writeFileSync(join(ledgerDir, `${archiveName(T0 + 30, "-part-000001")}.gz`), gzipSync(body([...shared, own(3), own(3)])));
  writeFileSync(join(ledgerDir, LIVE), body([...shared, own(4)]));
  mkdirSync(join(ledgerDir, "ledger-superseded"));
  writeFileSync(join(ledgerDir, "ledger-superseded", `${archiveName(T0 - 1)}.gz`), gzipSync(body([own(9)])));

  const s = store(t, ledgerDir, fixedClock(T0 + 60_000));
  const r = s.tick();
  assert.equal(r.archivesRead, 3, "the gz, plain and part-numbered archives were all read");
  assert.ok(r.liveBytes > 0, "and the live file");
  assert.equal(r.lines, 13);
  assert.equal(r.fresh, 6, "2 shared + 4 own lines are distinct; the cold store is never read");
  assert.equal(r.duplicates, 7);
  assert.equal(count(s.db, "seen"), 6);
  assert.equal(count(s.db, "fact"), 5, "worker.activity is identity-only");
  assert.equal(Number(s.db.prepare("SELECT count(*) AS n FROM fact WHERE step = 'run.start'").get()?.n), 1);
  assert.equal(s.tick().fresh, 0, "a second tick over unchanged files adds nothing");
});

test("a row stamped past ingest time plus five minutes is quarantined and counted", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const future = line(T0 + FUTURE_ROW_TOLERANCE_MS + 60_000, "run.start", { task_id: "CLI" });
  const nearFuture = line(T0 + FUTURE_ROW_TOLERANCE_MS - 60_000, "run.start", { task_id: "CLI" });
  writeFileSync(join(ledgerDir, LIVE), body([line(T0 - 1_000, "run.start", { task_id: "CLI" }), future, nearFuture]));

  const s = store(t, ledgerDir, fixedClock(T0));
  const r = s.tick();
  assert.equal(r.quarantined, 1);
  assert.equal(count(s.db, "quarantine"), 1);
  const held = s.db.prepare("SELECT step, ingested_ms, body FROM quarantine").get();
  assert.deepEqual([held?.step, held?.ingested_ms, held?.body], ["run.start", T0, future]);
  assert.equal(count(s.db, "fact"), 2, "the quarantined row is never applied");
  const newest = s.db.prepare("SELECT max(ts_ms) AS m FROM fact").get()?.m;
  assert.equal(newest, T0 + FUTURE_ROW_TOLERANCE_MS - 60_000, "max(ts) is not poisoned by the future row");
  appendFileSync(join(ledgerDir, LIVE), `${future}\n`);
  assert.equal(s.tick().duplicates, 1, "a quarantined row is still deduplicated");
});

test("a SIGKILL after any transaction resumes to the digest of a clean rebuild even between its rows and its checkpoint", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => line(T0 + from + i, i % 3 ? "worker.activity" : "run.start", { task_id: `W1-T${from + i}` }));
  writeFileSync(join(ledgerDir, `${archiveName(T0 + 1_000)}.gz`), gzipSync(body(rows(0, 30))));
  writeFileSync(join(ledgerDir, `${archiveName(T0 + 2_000)}.gz`), gzipSync(body(rows(20, 30))));
  writeFileSync(join(ledgerDir, LIVE), body(rows(40, 40)));
  const chunkBytes = 1_024;
  const expected = rebuildDigest(t, ledgerDir, fixedClock(T0 + 60_000), { chunkBytes });
  assert.ok(expected.transactions >= 6, `two archives and a chunked live file take ${expected.transactions} transactions`);
  const child = join(scratch(t, "projector-child"), "crash.mts");
  const src = (m: string) => JSON.stringify(pathToFileURL(join(REPO_ROOT, "src", "lib", m)).href);
  writeFileSync(child, [
    `import { fixedClock } from ${src("clock.ts")};`,
    `import { acquireLease } from ${src("read-model-db.ts")};`,
    `import { createLedgerProjector, openProjectorReadModel } from ${src("ledger-projector.ts")};`,
    "const [ledgerDir, stateDir, killAt, chunkBytes, t0] = process.argv.slice(2);",
    "const clock = fixedClock(Number(t0));",
    "const db = openProjectorReadModel(stateDir, 'core', clock);",
    "const got = acquireLease(db, { clock });",
    "if (!got.ok) process.exit(3);",
    "let n = 0;",
    "const beforeCheckpoint = () => { if (++n === Number(killAt)) process.kill(process.pid, 'SIGKILL'); };",
    "createLedgerProjector({ ledgerDir, db, lease: got.lease, clock, chunkBytes: Number(chunkBytes), beforeCheckpoint }).tick();",
    "process.exit(4);",
  ].join("\n"));

  let killed = 0;
  const killPoints = [1, Math.ceil(expected.transactions / 2), expected.transactions];
  for (const killAt of killPoints) {
    const stateDir = scratch(t, "projector-state");
    const run = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", child, ledgerDir, stateDir, String(killAt), String(chunkBytes), String(T0 + 60_000)], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(run.signal, "SIGKILL", `the child died mid-transaction ${killAt} (status ${run.status}, stderr ${run.stderr})`);
    killed++;
    const resumed = store(t, ledgerDir, fixedClock(T0 + 120_000), { chunkBytes }, stateDir);
    const before = count(resumed.db, "seen");
    assert.ok(before < expected.seen, `the killed transaction ${killAt} committed nothing (${before} of ${expected.seen})`);
    resumed.tick();
    assert.equal(readModelDigest(resumed.db), expected.digest, `resume after a kill in transaction ${killAt}`);
  }
  assert.equal(killed, killPoints.length);
});

test("an incremental run across many rotations is identical to a clean rebuild", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const livePath = join(ledgerDir, LIVE);
  const clock = fixedClock(T0 + 3_600_000);
  const s = store(t, ledgerDir, clock);
  let at = T0;
  let restarts = 0;
  let duplicates = 0;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 12; i++) {
      at += 1_000;
      const task = { task_id: `W1-T${round}`, run_id: `run-${round}-${i}` };
      appendFileSync(livePath, `${line(at, i % 4 === 0 ? "run.start" : "worker.activity", task)}\n`);
      if (i % 5 === 0) appendFileSync(livePath, `${line(at, "worker.activity", task)}\n`);
      if (i === 6) duplicates += s.tick().duplicates;
    }
    const rotated = rotateLedger(livePath, { ceilingBytes: 1_000, smoothingWindowMs: 0, now: () => new Date(at) });
    assert.equal(rotated.rotated, true, `round ${round} rotated`);
    const r = s.tick();
    duplicates += r.duplicates;
    if (r.liveRestarted) restarts++;
  }
  const archives = readdirSync(ledgerDir).filter((n) => /^ledger\..+\.ndjson(\.gz)?$/.test(n));
  assert.ok(archives.length >= 8, `8 rotations left ${archives.length} archives`);
  assert.equal(restarts, 8, "every rotation replaced the live file and the projector restarted it");
  assert.ok(duplicates > 0, "the carried core and the twins were seen again and dropped");
  const oracle = distinctUnionLines(ledgerDir);
  assert.equal(count(s.db, "seen"), oracle.size, "every distinct union line is held once");
  const rebuilt = rebuildDigest(t, ledgerDir, clock);
  assert.equal(rebuilt.seen, oracle.size);
  assert.equal(readModelDigest(s.db), rebuilt.digest);
});

test("a second writer is refused by the lease and commits nothing", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const stateDir = scratch(t, "projector-state");
  const clock = fixedClock(T0);
  writeFileSync(join(ledgerDir, LIVE), body([line(T0 - 10, "run.start")]));
  const first = store(t, ledgerDir, clock, {}, stateDir);
  first.tick();
  const digest = readModelDigest(first.db);

  const second = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => second.close());
  const refused = acquireLease(second, { holder: "second-writer", clock });
  assert.equal(refused.ok, false, "the lease is held");
  appendFileSync(join(ledgerDir, LIVE), `${line(T0 - 5, "run.start", { task_id: "W1-T2" })}\n`);
  const forged = createLedgerProjector({ ledgerDir, db: second, lease: { name: "projector", holder: "second-writer", ttlMs: 20_000, clock }, clock });
  assert.throws(() => forged.tick(), (e: unknown) => e instanceof ReadModelError && e.reason === "lease_lost");
  assert.equal(readModelDigest(first.db), digest, "the refused writer's rows never committed");
  assert.equal(first.tick().fresh, 1, "the holder still projects the new row");
});

test("the directory gate skips the rotation listing until a rename moves the directory mtime", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  writeFileSync(join(ledgerDir, `${archiveName(T0)}.gz`), gzipSync(body([line(T0, "run.start")])));
  writeFileSync(join(ledgerDir, LIVE), body([line(T0 + 1, "run.start")]));
  const s = store(t, ledgerDir, fixedClock(Date.now() + 60_000));
  assert.equal(s.tick().listed, true);
  const quiet = s.tick();
  assert.equal(quiet.listed, false, "an unchanged directory is not listed");
  appendFileSync(join(ledgerDir, LIVE), `${line(T0 + 2, "run.start")}\n`);
  assert.equal(s.tick().fresh, 1, "the live file is still tailed while the gate is shut");
  writeFileSync(join(ledgerDir, `${archiveName(T0 + 5)}.gz`), gzipSync(body([line(T0 + 3, "run.start")])));
  const after = s.tick();
  assert.equal(after.listed, true);
  assert.equal(after.archivesRead, 1);
});

test("an unreadable archive is retried on the next tick even when the directory did not change", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const archive = join(ledgerDir, `${archiveName(T0)}.gz`);
  writeFileSync(archive, "not gzip at all");
  const s = store(t, ledgerDir, fixedClock(Date.now() + 60_000));
  const first = s.tick();
  assert.equal(first.unread.length, 1);
  assert.match(first.unread[0] ?? "", /incorrect header check|unexpected end/);
  writeFileSync(archive, gzipSync(body([line(T0, "run.start")])));
  const second = s.tick();
  assert.equal(second.listed, true, "an unread archive keeps the gate open");
  assert.deepEqual([second.unread, second.archivesRead, second.fresh], [[], 1, 1]);
});

test("a torn final line is applied only once its newline lands", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const livePath = join(ledgerDir, LIVE);
  const whole = line(T0, "run.start", { task_id: "W1-T7", note: "x".repeat(80) });
  writeFileSync(livePath, `${line(T0 - 1, "run.start")}\n${whole.slice(0, 40)}`);
  const s = store(t, ledgerDir, fixedClock(T0), { chunkBytes: 16 });
  assert.equal(s.tick().fresh, 1, "only the complete line is applied");
  appendFileSync(livePath, `${whole.slice(40)}\n`);
  const r = s.tick();
  assert.equal(r.fresh, 1);
  assert.equal(r.liveRestarted, false, "the tail resumed at its checkpoint");
  assert.equal(count(s.db, "fact"), 2);
});

test("a live file rewritten in place is re-read from its first byte", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const livePath = join(ledgerDir, LIVE);
  writeFileSync(livePath, body([line(T0, "run.start", { task_id: "W1-T1" })]));
  const s = store(t, ledgerDir, fixedClock(T0));
  s.tick();
  writeFileSync(livePath, body([line(T0 + 1, "run.start", { task_id: "W1-T2" }), line(T0 + 2, "run.start", { task_id: "W1-T3" })]));
  const r = s.tick();
  assert.equal(r.liveRestarted, true);
  assert.equal(r.fresh, 2, "the replaced file's first row is not skipped");
});

test("malformed ambiguous and untimed rows are counted and classified by their top-level step", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const nested = JSON.stringify({ ts: new Date(T0).toISOString(), detail: { step: "worker.activity" }, step: "run.start" });
  const nestedOnly = JSON.stringify({ ts: new Date(T0 + 1).toISOString(), detail: { step: "run.start" }, step: "worker.activity" });
  const torn = `{"ts":"${new Date(T0 + 2).toISOString()}","step":"run.start",`;
  writeFileSync(join(ledgerDir, LIVE), body([nested, nestedOnly, torn, '{"step":"run.start","task":"W1-T9"}', "[]", '{"ts":"x"}']));
  const s = store(t, ledgerDir, fixedClock(T0));
  const r = s.tick();
  assert.equal(r.torn, 1, "a complete but malformed fact-step line is counted torn");
  const facts = s.db.prepare("SELECT step, task_id, ts_ms FROM fact ORDER BY seq").all().map((f) => `${f.step}:${f.task_id}:${f.ts_ms}`);
  assert.deepEqual(facts, [`run.start:null:${T0}`, "run.start:W1-T9:0"]);
});

test("a vanished archive's checkpoint is forgotten and its rows are not counted again", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const name = `${archiveName(T0)}.gz`;
  writeFileSync(join(ledgerDir, name), gzipSync(body([line(T0, "run.start")])));
  const s = store(t, ledgerDir, fixedClock(T0 + 60_000));
  s.tick();
  mkdirSync(join(ledgerDir, "ledger-superseded"));
  renameSync(join(ledgerDir, name), join(ledgerDir, "ledger-superseded", name));
  const r = s.tick();
  assert.equal(r.listed, true);
  assert.equal(count(s.db, "source_file"), 0);
  assert.equal(count(s.db, "seen"), 1);
});

test("a live file that fails to open for any reason but absence is thrown instead of skipped", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  symlinkSync(LIVE, join(ledgerDir, LIVE));
  const s = store(t, ledgerDir, fixedClock(T0));
  assert.throws(() => s.tick(), /ELOOP/);
});

test("a rotation's carried core adds no row", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const livePath = join(ledgerDir, LIVE);
  const rows = Array.from({ length: 12 }, (_, i) => line(T0 + i * 1_000, i % 3 === 0 ? "run.start" : "worker.activity", { task_id: `W1-T${i}` }));
  writeFileSync(livePath, body(rows));
  const s = store(t, ledgerDir, fixedClock(T0 + 3_600_000));
  assert.equal(s.tick().fresh, 12);
  const rotated = rotateLedger(livePath, { ceilingBytes: 500, smoothingWindowMs: 0, now: () => new Date(T0 + 12_000) });
  assert.equal(rotated.retainedLineCount, 4, "the rotation carried the four run.start rows");
  const carried = readFileSync(livePath, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(carried, rows.filter((_, i) => i % 3 === 0), "the new live file is exactly the carried core");
  const r = s.tick();
  assert.equal(r.liveRestarted, true);
  assert.equal(r.archivesRead, 1);
  assert.equal(r.fresh, 0, "the archive and the carried core are all duplicates");
  assert.equal(r.duplicates, 12 + 4);
});

test("a compacted day archive adds no row", (t) => {
  const ledgerDir = scratch(t, "projector-ledger");
  const day = (from: number) => Array.from({ length: 6 }, (_, i) => line(T0 + (from + i) * 1_000, "run.start", { task_id: `W1-T${from + i}` }));
  const sources = [join(ledgerDir, `${archiveName(T0 + 3_600_000)}.gz`), join(ledgerDir, `${archiveName(T0 + 7_200_000)}.gz`)];
  writeFileSync(sources[0]!, gzipSync(body(day(0))));
  writeFileSync(sources[1]!, gzipSync(body([...day(3), ...day(0).slice(0, 2)])));
  const s = store(t, ledgerDir, fixedClock(T0 + 86_400_000));
  assert.equal(s.tick().fresh, 9);
  mkdirSync(join(ledgerDir, "ledger-superseded"));
  const compacted = compactRotations(sources, {
    readRows: (path) => gunzipSync(readFileSync(path)).toString("utf8").split("\n"),
    write: (name, text) => writeFileSync(join(ledgerDir, name), gzipSync(text)),
    remove: (path) => renameSync(path, join(ledgerDir, "ledger-superseded", basename(path))),
    clock: fixedClock(T0 + 86_400_000),
  });
  assert.equal(compacted.rowsWritten, 9, "the compaction rewrote every distinct row into a new day file");
  const r = s.tick();
  assert.equal(r.archivesRead, compacted.archiveNames.length);
  assert.equal(r.fresh, 0);
  assert.equal(r.duplicates, 9);
  assert.deepEqual(s.db.prepare("SELECT name FROM source_file ORDER BY name").all().map((row) => row.name), [...compacted.archiveNames].sort());
});
