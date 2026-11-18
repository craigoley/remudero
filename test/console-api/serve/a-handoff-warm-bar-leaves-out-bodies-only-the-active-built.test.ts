/**
 * W1-T13600: a serve handoff's warm bar is the active generation's body count, and a standby must reach it.
 * OBSERVED 2026-11-18 (host ledger): after the 02:24Z cold start every handoff (02:45Z, 03:01Z, 03:16Z) aborted on
 * ready_bound with read_model_warm false, bodies 226 of wanted 235. A standby loads only the store, so bodies the
 * active built and posted itself, which the store does not hold, can never appear in it. The active now reports
 * `committed` (held bodies the last committed load read) and the supervisor's bar is that count.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { acquireLease, withWriteTransaction } from "#src/lib/read-model-db.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createReadModelWorker, type ReadModelWorkerHandle } from "#src/lib/read-model-worker.js";
import { readModelWarmProbe } from "#src/lib/serve-generation.js";
import { createServeSupervisor, type GenerationProcess, type PreparedSlot, type ServeSupervisorOptions } from "#src/lib/serve-supervisor.js";
import { trackWorkerThreads } from "#src/lib/worker-heaps.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

type Row = { step: string; extra?: Record<string, unknown> };
/** What a generation's read model holds: `bodies` in total, and `committed` when its code reports one. */
type Held = { bodies: number; committed?: number };

const fakeHandle = (held: Held) => ({
  bodies: new Map(Array.from({ length: held.bodies }, (_, i) => [`k${i}`, {}])) as never,
  state: () => ({ instances: new Map(), switches: {} as never }),
  ...(held.committed === undefined ? {} : { committedBodies: () => held.committed! }),
});

/**
 * Generation 1 is the cold active, every later one a standby. Each answers /v1/ready from the real
 * readModelWarmProbe over what it holds, with the query the supervisor sent, and 200 only when it passes.
 * `wanted` records the bar each standby was asked to meet (the cold start's own `bodies=0` poll is not a bar).
 */
function warmBarRig(active: Held, standby: Held) {
  const slots = new Map<string, { slot: PreparedSlot; held: Held; standby: boolean }>();
  const wanted: number[] = [];
  let forks = 0;
  const spawn: ServeSupervisorOptions["spawn"] = (command, env) => {
    const slot = JSON.parse(command.args[0]) as PreparedSlot;
    forks += 1;
    slots.set(env.RMD_SERVE_READY_SOCKET, { slot, held: forks === 1 ? active : standby, standby: forks > 1 });
    const onMessage: Array<(m: { type: string }) => void> = [];
    const onExit: Array<(c: number | null, s: string | null) => void> = [];
    const generation: GenerationProcess = {
      pid: forks,
      send(message) {
        if (message.type === "rmd.promote") queueMicrotask(() => onMessage.forEach((l) => l({ type: "rmd.promoted" })));
        if (message.type === "rmd.drain") queueMicrotask(() => onExit.forEach((l) => l(0, null)));
      },
      onMessage: (l) => void onMessage.push(l as never),
      onExit: (l) => void onExit.push(l),
      kill: () => onExit.forEach((l) => l(null, "SIGKILL")),
    };
    return generation;
  };
  const get: ServeSupervisorOptions["get"] = async (socketPath, path) => {
    const entry = slots.get(socketPath)!;
    if (path === "/v1/version") return { status: 200, body: JSON.stringify({ sha: entry.slot.sha }) };
    if (path.startsWith("/v1/ready")) {
      const query = new URL(path, "http://localhost").searchParams;
      if (entry.standby && query.has("bodies")) wanted.push(Number(query.get("bodies")));
      const criterion = readModelWarmProbe(fakeHandle(entry.held) as never)(query);
      return { status: criterion.ok ? 200 : 503, body: JSON.stringify({ ready: criterion.ok, criteria: [criterion] }) };
    }
    return { status: 200, body: "{}" };
  };
  const logs: Row[] = [];
  const state = { now: 0 };
  let sha = 1;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn, get,
    command: (slot: PreparedSlot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    log: (step, extra) => void logs.push({ step, extra }),
    exit: () => {},
    clock: { now: () => state.now, iso: () => "" } as never,
    sleep: async (ms) => void (state.now += ms),
    freeMemory: () => undefined, rss: () => undefined, peakRss: () => 1_000,
    hostPressure: async () => ({ atMs: state.now, memAvailableBytes: 2 ** 40, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [] }),
    upgradeThresholds: () => ({ hostReserveBytes: 0, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 }),
    socketPathFor: (n) => `/sock/${n}`,
  });
  const steps = () => logs.map((l) => l.step);
  const aborted = () => logs.filter((l) => l.step === "serve.handoff_aborted").map((l) => l.extra!);
  return { supervisor, wanted, steps, aborted };
}

test("W1-T13600 criterion 1: an active holding 235 bodies of which 226 are committed sets the bar at 226, so a standby holding the 226 the store gives it hands off", async () => {
  const rig = warmBarRig({ bodies: 235, committed: 226 }, { bodies: 226, committed: 226 });
  await rig.supervisor.start();
  await rig.supervisor.requestHandoff();
  await settle();
  assert.deepEqual(rig.wanted, [226], "the supervisor asked the standby for the active's committed count");
  assert.ok(rig.steps().includes("serve.handoff_done"), `the handoff completed: ${rig.steps().join(", ")}`);
  assert.equal(rig.supervisor.activeSha(), "sha-2");
});

test("W1-T13600 criterion 2: an active on older code reports no committed count, so the bar stays its total and the 226-body standby still aborts on ready_bound, as observed", async () => {
  const rig = warmBarRig({ bodies: 235 }, { bodies: 226, committed: 226 });
  await rig.supervisor.start();
  await rig.supervisor.requestHandoff();
  await settle();
  assert.deepEqual(rig.wanted.slice(0, 1), [235], "the bar falls back to the active's total");
  assert.ok(!rig.steps().includes("serve.handoff_done"), "no handoff completed");
  assert.equal(rig.aborted()[0]?.criterion, "ready_bound", "the observed abort reproduces");
  assert.equal(rig.supervisor.activeSha(), "sha-1");
});

test("W1-T13600 criterion 3: invariant:never-thinner — a standby with fewer bodies than the active's committed count still aborts", async () => {
  const rig = warmBarRig({ bodies: 235, committed: 226 }, { bodies: 220, committed: 220 });
  await rig.supervisor.start();
  await rig.supervisor.requestHandoff();
  await settle();
  assert.deepEqual(rig.wanted.slice(0, 1), [226]);
  assert.ok(!rig.steps().includes("serve.handoff_done"), "a genuinely thinner standby is refused");
  assert.equal(rig.aborted()[0]?.criterion, "ready_bound");
});

function storeFixture(t: TestContext) {
  const dir = readModelFixtureDir(t, "warm-bar-committed").dir;
  const db = openProjectorReadModel(dir, "core");
  db.exec("CREATE TABLE view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view,key)) WITHOUT ROWID");
  const got = acquireLease(db);
  assert.ok(got.ok);
  const handles: ReadModelWorkerHandle[] = [];
  const threads = trackWorkerThreads();
  onReadModelClose(t, async () => {
    for (const handle of handles) handle.stop();
    await threads.stop();
    db.close();
  });
  const entry = (key: string) => ({ view: "fixture", key, version: 1, generation: 1, etag: key,
    body: { view: "fixture", version: 1, generatedAt: new Date().toISOString(), asOf: null, stale: false, sources: [], data: key } });
  const write = (key: string) => {
    const body = entry(key);
    withWriteTransaction(db, got.lease, () => db.prepare("INSERT OR REPLACE INTO view_body VALUES(?,?,?,?,?,?)")
      .run(body.view, key, 1, 1, key, JSON.stringify(body.body)));
  };
  const open = (workerUrl?: URL) => {
    const handle = createReadModelWorker({ stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], ...(workerUrl ? { workerUrl } : {}) });
    handles.push(handle);
    return handle;
  };
  return { dir, entry, write, open };
}

test("W1-T13600 criterion 4: committedBodies counts only held bodies the committed load read; a body the worker posted that the store lacks is left out, and a fresh standby meets that count", { timeout: 10_000 }, async (t) => {
  const f = storeFixture(t);
  f.write("a"); f.write("b");
  const worker = join(f.dir, "producer.mjs");
  writeFileSync(worker, `import { parentPort, workerData } from 'node:worker_threads';
parentPort.on('message', m => { if (m.type === 'stop') { const s = new Int32Array(workerData.signal); Atomics.store(s,1,1); Atomics.notify(s,1); parentPort.close(); } });
parentPort.postMessage(${JSON.stringify({ type: "body", entry: f.entry("built-on-demand") })});
`);
  const active = f.open(pathToFileURL(worker));
  const posted = new Promise<void>((resolve) => active.onBody(() => resolve()));
  active.start();
  await posted;
  assert.equal(active.bodies.size, 3, "the active holds the two committed bodies and the one it built");
  assert.equal(active.committedBodies?.(), 2, "only the two the store holds count");
  const report = readModelWarmProbe(active)(new URLSearchParams());
  assert.equal((report.detail as { committed?: number }).committed, 2, "the probe reports the committed count");
  const standby = f.open();
  assert.equal(standby.bodies.size, 2);
  assert.equal(readModelWarmProbe(standby)(new URLSearchParams(`bodies=${active.bodies.size}`)).ok, false,
    "positive control: the old bar (the active's total) refuses a standby that holds everything the store has");
  assert.equal(readModelWarmProbe(standby)(new URLSearchParams(`bodies=${active.committedBodies?.()}`)).ok, true,
    "the committed bar admits it");
});
