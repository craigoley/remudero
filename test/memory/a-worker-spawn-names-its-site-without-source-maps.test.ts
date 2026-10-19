import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HeapInfo } from "node:v8";
import { Worker } from "node:worker_threads";
import { fixedClock } from "../../src/lib/clock.js";
import {
  askNestedThreadHeaps, readWorkerHeaps, spawnSite, trackWorkerThreads,
  THREAD_HEAPS_ANSWER, THREAD_HEAPS_REQUEST, WORKER_HEAP_PREFIX,
  type WorkerHeapReading, type WorkerThread,
} from "../../src/lib/worker-heaps.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKER_HEAPS = pathToFileURL(join(REPO_ROOT, "src/lib/worker-heaps.ts")).href;
const READ_PLANE = pathToFileURL(join(REPO_ROOT, "src/lib/read-plane.ts")).href;
const EMPTY_WORKER = 'new Worker("require(\'node:worker_threads\').parentPort.on(\'message\', () => {});", { eval: true, execArgv: [] })';

// These are functional tests, not a heap benchmark. All children, fixtures, channels and workers
// belong to this file. The first two tests do not import the proposed shared helper: running just
// their literal titles on the mapped-worker baseline must fail on behavior, never a missing module.
// Helper tests below deliberately fail (rather than skip) if the extraction is absent or broken.
function mappedModule(source: string, original: string): string {
  // First generated line -> original line 101, each following line -> the next original line.
  const mappings = source.split("\n").map((_line, index) => index === 0 ? "AAoGA" : "AACA").join(";");
  const map = { version: 3, sources: [original], names: [], mappings };
  return `${source}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
}

const METER = `
import { createRequire } from "node:module";
const internal = createRequire(import.meta.url)("internal/source_map/source_map");
const Original = internal.SourceMap;
const parsed = [];
globalThis.t9821Parsed = parsed;
internal.SourceMap = class extends Original {
  constructor(payload, options) { super(payload, options); parsed.push(...payload.sources); }
};
`;

function runChild<T>(driver: string, files: Record<string, string> = {}): T {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9821-"));
  try {
    writeFileSync(join(dir, "driver.mjs"), driver);
    writeFileSync(join(dir, "meter.mjs"), METER);
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
    // Fixture coverage must not enter the retained parent coverage session (W1-T2732). Pin the
    // child's loaders here, so an inherited NODE_OPTIONS cannot initialize maps before the meter.
    const env = { ...process.env, NODE_V8_COVERAGE: undefined, NODE_OPTIONS: undefined };
    const output = execFileSync(process.execPath, [
      "--expose-internals", "--enable-source-maps",
      "--import", pathToFileURL(join(dir, "meter.mjs")).href, "--import", "tsx",
      join(dir, "driver.mjs"), WORKER_HEAPS, READ_PLANE,
    ], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000 });
    return JSON.parse(output.trim()) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T9821: a tracked worker spawn parses no source map", () => {
  const result = runChild<{
    sourceMapsEnabled: boolean; kinds: string[]; identity: boolean; parsedBySpawn: string[];
    parsedByControl: string[]; controlStack: string;
  }>(`
const parsed = globalThis.t9821Parsed;
const { trackWorkerThreads } = await import(process.argv[2]);
const mapped = await import(new URL("mapped-worker.mjs", import.meta.url));
const book = trackWorkerThreads();
let worker;
let result;
try {
  const before = parsed.length;
  worker = mapped.spawnMappedWorker();
  const live = book.live();
  const parsedBySpawn = parsed.slice(before);
  const controlStack = mapped.formatMappedStack();
  result = { sourceMapsEnabled: process.sourceMapsEnabled, kinds: live.map(item => item.kind),
    identity: live.length === 1 && live[0].thread === worker, parsedBySpawn,
    parsedByControl: parsed.slice(before + parsedBySpawn.length), controlStack };
} finally {
  book.stop();
  if (worker) await worker.terminate();
}
console.log(JSON.stringify(result));
`, { "mapped-worker.mjs": mappedModule([
    'import { Worker } from "node:worker_threads";',
    `export function spawnMappedWorker() { return ${EMPTY_WORKER}; }`,
    'export function formatMappedStack() { return new Error().stack; }',
  ].join("\n"), "mapped-worker.ts") });
  assert.equal(result.sourceMapsEnabled, true);
  // Check both controls before the zero: the meter sees actual construction, and this same
  // mapped module formats a genuinely mapped stack after the measured real worker spawn.
  assert.match(result.controlStack, /mapped-worker\.ts:103:/);
  assert.ok(result.parsedBySpawn.concat(result.parsedByControl).some(source => source.endsWith("mapped-worker.ts")),
    "positive control: Node constructed the spawning module's SourceMap");
  assert.deepEqual(result.parsedBySpawn, [], "tracking the real Worker parses no module's map");
  assert.ok(result.parsedByControl.some(source => source.endsWith("mapped-worker.ts")),
    "the later formatted stack, not tracking, must cause the first parse");
  assert.equal(result.identity, true);
  assert.deepEqual(result.kinds, ["mapped-worker:Module.spawnMappedWorker"]);
});

test("W1-T9821: the spawn site still names its module and function", () => {
  const result = runChild<{
    rows: Array<{ scenario: string; kind: string; raw: string; legacy: string; frames: string[]; identity: boolean }>;
    missing: string; builtin: string; excluded: string; emptyAfterExit: boolean;
  }>(`
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
const { trackWorkerThreads, spawnSite } = await import(process.argv[2]);
const channel = diagnosticsChannel.channel("worker_threads");
const observations = [];
// An independent oracle observes the same real spawn. String(CallSite) is V8's raw function
// clause (including alias/new/async/eval), while the second capture is the former mapped path.
// This observer is intentionally only in the naming child, never the map-meter child.
function observe() {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  let frames;
  try {
    Error.prepareStackTrace = (_error, sites) => sites;
    Error.stackTraceLimit = 50;
    const site = {};
    Error.captureStackTrace(site, observe);
    frames = site.stack.map(String);
  } finally { Error.prepareStackTrace = prepare; Error.stackTraceLimit = limit; }
  const old = {};
  Error.captureStackTrace(old, observe);
  observations.push({ raw: spawnSite("Error\\n" + frames.map(frame => "    at " + frame).join("\\n")),
    legacy: spawnSite(old.stack), frames });
}
channel.subscribe(observe);
const book = trackWorkerThreads();
const workers = [];
const rows = [];
async function record(scenario, worker) {
  workers.push(worker);
  const tracked = book.live().find(item => item.thread === worker);
  assert.ok(tracked, scenario + ": the worker must not disappear");
  const observation = observations.shift();
  assert.ok(observation, scenario + ": independent capture saw the channel");
  rows.push({ scenario, kind: tracked.kind, identity: tracked.thread === worker, ...observation });
  await worker.terminate();
}
let result;
try {
  const named = await import(new URL("mapped-worker.mjs", import.meta.url));
  await record("named", named.spawnMappedWorker());
  const module = await import(new URL("module-worker.mjs", import.meta.url));
  await record("unmapped-top-level", module.worker);
  const bundle = await import(new URL("worker-bundle.mjs", import.meta.url));
  await record("bundle-named", bundle.spawnFromBundle());
  await record("bundle-method", new bundle.WorkerOwner().start());
  const top = await import(new URL("anonymous-worker.mjs", import.meta.url));
  await record("mapped-top-level", top.worker);
  const callback = await import(new URL("callback-worker.mjs", import.meta.url));
  await record("mapped-callback", callback.spawnCallback());
  const labels = await import(new URL("runtime-labels.mjs", import.meta.url));
  await record("alias", labels.aliasOwner.alias());
  await record("receiver", new labels.Receiver().method());
  await record("constructor", new labels.Owner().worker);
  await record("async", await labels.spawnAsync());
  await record("eval", labels.spawnEval());
  const remapped = await import(new URL("runtime-remapped.mjs", import.meta.url));
  await record("original-module-remapping", remapped.spawnRemapped());
  result = { rows, missing: spawnSite(undefined),
    builtin: spawnSite("Error\\n    at new Worker (node:internal/worker:297:28)"),
    excluded: spawnSite("Error\\n    at onSpawn (file:///abs/worker-heaps.ts:1:1)\\n    at startWorker (file:///abs/child-entry-argv.ts:2:1)"),
    emptyAfterExit: book.live().length === 0 };
} finally {
  book.stop();
  channel.unsubscribe(observe);
  await Promise.all(workers.map(worker => worker.terminate()));
}
console.log(JSON.stringify(result));
`, {
    "mapped-worker.mjs": mappedModule([
      'import { Worker } from "node:worker_threads";',
      `export function spawnMappedWorker() { return ${EMPTY_WORKER}; }`,
    ].join("\n"), "mapped-worker.ts"),
    "module-worker.mjs": `import { Worker } from "node:worker_threads";\nexport const worker = ${EMPTY_WORKER};`,
    "worker-bundle.mjs": [
      'import { Worker } from "node:worker_threads";',
      '// src/lib/worker-heaps.ts',
      'function onSpawn() { return startWorker(); }',
      '// src/lib/child-entry-argv.ts',
      `function startWorker() { return ${EMPTY_WORKER}; }`,
      '// src/lib/bundle-owner.ts',
      'export function spawnFromBundle() { return onSpawn(); }',
      'export class WorkerOwner { start() { return onSpawn(); } }',
    ].join("\n"),
    "anonymous-worker.mjs": mappedModule(`import { Worker } from "node:worker_threads";\nexport const worker = ${EMPTY_WORKER};`, "anonymous-worker.ts"),
    "callback-worker.mjs": mappedModule([
      'import { Worker } from "node:worker_threads";',
      `export function spawnCallback() { return [0].map(() => ${EMPTY_WORKER})[0]; }`,
    ].join("\n"), "callback-worker.ts"),
    "child-entry-argv.mjs": `import { Worker } from "node:worker_threads";\nexport async function asyncHelper() { await Promise.resolve(); return ${EMPTY_WORKER}; }`,
    "runtime-labels.mjs": mappedModule([
      'import { Worker } from "node:worker_threads";',
      'import { asyncHelper } from "./child-entry-argv.mjs";',
      `export const aliasOwner = { alias: function actualName() { return ${EMPTY_WORKER}; } };`,
      `export class Receiver { method() { return ${EMPTY_WORKER}; } }`,
      `export class Owner { constructor() { this.worker = ${EMPTY_WORKER}; } }`,
      'export async function spawnAsync() { return await asyncHelper(); }',
      `export function spawnEval() { return eval(${JSON.stringify(EMPTY_WORKER)}); }`,
    ].join("\n"), "runtime-labels.ts"),
    "runtime-remapped.mjs": mappedModule(`import { Worker } from "node:worker_threads";\nexport function spawnRemapped() { return ${EMPTY_WORKER}; }`, "original-only.ts"),
  });
  const rows = new Map(result.rows.map(row => [row.scenario, row]));
  assert.equal(rows.size, 12, "every enumerated runtime shape was exercised");
  // The receipt enumerates actual old/new spellings, including V8's version-sensitive eval
  // clause, rather than pretending all source-mapped labels equal their runtime labels.
  console.log(`W1-T9821 old/mapped versus new/runtime labels: ${JSON.stringify(result.rows)}`);
  for (const row of result.rows) {
    assert.equal(row.identity, true, row.scenario);
    assert.equal(typeof row.kind, "string", "only a primitive label is retained");
    assert.equal(row.kind, row.raw, `${row.scenario}: use the independently captured runtime function clause`);
    assert.notEqual(row.kind, "unknown", `${row.scenario}: the real spawn has an eligible site`);
  }
  for (const [scenario, expected] of [
    ["named", "mapped-worker:Module.spawnMappedWorker"],
    ["unmapped-top-level", "module-worker:<module>"],
    ["bundle-named", "bundle-owner:Module.spawnFromBundle"],
    ["bundle-method", "bundle-owner:WorkerOwner.start"],
    ["receiver", "runtime-labels:Receiver.method"],
  ]) {
    assert.equal(rows.get(scenario)?.kind, expected);
    assert.equal(rows.get(scenario)?.legacy, expected, `${scenario}: invariant old/new label`);
  }
  for (const [scenario, module] of [["mapped-top-level", "anonymous-worker"], ["mapped-callback", "callback-worker"]]) {
    assert.equal(rows.get(scenario)?.legacy, `${module}:<anonymous>`);
    assert.equal(rows.get(scenario)?.kind, `${module}:<module>`, "the explicitly reviewed nameless canonical spelling");
  }
  assert.equal(rows.get("alias")?.kind, "runtime-labels:Object.actualName [as alias]");
  assert.equal(rows.get("alias")?.legacy, "runtime-labels:Object.actualName");
  assert.equal(rows.get("constructor")?.kind, "runtime-labels:new Owner");
  assert.match(rows.get("constructor")?.legacy ?? "", /:new Owner$/);
  assert.equal(rows.get("async")?.kind, "runtime-labels:async Module.spawnAsync");
  assert.match(rows.get("async")?.legacy ?? "", /:async Module\.spawnAsync$/);
  assert.ok(rows.get("eval")?.frames.some(frame => frame.includes("eval at spawnEval")), "control: a real eval frame was captured");
  assert.equal(rows.get("original-module-remapping")?.legacy, "original-only:Module.spawnRemapped");
  assert.equal(rows.get("original-module-remapping")?.kind, "runtime-remapped:Module.spawnRemapped");
  assert.equal(result.missing, "unknown");
  assert.equal(result.builtin, "unknown");
  assert.equal(result.excluded, "unknown");
  assert.equal(result.emptyAfterExit, true);
});

test("W1-T9821: worker frame budgets preserve native boundaries including invalid runtime limits", () => {
  const result = runChild<{ rows: Array<{ limit: string; depth: number; expected: string; actual: string; count: number; restored: boolean }> }>(`
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
const { trackWorkerThreads, spawnSite } = await import(process.argv[2]);
const { makeChannel, publishDeep } = await import(new URL("child-entry-argv.mjs", import.meta.url));
const channel = makeChannel();
let expected;
// Stand in for the old onSpawn frame, at the same call depth and native ambient budget.
// Remove this one frame after capture, just as spawnSite skips worker-heaps' onSpawn.
function nativeCapture() {
  const prepare = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, sites) => sites;
    const site = {};
    Error.captureStackTrace(site);
    const sites = Array.isArray(site.stack) ? site.stack : [];
    expected = spawnSite("Error\\n" + sites.slice(1).map(frame => "    at " + String(frame)).join("\\n"));
  } finally { Error.prepareStackTrace = prepare; }
}
channel.subscribe(nativeCapture);
const book = trackWorkerThreads(channel);
const ambient = Error.stackTraceLimit;
const prepare = Error.prepareStackTrace;
const rows = [];
let id = 0;
try {
  for (const value of [undefined, null, "7", NaN, -Infinity, -1, 0, 0.8, 1, 1.8, 2, 2.8, 7, ambient, 51, Infinity]) {
    for (const depth of [0, 12, 60]) {
      Error.stackTraceLimit = value;
      const worker = Object.assign(new EventEmitter(), { threadId: ++id });
      publishDeep(channel, worker, depth);
      const live = book.live();
      rows.push({ limit: String(value), depth, expected, actual: live[0]?.kind, count: live.length,
        restored: Object.is(Error.stackTraceLimit, value) && Error.prepareStackTrace === prepare });
      assert.equal(live[0]?.thread, worker);
      worker.threadId = -1;
      worker.emit("exit");
      assert.equal(book.live().length, 0);
    }
  }
} finally { Error.stackTraceLimit = ambient; Error.prepareStackTrace = prepare; book.stop(); channel.unsubscribe(nativeCapture); }
console.log(JSON.stringify({ rows }));
`, {
    "child-entry-argv.mjs": [
      'export function makeChannel() {',
      '  const subscribers = new Set();',
      '  return { subscribe(fn) { subscribers.add(fn); }, unsubscribe(fn) { subscribers.delete(fn); },',
      '    publish(message) { for (const fn of subscribers) fn(message); } };',
      '}',
      'export function publishDeep(channel, worker, depth) {',
      '  if (depth > 0) return publishDeep(channel, worker, depth - 1);',
      '  channel.publish({ worker });',
      '}',
    ].join("\n"),
  });
  for (const row of result.rows) {
    const context = `${row.limit}, excluded depth ${row.depth}`;
    assert.equal(row.count, 1, `${context}: unsupported capture must still book the worker`);
    assert.equal(row.actual, row.expected, `${context}: native frame budget and eligible order`);
    assert.equal(row.restored, true, `${context}: preserve exact ambient values`);
    if (["undefined", "null", "7", "NaN", "-Infinity", "-1", "0", "0.8", "1", "1.8"].includes(row.limit)) {
      assert.equal(row.actual, "unknown", context);
    }
  }
  assert.ok(result.rows.some(row => row.limit === "Infinity" && row.depth === 60 && row.actual !== "unknown"),
    "positive control: the deep eligible caller exists, with no invented global cap");
  assert.ok(result.rows.some(row => row.limit === "51" && row.depth === 60 && row.actual === "unknown"),
    "a worker must not acquire extra eligible slots beyond its ambient budget");
});

test("W1-T9821: the shared helper preserves the read-plane's 49 returned frames", async () => {
  const { rawCallSites } = await import("../../src/lib/raw-call-sites.js");
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  function deep(depth: number, requested?: number): NodeJS.CallSite[] {
    return depth > 0 ? deep(depth - 1, requested) : rawCallSites(requested);
  }
  try {
    Error.stackTraceLimit = 1;
    assert.equal(deep(70).length, 49, "undefined intentionally selects helper default 50, then removes its own frame");
    for (const [requested, returned] of [[0, 0], [0.8, 0], [1, 0], [1.8, 0], [2, 1], [2.8, 1], [7, 6], [50, 49], [NaN, 0], [-1, 0]]) {
      const sites = deep(70, requested);
      assert.equal(sites.length, returned, String(requested));
      if (sites.length) assert.equal(sites[0].getFunctionName(), "deep", "no shared-helper frame survives");
      assert.equal(Error.stackTraceLimit, 1);
      assert.equal(Error.prepareStackTrace, prepare);
    }
    assert.ok(deep(70, Infinity).length > 70, "Infinity inspects only this finite fixture stack");
  } finally { Error.prepareStackTrace = prepare; Error.stackTraceLimit = limit; }

  const result = runChild<{ inside: { caller?: string; leaf?: string; callerIsLeaf?: true }; outside: { caller?: string; leaf?: string; callerIsLeaf?: true } }>(`
const { callerFrame } = await import(process.argv[3]);
const { readOwner } = await import(new URL("budget-owner.mjs", import.meta.url));
const limit = Error.stackTraceLimit;
let result;
try {
  Error.stackTraceLimit = 1;
  result = { inside: readOwner(46, callerFrame), outside: readOwner(47, callerFrame) };
} finally { Error.stackTraceLimit = limit; }
console.log(JSON.stringify(result));
`, {
    "worktree-git.mjs": 'export function leaf(depth, read) { return depth > 0 ? leaf(depth - 1, read) : read(); }',
    "budget-owner.mjs": 'import { leaf } from "./worktree-git.mjs";\nexport function readOwner(depth, read) { return leaf(depth, read); }',
  });
  assert.match(result.inside.caller ?? "", /^at readOwner \(.*budget-owner\.mjs:2:\d+\)$/);
  assert.equal(result.inside.leaf, "leaf");
  assert.equal(result.inside.callerIsLeaf, undefined);
  assert.equal(result.outside.callerIsLeaf, true, "the next caller lies beyond exactly 49 returned slots");
  assert.equal(result.outside.leaf, "leaf");
  assert.match(result.outside.caller ?? "", /^at leaf \(.*worktree-git\.mjs:1:\d+\)$/);
});

test("W1-T9821: raw call sites restore the formatter and limit after success and capture failures", async () => {
  const { rawCallSites } = await import("../../src/lib/raw-call-sites.js");
  const NativeError = Error;
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  const sentinel = (): string => "the caller's formatter";
  const failure = new Error("offline capture failure");
  try {
    Error.prepareStackTrace = sentinel;
    Error.stackTraceLimit = 7;
    const sites = rawCallSites();
    assert.ok(sites.length > 0);
    assert.equal(sites[0].getFileName(), import.meta.url);
    assert.equal(Error.prepareStackTrace, sentinel);
    assert.equal(Error.stackTraceLimit, 7);
    for (const construct of [
      () => { throw failure; },
      () => ({ get stack() { throw failure; } }),
    ]) {
      let caught: unknown;
      try {
        globalThis.Error = new Proxy(NativeError, { construct });
        rawCallSites();
      } catch (error) { caught = error; }
      finally { globalThis.Error = NativeError; }
      assert.equal(caught, failure);
      assert.equal(Error.prepareStackTrace, sentinel, "capture failure restores the exact formatter");
      assert.equal(Error.stackTraceLimit, 7, "capture failure restores the caller's limit");
    }
    Reflect.set(Error, "prepareStackTrace", undefined);
    rawCallSites();
    assert.equal(Error.prepareStackTrace, undefined);
  } finally {
    globalThis.Error = NativeError;
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
});

test("W1-T9821: raw call sites restore the formatter when setting the limit fails", async () => {
  const { rawCallSites } = await import("../../src/lib/raw-call-sites.js");
  const NativeError = Error;
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  const sentinel = (): string => "the caller's formatter";
  const failure = new Error("offline limit setter failure");
  let reject = true;
  let caught: unknown;
  try {
    Error.prepareStackTrace = sentinel;
    Error.stackTraceLimit = 7;
    globalThis.Error = new Proxy(NativeError, {
      set(target, key, value) {
        // One failed assignment, followed by writable restoration. An arbitrary externally
        // hostile setter that also rejects restoration cannot be promised recoverable.
        if (key === "stackTraceLimit" && reject) { reject = false; throw failure; }
        return Reflect.set(target, key, value);
      },
    });
    try { rawCallSites(); } catch (error) { caught = error; }
    finally { globalThis.Error = NativeError; }
    assert.equal(caught, failure);
    assert.equal(Error.prepareStackTrace, sentinel);
    assert.equal(Error.stackTraceLimit, 7);
  } finally {
    globalThis.Error = NativeError;
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
});

function fakeThread(threadId: number, read?: () => Promise<HeapInfo>): WorkerThread & EventEmitter {
  return Object.assign(new EventEmitter(), { threadId, ...(read ? { getHeapStatistics: read } : {}) }) as WorkerThread & EventEmitter;
}

function heap(total_heap_size: number, used_heap_size: number | undefined, external_memory: number): HeapInfo {
  return { total_heap_size, used_heap_size, external_memory } as HeapInfo;
}

function publishSameSite(channel: diagnosticsChannel.Channel, worker: WorkerThread): void { channel.publish({ worker }); }
function publishOtherSite(channel: diagnosticsChannel.Channel, worker: WorkerThread): void { channel.publish({ worker }); }

test("W1-T9821: labels retain distinct thread parts, grouping arithmetic, holds and unsized state", async () => {
  const channel = diagnosticsChannel.channel(Symbol("W1-T9821-accounting"));
  const book = trackWorkerThreads(channel);
  const first = fakeThread(982101, async () => heap(1000, 600, 100));
  const second = fakeThread(982102, async () => heap(2000, 900, 200));
  const other = fakeThread(982103, async () => heap(3000, undefined, 300));
  const unsized = fakeThread(982104);
  try {
    publishSameSite(channel, first);
    publishSameSite(channel, second);
    publishOtherSite(channel, other);
    publishOtherSite(channel, unsized);
    channel.publish({});
    const live = book.live();
    assert.deepEqual(live.map(item => item.thread), [first, second, other, unsized]);
    assert.equal(live[0].kind, live[1].kind, "the existing same-site bucket is preserved");
    assert.equal(live[2].kind, live[3].kind);
    assert.notEqual(live[0].kind, live[2].kind, "distinct named sites must not acquire a new collision");
    assert.ok(live[0].kind.endsWith(":publishSameSite"));
    assert.ok(live[2].kind.endsWith(":publishOtherSite"));
    assert.deepEqual(Object.keys(live[0]).sort(), ["kind", "thread"], "no new DTO or retained call sites");
    const readings = await readWorkerHeaps(live, 100, id => ({
      holds: id === first.threadId ? {
        "board:one": { entries: 2, bytes: 250, unit: "rows", bytes_basis: "insertion-accounted-payload-not-exclusive-v8" },
        "board:unknown": { entries: 1, unsized: "payload cannot be sized", unit: "rows" },
      } : { "board:other": { entries: 1, bytes: 50, unit: "rows", bytes_basis: "serialized-payload-estimate-not-exclusive-v8" } },
      observedAt: id === first.threadId ? 900 : undefined,
    }), fixedClock(1000));
    assert.equal(readings.length, 2);
    const same = readings.find(item => item.name === `${WORKER_HEAP_PREFIX}${live[0].kind}`)!;
    const separate = readings.find(item => item.name === `${WORKER_HEAP_PREFIX}${live[2].kind}`)!;
    assert.equal(same.entries, 2);
    assert.equal(same.bytes, 3300);
    assert.equal(same.used_bytes, 1800);
    assert.equal(same.error, undefined);
    assert.deepEqual(Object.keys(same.parts ?? {}).sort(), ["thread-982101", "thread-982102"]);
    assert.deepEqual(same.parts?.["thread-982101"], {
      entries: 1, bytes: 1100, used_bytes: 700,
      holds: {
        "board:one": { entries: 2, bytes: 250, unit: "rows", bytes_basis: "insertion-accounted-payload-not-exclusive-v8" },
        "board:unknown": { entries: 1, unsized: "payload cannot be sized", unit: "rows" },
      },
      holds_age_ms: 100, unattributed_used_bytes: 450,
      unattributed_used_basis: "used-heap-less-named-payload-estimates-not-exclusive-v8",
      unattributed_used_reason: "partial attribution: named unsized holders remain; payload estimates may overlap",
    });
    const secondPart = same.parts!["thread-982102"];
    assert.equal(secondPart.bytes, 2200);
    assert.equal(secondPart.used_bytes, 1100);
    assert.equal(secondPart.unattributed_used_bytes, 1050);
    assert.equal(secondPart.holds_age_reason, "holder report time unavailable or ahead of sample clock");
    assert.equal(separate.entries, 2);
    assert.equal(separate.bytes, 3300);
    assert.equal(Object.hasOwn(separate, "used_bytes"), false);
    assert.match(separate.error ?? "", /thread 982104 unsized: this runtime has no worker\.getHeapStatistics\(\)/);
    for (const id of [982103, 982104]) {
      const part = separate.parts![`thread-${id}`];
      assert.equal(Object.hasOwn(part, "used_bytes"), false);
      assert.equal(part.unattributed_used_reason, "used heap unavailable; residual not measured");
      assert.equal(Object.hasOwn(part, "unattributed_used_bytes"), false);
    }
    assert.equal(separate.parts!["thread-982103"].bytes, 3300);
    assert.equal(separate.parts!["thread-982104"].bytes, 0);
    assert.equal(readings.reduce((sum, item) => sum + item.entries, 0), 4);
    assert.equal(readings.reduce((sum, item) => sum + item.bytes, 0), 6600);
    first.threadId = -1;
    first.emit("exit");
    assert.deepEqual(book.live().map(item => item.thread), [second, other, unsized], "delete the original id, not the exited -1 id");
    book.stop();
    assert.equal(channel.hasSubscribers, false, "stop unsubscribes only this owned channel");
    publishSameSite(channel, fakeThread(982105));
    assert.equal(book.live().length, 3, "stop does not clear existing entries or book new ones");
    for (const thread of [second, other, unsized]) { thread.threadId = -1; thread.emit("exit"); }
    assert.deepEqual(book.live(), []);
  } finally { book.stop(); }
});

test("W1-T9821: two live real workers remain two separately sized parts until exit and stop", async () => {
  const book = trackWorkerThreads();
  const workers: Worker[] = [];
  function spawnEmpty(): Worker {
    const worker = new Worker("require('node:worker_threads').parentPort.on('message', () => {});", { eval: true, execArgv: [] });
    workers.push(worker);
    return worker;
  }
  try {
    const first = spawnEmpty();
    const firstOnline = once(first, "online");
    const second = spawnEmpty();
    await Promise.all([firstOnline, once(second, "online")]);
    const live = book.live();
    assert.equal(live.length, 2);
    assert.equal(live[0].thread, first);
    assert.equal(live[1].thread, second);
    assert.notEqual(first.threadId, second.threadId);
    assert.equal(live[0].kind, live[1].kind);
    const [reading, ...extra] = await readWorkerHeaps(live);
    assert.deepEqual(extra, []);
    assert.equal(reading.entries, 2);
    assert.equal(reading.error, undefined);
    assert.equal(reading.name, `${WORKER_HEAP_PREFIX}${live[0].kind}`);
    assert.deepEqual(Object.keys(reading.parts ?? {}).sort(), [`thread-${first.threadId}`, `thread-${second.threadId}`].sort());
    const parts = Object.values(reading.parts!);
    assert.ok(parts.every(part => part.entries === 1 && part.bytes > 0 && (part.used_bytes ?? 0) > 0));
    assert.equal(reading.bytes, parts.reduce((sum, part) => sum + part.bytes, 0));
    assert.equal(reading.used_bytes, parts.reduce((sum, part) => sum + part.used_bytes!, 0));
    await first.terminate();
    assert.deepEqual(book.live().map(item => item.thread), [second]);
    book.stop();
    const after = spawnEmpty();
    assert.deepEqual(book.live().map(item => item.thread), [second], "stopped subscription sees no later real worker");
    await Promise.all([second.terminate(), after.terminate()]);
    assert.deepEqual(book.live(), []);
  } finally {
    book.stop();
    await Promise.all(workers.map(worker => worker.terminate()));
  }
});

test("W1-T9821: pending, rejected and nested heap reads keep their existing accounting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const channel = diagnosticsChannel.channel(Symbol("W1-T9821-pending-nested"));
  const book = trackWorkerThreads(channel);
  let settle!: (value: HeapInfo) => void;
  let calls = 0;
  const pending = fakeThread(982111, () => { calls++; return new Promise<HeapInfo>(resolve => { settle = resolve; }); });
  const failed = fakeThread(982112, async () => { throw new Error("offline native rejection"); });
  const parent = Object.assign(fakeThread(982113, async () => heap(1000, 500, 100)), {
    postMessage(message: { type: string; id: number }): void {
      assert.equal(message.type, THREAD_HEAPS_REQUEST);
      requests.push(message.id);
    },
  });
  const requests: number[] = [];
  const answer = askNestedThreadHeaps(parent);
  try {
    publishSameSite(channel, pending);
    publishSameSite(channel, failed);
    publishOtherSite(channel, parent);
    const live = book.live();
    const first = readWorkerHeaps(live, 20);
    // Let the immediately rejected native request settle before advancing only the deadline
    // clock. Otherwise the mock timer beats even an already-rejected promise's microtasks.
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(20);
    const timedOut = await first;
    const sameName = `${WORKER_HEAP_PREFIX}${live[0].kind}`;
    const same = timedOut.find(item => item.name === sameName)!;
    assert.equal(same.entries, 2);
    assert.equal(same.bytes, 0);
    assert.equal(Object.hasOwn(same, "used_bytes"), false);
    assert.deepEqual(same.parts, { "thread-982111": { entries: 1, bytes: 0 }, "thread-982112": { entries: 1, bytes: 0 } });
    assert.match(same.error ?? "", /thread 982111 unsized: no heap statistics within 20ms/);
    assert.match(same.error ?? "", /thread 982112 unsized: offline native rejection/);
    const inside = timedOut.find(item => item.name === `${WORKER_HEAP_PREFIX}inside:${live[2].kind}`)!;
    assert.equal(inside.entries, 0);
    assert.equal(inside.bytes, 0);
    assert.equal(Object.hasOwn(inside, "used_bytes"), false);
    assert.match(inside.error ?? "", /thread 982113's own threads unsized: no answer within 20ms/);

    const second = readWorkerHeaps(live, 20);
    assert.equal(calls, 1, "a timed-out native request is not duplicated by the next sample");
    assert.equal(answer({ type: "unrelated" }), false);
    assert.equal(answer({ type: THREAD_HEAPS_ANSWER }), false);
    const child: WorkerHeapReading = {
      name: `${WORKER_HEAP_PREFIX}${live[2].kind}`, kind: "worker-heap", entries: 1, bytes: 80, used_bytes: 60,
      parts: { "thread-982114": { entries: 1, bytes: 80, used_bytes: 60 } },
    };
    answer({ type: THREAD_HEAPS_ANSWER, id: requests[0], readings: [{ ...child, bytes: 9999 }] });
    answer({ type: THREAD_HEAPS_ANSWER, id: requests[1], readings: [child] });
    const next = await second;
    assert.match(next.find(item => item.name === sameName)?.error ?? "", /thread 982111 unsized: heap statistics request still pending/);
    const parentGroup = next.find(item => item.name === child.name)!;
    assert.equal(parentGroup.entries, 2);
    assert.equal(parentGroup.bytes, 1180);
    assert.equal(parentGroup.used_bytes, 660);
    assert.deepEqual(parentGroup.parts, {
      "thread-982113": { entries: 1, bytes: 1100, used_bytes: 600 },
      "thread-982114": { entries: 1, bytes: 80, used_bytes: 60 },
    });
    settle(heap(2000, 1000, 200));
    // The pending native request settles independently of its expired sample deadline.
    await new Promise<void>(resolve => setImmediate(resolve));
    pending.threadId = -1;
    pending.emit("exit");
    assert.deepEqual(book.live().map(item => item.thread), [failed, parent]);
    const exited = await readWorkerHeaps([{ kind: live[0].kind, thread: pending }], 20);
    assert.equal(exited[0].entries, 1);
    assert.equal(exited[0].bytes, 0);
    assert.equal(Object.hasOwn(exited[0], "used_bytes"), false);
    assert.match(exited[0].error ?? "", /worker exited/);
  } finally {
    settle?.(heap(2000, 1000, 200));
    book.stop();
    t.mock.timers.reset();
  }
});
