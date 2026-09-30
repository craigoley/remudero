import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import type { Clock } from "../src/lib/clock.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION, createLedgerProjector, openProjectorReadModel, readModelDigest } from "../src/lib/ledger-projector.js";
import { READ_MODEL_LEASE_TTL_MS, acquireLease, openReadModel, type ReadModelDb } from "../src/lib/read-model-db.js";
import {
  READ_MODEL_LEASE_RENEW_MS,
  READ_MODEL_PASS_SHARE,
  READ_MODEL_TICK_MS,
  createReadModelTicker,
  runReadModelWorker,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
/** The work clock's cost of one applied row: time moves only when rows commit. */
const MS_PER_ROW = 10;

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rows(n: number, startMs: number, tag: string): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `${JSON.stringify({ ts: new Date(startMs + i).toISOString(), step: i % 2 === 0 ? "run.start" : "worker.activity", task_id: `T${i % 50}`, run_id: `${tag}-${i}` })}\n`;
  }
  return out;
}

/** `archives` gzip rotations of `perArchive` rows each, then `live` rows in the live file. */
function writeBacklog(dir: string, archives: number, perArchive: number, live: number): number {
  mkdirSync(dir, { recursive: true });
  let at = T0 - 86_400_000;
  for (let a = 0; a < archives; a++) {
    writeFileSync(join(dir, `ledger.${new Date(at + perArchive).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(rows(perArchive, at, `a${a}`)));
    at += perArchive;
  }
  writeFileSync(join(dir, "ledger.ndjson"), rows(live, at, "live"));
  return archives * perArchive + live;
}

/**
 * A clock that moves MS_PER_ROW for every row the home instance has committed, plus whatever the
 * test sleeps between ticks: a tick's duration is exactly the work it did, on any machine. Every
 * reading also checks that no instance's lease has expired while it was held.
 */
function workClock(stateDir: string, instances: string[]): { clock: Clock; watch(): void; advance(ms: number): void; lapsed: string[] } {
  let slept = 0;
  let readers: Array<{ name: string; db: ReadModelDb }> | undefined;
  const lapsed: string[] = [];
  const now = (): number => {
    const applied = readers ? Number(readers[0]!.db.prepare("SELECT count(*) AS n FROM seen").get()?.n ?? 0) : 0;
    const at = T0 + slept + applied * MS_PER_ROW;
    for (const { name, db } of readers ?? []) {
      const lease = db.prepare("SELECT expires_ms FROM lease WHERE name = 'projector'").get();
      if (lease && Number(lease.expires_ms) < at && !lapsed.includes(name)) lapsed.push(name);
    }
    return at;
  };
  return {
    clock: { now, date: () => new Date(now()), iso: () => new Date(now()).toISOString() },
    watch: () => {
      readers = instances.map((name) => ({ name, db: openReadModel({ stateDir, instance: name, schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION, readOnly: true }) }));
    },
    advance: (ms) => void (slept += ms),
    lapsed,
  };
}

interface Run {
  messages: ReadModelWorkerMessage[];
  ticks: Array<{ ms: number; bodies: ReadModelWorkerMessage[] }>;
  lapsed: string[];
  budgetMs: number;
  logs(step: string): Array<Record<string, unknown>>;
  /** Log steps in order, each tagged with the tick it was posted in (0 = start). */
  order: Array<{ tick: number; step: string }>;
}

/** Starts a ticker over core (with the backlog) and an idle console, then ticks until core has caught up. */
function catchUp(t: TestCtx, backlog: { archives: number; perArchive: number; live: number }, oracle: "on" | "off" = "off"): Run & { stateDir: string; coreDir: string } {
  const stateDir = scratch(t, "rmcu-state");
  const coreDir = scratch(t, "rmcu-core");
  const consoleDir = scratch(t, "rmcu-console");
  writeBacklog(coreDir, backlog.archives, backlog.perArchive, backlog.live);
  writeBacklog(consoleDir, 0, 0, 3);
  const work = workClock(stateDir, ["core", "console"]);
  const messages: ReadModelWorkerMessage[] = [];
  const order: Run["order"] = [];
  let tickNo = 0;
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: coreDir }, { name: "console", ledgerDir: consoleDir }], clock: work.clock, holder: "catch-up", oracle,
    post: (m) => {
      messages.push(m);
      if (m.type === "log") order.push({ tick: tickNo, step: m.step });
    },
  });
  t.after(() => ticker.release());
  ticker.start();
  work.watch();
  const ticks: Run["ticks"] = [];
  const caughtUp = () => messages.some((m) => m.type === "log" && m.step === "read_model.caught_up" && m.extra.instance === "core");
  while (!caughtUp() && ticks.length < 500) {
    tickNo++;
    const before = messages.length;
    const from = work.clock.now();
    ticker.tick();
    ticks.push({ ms: work.clock.now() - from, bodies: messages.slice(before).filter((m) => m.type === "body") });
    work.advance(READ_MODEL_TICK_MS);
  }
  for (let i = 0; i < 3; i++) {
    tickNo++;
    ticker.tick();
    work.advance(READ_MODEL_TICK_MS);
  }
  return {
    stateDir, coreDir, messages, ticks, lapsed: work.lapsed, order,
    budgetMs: (READ_MODEL_LEASE_RENEW_MS * READ_MODEL_PASS_SHARE) / 2,
    logs: (step) => messages.flatMap((m) => (m.type === "log" && m.step === step ? [m.extra] : [])),
  };
}

test("a read-model backlog is caught up in many ticks each under the budget with every lease renewed between them", (t) => {
  const run = catchUp(t, { archives: 25, perArchive: 100, live: 300 });
  const whole = 2_800 * MS_PER_ROW;
  assert.ok(whole > READ_MODEL_LEASE_TTL_MS, "the backlog, applied in one go, outlasts a lease: the fixture can see a lapse");
  const working = run.ticks.filter((tick) => tick.ms > 0);
  assert.ok(working.length >= whole / run.budgetMs, `the backlog took ${working.length} ticks, not one`);
  for (const [i, tick] of run.ticks.entries()) assert.ok(tick.ms <= run.budgetMs, `tick ${i + 1} took ${tick.ms} ms, over the ${run.budgetMs} ms budget`);
  assert.deepEqual(run.lapsed, [], "no lease expired while its holder was catching up");
  const [done] = run.logs("read_model.caught_up");
  assert.equal(done?.rows, 2_800);
  assert.ok(Number(done?.maxTickMs) <= run.budgetMs && Number(done?.ticks) === working.length);

  // Partial archive checkpoints resume exactly: the store equals one unbudgeted rebuild of the same ledger.
  const cleanDir = scratch(t, "rmcu-clean");
  const clean = openProjectorReadModel(cleanDir, "core");
  const got = acquireLease(clean, { holder: "clean" });
  assert.ok(got.ok);
  createLedgerProjector({ ledgerDir: run.coreDir, db: clean, lease: got.lease }).tick();
  const built = openReadModel({ stateDir: run.stateDir, instance: "core", schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION, readOnly: true });
  assert.equal(readModelDigest(built), readModelDigest(clean));
  built.close();
  clean.close();
});

test("a read-model catch-up posts a stale view body with its backlog as the reason until it has caught up", (t) => {
  const run = catchUp(t, { archives: 25, perArchive: 100, live: 300 });
  const status = (bodies: ReadModelWorkerMessage[]) => bodies.flatMap((m) => (m.type === "body" && m.entry.view === "read-model" ? [m.entry.body] : []));
  const first = status(run.ticks[0]!.bodies)[0];
  assert.ok(first, "the first tick of a catch-up already posts a body");
  assert.equal(first.stale, true);
  const core = first.sources.find((source) => source.name === "ledger:core");
  assert.match(String(core?.reason), /^catching up: about [1-9]\d* rows \([1-9]\d* bytes\) behind, done in about [1-9]\d* s$/);
  const mid = status(run.ticks[Math.floor(run.ticks.length / 2)]!.bodies);
  assert.ok(mid.length > 0 && mid.every((body) => body.stale), "bodies keep posting mid catch-up, each stale");
  const last = status(run.messages).at(-1);
  assert.equal(last?.stale, false, "once caught up the body is fresh");
  const progress = run.logs("read_model.catch_up");
  assert.ok(progress.length >= 2 && progress.length < run.ticks.length, "progress is ledgered on a cadence, not every tick");
  assert.ok(progress.every((row) => Number(row.rowsBehind) > 0 && Number(row.etaMs) > 0 && Number(row.bytesBehind) > 0));
});

test("the read-model oracle waits while a backlog is being caught up", (t) => {
  const run = catchUp(t, { archives: 3, perArchive: 100, live: 1_500 }, "on");
  const doneAt = run.order.find((entry) => entry.step === "read_model.caught_up")?.tick;
  assert.ok(doneAt !== undefined && doneAt > 3, "the live backlog took several ticks");
  const early = run.order.filter((entry) => entry.step.startsWith("read_model.consistency") && entry.tick <= doneAt);
  assert.deepEqual(early, [], "no oracle slice ran before the catch-up finished");
  const metric = join(run.stateDir, "ledger.ndjson");
  const checked = existsSync(metric) ? readFileSync(metric, "utf8").split("\n").filter((line) => line.includes('"read_model.consistency"')) : [];
  assert.ok(checked.length > 0 || run.order.some((entry) => entry.step.startsWith("read_model.consistency")), "the oracle ran once caught up");
});

test("the read-model worker holds every instance lease before its first tick", async (t) => {
  const stateDir = scratch(t, "rmcu-lease-state");
  const coreDir = scratch(t, "rmcu-lease-core");
  const siteDir = scratch(t, "rmcu-lease-site");
  writeBacklog(coreDir, 2, 50, 10);
  writeBacklog(siteDir, 0, 0, 2);
  const instances = [{ name: "core", ledgerDir: coreDir }, { name: "site", ledgerDir: siteDir }];

  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances, clock: workClock(stateDir, []).clock, holder: "early", post: (m) => void posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  assert.deepEqual(posted.filter((m) => m.type === "log").map((m) => m.type === "log" && [m.step, m.extra.instance]), [["read_model.lease_acquired", "core"], ["read_model.lease_acquired", "site"]]);
  const [state] = posted.filter((m) => m.type === "state");
  assert.ok(state?.type === "state");
  assert.deepEqual(state.instances.map((i) => [i.instance, i.lease, i.tickedAt]), [["core", "held", undefined], ["site", "held", undefined]]);
  for (const { name } of instances) {
    const db = openReadModel({ stateDir, instance: name, schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION, readOnly: true });
    assert.equal(db.prepare("SELECT holder FROM lease").get()?.holder, "early");
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM seen").get()?.n), 0, "nothing was projected yet");
    db.close();
  }

  // The worker branch does the same before its first tick: its first state names both leases, unticked.
  const signal = new SharedArrayBuffer(8);
  const branch: ReadModelWorkerMessage[] = [];
  const branchState = scratch(t, "rmcu-lease-branch");
  runReadModelWorker({ on: () => undefined, postMessage: (m) => void branch.push(m as ReadModelWorkerMessage), close: () => undefined }, { kind: "remudero-read-model", stateDir: branchState, instances, tickMs: 5, signal });
  Atomics.store(new Int32Array(signal), 0, 1);
  const until = Date.now() + 10_000;
  while (Atomics.load(new Int32Array(signal), 1) !== 1 && Date.now() < until) await sleep(5);
  const firstState = branch.find((m) => m.type === "state");
  assert.ok(firstState?.type === "state");
  assert.deepEqual(firstState.instances.map((i) => [i.instance, i.lease, i.tickedAt]), [["core", "held", undefined], ["site", "held", undefined]]);
});

test("a read-model instance that cannot open at start backs off alone while the others take their lease", (t) => {
  const stateDir = scratch(t, "rmcu-broken-state");
  const coreDir = scratch(t, "rmcu-broken-core");
  writeBacklog(coreDir, 0, 0, 2);
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", `site.v${LEDGER_PROJECTOR_SCHEMA_VERSION}.current`), "not-a-generation\n");
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: coreDir }, { name: "site", ledgerDir: coreDir }], clock: workClock(stateDir, []).clock, post: (m) => void posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  const failed = posted.flatMap((m) => (m.type === "log" && m.step === "read_model.tick_failed" ? [m.extra] : []));
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.instance, "site");
  assert.match(String(failed[0]?.error), /bad_pointer/);
  const state = posted.find((m) => m.type === "state");
  assert.ok(state?.type === "state");
  assert.deepEqual(state.instances.map((i) => [i.instance, i.lease, i.failures]), [["core", "held", 0], ["site", "none", 1]]);
});
