// test/serve-starts-its-workers-from-current-worker-bundles.test.ts — W1-T9370.
//
// Serve's main thread runs under tsx, and each worker it starts used to load its .ts module graph through tsx too:
// 82 MB used / 218 MB of heap per isolate on now-view.ts's graph, against 22 / 57 for a bundle without tsx.
// startWorker starts a tsx parent's worker from the tree's current worker bundle (W1-T8777) with tsx dropped from
// its execArgv, and from its .ts source on every doubt. These tests run a real fixture tree and real workers.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { execArgvWithoutTsx, setWorkerEntryLog, startWorker } from "#src/lib/child-entry-argv.js";

type StartWorkerOpts = NonNullable<Parameters<typeof startWorker>[2]>;
import { spawnSite } from "#src/lib/worker-heaps.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");
const HELPER = join(REPO_ROOT, "src", "lib", "child-entry-argv.ts");
const HEAPS = join(REPO_ROOT, "src", "lib", "worker-heaps.ts");
const WORKER = "src/lib/fixture-worker.ts";
interface BuildModule { buildChildEntries(opts: { root: string; entries: { name: string; source: string }[]; workers?: readonly string[] }): Promise<unknown> }
const build = async (root: string): Promise<void> => {
  await ((await import(pathToFileURL(SCRIPT).href)) as BuildModule).buildChildEntries({ root, entries: [], workers: [WORKER] });
};

/** A tree whose worker module starts itself through startWorker, as serve's worker modules do. */
function makeTree(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-serve-worker-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(join(root, WORKER), [
    'import { isMainThread, parentPort } from "node:worker_threads";',
    `import { runsBundled } from ${JSON.stringify(HELPER)};`,
    "if (!isMainThread) parentPort!.postMessage({ bundled: runsBundled(), execArgv: process.execArgv });",
  ].join("\n") + "\n");
  return root;
}
const selfUrl = (root: string): string => pathToFileURL(join(root, WORKER)).href;

/**
 * Starts the fixture worker from this tsx test process, as serve's main thread starts its own. The execArgv is given,
 * not inherited: this runner preloads test/setup/tmp-hygiene.ts, a TypeScript preload serve never has (case 6).
 */
function run(root: string, deps: StartWorkerOpts = {}, options: WorkerOptions = { execArgv: ["--import", "tsx"] }): Promise<{ bundled: boolean; execArgv: string[] }> {
  return new Promise((resolve, reject) => {
    const worker = startWorker(selfUrl(root), options, { storeRoot: false, ...deps });
    worker.once("message", (m) => { void worker.terminate(); resolve(m as { bundled: boolean; execArgv: string[] }); });
    worker.once("error", reject);
  });
}

test("W1-T9370: serve starts its workers from current worker bundles", async (t) => {
  assert.ok(process.execArgv.some((a) => /tsx/.test(a)) || /tsx/.test(process.env.NODE_OPTIONS ?? ""), "this test is a tsx parent");
  const rows: Array<Record<string, unknown>> = [];
  setWorkerEntryLog((step, extra) => void rows.push({ step, ...extra }));
  t.after(() => setWorkerEntryLog(undefined));

  // 1. A current bundle: the worker runs it, with no tsx loader in its execArgv; the decision is ledgered once.
  const current = makeTree(t);
  await build(current);
  const fromBundle = await run(current);
  assert.equal(fromBundle.bundled, true, "the worker runs its bundle");
  assert.ok(!fromBundle.execArgv.some((a) => /tsx/.test(a)), `no tsx in the worker: ${fromBundle.execArgv.join(" ")}`);
  assert.equal((await run(current)).bundled, true, "the next start reuses the decision");
  assert.deepEqual(rows, [{ step: "worker.entry_resolved", module: WORKER, kind: "bundle", reason: "source-hash-match" }]);

  // 2. The switch off: the .ts source, as before.
  assert.equal((await run(current, { env: { RMD_BUNDLED_WORKERS: "0" } })).bundled, false);

  // 3. A stale bundle: the .ts source, and why.
  const stale = makeTree(t);
  await build(stale);
  writeFileSync(join(stale, WORKER), "// edited after the build\n", { flag: "a" });
  assert.equal((await run(stale)).bundled, false);
  assert.equal(rows.at(-1)?.reason, "source-changed");

  // 4. A refused start (a flag a worker rejects): the .ts source, and the module stays on it.
  const refused = makeTree(t);
  await build(refused);
  let attempts = 0;
  const refuse: StartWorkerOpts["construct"] = (url, options) => {
    attempts++;
    if (String(url).endsWith(".mjs")) throw Object.assign(new Error("invalid execArgv"), { code: "ERR_WORKER_INVALID_EXEC_ARGV" });
    return startWorker(url, options, { override: url });
  };
  assert.equal((await run(refused, { construct: refuse })).bundled, false);
  assert.equal((await run(refused, { construct: refuse })).bundled, false);
  assert.equal(attempts, 3, "one refused bundle start, then the source each time");
  assert.match(String(rows.at(-1)?.reason), /^bundle-start-refused: invalid execArgv/);

  // 5. Serve's own flags: node refuses `--expose-gc` in a worker's execArgv, so the start drops what node names and
  //    retries once; the flag is in force for the whole process anyway.
  const serveFlags = makeTree(t);
  await build(serveFlags);
  const asServe = await run(serveFlags, {}, { execArgv: ["--expose-gc", "--import", "tsx"] });
  assert.equal(asServe.bundled, true, "serve's worker runs its bundle");
  assert.deepEqual(asServe.execArgv, [], "neither tsx nor the refused flag reaches the worker");
  assert.equal(rows.at(-1)?.kind, "bundle", "a dropped flag demotes nothing");

  // 6. A parent that preloads a TypeScript file: its workers keep their source, and why; the preload is never dropped.
  const preloads = makeTree(t);
  writeFileSync(join(preloads, "src", "preload.ts"), "export {};\n");
  await build(preloads);
  assert.equal((await run(preloads, {}, { execArgv: ["--import", "tsx", "--import", join(preloads, "src", "preload.ts")] })).bundled, false);
  assert.equal(rows.at(-1)?.reason, `parent-preloads-typescript: ${join(preloads, "src", "preload.ts").slice(-80)}`);
});

test("a bundle-started worker that exits before it speaks demotes its module; one that spoke keeps it", async (t) => {
  const root = makeTree(t);
  await build(root);
  const started: string[] = [];
  const fake = (speak: boolean): StartWorkerOpts["construct"] => (url) => {
    started.push(String(url).endsWith(".mjs") ? "bundle" : "source");
    const w = new EventEmitter() as unknown as Worker;
    setImmediate(() => { if (speak) w.emit("message", {}); w.emit("exit", 1); });
    return w;
  };
  const exit = (w: Worker): Promise<void> => new Promise((r) => w.once("exit", () => r()));
  await exit(startWorker(selfUrl(root), { execArgv: ["--import", "tsx"] }, { storeRoot: false, construct: fake(true) }));
  await exit(startWorker(selfUrl(root), { execArgv: ["--import", "tsx"] }, { storeRoot: false, construct: fake(false) }));
  await exit(startWorker(selfUrl(root), { execArgv: ["--import", "tsx"] }, { storeRoot: false, construct: fake(false) }));
  assert.deepEqual(started, ["bundle", "bundle", "source"], "a terminated lane that worked keeps its bundle; a silent crash does not");
});

test("only tsx's loader flags leave a bundled worker's execArgv", () => {
  assert.deepEqual(execArgvWithoutTsx(["--import", "tsx", "--max-old-space-size=4096"]), ["--max-old-space-size=4096"]);
  assert.deepEqual(execArgvWithoutTsx(["--import", "/app/node_modules/tsx/dist/loader.mjs", "--enable-source-maps"]), ["--enable-source-maps"]);
  assert.deepEqual(execArgvWithoutTsx(["--import=file:///app/node_modules/tsx/dist/esm/index.mjs", "--require", "tsx/cjs", "--import", "./x.mjs"]), ["--import", "./x.mjs"]);
  assert.deepEqual(execArgvWithoutTsx(["--loader", "tsx", "--trace-warnings"]), ["--trace-warnings"]);
  assert.deepEqual(execArgvWithoutTsx(["--import", "tsxlike", "--import", "my-tsx-helpers"]), ["--import", "tsxlike", "--import", "my-tsx-helpers"], "a name that merely contains tsx stays");
});

test("serve.memory still names a worker by the module that asked for it, not by startWorker", () => {
  const stack = [
    "Error",
    "    at new Worker (node:internal/worker:297:28)",
    "    at construct (file:///app/src/lib/child-entry-argv.ts:150:9)",
    "    at startWorker (file:///app/src/lib/child-entry-argv.ts:171:22)",
    "    at spawnHeavyViews (file:///app/src/lib/read-model-worker.ts:1802:21)",
  ].join("\n");
  assert.equal(spawnSite(stack), "read-model-worker:spawnHeavyViews");
});

/**
 * A tree whose worker spawns a lane thread from a function esbuild must rename: a sibling module holds a `spawn` too.
 * Bundled, every frame names the bundle's file, and the first is the tracker's own onSpawn closure (the live
 * `worker-lib-read-model-worker:onSpawn` holder); tsx-loaded, the frame named `fixture-worker:spawn`.
 */
function makeSpawningTree(t: { after: (fn: () => void) => void }): string {
  const root = makeTree(t);
  writeFileSync(join(root, "src", "lib", "fixture-sibling.ts"), "export function spawn(): string {\n  return \"sibling\";\n}\n");
  writeFileSync(join(root, WORKER), [
    'import { isMainThread, parentPort, workerData } from "node:worker_threads";',
    `import { runsBundled, startWorker } from ${JSON.stringify(HELPER)};`,
    `import { trackWorkerThreads } from ${JSON.stringify(HEAPS)};`,
    'import { spawn as sibling } from "./fixture-sibling.js";',
    "function spawn() {",
    "  return startWorker(import.meta.url, { workerData: { lane: true } });",
    "}",
    "if (!isMainThread && workerData?.lane) parentPort!.postMessage({ lane: true });",
    "else if (!isMainThread) {",
    "  const book = trackWorkerThreads();",
    "  const lane = spawn();",
    "  parentPort!.postMessage({ bundled: runsBundled(), sibling: sibling(), kinds: book.live().map((w) => w.kind) });",
    "  lane.once(\"message\", () => void lane.terminate());",
    "}",
  ].join("\n") + "\n");
  return root;
}

test("a bundled worker names the threads it spawns by their source module and function, as tsx did", async (t) => {
  const root = makeSpawningTree(t);
  await build(root);
  const bundle = join(root, "dist", "child-entries", "worker-lib-fixture-worker.mjs");
  const text = readFileSync(bundle, "utf8").split("\n");
  const lineOf = (pattern: RegExp, after = 0): number => {
    const at = text.findIndex((line, index) => index >= after && pattern.test(line));
    assert.ok(at >= 0, `the bundle holds ${pattern}`);
    return at + 1;
  };
  const workerHeader = text.findLastIndex((line) => line === `// ${WORKER}`) + 1;
  assert.ok(workerHeader > 0, "the bundle holds the worker's source section");
  const workerSpawn = lineOf(/^function spawn\d+\(/, workerHeader);
  assert.ok(workerSpawn > workerHeader, "esbuild renamed the worker's spawn, so only keepNames restores it");

  // In this thread: a stack as V8 prints it inside the bundle, every frame naming the bundle's own file.
  const url = pathToFileURL(bundle).href;
  const stack = [
    "Error",
    `    at onSpawn (${url}:${lineOf(/const onSpawn = /)}:5)`,
    "    at new Worker (node:internal/worker:297:28)",
    `    at construct (${url}:${lineOf(/^function startWorker\(/) + 1}:9)`,
    `    at startWorker (${url}:${lineOf(/^function startWorker\(/) + 3}:22)`,
    `    at spawn (${url}:${workerSpawn + 1}:10)`,
  ].join("\n");
  assert.equal(spawnSite(stack), "fixture-worker:spawn");
  assert.equal(spawnSite(`Error\n    at file://${bundle}:1:1`), "worker-lib-fixture-worker:<module>", "the banner lies before any module");

  // A real bundle-started worker, spawning its own lane through startWorker as read-model-worker does.
  const answer = await new Promise<{ bundled: boolean; sibling: string; kinds: string[] }>((resolve, reject) => {
    const worker = startWorker(selfUrl(root), { execArgv: ["--import", "tsx"] }, { storeRoot: false });
    worker.once("message", (m) => { void worker.terminate(); resolve(m as { bundled: boolean; sibling: string; kinds: string[] }); });
    worker.once("error", reject);
  });
  assert.equal(answer.bundled, true, "the worker runs its bundle, where every frame names the bundle");
  assert.equal(answer.sibling, "sibling");
  assert.deepEqual(answer.kinds, ["fixture-worker:spawn"]);
});
