// test/serve-memory-names-where-rss-lives.test.ts — W1-T5355.
//
// MEASURED 2026-10-02: 50 `serve.memory` rows named 2.55-2.57 MB of holders while rss ran 2.8-4.7
// GB and the main heap 0.45-1.6 GB. Each worker thread is a V8 heap of its own, counted in rss and
// never in the main heapUsed; the per-instance analytics caches and the goal board were never
// registered; and the monitor escalates only when a relief fired, so falling headroom with nothing
// to drop filed nothing. These suites pin the three halves: a `worker-heap:<kind>` reading per spawn
// site plus `unattributed_bytes`, the instance and goal-board holders at serve level, and the
// `serve-memory-headroom` invariant over a below-25% series with zero reliefs.
// FALSIFIER: drop the worker heaps from the sample and the fake 900 MB worker is absorbed into
// `unattributed_bytes`; drop the rule and the zero-relief series yields no finding.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HeapInfo } from "node:v8";
import { Worker } from "node:worker_threads";

import { clockFromMillisFn } from "../src/lib/clock.js";
import { daemonInstanceRegistryPath } from "../src/lib/deployer.js";
import { evaluateIncidentInvariants, SERVE_MEMORY_HEADROOM_RULE_ID } from "../src/lib/incident-invariants.js";
import { loadPlan } from "../src/lib/plan.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import {
  LEGACY_RELIEF_HEADROOM,
  readWorkerHeaps,
  sampleServeMemory,
  SERVE_MEMORY_RELIEVED_STEP,
  SERVE_MEMORY_SAMPLE_FAILED_STEP,
  SERVE_MEMORY_SAMPLE_MS,
  SERVE_MEMORY_STEP,
  spawnSite,
  startServeMemoryMonitor,
  trackWorkerThreads,
  WORKER_HEAP_PREFIX,
  workerThreads,
  type CgroupHeadroom,
  type HolderReading,
  type TrackedWorker,
  type WorkerThread,
} from "../src/lib/serve-memory.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

type Row = { step: string } & Record<string, unknown>;

const MB = 1024 ** 2;
const GIB = 1024 ** 3;
const USAGE: NodeJS.MemoryUsage = { rss: 4 * GIB, heapTotal: 600 * MB, heapUsed: 500 * MB, external: 14 * MB, arrayBuffers: 6 * MB };
const T0 = Date.UTC(2026, 9, 2, 16, 33);
const READ = "rss-lives-read";
const WRITE = "rss-lives-write";

function headroomAt(fraction: number): () => CgroupHeadroom {
  return () => ({ limitBytes: 8 * GIB, freeBytes: Math.round(fraction * 8 * GIB), fraction });
}

/** A fake interval that hands its callback back to the test instead of arming a real timer. */
function manualTimer(): { tick: () => void; setInterval: typeof setInterval; clearInterval: typeof clearInterval } {
  let run: () => void = () => {};
  const handle = { unref: () => handle } as unknown as ReturnType<typeof setInterval>;
  return {
    tick: () => run(),
    setInterval: ((fn: () => void) => {
      run = fn;
      return handle;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
  };
}

/** A worker thread that answers its heap read the way `getHeapStatistics` is told to. */
function fakeThread(threadId: number, getHeapStatistics?: () => Promise<HeapInfo>): WorkerThread & EventEmitter {
  return Object.assign(new EventEmitter(), { threadId, ...(getHeapStatistics ? { getHeapStatistics } : {}) }) as unknown as WorkerThread & EventEmitter;
}

const heapOf = (total: number, external = 0): (() => Promise<HeapInfo>) => async () => ({ total_heap_size: total, external_memory: external }) as HeapInfo;

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function spawnProbeThread(): Worker {
  return new Worker("setInterval(() => {}, 1000);", { eval: true });
}

async function stopThread(worker: Worker): Promise<void> {
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  await worker.terminate();
  await exited;
}

test("W1-T5355: a worker thread is booked by its spawn site and its real heap is read until it exits", async () => {
  const book = trackWorkerThreads();
  const worker = spawnProbeThread();
  try {
    await new Promise((resolve) => worker.once("online", resolve));
    const live = book.live();
    assert.deepEqual(live.map((tracked) => tracked.kind), ["serve-memory-names-where-rss-lives.test:spawnProbeThread"], "the kind is the function that called new Worker");
    const [reading] = await readWorkerHeaps(live);
    assert.equal(reading.name, `${WORKER_HEAP_PREFIX}serve-memory-names-where-rss-lives.test:spawnProbeThread`);
    assert.equal(reading.kind, "worker-heap");
    assert.equal(reading.entries, 1);
    assert.ok(reading.bytes > 0, "a live thread's committed heap is sized");
    assert.equal(reading.error, undefined);
  } finally {
    await stopThread(worker);
  }
  assert.deepEqual(book.live(), [], "an exited thread leaves the book");
  book.stop();
  const after = spawnProbeThread();
  assert.deepEqual(book.live(), [], "a stopped book sees no new thread");
  await stopThread(after);
  assert.equal(workerThreads(), workerThreads(), "serve's book is one per thread");
});

test("W1-T5355: a spawn site is the first frame outside node and serve-memory", () => {
  assert.equal(spawnSite(undefined), "unknown");
  assert.equal(spawnSite("Error\n    at new Worker (node:internal/worker:297:28)"), "unknown", "only node frames name nothing");
  assert.equal(
    spawnSite("Error\n    at new Worker (node:internal/worker:297:28)\n    at spawn (file:///app/dist/lib/read-model-worker.js:1751:21)"),
    "read-model-worker:spawn",
  );
  assert.equal(spawnSite("Error\n    at file:///app/dist/lib/board-worker.mjs:155:9"), "board-worker:<module>", "a top-level spawn names its module");
});

test("W1-T5355: worker heaps group by spawn site, and a thread that cannot be read is named unsized", async (t) => {
  // The timeout timer is unref'd so a pending read never holds serve open; this holds the test's loop instead.
  const hold = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(hold));
  const never = fakeThread(4, () => new Promise<HeapInfo>(() => {}));
  const readings = await readWorkerHeaps([
    { kind: "read-model-worker:spawn", thread: fakeThread(2, heapOf(900 * MB, 10 * MB)) },
    { kind: "read-model-worker:spawn", thread: fakeThread(3, heapOf(100 * MB)) },
    { kind: "read-model-worker:spawn", thread: never },
    { kind: "board-worker:start", thread: fakeThread(5, async () => { throw new Error("Worker is not running"); }) },
    { kind: "old-runtime:spawn", thread: fakeThread(6) },
  ], 20);
  const byName = new Map(readings.map((reading) => [reading.name, reading]));
  const model = byName.get("worker-heap:read-model-worker:spawn");
  assert.equal(model?.entries, 3, "every live thread of a kind is counted");
  assert.equal(model?.bytes, 1010 * MB, "committed heap plus the thread's external memory");
  assert.deepEqual(model?.parts, { "thread-2": { entries: 1, bytes: 910 * MB }, "thread-3": { entries: 1, bytes: 100 * MB }, "thread-4": { entries: 1, bytes: 0 } });
  assert.match(model?.error ?? "", /thread 4 unsized: no heap statistics within 20ms/);
  assert.match(byName.get("worker-heap:board-worker:start")?.error ?? "", /thread 5 unsized: Worker is not running/);
  assert.match(byName.get("worker-heap:old-runtime:spawn")?.error ?? "", /thread 6 unsized: this runtime has no worker.getHeapStatistics\(\)/);
  const twice = await readWorkerHeaps([{ kind: "k", thread: never }, { kind: "k", thread: fakeThread(7, async () => { throw "gone"; }) }], 5);
  assert.match(twice[0].error ?? "", /thread 4 unsized: .*; thread 7 unsized: gone/, "each unsized thread is named, never overwritten");
  assert.deepEqual(await readWorkerHeaps([]), []);
});

test("W1-T5355: the unattributed remainder is rss less the main heap, its external memory and every sized worker heap", () => {
  const workerHeaps: HolderReading[] = [{ name: "worker-heap:read-model-worker:spawn", kind: "worker-heap", entries: 1, bytes: 900 * MB }];
  const sample = sampleServeMemory([], { usage: () => USAGE, headroom: headroomAt(0.5), workerHeaps });
  assert.equal(sample.heap_total_bytes, USAGE.heapTotal);
  assert.deepEqual(sample.holders, workerHeaps);
  assert.equal(sample.unattributed_bytes, USAGE.rss - USAGE.heapTotal - USAGE.external - 900 * MB);
  assert.equal(sampleServeMemory([], { usage: () => USAGE, headroom: headroomAt(0.5) }).unattributed_bytes, USAGE.rss - USAGE.heapTotal - USAGE.external);
});

test("W1-T5355: an async sample is ledgered when it resolves and recorded when it rejects", async () => {
  const rows: Row[] = [];
  const timer = manualTimer();
  let fail = false;
  const stop = startServeMemoryMonitor({
    holders: () => [],
    sample: async (holders) => {
      if (fail) throw new Error("heap read exploded");
      return sampleServeMemory(holders, { usage: () => USAGE, headroom: headroomAt(0.5) });
    },
    log: (step, extra) => void rows.push({ step, ...extra }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });
  timer.tick();
  await settled();
  fail = true;
  timer.tick();
  await settled();
  stop();
  assert.deepEqual(rows.map((row) => row.step), [SERVE_MEMORY_STEP, SERVE_MEMORY_SAMPLE_FAILED_STEP]);
  assert.equal(rows[1].reason, "heap read exploded");
});

test("W1-T5355: sustained low headroom with nothing to relieve fires the serve-memory-headroom invariant", () => {
  let now = T0;
  const rows: Row[] = [];
  const incidents: unknown[] = [];
  let fraction = 0.2;
  const timer = manualTimer();
  const stop = startServeMemoryMonitor({
    holders: () => [],
    sample: (holders) => sampleServeMemory(holders, { usage: () => USAGE, headroom: () => headroomAt(fraction)() }),
    log: (step, extra) => void rows.push({ ts: new Date(now).toISOString(), step, ...extra }),
    incident: (line) => void incidents.push(line),
    clock: clockFromMillisFn(() => now),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });
  const tickFor = (samples: number): void => {
    for (let i = 0; i < samples; i += 1) {
      now += SERVE_MEMORY_SAMPLE_MS;
      timer.tick();
    }
  };
  tickFor(20);
  assert.equal(rows.filter((row) => row.step === SERVE_MEMORY_RELIEVED_STEP).length, 0, "nothing was droppable");
  assert.deepEqual(incidents, [], "the monitor's own escalation waits on a relief that never comes");
  const findings = evaluateIncidentInvariants(rows, now);
  assert.deepEqual(findings.map((finding) => finding.ruleId), [SERVE_MEMORY_HEADROOM_RULE_ID], "the invariant reads the rows and fires anyway");
  assert.equal(findings[0].longMs, 18 * SERVE_MEMORY_SAMPLE_MS);
  assert.match(findings[0].message, /headroom at most 20% over 18 sample\(s\), below 25%; reliefs=0; last rss=4294967296 unattributed=/);

  fraction = LEGACY_RELIEF_HEADROOM;
  tickFor(1);
  assert.deepEqual(evaluateIncidentInvariants(rows, now), [], "a recovered latest sample clears the short window");
  stop();
});

test("W1-T5355: a dip, a null headroom and a healthy series never fire the headroom invariant", () => {
  const series = (headrooms: (number | null)[]): Row[] =>
    headrooms.map((headroom, i) => ({ ts: new Date(T0 + (i + 1) * SERVE_MEMORY_SAMPLE_MS).toISOString(), step: SERVE_MEMORY_STEP, headroom }));
  const end = T0 + 20 * SERVE_MEMORY_SAMPLE_MS;
  const fired = (rows: Row[]): string[] => evaluateIncidentInvariants(rows, end).map((finding) => finding.ruleId);
  assert.deepEqual(fired(series([...Array(10).fill(0.2), 0.5, ...Array(9).fill(0.2)])), [], "one recovered sample inside the long window is not sustained");
  assert.deepEqual(fired(series(Array(20).fill(null))), [], "no cgroup is no evidence");
  assert.deepEqual(fired(series(Array(20).fill(0.6))), []);
  assert.deepEqual(fired([]), []);
});

/** core (the gateway's own root) + site, whose analytics cache serve must register by name. */
function fleet(t: { after: (fn: () => void) => void }, serveMemory: ServeDeps["serveMemory"]): { deps: ServeDeps; rows: Row[] } {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rss-lives-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = (dir: string, repo: string, taskId: string): { ledgerPath: string; planPath: string; checkout: string } => {
    mkdirSync(join(dir, "state"), { recursive: true });
    const ledgerPath = join(dir, "state", "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const checkout = join(dir, "repos", repo);
    mkdirSync(join(checkout, "plan"), { recursive: true });
    const planPath = join(checkout, "plan", "tasks.yaml");
    writeFileSync(planPath, `- id: ${taskId}\n  title: ${taskId} title\n  repo: ${repo}\n  type: implement\n  depends_on: []\n  status: queued\n`);
    return { ledgerPath, planPath, checkout };
  };
  const core = root(join(base, "core-root"), "remudero", "CORE-T1");
  const stateBase = join(base, "instances");
  root(join(stateBase, "site"), "remudero-site", "SITE-T1");
  mkdirSync(join(core.checkout, ".remudero"), { recursive: true });
  const row = (name: string, repo: string): string => [`  ${name}:`, `    repo: ${repo}`, "    project: remudero", `    github_repo: craigoley/${repo}`].join("\n");
  writeFileSync(daemonInstanceRegistryPath(core.checkout), ["instances:", row("core", "remudero"), row("site", "remudero-site"), ""].join("\n"));
  const github = fakeGitHub();
  const rows: Row[] = [];
  const deps: ServeDeps = {
    board: { plan: loadPlan(core.planPath), ledgerPath: core.ledgerPath, github },
    panelGraph: { root: core.checkout, planPath: core.planPath, ledgerPath: core.ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath: core.ledgerPath,
    issues: { close() {} },
    fleetControlRoot: join(base, "core-root"),
    questionsRoot: core.checkout,
    tokens: { read: READ, write: WRITE },
    consoleSha: "test-sha",
    resolveCurrentSha: () => "test-sha",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    instances: { stateBase, github: () => github },
    log: (step, extra) => void rows.push({ step, ...extra }),
    serveMemory,
  };
  return { deps, rows };
}

test("W1-T5355: serve's sample names each worker heap, every instance analytics cache, the goal board and the unattributed remainder", async (t) => {
  const timer = manualTimer();
  const projector: TrackedWorker = { kind: "read-model-worker:spawn", thread: fakeThread(7, heapOf(900 * MB)) };
  const { deps, rows } = fleet(t, { ...timer, usage: () => USAGE, headroom: headroomAt(0.5), workers: () => [projector] });
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const plan = await fetch(`${url}/v1/operator-agent/intent-plans`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" },
      body: JSON.stringify({ goal: "run CORE-T1", idempotencyKey: "w1-t5355-goal-board" }),
    });
    assert.equal(plan.status, 201, "a goal naming a task reads the goal board");
    await plan.text();
    timer.tick();
    await settled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const samples = rows.filter((row) => row.step === SERVE_MEMORY_STEP);
  assert.equal(samples.length, 1, "one tick ledgers one sample");
  const holders = samples[0].holders as HolderReading[];
  const byName = new Map(holders.map((holder) => [holder.name, holder]));
  assert.deepEqual(byName.get("worker-heap:read-model-worker:spawn"), {
    name: "worker-heap:read-model-worker:spawn", kind: "worker-heap", entries: 1, bytes: 900 * MB, parts: { "thread-7": { entries: 1, bytes: 900 * MB } },
  });
  assert.equal(byName.get("analytics:site")?.kind, "refreshable", "the site instance's analytics cache is named and sheddable");
  assert.equal(byName.get("goal-board")?.kind, "measured");
  assert.ok((byName.get("goal-board")?.bytes ?? 0) > 0, "the goal board serve built is sized");
  assert.equal(samples[0].unattributed_bytes, USAGE.rss - USAGE.heapTotal - USAGE.external - 900 * MB, "the worker heap is attributed, not left in the remainder");
});
