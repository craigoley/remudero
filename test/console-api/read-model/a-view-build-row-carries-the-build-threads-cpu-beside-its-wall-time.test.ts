import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { createReadModelTicker, readModelSwitchesPath, type ReadModelTickerOptions, type ReadModelView, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { switchViewsOn } from "#test/helpers/read-model-switches.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-14T12:00:00Z");
const WINDOW_MS = 10 * 60_000;

interface Spent { wall(ms: number): void; cpu(ms: number): void }

/** A ticker on a hand clock. `reading` is the thread CPU reading: scripted from `spent.cpu`, throwing, absent, or the real one. */
function rig(t: TestContext, makeViews: (spent: Spent) => ReadModelView[], reading: "scripted" | "throws" | "absent" | "real", options: Partial<ReadModelTickerOptions> = {}) {
  const stateDir = readModelFixtureDir(t, "view-build-cpu").dir;
  let at = T0;
  let cpuUs = 0;
  const spent: Spent = { wall: (ms) => { at += ms; }, cpu: (ms) => { cpuUs += ms * 1000; } };
  if (reading === "scripted") t.mock.method(process, "threadCpuUsage", () => ({ user: Math.round(cpuUs * 0.75), system: cpuUs - Math.round(cpuUs * 0.75) }));
  if (reading === "throws") t.mock.method(process, "threadCpuUsage", () => { throw new Error("no per-thread CPU reading on this runtime"); });
  if (reading === "absent") {
    const own = Object.getOwnPropertyDescriptor(process, "threadCpuUsage");
    Object.defineProperty(process, "threadCpuUsage", { value: undefined, configurable: true, writable: true });
    onReadModelClose(t, () => {
      if (own) Object.defineProperty(process, "threadCpuUsage", own);
      else Reflect.deleteProperty(process, "threadCpuUsage");
    });
  }
  const clock: Clock = { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
  const views = makeViews(spent);
  switchViewsOn(stateDir, views.map((view) => view.name));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "off", views: Object.fromEntries(views.map((view) => [view.name, "serve"])) }));
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [], views, clock, oracle: "off", passBudgetMs: 100, ...options, post: (message) => void posted.push(message) });
  onReadModelClose(t, () => ticker.release());
  ticker.start();
  const rows = (step = "read_model.view_builds") => posted.flatMap((message) => message.type === "log" && message.step === step ? [message.extra] : []);
  const bodies = () => posted.flatMap((message) => message.type === "body" ? [{ view: message.entry.view, key: message.entry.key, data: message.entry.body.data }] : []);
  const flushAt = (time: number): void => {
    ticker.lane({ heavy: false, dueAt: Infinity });
    at = time;
    ticker.tick();
  };
  const advance = (ms: number): void => { at += ms; };
  return { ticker, rows, bodies, flushAt, advance, now: () => at };
}

test("W1-T11815 criterion 1: the view_builds tally sums each build's thread CPU as cpuMs beside ms and maxMs", (t) => {
  let cost = { wall: 40, cpu: 7 };
  const { ticker, rows, flushAt } = rig(t, (spent) => [{
    name: "board", version: 1,
    materialize: () => {
      spent.wall(cost.wall);
      spent.cpu(cost.cpu);
      return [{ key: "", data: 1, sources: [] }];
    },
  }], "scripted");
  ticker.tick();
  cost = { wall: 20, cpu: 3 };
  ticker.buildNow("board");
  flushAt(T0 + WINDOW_MS);
  const [row, ...rest] = rows();
  assert.equal(rest.length, 0);
  assert.equal(row?.ms, 60);
  assert.equal(row?.maxMs, 40);
  assert.equal(row?.cpuMs, 10, "7 ms and 3 ms of thread CPU, user plus system");
});

test("W1-T11815 criterion 1: with the real thread reading a CPU-bound build reports its CPU", (t) => {
  const { ticker, rows, flushAt } = rig(t, (spent) => [{
    name: "spin", version: 1,
    materialize: () => {
      const from = process.threadCpuUsage();
      let sum = 0;
      for (let usage = process.threadCpuUsage(from); usage.user + usage.system < 8_000; usage = process.threadCpuUsage(from)) {
        for (let i = 0; i < 10_000; i++) sum += i;
      }
      spent.wall(1);
      return [{ key: "", data: sum, sources: [] }];
    },
  }], "real");
  ticker.tick();
  flushAt(T0 + WINDOW_MS);
  const cpuMs = rows()[0]?.cpuMs;
  assert.equal(typeof cpuMs, "number");
  assert.ok((cpuMs as number) >= 8, `the spin used at least 8 ms of thread CPU, row says ${String(cpuMs)}`);
});

test("W1-T11815 criterion 2: a read_model.slow_view row carries the build's cpuMs beside its ms and its stages", (t) => {
  const { ticker, rows } = rig(t, (spent) => [{
    name: "slow", version: 1,
    materialize: () => {
      spent.wall(639);
      spent.cpu(12);
      return [{ key: "", data: 1, sources: [] }];
    },
    stages: () => ({ board: 638 }),
  }], "scripted");
  ticker.tick();
  assert.deepEqual(rows("read_model.slow_view"), [{ view: "slow", ms: 639, cpuMs: 12, passMs: 100, thread: "projector", stages: { board: 638 } }]);
});

test("W1-T11815 criterion 3: without a thread CPU reading cpuMs is omitted and the builds, their times and bodies are unchanged", async (t) => {
  const runs = new Map<string, ReturnType<typeof once>>();
  const once = (t: TestContext, reading: "scripted" | "throws" | "absent") => {
    let n = 0;
    const built: number[] = [];
    const { ticker, rows, bodies, flushAt, advance, now } = rig(t, (spent) => [{
      name: "paced", version: 1,
      materialize: () => {
        built.push(now());
        spent.wall(150);
        spent.cpu(4);
        return [{ key: "", data: { n: ++n }, sources: [] }];
      },
    }], reading);
    for (let step = 0; step < 2_000; step++) {
      ticker.tick();
      advance(1);
    }
    flushAt(T0 + WINDOW_MS);
    return { built, bodies: bodies(), builds: rows(), slow: rows("read_model.slow_view") };
  };
  for (const reading of ["scripted", "throws", "absent"] as const) await t.test(reading, (st) => void runs.set(reading, once(st, reading)));
  const measured = runs.get("scripted")!;
  assert.ok(measured.built.length >= 3, `control: the view was built at least three times (${measured.built.length})`);
  assert.equal(measured.builds[0]?.cpuMs, 4 * measured.built.length, "control: with a reading the row has cpuMs");
  for (const reading of ["throws", "absent"] as const) {
    const bare = runs.get(reading)!;
    assert.deepEqual(bare.built, measured.built, `${reading}: the same build times`);
    assert.deepEqual(bare.bodies, measured.bodies, `${reading}: the same bodies`);
    const strip = <T extends Record<string, unknown>>(rows: T[]) => rows.map(({ cpuMs: _cpuMs, ...rest }) => rest);
    assert.deepEqual(bare.builds, strip(measured.builds), `${reading}: the same view_builds rows less cpuMs`);
    assert.deepEqual(bare.slow, strip(measured.slow), `${reading}: the same slow_view rows less cpuMs`);
    assert.ok(bare.builds.every((row) => !("cpuMs" in row)) && bare.slow.every((row) => !("cpuMs" in row)), `${reading}: no cpuMs`);
  }
});

test("W1-T14380 criterion 1: view_builds sums each stage's ms over builds faster than a pass", (t) => {
  let ran: Record<string, number> = { board: 30, snapshot: 9 };
  const { ticker, rows, flushAt } = rig(t, (spent) => [{
    name: "staged", version: 1,
    materialize: () => {
      spent.wall(40);
      return [{ key: "", data: 1, sources: [] }];
    },
    stages: () => ran,
  }], "scripted");
  ticker.tick();
  ran = { board: 5, assemble: 2 };
  ticker.buildNow("staged");
  flushAt(T0 + WINDOW_MS);
  assert.deepEqual(rows("read_model.slow_view"), [], "control: neither build passed the slow threshold");
  assert.deepEqual(rows()[0]?.stageMs, { board: 35, snapshot: 9, assemble: 2 });
});

test("W1-T14380 criterion 2: invariant:untimed-unchanged — a view that times no stages reports no stageMs", (t) => {
  const { ticker, rows, flushAt } = rig(t, (spent) => [{
    name: "untimed", version: 1,
    materialize: () => {
      spent.wall(40);
      return [{ key: "", data: 1, sources: [] }];
    },
  }], "scripted");
  ticker.tick();
  flushAt(T0 + WINDOW_MS);
  assert.equal(rows().length, 1);
  assert.equal("stageMs" in rows()[0]!, false);
});
