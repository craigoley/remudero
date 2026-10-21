// test/a-bundled-parent-starts-its-workers-from-bundled-worker-entries.test.ts — W1-T8777.
//
// A bundle rebinds each module's import.meta.url to its .ts source, so a module that starts a worker from its own
// URL would start a .ts worker, and a bundled isolate has no tsx loader to run it. The build now emits each worker
// module as its own bundle, and bundledWorkerUrl starts a bundled parent's worker from it. These tests drive the
// real build against fixture trees and run the bundled parent under plain node. ADR 0006 decision 4.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundledWorkerUrl, runsBundled } from "../src/lib/child-entry-argv.js";
import { materializeFromStore } from "../src/lib/child-entry-store.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");
const HELPER = join(REPO_ROOT, "src", "lib", "child-entry-argv.ts");

interface Built { module: string; bundle: string; bytes: number; sha256: string }
interface Manifest { sourceHash: string; entries: Array<{ name: string; bundle: string }>; workers: Built[] }
interface BuildModule {
  OUT_DIR: string;
  WORKER_ENTRIES: readonly string[];
  workerBundleName(module: string): string;
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[]; workers?: readonly string[]; outDir?: string; layoutDir?: string }): Promise<Manifest>;
  sourceHash(root: string): string;
  workerBundle(root: string, module: string, opts?: { verifySource?: boolean }): { current: boolean; reason: string; bundle?: string };
}
/**
 * Required, as src/lib/child-entry-argv.ts and the store require it, so this process holds ONE instance of the script.
 * An import() beside those require()s made two, and the coverage merge keeps one instance per process
 * (droppedRepeatInstances): the one it dropped was the one that built the worker bundles.
 */
const loadBuild = async (): Promise<BuildModule> => createRequire(import.meta.url)(SCRIPT) as BuildModule;

const WORKER = "src/lib/fixture-worker.ts";
const ENTRY = { name: "fixture-main", source: "src/main.ts" };

/** A tree whose entry starts a worker from the worker module's own URL, the shape of the four real worker modules. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-worker-entry-tree-"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(join(root, WORKER), [
    'import { isMainThread, parentPort, Worker } from "node:worker_threads";',
    `import { bundledWorkerUrl, runsBundled } from ${JSON.stringify(HELPER)};`,
    "export function start(): Promise<unknown> {",
    "  return new Promise((resolve, reject) => {",
    "    const worker = new Worker(bundledWorkerUrl(import.meta.url));",
    "    worker.once(\"message\", resolve);",
    "    worker.once(\"error\", reject);",
    "  });",
    "}",
    "if (!isMainThread) parentPort!.postMessage({ bundled: runsBundled(), self: import.meta.url, argv1: process.argv[1], execArgv: process.execArgv });",
  ].join("\n") + "\n");
  writeFileSync(join(root, ENTRY.source), [
    'import { start } from "./lib/fixture-worker.ts";',
    "start().then((m) => { console.log(JSON.stringify(m)); process.exit(0); }, (e) => { console.error(String(e)); process.exit(3); });",
  ].join("\n") + "\n");
  return root;
}

test("W1-T8777: the build emits and lists a bundle per named worker entry", async (t) => {
  const mod = await loadBuild();
  assert.deepEqual([...mod.WORKER_ENTRIES], ["src/lib/read-model-worker.ts", "src/lib/read-model-slow-lane.ts", "src/lib/status.ts", "src/lib/board-worker.ts",
    "src/lib/tick-read-worker.ts", "src/lib/benchmark-cohort.ts", "src/lib/secret-boundary.ts", "src/lib/config-gardener.ts",
    "src/lib/console-projection-worker.ts", "src/lib/repo-dashboard-route.ts", "src/lib/serve-plan-reload.ts"]);
  assert.equal(mod.workerBundleName("src/lib/board-worker.ts"), "worker-lib-board-worker.mjs");
  for (const module of mod.WORKER_ENTRIES) assert.ok(existsSync(join(REPO_ROOT, module)), `the declared worker ${module} exists, so the real build bundles it`);
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = await mod.buildChildEntries({ root, entries: [ENTRY], workers: [WORKER, "src/lib/not-in-this-tree.ts"] });
  assert.deepEqual(manifest.workers.map((w) => [w.module, w.bundle]), [[WORKER, "worker-lib-fixture-worker.mjs"]]);
  assert.ok(existsSync(join(root, mod.OUT_DIR, "worker-lib-fixture-worker.mjs")));
  const verdict = mod.workerBundle(root, WORKER);
  assert.equal(verdict.reason, "source-hash-match");
  assert.equal(verdict.current, true);
  writeFileSync(join(root, WORKER), "export {};\n", { flag: "a" });
  assert.equal(mod.workerBundle(root, WORKER).reason, "source-changed", "an edited source is not current");
  assert.equal(mod.workerBundle(root, WORKER, { verifySource: false }).reason, "bundle-intact", "a bundled process judges only integrity");
  assert.equal(mod.workerBundle(root, "src/lib/absent.ts").reason, "worker-not-built");
  assert.equal(mod.workerBundle(root, "../outside.ts").reason, "worker-module-invalid");
  await assert.rejects(mod.buildChildEntries({ root, entries: [{ name: "absent", source: "src/absent.ts" }], workers: [] }), /absent: source src\/absent\.ts does not exist/, "a declared entry must exist");
});

test("W1-T8777: a bundled parent starts its worker from the bundled worker entry", async (t) => {
  const mod = await loadBuild();
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The build runs under plain node, as deploy/Dockerfile runs it. This also keeps the worker loop's coverage
  // honest: Node's merge lets a file's plain-node instances (every CLI child) overwrite the lines of its
  // tsx-transformed instance, so a line run only under tsx reads as never run.
  const build = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)}); await m.buildChildEntries(${JSON.stringify({ root, entries: [ENTRY], workers: [WORKER] })});`],
  { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_OPTIONS: "" } });
  assert.equal(build.status, 0, `the plain-node build ran: ${build.stderr}`);
  // Plain node: no tsx loader anywhere, as a bundled serve or daemon would run.
  const run = spawnSync(process.execPath, [join(root, mod.OUT_DIR, "fixture-main.mjs")], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_OPTIONS: "" } });
  assert.equal(run.status, 0, `the bundled parent's worker ran: ${run.stderr}`);
  const got = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { bundled: boolean; self: string; argv1: string; execArgv: string[] };
  assert.equal(got.bundled, true, "the worker isolate runs its own bundle");
  assert.equal(got.self, pathToFileURL(join(root, WORKER)).href, "the worker module still sees its source URL");
  assert.notEqual(got.argv1, join(root, WORKER), "a worker bundle never rewrites process.argv[1] to itself");
  assert.ok(!got.execArgv.some((a) => /tsx/.test(a)), `the worker runs without tsx: ${got.execArgv.join(" ")}`);
});

test("W1-T8777: an unbundled parent keeps its self-URL worker start", () => {
  assert.equal(runsBundled(), false, "this test runs under tsx");
  const self = pathToFileURL(join(REPO_ROOT, "src", "lib", "board-worker.ts")).href;
  assert.equal(bundledWorkerUrl(self).href, self);
  assert.equal(bundledWorkerUrl(self, () => { throw new Error("never asked"); }).href, self, "the manifest is never read unbundled");
});

test("a bundled process with no worker bundle refuses loudly rather than start a .ts worker", async (t) => {
  const mod = await loadBuild();
  const root = makeTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await mod.buildChildEntries({ root, entries: [ENTRY], workers: [] });
  const flag = globalThis as { __rmd_bundled?: unknown };
  flag.__rmd_bundled = true;
  t.after(() => { delete flag.__rmd_bundled; });
  assert.throws(() => bundledWorkerUrl(pathToFileURL(join(root, WORKER))), /cannot start src\/lib\/fixture-worker\.ts as a worker: worker-not-built \(W1-T8777\)/);
  assert.throws(() => bundledWorkerUrl(pathToFileURL(join(root, "elsewhere.ts"))), /not under a src\/ directory/);
  const seam = (r: string, m: string) => ({ current: true, reason: "bundle-intact", bundle: join(r, "dist", "child-entries", `${m.length}.mjs`) });
  assert.equal(bundledWorkerUrl(pathToFileURL(join(root, WORKER)), seam).href, pathToFileURL(join(root, "dist", "child-entries", `${WORKER.length}.mjs`)).href);
});

test("a build materialized from the store carries its worker bundles", async (t) => {
  const mod = await loadBuild();
  const root = makeTree();
  const store = mkdtempSync(join(tmpdir(), "rmd-worker-entry-store-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); });
  await mod.buildChildEntries({ root, entries: [ENTRY], workers: [WORKER], outDir: join(store, mod.sourceHash(root)), layoutDir: mod.OUT_DIR });
  assert.deepEqual(materializeFromStore(root, store), { outcome: "hit", hash: mod.sourceHash(root) });
  assert.equal(mod.workerBundle(root, WORKER).current, true, "the tree's copy holds the worker bundle");
});
