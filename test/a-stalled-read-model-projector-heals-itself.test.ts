import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Clock } from "../src/lib/clock.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { DIR_GATE_RELIST_MS, MIN_TRANSACTION_LINES, createLedgerProjector, openProjectorReadModel, type LedgerProjectorOptions } from "../src/lib/ledger-projector.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { READ_MODEL_STALL_MS, createReadModelTicker, createReadModelWorker, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const LIVE = "ledger.ndjson";
const SILENT_WORKER = new URL("data:text/javascript,setInterval(() => {}, 1000)");

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clock the test moves by hand; `perRead` also moves it on every reading, so work looks slow. */
function handClock(start: number): { clock: Clock; advance: (ms: number) => void; perRead: (ms: number) => void } {
  let ms = start;
  let step = 0;
  const now = (): number => (ms += step) - step;
  return {
    clock: { now, date: () => new Date(now()), iso: () => new Date(now()).toISOString() },
    advance: (by) => void (ms += by),
    perRead: (by) => void (step = by),
  };
}

/** `n` rows of one fixed width, so two sets of the same count have the same byte size. */
function rows(n: number, startMs: number, tag: string): string {
  let out = "";
  for (let i = 0; i < n; i++) out += `${JSON.stringify({ ts: new Date(startMs + i).toISOString(), step: "run.start", run_id: `${tag}-${String(i).padStart(4, "0")}` })}\n`;
  return out;
}

function archiveName(ms: number): string {
  return `ledger.${new Date(ms).toISOString().replace(/[:.]/g, "-")}.ndjson`;
}

function projector(t: TestCtx, ledgerDir: string, clock: Clock, stateDir: string, extra: Partial<LedgerProjectorOptions> = {}) {
  const db = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, holder: "proj-fix" });
  if (!got.ok) throw new Error(`lease held by ${got.heldBy}`);
  const p = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock, ...extra });
  const seen = (): number => Number(db.prepare("SELECT count(*) AS n FROM seen").get()?.n);
  return { db, p, seen };
}

test("an archive rewritten under its old name inode and size is read again by its content", (t) => {
  const ledgerDir = scratch(t, "proj-fix-ledger");
  const stateDir = scratch(t, "proj-fix-state");
  const path = join(ledgerDir, archiveName(T0));
  writeFileSync(path, rows(20, T0, "old"));
  const clock = handClock(T0 + 3_600_000).clock;
  const first = projector(t, ledgerDir, clock, stateDir);
  first.p.tick();
  assert.equal(first.seen(), 20);

  // A deleted archive's inode is recycled: the same name, inode and size now hold other bytes.
  const before = statSync(path, { bigint: true });
  writeFileSync(path, rows(20, T0 + 60_000, "new"));
  const after = statSync(path, { bigint: true });
  assert.deepEqual([after.ino, after.size], [before.ino, before.size], "the fixture reproduces a reused identity");
  const second = projector(t, ledgerDir, clock, stateDir);
  const r = second.p.tick();
  assert.equal(r.archivesRead, 1, "the archive is identified by its content, not its inode");
  assert.equal(second.seen(), 40, "every row of the new file is applied");
});

test("a directory gate whose mtime never moves still lists a new archive after the relist interval", (t) => {
  const ledgerDir = scratch(t, "proj-fix-gate");
  writeFileSync(join(ledgerDir, archiveName(T0)), rows(3, T0, "a"));
  const settled = Math.floor(Date.now() / 1000) - 10;
  utimesSync(ledgerDir, settled, settled);
  const hand = handClock(Date.now() + 60_000);
  const s = projector(t, ledgerDir, hand.clock, scratch(t, "proj-fix-state"));
  assert.equal(s.p.tick().listed, true);
  assert.equal(s.p.tick().listed, false, "the gate is shut on a settled directory");

  writeFileSync(join(ledgerDir, archiveName(T0 + 5)), rows(4, T0 + 1_000, "b"));
  utimesSync(ledgerDir, settled, settled); // a directory whose mtime failed to move
  assert.equal(s.p.tick().listed, false, "a stuck mtime keeps the gate shut for now");
  hand.advance(DIR_GATE_RELIST_MS);
  const later = s.p.tick();
  assert.deepEqual([later.listed, later.archivesRead], [true, 1], "the relist interval reopens the gate");
  assert.equal(s.seen(), 7);
});

test("a collapsed rate estimate recovers when a transaction is too fast to time", (t) => {
  const ledgerDir = scratch(t, "proj-fix-rate");
  const live = join(ledgerDir, LIVE);
  writeFileSync(live, rows(10, T0, "slow"));
  const hand = handClock(T0 + 3_600_000);
  const s = projector(t, ledgerDir, hand.clock, scratch(t, "proj-fix-state"));
  hand.perRead(1_000); // one stalled transaction: ten rows in seconds
  s.p.tick({ budgetMs: 833 });
  hand.perRead(0); // then transactions too fast for a millisecond clock
  appendFileSync(live, rows(2_000, T0 + 10_000, "fast"));
  const r = s.p.tick({ budgetMs: 833 });
  assert.equal(r.fresh, 2_000);
  assert.ok(r.transactions <= 3, `the backlog took ${r.transactions} transactions: the rate never recovered`);
  assert.ok(MIN_TRANSACTION_LINES > 1);
});

test("a live checkpoint on an old inode past the new file's end restarts at byte zero", (t) => {
  const ledgerDir = scratch(t, "proj-fix-live");
  const live = join(ledgerDir, LIVE);
  writeFileSync(live, rows(50, T0, "big"));
  const s = projector(t, ledgerDir, handClock(T0 + 3_600_000).clock, scratch(t, "proj-fix-state"));
  s.p.tick();
  rmSync(live);
  writeFileSync(live, rows(5, T0 + 60_000, "small"));
  const r = s.p.tick();
  assert.deepEqual([r.liveRestarted, r.fresh], [true, 5]);
});

test("a read-model instance with work outstanding and no commit is ledgered stalled then reopened then escalated once", (t) => {
  const stateDir = scratch(t, "proj-fix-stall-state");
  const ledgerDir = join(scratch(t, "proj-fix-stall"), "state");
  writeFileSync(ledgerDir, "a file where the state dir should be"); // every tick fails
  const hand = handClock(T0);
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const titles: string[] = [];
  const issues: IssueGateway = { create: (title) => (titles.push(title), "https://github.com/craigoley/remudero/issues/1") };
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir }], clock: hand.clock, holder: "proj-fix", oracle: "off",
    escalation: { issues, ledgerPath: join(stateDir, LIVE), runId: "read-model" },
    post: (m: ReadModelWorkerMessage) => void (m.type === "log" && logs.push({ step: m.step, extra: m.extra })),
  });
  t.after(() => ticker.release());
  const steps = (): string[] => logs.map((l) => l.step).filter((s) => /stall/.test(s));
  ticker.start();
  ticker.tick();
  assert.deepEqual(steps(), []);
  for (let i = 0; i < 3; i++) {
    hand.advance(READ_MODEL_STALL_MS + 1);
    ticker.tick();
  }
  assert.deepEqual(steps(), ["read_model.stalled", "read_model.stall_escalated"], "one row per tier, not one per tick");
  assert.equal(titles.length, 1, "escalated once through the one escalation path");
  assert.match(String(logs.find((l) => l.step === "read_model.stalled")?.extra.reason), /tick failed/);

  rmSync(ledgerDir);
  mkdirSync(ledgerDir);
  writeFileSync(join(ledgerDir, LIVE), rows(3, T0, "back"));
  hand.advance(READ_MODEL_STALL_MS + 1);
  ticker.tick();
  assert.deepEqual(steps(), ["read_model.stalled", "read_model.stall_escalated", "read_model.unstalled"]);
});

test("a read-model worker that posts nothing is ledgered silent and then recycled", async (t) => {
  const stateDir = scratch(t, "proj-fix-silent");
  const hand = handClock(T0);
  const logged: string[] = [];
  let watch: (() => void) | undefined;
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: SILENT_WORKER, stopWaitMs: 20, clock: hand.clock,
    log: (step) => void logged.push(step), every: (run) => ((watch = run), () => undefined),
  });
  t.after(() => handle.stop());
  handle.start();
  watch?.();
  const rows = (): string[] => logged.filter((s) => /worker_(silent|recycled|exited)/.test(s));
  assert.deepEqual(rows(), []);
  hand.advance(READ_MODEL_STALL_MS);
  watch?.();
  watch?.();
  assert.deepEqual(rows(), ["read_model.worker_silent"], "silence is ledgered once");
  hand.advance(READ_MODEL_STALL_MS);
  watch?.();
  assert.deepEqual(rows(), ["read_model.worker_silent", "read_model.worker_recycled"]);
  for (let i = 0; i < 200 && !rows().includes("read_model.worker_exited"); i++) await sleep(10);
  assert.deepEqual(rows(), ["read_model.worker_silent", "read_model.worker_recycled", "read_model.worker_exited"], "the terminated worker is respawned by the exit handler");
});
