// test/serve-names-and-relieves-its-memory-pressure.test.ts — W1-T5175.
//
// The kernel killed serve's node at 2026-10-01 16:09:17Z (memcg, anon-rss 5.0 GB of a 5 GiB
// limit) and no ledger row said which cache, projector or view body held it. These suites pin the
// two halves the task adds: a `serve.memory` sample naming every holder's entries and bytes, and a
// tiered relief that drops a served (or shadowed) view's legacy cache first as the container's own
// headroom shrinks, sheds the largest refreshable holder only below a lower line, and escalates a
// repeated relief once. FALSIFIER: remove the relief arm and the second test sees no cache dropped.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Plan } from "../src/lib/plan.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import {
  approxBytes,
  createServeMemoryRegistry,
  droppableRouteCache,
  LEGACY_RELIEF_HEADROOM,
  readCgroupHeadroom,
  REFRESHABLE_RELIEF_HEADROOM,
  relieveServeMemory,
  sampleServeMemory,
  SERVE_MEMORY_RELIEVED_STEP,
  SERVE_MEMORY_STEP,
  snapshotHolder,
  startServeMemoryMonitor,
  viewBodiesHolder,
  withoutRestore,
  type CgroupHeadroom,
  type MemoryHolder,
} from "../src/lib/serve-memory.js";
import type { RouteHandler } from "../src/lib/service.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

type Row = { step: string } & Record<string, unknown>;

const GIB = 1024 ** 3;
const USAGE: NodeJS.MemoryUsage = { rss: 4 * GIB, heapTotal: 3 * GIB, heapUsed: 2 * GIB, external: 64 * 1024 ** 2, arrayBuffers: 32 * 1024 ** 2 };

function headroomAt(fraction: number): () => CgroupHeadroom {
  return () => ({ limitBytes: 5 * GIB, freeBytes: Math.round(fraction * 5 * GIB), fraction });
}

/** A fake interval that hands its callback back to the test instead of arming a real timer. */
function manualTimer(): { tick: () => void; cleared: () => boolean; setInterval: typeof setInterval; clearInterval: typeof clearInterval } {
  let run: () => void = () => {};
  let cleared = false;
  const handle = { unref: () => handle } as unknown as ReturnType<typeof setInterval>;
  return {
    tick: () => run(),
    cleared: () => cleared,
    setInterval: ((fn: () => void) => {
      run = fn;
      return handle;
    }) as unknown as typeof setInterval,
    clearInterval: (() => void (cleared = true)) as unknown as typeof clearInterval,
  };
}

function servedFixture(serveMemory: ServeDeps["serveMemory"]): { deps: ServeDeps; rows: Row[]; root: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-memory-`));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const rows: Row[] = [];
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() } as Plan, ledgerPath, github },
    panelGraph: {
      root,
      planPath,
      ledgerPath,
      github: { prView: () => null } as TraceGithub,
      statusGithub: github,
      ratify: { approve: () => {}, reframe: () => {} } as RatifyCliGateway,
    },
    ledgerPath,
    issues: { close: () => {} } as IssueCloser,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "memory-read", write: "memory-write" },
    pollMs: 50,
    log: (step, extra) => void rows.push({ step, ...extra }),
    serveMemory,
  };
  return { deps, rows, root, ledgerPath };
}

test("W1-T5175: serve ledgers a memory sample that names each holder size", async () => {
  const timer = manualTimer();
  const { deps, rows, root } = servedFixture({ ...timer, usage: () => USAGE, headroom: headroomAt(0.5) });
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const read = await fetch(`http://127.0.0.1:${port}/v1/recent`, { headers: { authorization: "Bearer memory-read" } });
    assert.equal(read.status, 200);
    await read.text();
    timer.tick();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(timer.cleared(), true, "the sample loop stops when serve closes");
  const samples = rows.filter((row) => row.step === SERVE_MEMORY_STEP);
  assert.equal(samples.length, 1, "one tick ledgers one sample");
  const sample = samples[0];
  assert.equal(sample.rss_bytes, USAGE.rss);
  assert.equal(sample.heap_used_bytes, USAGE.heapUsed);
  assert.equal(sample.external_bytes, USAGE.external);
  assert.equal(sample.array_buffers_bytes, USAGE.arrayBuffers);
  assert.equal(sample.limit_bytes, 5 * GIB);
  assert.equal(sample.headroom, 0.5);
  const holders = sample.holders as { name: string; kind: string; view?: string; entries: number; bytes: number }[];
  const byName = new Map(holders.map((holder) => [holder.name, holder]));
  for (const name of ["analytics", "live-analytics", "board-snapshot", "legacy-cache:core:/v1/status", "legacy-cache:core:/v1/inbox"]) {
    assert.ok(byName.has(name), `the sample names ${name}`);
  }
  for (const holder of holders) {
    assert.equal(typeof holder.entries, "number", `${holder.name} reports its entry count`);
    assert.equal(typeof holder.bytes, "number", `${holder.name} reports its approximate bytes`);
  }
  const recent = byName.get("legacy-cache:core:/v1/recent");
  assert.equal(recent?.kind, "legacy-cache");
  assert.equal(recent?.view, "now");
  assert.equal(recent?.entries, 1, "the read just served is the route cache's one entry");
  assert.ok((recent?.bytes ?? 0) > 0, "and its bytes are the body it holds");
  assert.ok((byName.get("analytics")?.bytes ?? 0) > 0, "the analytics refresh result is sized");
  assert.equal(rows.filter((row) => row.step === SERVE_MEMORY_RELIEVED_STEP).length, 0, "half the container free relieves nothing");
});

function fakeLegacy(name: string, view: string, bytes: number, dropped: string[]): MemoryHolder {
  let held = bytes;
  return { name, kind: "legacy-cache", view, size: () => ({ entries: held > 0 ? 1 : 0, bytes: held }), drop: () => void (dropped.push(name), (held = 0)) };
}

function fakeRefreshable(name: string, bytes: number, dropped: string[]): MemoryHolder {
  let held = bytes;
  return { name, kind: "refreshable", size: () => ({ entries: held > 0 ? 1 : 0, bytes: held }), drop: () => void (dropped.push(name), (held = 0)) };
}

test("W1-T5175: shrinking headroom drops a served view legacy cache first", () => {
  const dropped: string[] = [];
  const registry = createServeMemoryRegistry();
  registry.add(fakeLegacy("legacy-cache:core:/v1/inbox", "inbox", 4_000, dropped));
  registry.add(fakeLegacy("legacy-cache:core:/v1/feedback", "feedback", 9_000, dropped));
  registry.add(fakeLegacy("legacy-cache:core:/v1/repos", "repositories", 2_000, dropped));
  registry.add(fakeRefreshable("analytics", 50_000, dropped));
  registry.add(fakeRefreshable("live-analytics", 7_000, dropped));
  const modes: Record<string, "serve" | "shadow" | "off"> = { inbox: "serve", feedback: "off", repositories: "shadow" };
  const rows: Row[] = [];
  const incidents: Record<string, unknown>[] = [];
  let fraction = 0.6;
  const timer = manualTimer();
  const stop = startServeMemoryMonitor({
    holders: registry.holders,
    sample: (holders) => sampleServeMemory(holders, { usage: () => USAGE, headroom: () => headroomAt(fraction)() }),
    modeOf: (view) => modes[view],
    log: (step, extra) => void rows.push({ step, ...extra }),
    incident: (line) => void incidents.push(line),
    clock: fixedClock(Date.UTC(2026, 9, 1, 16, 9, 17)),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });

  timer.tick();
  assert.deepEqual(dropped, [], "plenty of headroom drops nothing");

  fraction = (LEGACY_RELIEF_HEADROOM + REFRESHABLE_RELIEF_HEADROOM) / 2;
  timer.tick();
  assert.deepEqual(dropped, ["legacy-cache:core:/v1/inbox", "legacy-cache:core:/v1/repos"],
    "the served and shadowed views' legacy caches go first; the switched-off view keeps the cache it still answers from, and nothing refreshable is shed yet");
  const relieved = rows.filter((row) => row.step === SERVE_MEMORY_RELIEVED_STEP);
  assert.deepEqual(relieved.map((row) => [row.holder, row.tier, row.mode, row.bytes]), [
    ["legacy-cache:core:/v1/inbox", 1, "serve", 4_000],
    ["legacy-cache:core:/v1/repos", 1, "shadow", 2_000],
  ], "each step ledgers the holder and the bytes it held");
  assert.equal(incidents.length, 0, "one relief is not yet repeated");

  fraction = REFRESHABLE_RELIEF_HEADROOM / 2;
  timer.tick();
  assert.deepEqual(dropped.slice(2), ["analytics"], "below the lower line only the LARGEST refreshable holder is shed");
  assert.equal(incidents.length, 1, "a repeated relief escalates");
  assert.equal(incidents[0].step, "incident.event");
  assert.equal(incidents[0].name, "serve-memory-relief");
  assert.match(String(incidents[0].message), /analytics/);

  timer.tick();
  assert.deepEqual(dropped.slice(3), ["live-analytics"], "the next sample sheds the next largest");
  assert.equal(incidents.length, 1, "and the escalation fires once, not once per relief");

  fraction = 0.6;
  timer.tick();
  fraction = REFRESHABLE_RELIEF_HEADROOM / 2;
  registry.add(fakeRefreshable("analytics", 50_000, dropped));
  timer.tick();
  timer.tick();
  assert.equal(incidents.length, 1, "recovered headroom re-arms the streak but a single fresh relief does not escalate");
  stop();
  assert.equal(timer.cleared(), true);
});

test("W1-T5175: a holder is sized, an unmeasurable reading is named, and a failing step is recorded", () => {
  assert.equal(approxBytes(null), 8);
  assert.equal(approxBytes("abcd"), 4);
  const shared = { s: "xy" };
  const cyclic: Record<string, unknown> = { a: shared, b: shared, list: [1, 2, 3], map: new Map([["k", "vv"]]), set: new Set(["q"]), buf: Buffer.alloc(100) };
  cyclic.self = cyclic;
  const sized = approxBytes(cyclic);
  assert.ok(sized > 100, "a nested value counts its buffers, strings and containers");
  assert.ok(approxBytes(cyclic, 3) < sized, "the node budget bounds the walk");
  const getter = Object.defineProperty({}, "hot", { get: () => { throw new Error("never read"); }, enumerable: true });
  assert.ok(approxBytes(getter) > 0, "an accessor is never invoked");

  assert.deepEqual(snapshotHolder("absent", () => undefined).size(), { entries: 0, bytes: 0 });
  assert.equal(snapshotHolder("measured", () => ({ a: 1 })).kind, "measured");
  assert.equal(snapshotHolder("shed", () => ({ a: 1 }), () => {}).kind, "refreshable");

  const bodies = new Map([
    ["inbox\u0000a", { view: "inbox", generation: 3, body: { data: "x".repeat(50) } }],
    ["inbox\u0000b", { view: "inbox", generation: 3, body: { data: "y" } }],
    ["now\u0000core", { view: "now", generation: 4, body: { data: [] } }],
  ]);
  const view = viewBodiesHolder(() => bodies).size();
  assert.equal(view.entries, 3);
  assert.deepEqual(Object.keys(view.parts ?? {}).sort(), ["inbox@g3", "now@g4"]);
  assert.equal(view.parts?.["inbox@g3"].entries, 2);

  const files: Record<string, string> = { "/cg/memory.max": "1000\n", "/cg/memory.current": "800\n", "/cg/memory.stat": "file 100\nshmem 0\nfile_dirty 0\nfile_writeback 0\n" };
  const read = (path: string): string => {
    if (!(path in files)) throw new Error(`ENOENT ${path}`);
    return files[path];
  };
  assert.deepEqual(readCgroupHeadroom(read, "/cg"), { limitBytes: 1000, freeBytes: 300, fraction: 0.3 });
  files["/cg/memory.max"] = "max\n";
  assert.equal(readCgroupHeadroom(read, "/cg"), undefined, "an unbounded container has no headroom to relieve against");
  assert.equal(readCgroupHeadroom(read, "/nowhere"), undefined, "no cgroup v2 at all reads as unmeasurable");
  assert.equal(readCgroupHeadroom(undefined, join(tmpdir(), "no-such-cgroup-root")), undefined, "the real reader answers the same on a missing root");

  const real = sampleServeMemory([{ name: "broken", kind: "measured", size: () => { throw new Error("size exploded"); } }]);
  assert.ok(real.rss_bytes > 0, "the default reads this process's own memory");
  assert.equal(real.holders[0].error, "size exploded", "a holder that cannot size itself is named, not dropped from the row");
  assert.equal(real.holders[0].bytes, 0);
  assert.equal(relieveServeMemory({ ...real, headroom: null }, [], () => "serve").length, 0, "no headroom reading relieves nothing");

  const failingDrop: MemoryHolder = { name: "legacy-cache:core:/v1/inbox", kind: "legacy-cache", view: "inbox", size: () => ({ entries: 1, bytes: 10 }), drop: () => { throw new Error("drop exploded"); } };
  const unmapped: MemoryHolder = { name: "legacy-cache:core:/v1/daemon-health", kind: "legacy-cache", size: () => ({ entries: 1, bytes: 10 }), drop: () => assert.fail("a cache no view replaces is never dropped") };
  const pressured = sampleServeMemory([failingDrop, unmapped], { usage: () => USAGE, headroom: headroomAt(0.01) });
  const reliefs = relieveServeMemory(pressured, [failingDrop, unmapped], () => "serve");
  assert.deepEqual(reliefs.map((relief) => [relief.holder, relief.error]), [["legacy-cache:core:/v1/inbox", "drop exploded"]]);

  const rows: Row[] = [];
  const timer = manualTimer();
  const stop = startServeMemoryMonitor({
    holders: () => [],
    sample: () => { throw new Error("sample exploded"); },
    log: (step, extra) => void rows.push({ step, ...extra }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  });
  timer.tick();
  stop();
  assert.deepEqual(rows.map((row) => [row.step, row.reason]), [["serve.memory_sample_failed", "sample exploded"]]);

  const escalations: Row[] = [];
  const pressure = manualTimer();
  const shedAgain: MemoryHolder = { name: "analytics", kind: "refreshable", size: () => ({ entries: 1, bytes: 10 }), drop: () => {} };
  const stopPressure = startServeMemoryMonitor({
    holders: () => [shedAgain],
    sample: (holders) => sampleServeMemory(holders, { usage: () => USAGE, headroom: headroomAt(0.01) }),
    log: (step, extra) => void escalations.push({ step, ...extra }),
    incident: () => { throw new Error("ledger full"); },
    escalateAfter: 1,
    setInterval: pressure.setInterval,
    clearInterval: pressure.clearInterval,
  });
  pressure.tick();
  stopPressure();
  assert.deepEqual(escalations.filter((row) => row.step === "serve.memory_escalation_failed").map((row) => row.reason), ["ledger full"]);
});

test("W1-T5175: a dropped route cache rebuilds on demand without restoring what it shed", async () => {
  const made: boolean[] = [];
  const handlers: RouteHandler[] = [
    (_req, res) => void res.end("first-body"),
    (_req, res) => void res.end("second"),
  ];
  const cache = droppableRouteCache("legacy-cache:core:/v1/inbox", "inbox", (afterDrop) => {
    made.push(afterDrop);
    return handlers[made.length - 1];
  });
  const call = async (url: string): Promise<string[]> => {
    const ends: string[] = [];
    const res = { end: (chunk?: unknown) => void ends.push(chunk === undefined ? "" : String(chunk)) } as unknown as ServerResponse;
    await cache.handler({ url } as IncomingMessage, res, { params: {} });
    return ends;
  };
  assert.deepEqual(await call("/v1/inbox?b=2&a=1"), ["first-body"]);
  await call("/v1/inbox?a=1&b=2");
  assert.deepEqual(cache.holder.size(), { entries: 1, bytes: "first-body".length }, "one normalized query is one entry");
  cache.holder.drop?.();
  assert.deepEqual(cache.holder.size(), { entries: 0, bytes: 0 });
  assert.deepEqual(await call("/v1/inbox"), ["second"]);
  assert.deepEqual(made, [false, true], "the rebuilt cache is told it follows a drop");
  const silent = droppableRouteCache("x", undefined, () => (_req, res) => void res.end());
  await silent.handler({ url: "/x" } as IncomingMessage, { end: () => {} } as unknown as ServerResponse, { params: {} });
  assert.deepEqual(silent.holder.size(), { entries: 0, bytes: 0 }, "a bodiless answer (a 304) sizes nothing");
  const many = droppableRouteCache("many", undefined, () => (_req, res) => void res.end(Buffer.from("ab")));
  for (let i = 0; i < 80; i += 1) await many.handler({ url: `/m?i=${i}` } as IncomingMessage, { end: () => {} } as unknown as ServerResponse, { params: {} });
  assert.equal(many.holder.size().entries, 64, "the size book is bounded like the cache it watches");

  assert.equal(withoutRestore(undefined), undefined);
  const saved: string[] = [];
  const store = withoutRestore({ restore: async () => [{ key: "k" }] as never, save: async (path, key) => void saved.push(`${path} ${key}`) });
  assert.deepEqual(await store?.restore("/v1/inbox"), []);
  await store?.save("/v1/inbox", "k", { status: 200, headers: {}, body: "", generatedAtMs: 0 });
  assert.deepEqual(saved, ["/v1/inbox k"], "persistence still saves after a drop");
});

test("W1-T5175: serve sheds its largest refreshable holder under pressure and ledgers the escalation once", async () => {
  const timer = manualTimer();
  const { deps, rows, root, ledgerPath } = servedFixture({ ...timer, usage: () => USAGE, headroom: headroomAt(REFRESHABLE_RELIEF_HEADROOM / 2), clock: fixedClock(Date.UTC(2026, 9, 1, 16, 9, 17)) });
  const server = buildServeServer(deps);
  try {
    timer.tick();
    timer.tick();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  try {
    const relieved = rows.filter((row) => row.step === SERVE_MEMORY_RELIEVED_STEP);
    assert.deepEqual(relieved.map((row) => [row.holder, row.tier]), [["analytics", 2], ["analytics", 2]], "the analytics refresh result is the largest refreshable holder");
    assert.ok(rows.some((row) => row.step === "serve.analytics_shed"), "the relief is the analytics cache's own shed");
    const incidents = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row).filter((row) => row.step === "incident.event");
    assert.deepEqual(incidents.map((row) => row.name), ["serve-memory-relief"], "the repeated relief reaches the incident path once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
