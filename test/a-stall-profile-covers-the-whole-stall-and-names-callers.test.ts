// W1-T9361: a loop-stall profile row covers the WHOLE stall and names the callers. Every profile chunk is folded
// into a per-frame aggregate before it is released (W1-T7746 kept only the newest two), the row says how much of
// the lag it profiled, and each native leaf (`spawn`, `readFileUtf8`) names its nearest script caller from the
// profile's node tree, beside the top inclusive frames, the callers that held the loop and the sync-spawn callers.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { foldStallChunk, LOOP_STALL_FORWARDING_FRAMES, startLoopStallProfiler, summarizeStallFold, topSelfFrames,
  type CpuProfile, type StallFold } from "../src/lib/loop-stall-profiler.js";
import { startReadPlaneTelemetry, SYNC_SPAWN_LEAF_FRAMES } from "../src/lib/read-plane.js";

type Row = { step: string } & Record<string, unknown>;
type Ref = { function: string; url: string; line: number };
type Frame = Ref & { self_ms: number; caller?: Ref; via?: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}

// ── synthetic CpuProfile chunks, shaped as V8 reports them ─────────────────────────────────────────────────────

/** One frame of a synthetic stack. `line` is 1-based (V8's `lineNumber` is 0-based); a native has no url. */
type Site = { fn: string; url?: string; line?: number };

const SRC = "file:///home/node/Remudero/remudero/src/lib/";
const at = (fn: string, module: string, line: number): Site => ({ fn, url: `${SRC}${module}`, line });
const builtin = (fn: string, url: string, line: number): Site => ({ fn, url, line });
const native = (fn: string): Site => ({ fn });

const TIMERS = builtin("listOnTimeout", "node:internal/timers", 581);
const TICK = at("tick", "daemon.ts", 1900);
const WRAPPER = at("wrapper", "read-plane.ts", 189); // read-plane's sync-spawn meter wraps every sync child API
const EXEC_FILE_SYNC = builtin("execFileSync", "node:child_process", 900);
const SPAWN_SYNC = builtin("spawnSync", "node:child_process", 860);
const SPAWN_SYNC_INTERNAL = builtin("spawnSync", "node:internal/child_process", 1145);
const SPAWN = native("spawn");
const READ_FILE_SYNC = builtin("readFileSync", "node:fs", 473);
const READ_FILE_UTF8 = native("readFileUtf8");

/** A chunk whose samples walk `stacks` (outermost frame first), one sample per stack lasting `ms`. Nodes share a
 *  prefix the way V8's node tree does, and each node lists its `children`. */
function chunk(stacks: { stack: Site[]; ms: number }[], startTime = 0): CpuProfile {
  const nodes: CpuProfile["nodes"] = [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [] }];
  const byPath = new Map<string, number>();
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  let previousUs = 0;
  for (const { stack, ms } of stacks) {
    let parent = nodes[0]!;
    let path = "";
    for (const site of stack) {
      path += `>${site.fn}@${site.url ?? ""}:${site.line ?? 0}`;
      let id = byPath.get(path);
      if (id === undefined) {
        id = nodes.length + 1;
        byPath.set(path, id);
        nodes.push({ id, callFrame: { functionName: site.fn, url: site.url ?? "", lineNumber: (site.line ?? 0) - 1 }, children: [] });
        parent.children!.push(id);
      }
      parent = nodes[id - 1]!;
    }
    samples.push(parent.id);
    timeDeltas.push(previousUs);
    previousUs = ms * 1000;
  }
  const spanUs = stacks.reduce((sum, { ms }) => sum + ms * 1000, 0);
  return { nodes, startTime, endTime: startTime + spanUs, samples, timeDeltas };
}

const ref = (site: Site): Ref => ({ function: site.fn, url: site.url ?? "", line: site.line ?? 0 });
const fold = (chunks: readonly CpuProfile[]): StallFold => {
  let into: StallFold | undefined;
  for (const profile of chunks) into = foldStallChunk(into, profile, LOOP_STALL_FORWARDING_FRAMES);
  return into!;
};

// The 2026-10-15 rows' shapes (core ledger, `daemon.loop_stall_profile` 00:15-13:57Z): `spawn` under a sync child API
// through read-plane's meter, `readFileUtf8` under readFileSync, a script leaf, and the transport's blocking sleep.
const SRE_PASS = at("runSreLanePass", "sre-lane.ts", 240);
const LATEST_TS = at("latestLedgerTsMs", "status.ts", 120);
const RESPONDER = at("", "inbox-responder.ts", 1);
const PARSE_LEDGER = at("parseLedgerContent", "status.ts", 88);
const MIXED_STALL: { stack: Site[]; ms: number }[] = [
  { stack: [TIMERS, TICK, SRE_PASS, WRAPPER, EXEC_FILE_SYNC, SPAWN_SYNC, SPAWN_SYNC_INTERNAL, SPAWN], ms: 30 },
  { stack: [TIMERS, TICK, LATEST_TS, READ_FILE_SYNC, READ_FILE_UTF8], ms: 12 },
  { stack: [TIMERS, TICK, RESPONDER, PARSE_LEDGER], ms: 2 },
];

test("W1-T9361: a native leaf names its nearest JS caller", () => {
  assert.deepEqual(topSelfFrames([chunk(MIXED_STALL)]), [
    // read-plane's `wrapper` only forwards the call; the frame that called it is the caller.
    { function: "spawn", url: "", line: 0, self_ms: 30, caller: ref(SRE_PASS), via: "execFileSync" },
    { function: "readFileUtf8", url: "", line: 0, self_ms: 12, caller: ref(LATEST_TS), via: "readFileSync" },
    { function: "parseLedgerContent", url: `${SRC}status.ts`, line: 88, self_ms: 2,
      caller: { function: "(anonymous)", url: `${SRC}inbox-responder.ts`, line: 1 } },
  ]);
  // One leaf under two callers is two frames, each naming its own: the leaf alone could not tell them apart.
  const READ_PLAN = at("readPlanShards", "plan.ts", 410);
  const two = topSelfFrames([chunk([
    { stack: [TIMERS, TICK, LATEST_TS, READ_FILE_SYNC, READ_FILE_UTF8], ms: 5 },
    { stack: [TIMERS, TICK, READ_PLAN, READ_FILE_SYNC, READ_FILE_UTF8], ms: 7 },
  ])]);
  assert.deepEqual(two.map((frame) => [frame.function, frame.caller?.function, frame.self_ms]),
    [["readFileUtf8", "readPlanShards", 7], ["readFileUtf8", "latestLedgerTsMs", 5]]);
  // A native with no script frame below it (the collector, a bare timer) names no caller and no builtin.
  assert.deepEqual(topSelfFrames([chunk([{ stack: [native("(garbage collector)")], ms: 4 }])]),
    [{ function: "(garbage collector)", url: "", line: 0, self_ms: 4 }]);
  assert.deepEqual(topSelfFrames([]), [], "no chunk, no frame");
});

test("W1-T9361: the row names the top inclusive JS frames", () => {
  const WALK = at("walk", "ledger-union.ts", 30);
  const summary = summarizeStallFold(fold([chunk([
    ...MIXED_STALL,
    // Recursion is one frame's time ONCE per sample, never once per stack entry.
    { stack: [TIMERS, TICK, WALK, WALK, WALK], ms: 5 },
  ])]));
  assert.deepEqual(summary.top_inclusive, [
    { ...ref(TICK), total_ms: 49 },
    { ...ref(SRE_PASS), total_ms: 30 },
    { ...ref(LATEST_TS), total_ms: 12 },
    { ...ref(WALK), total_ms: 5 },
    { ...ref(PARSE_LEDGER), total_ms: 2 }, // a tie keeps the deeper frame first
  ]);
  // Script frames only: no `node:` builtin, no native, and no forwarding frame (read-plane's wrapper) is ranked.
  for (const frame of summarizeStallFold(fold([chunk(MIXED_STALL)]), 20).top_inclusive) {
    assert.ok(frame.url.startsWith(SRC) && frame.function !== "wrapper", JSON.stringify(frame));
  }
  // The callers that held the loop: each sample credited to its innermost script frame, so a function's builtin and
  // native work is its own. The sync-spawn share names its callers beside the meter's sync_spawn_ms.
  assert.deepEqual(summary.top_callers, [
    { ...ref(SRE_PASS), self_ms: 30 },
    { ...ref(LATEST_TS), self_ms: 12 },
    { ...ref(WALK), self_ms: 5 },
    { ...ref(PARSE_LEDGER), self_ms: 2 },
  ]);
  assert.equal(summary.sync_spawn_profiled_ms, 30);
  assert.deepEqual(summary.sync_spawn_callers, [{ ...ref(SRE_PASS), self_ms: 30 }]);
  assert.equal(summary.profiled_ms, 49);
  assert.equal(summary.chunks, 1);
});

test("W1-T9361: the aggregate grows with distinct frames, not stall length", () => {
  const one = chunk(MIXED_STALL);
  const sizes = (f: StallFold) => [f.self.size, f.inclusive.size, f.callers.size, f.syncSpawn.size];
  const short = fold(Array.from({ length: 3 }, () => one));
  const long = fold(Array.from({ length: 300 }, () => one));
  assert.deepEqual(sizes(long), sizes(short));
  assert.deepEqual(sizes(short), [3, 5, 3, 1]);
  assert.equal(long.chunks, 300);
  assert.equal(summarizeStallFold(long).profiled_ms, 300 * 44);
  assert.equal(summarizeStallFold(long).top_frames[0]!.self_ms, 300 * 30);
  // A new frame is what grows it: one more leaf under a known caller is one more self entry, and nothing else.
  const grown = foldStallChunk(long, chunk([{ stack: [TIMERS, TICK, SRE_PASS, native("getReport")], ms: 1 }]),
    LOOP_STALL_FORWARDING_FRAMES);
  assert.equal(grown, long, "the fold is updated in place and returned");
  assert.deepEqual(sizes(grown), [4, 5, 3, 1]);
});

test("W1-T9361: the recorded 2026-10-15 stall shapes name their callers", () => {
  // 04:19:03Z (lag 182,551 ms, sync_spawn_ms 188,955): spawn 69,947 ms self, the plan PR preflight's child.
  const RUN_IN_TREE = at("runInTree", "plan-pr-emitter.ts", 588);
  // 00:15:57Z (lag 445,980 ms): readFileUtf8 143,322 ms self beside host-memory-shadow's readers.
  const PRESSURE = at("readContainerPressure", "host-memory-shadow.ts", 210);
  // 07:12:50Z: defaultBlockingSleepSync 5,070 ms self, the transport's retry sleep (a forwarding module).
  const SLEEP = at("defaultBlockingSleepSync", "github-transport.ts", 3);
  const GH_JSON = at("ghJson", "github-transport.ts", 400);
  const LIST_PRS = at("listOpenPulls", "fleet-lane.ts", 77);
  // An async child's own `spawn` is short and is no sync child: execFile enters ChildProcess.spawn.
  const ASYNC = [TIMERS, TICK, at("refreshHeads", "fleet-lane.ts", 300), builtin("execFile", "node:child_process", 340),
    builtin("spawn", "node:internal/child_process", 360), SPAWN];
  const summary = summarizeStallFold(fold([
    chunk([{ stack: [TIMERS, TICK, RUN_IN_TREE, WRAPPER, SPAWN_SYNC, SPAWN_SYNC_INTERNAL, SPAWN], ms: 699 },
      { stack: [TIMERS, TICK, PRESSURE, READ_FILE_SYNC, READ_FILE_UTF8], ms: 143 }], 0),
    chunk([{ stack: [TIMERS, TICK, LIST_PRS, GH_JSON, SLEEP], ms: 50 }, { stack: ASYNC, ms: 3 }], 842_000),
  ]));
  assert.deepEqual(summary.top_frames.map((frame) => [frame.function, frame.caller?.function, frame.via, frame.self_ms]), [
    ["spawn", "runInTree", "spawnSync", 699],
    ["readFileUtf8", "readContainerPressure", "readFileSync", 143],
    // The sleep is the leaf; its caller skips the transport's own frames to the code that asked for the read.
    ["defaultBlockingSleepSync", "listOpenPulls", undefined, 50],
    ["spawn", "refreshHeads", "execFile", 3],
  ]);
  assert.deepEqual(summary.top_callers.map((caller) => [caller.function, caller.self_ms]),
    [["runInTree", 699], ["readContainerPressure", 143], ["listOpenPulls", 50], ["refreshHeads", 3]]);
  assert.equal(summary.sync_spawn_profiled_ms, 699, "the async child is not counted as a sync one");
  assert.deepEqual(summary.sync_spawn_callers, [{ ...ref(RUN_IN_TREE), self_ms: 699 }]);
  assert.equal(summary.profiled_ms, 895);
  assert.equal(summary.chunks, 2);
});

test("W1-T9361: the forwarding frames hold every spawn leaf read-plane declares, and read-plane itself", () => {
  const sources = new Set(LOOP_STALL_FORWARDING_FRAMES.map((pattern) => pattern.source));
  for (const leaf of SYNC_SPAWN_LEAF_FRAMES) assert.ok(sources.has(leaf.source), `missing ${leaf.source}`);
  assert.equal(sources.size, SYNC_SPAWN_LEAF_FRAMES.length + 1);
  const matches = (fn: string, url: string) =>
    LOOP_STALL_FORWARDING_FRAMES.some((pattern) => pattern.test(`at ${fn} (${url}:1)`));
  assert.ok(matches("wrapper", `${SRC}read-plane.ts`));
  assert.ok(matches("runGit", `${SRC}plan.ts`));
  assert.ok(!matches("readPlanShards", `${SRC}plan.ts`), "only plan.ts's named runner forwards");
  assert.ok(!matches("runInTree", `${SRC}plan-pr-emitter.ts`));
});

// ── the watchdog itself, with the inspector replaced: deterministic chunks, no V8 Profiler domain ──────────────

/** Prepended to the watchdog source: a session that attaches without the inspector and serves `chunks` in order,
 *  one per `Profiler.stop` (the last one repeats), counting each in `probe[0]` so the stalled test can see it. */
const FAKE_INSPECTOR = `
const fakeData = process.getBuiltinModule("node:worker_threads").workerData;
const fakeProbe = new Int32Array(fakeData.probe);
const fakeSession = process.getBuiltinModule("node:inspector").Session.prototype;
fakeSession.connectToMainThread = function () {};
fakeSession.post = function (method, params, reply) {
  let result = {};
  if (method === "Profiler.stop") {
    const served = Atomics.add(fakeProbe, 0, 1);
    result = { profile: fakeData.chunks[Math.min(served, fakeData.chunks.length - 1)] };
    Atomics.notify(fakeProbe, 0);
  }
  setImmediate(() => reply(null, result));
};
`;

/** Hold the main thread until the watchdog has stopped `served` chunks: no timer, no heartbeat runs meanwhile. */
function holdTheLoopUntil(probe: Int32Array, served: number): void {
  const deadline = performance.now() + 30_000;
  for (let seen = Atomics.load(probe, 0); seen < served; seen = Atomics.load(probe, 0)) {
    if (performance.now() > deadline) throw new Error(`the watchdog served ${seen} of ${served} chunks`);
    Atomics.wait(probe, 0, seen, 50);
  }
}

test("W1-T9361: every chunk of a long stall is attributed and profiled_ms covers them", async () => {
  // Four or more chunks of one stall; the FIRST holds the stall's longest frame. W1-T7746 kept the newest two.
  // Each chunk spans CHUNK_MS; V8's (idle) bookkeeping fills the rest and is no frame.
  const CHUNK_MS = 50;
  const IDLE = native("(idle)");
  const chunks = [
    chunk([{ stack: [TIMERS, TICK, at("firstChunkWork", "status.ts", 10)], ms: 40 }, { stack: [IDLE], ms: 10 }]),
    chunk([{ stack: [TIMERS, TICK, at("secondChunkWork", "status.ts", 20)], ms: 20 }, { stack: [IDLE], ms: 30 }]),
    chunk([{ stack: [TIMERS, TICK, at("thirdChunkWork", "status.ts", 30)], ms: 20 }, { stack: [IDLE], ms: 30 }]),
    chunk([{ stack: [TIMERS, TICK, at("lastChunkWork", "status.ts", 40)], ms: 5 }, { stack: [IDLE], ms: 45 }]),
  ];
  const probe = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const rows: Row[] = [];
  const profiler = startLoopStallProfiler({ spawn: (source, workerData) =>
    new Worker(`${FAKE_INSPECTOR}${source}`, { eval: true, workerData: { ...workerData, probe: probe.buffer, chunks } }) });
  try {
    profiler.observe({ lagMs: 1, intervalMs: 250 }, (step, extra) => rows.push({ step, ...extra }));
    assert.equal(await profiler.ready(), true);
    await sleep(100);
    holdTheLoopUntil(probe, 3); // three rotations; the stall's end stops a fourth chunk or later
    const row = await waitFor(() => rows.find((r) => r.step === "daemon.loop_stall_profile"));
    const served = Atomics.load(probe, 0);
    assert.ok(served >= 4, `served ${served}`);
    assert.equal(row.chunks, served);
    assert.equal(row.profiled_ms, served * CHUNK_MS, "profiled_ms is every folded chunk's span");
    const frames = row.top_frames as Frame[];
    assert.equal(frames[0]?.function, "firstChunkWork", JSON.stringify(frames));
    assert.equal(frames[0]?.self_ms, 40);
    assert.equal(frames[0]?.caller?.function, "tick");
    for (const name of ["secondChunkWork", "thirdChunkWork", "lastChunkWork"]) {
      assert.ok(frames.some((frame) => frame.function === name), `${name} in ${JSON.stringify(frames)}`);
    }
    // Before profiling began the loop had been still for a whole bound: that time is said, not hidden.
    assert.ok(Number(row.unprofiled_ms) >= Number(row.bound_ms), `unprofiled ${row.unprofiled_ms} bound ${row.bound_ms}`);
    assert.equal(row.unattributed_ms, Math.max(0, Number(row.lag_ms) - Number(row.sync_spawn_ms)));
    assert.deepEqual((row.top_inclusive as Ref[])[0], { ...ref(TICK), total_ms: 80 + 5 * (served - 3) });
    assert.equal((row.top_callers as Frame[])[0]?.function, "firstChunkWork");
    assert.deepEqual(row.sync_spawn_callers, []);
    assert.equal(row.sync_spawn_profiled_ms, 0);
    assert.equal(rows.filter((r) => r.step === "daemon.loop_stall_profile_failed").length, 0);
  } finally {
    profiler.stop();
  }
});

// THE LIVE PROFILING TEST COMES LAST: it enables V8's Profiler domain, whose session resets this process's precise
// coverage when it disconnects (v8.takeCoverage() first keeps what was measured), so a test after it reads uncovered.

/** The busy function under test: the stall's JS part, long enough for the watchdog to start the profiler. */
function busyLoopPastTheBound(): number {
  let x = 0;
  for (let i = 0; i < 2e5; i++) x += (i * 31) % 7;
  return x;
}

function stallTheLoop(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) Array.from({ length: 50 }, busyLoopPastTheBound);
}

/** The named JS caller of a synchronous child, as plan-pr-emitter's runInTree is in production. */
function blockOnAChild(): void {
  childProcess.execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 700)"]);
}

test("W1-T9361: a live sync child is profiled under its JS caller beside the meter's sync_spawn_ms", async () => {
  const rows: Row[] = [];
  const telemetry = startReadPlaneTelemetry(); // its meter wraps execFileSync: the production stack shape
  try {
    telemetry.sample.observeLoopLag({ lagMs: 1, intervalMs: 250 }, (step, extra) => rows.push({ step, ...extra }));
    assert.equal(await telemetry.stallProfiler.ready(), true);
    await sleep(250);
    // The JS part outlasts the bound, so the profiler is running before the child starts: an inspector command
    // waits while the main thread is inside a native call, but the sampler does not.
    stallTheLoop(900);
    blockOnAChild();
    const row = await waitFor(() => rows.find((r) => r.step === "daemon.loop_stall_profile"));
    const spawned = (row.top_frames as Frame[]).find((frame) => frame.function === "spawn");
    assert.ok(spawned, JSON.stringify(row.top_frames));
    assert.equal(spawned.caller?.function, "blockOnAChild");
    assert.match(spawned.caller!.url, /a-stall-profile-covers-the-whole-stall-and-names-callers\.test\.ts/);
    assert.equal(spawned.via, "execFileSync");
    const callers = row.sync_spawn_callers as Frame[];
    assert.equal(callers[0]?.function, "blockOnAChild");
    const profiledMs = Number(row.sync_spawn_profiled_ms);
    assert.ok(profiledMs >= 300, `sync_spawn_profiled_ms ${profiledMs}`);
    assert.ok(profiledMs <= Number(row.sync_spawn_ms) + 50, `profiled ${profiledMs} vs metered ${row.sync_spawn_ms}`);
    assert.ok(Number(row.profiled_ms) >= profiledMs);
    assert.ok((row.top_inclusive as Ref[]).some((frame) => frame.function === "blockOnAChild"));
  } finally {
    v8.takeCoverage();
    telemetry.stop();
  }
});
