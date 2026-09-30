import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { Clock } from "../src/lib/clock.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "../src/lib/ledger-projector.js";
import { openReadModel, type ReadModelDb } from "../src/lib/read-model-db.js";
import {
  READ_MODEL_LEASE_RENEW_MS,
  READ_MODEL_PASS_SHARE,
  READ_MODEL_TICK_MS,
  READ_MODEL_VIEW_SHARE,
  createReadModelTicker,
  type ReadModelView,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
/** The work clock's cost of one applied row. */
const MS_PER_ROW = 10;
const PASS_MS = READ_MODEL_LEASE_RENEW_MS * READ_MODEL_PASS_SHARE;

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rows(n: number, startMs: number, tag: string): string {
  let out = "";
  for (let i = 0; i < n; i++) out += `${JSON.stringify({ ts: new Date(startMs + i).toISOString(), step: "run.start", task_id: `T${i % 50}`, run_id: `${tag}-${i}` })}\n`;
  return out;
}

function writeBacklog(dir: string, archives: number, perArchive: number, live: number): void {
  mkdirSync(dir, { recursive: true });
  let at = T0 - 86_400_000;
  for (let a = 0; a < archives; a++) {
    writeFileSync(join(dir, `ledger.${new Date(at + perArchive).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(rows(perArchive, at, `a${a}`)));
    at += perArchive;
  }
  writeFileSync(join(dir, "ledger.ndjson"), rows(live, at, "live"));
}

/** Time moves MS_PER_ROW per row core has applied, plus whatever a view's build or the test's sleep adds. */
function workClock(stateDir: string): { clock: Clock; watch(names: string[]): void; advance(ms: number): void; applied(): number; lapsed: string[] } {
  let extra = 0;
  let readers: Array<{ name: string; db: ReadModelDb }> | undefined;
  const lapsed: string[] = [];
  const applied = (): number => (readers ? Number(readers[0]!.db.prepare("SELECT count(*) AS n FROM seen").get()?.n ?? 0) : 0);
  const now = (): number => {
    const at = T0 + extra + applied() * MS_PER_ROW;
    for (const { name, db } of readers ?? []) {
      const lease = db.prepare("SELECT expires_ms FROM lease WHERE name = 'projector'").get();
      if (lease && Number(lease.expires_ms) < at && !lapsed.includes(name)) lapsed.push(name);
    }
    return at;
  };
  return {
    clock: { now, date: () => new Date(now()), iso: () => new Date(now()).toISOString() },
    watch: (names) => {
      readers = names.map((name) => ({ name, db: openReadModel({ stateDir, instance: name, schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION, readOnly: true }) }));
    },
    advance: (ms) => void (extra += ms),
    applied,
    lapsed,
  };
}

/** A view whose every build costs `ms` of work-clock time; a per-instance one costs it per instance. */
function costly(name: string, ms: number, advance: (ms: number) => void, built: string[], perInstance = false, scopes: number[] = []): ReadModelView {
  return {
    name,
    version: 1,
    ...(perInstance ? { perInstance: true } : {}),
    materialize: ({ instances, now }) => {
      const scope = perInstance ? instances.map(({ state }) => state.instance) : [""];
      scopes.push(instances.length);
      return scope.map((instance) => {
        advance(ms);
        built.push(perInstance ? `${name}@${instance}` : name);
        return { key: instance ? `instance=${instance}` : "", data: { now }, sources: [] };
      });
    },
  };
}

test("a read-model tick with a large projection batch plus view body builds stays within the pass budget", (t) => {
  const stateDir = scratch(t, "rmvb-state");
  const coreDir = scratch(t, "rmvb-core");
  const consoleDir = scratch(t, "rmvb-console");
  writeBacklog(coreDir, 25, 100, 300);
  writeBacklog(consoleDir, 0, 0, 3);
  const work = workClock(stateDir);
  const built: string[] = [];
  const wideScopes: number[] = [];
  // Unbudgeted, one pass would be a projection batch plus 100 + 2 x 600 + 2 x 1_500 ms of bodies: well over the pass.
  const views = [
    costly("cheap", 100, work.advance, built),
    costly("wide", 600, work.advance, built, true, wideScopes),
    costly("heavy", 1_500, work.advance, built),
    costly("heavier", 1_500, work.advance, built),
  ];
  assert.ok(100 + 2 * 600 + 1_500 > PASS_MS && 1_500 > PASS_MS * READ_MODEL_VIEW_SHARE, "the fixture's bodies cannot share one pass");
  const messages: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: coreDir }, { name: "console", ledgerDir: consoleDir }], clock: work.clock, holder: "view-budget", oracle: "off", views,
    post: (m) => void messages.push(m),
  });
  t.after(() => ticker.release());
  ticker.start();
  work.watch(["core", "console"]);
  const ticks: Array<{ ms: number; built: string[]; projected: boolean }> = [];
  const caughtUp = () => messages.some((m) => m.type === "log" && m.step === "read_model.caught_up" && m.extra.instance === "core");
  while (!caughtUp() && ticks.length < 500) {
    const from = work.clock.now();
    const before = built.length;
    const rowsBefore = work.applied();
    ticker.tick();
    ticks.push({ ms: work.clock.now() - from, built: built.slice(before), projected: work.applied() > rowsBefore });
    work.advance(READ_MODEL_TICK_MS);
  }
  assert.ok(caughtUp(), "the backlog was caught up");
  assert.ok(ticks.filter((tick) => tick.projected).length >= 10, "the projection batch spanned many ticks");
  for (const [i, tick] of ticks.entries()) {
    assert.ok(tick.ms <= PASS_MS, `tick ${i + 1} took ${tick.ms} ms (built ${tick.built.join(", ") || "nothing"}), over the ${PASS_MS} ms pass budget`);
  }
  for (const unit of ["cheap", "wide@core", "wide@console", "heavy", "heavier"]) {
    assert.ok(built.filter((b) => b === unit).length >= 2, `${unit} was rebuilt during the catch-up, not starved`);
  }
  assert.ok(ticks.some((tick) => tick.built.includes("heavy") && !tick.projected), "a body too big to share a pass got a tick of its own");
  const stalled = ticks.findIndex((tick, i) => i > 0 && !tick.projected && !ticks[i - 1]!.projected);
  assert.equal(stalled, -1, `ticks ${stalled} and ${stalled + 1} both left the backlog unprojected`);
  assert.ok(wideScopes.length > 0 && wideScopes.every((n) => n === 1), "a per-instance view is built one instance at a time");
  assert.deepEqual(work.lapsed, [], "no lease expired while bodies and the backlog shared the ticks");
});

test("a read-model view is not rebuilt before its last cost divided by the view share has passed", (t) => {
  const stateDir = scratch(t, "rmvb-pace-state");
  const coreDir = scratch(t, "rmvb-pace-core");
  writeBacklog(coreDir, 0, 0, 3);
  const work = workClock(stateDir);
  const built: string[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: coreDir }], clock: work.clock, holder: "view-pace", oracle: "off",
    views: [costly("paced", 200, work.advance, built)], post: () => {},
  });
  t.after(() => ticker.release());
  ticker.start();
  const at: number[] = [];
  for (let i = 0; i < 12; i++) {
    const before = built.length;
    const from = work.clock.now();
    ticker.tick();
    if (built.length > before) at.push(from);
    work.advance(READ_MODEL_TICK_MS);
  }
  assert.ok(at.length >= 2, "the view was built more than once");
  const gapMs = 200 / READ_MODEL_VIEW_SHARE;
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= gapMs, `rebuilt ${at[i]! - at[i - 1]!} ms after the last build, sooner than ${gapMs} ms`);
});
