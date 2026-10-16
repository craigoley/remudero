// test/the-read-plane-worker-starts-from-a-narrow-entry.test.ts — W1-T9722.
//
// The daemon's read-plane worker was handed src/run-task.ts's own URL, so its isolate loaded the whole CLI
// (758 modules, 97.9 MiB heapUsed under tsx, offline) to run createTickReadProducer. The producer and the
// declarations only it uses now live in src/lib/tick-read-worker.ts, which is also the worker's entry.
// These tests walk that entry's static import graph, start real workers from it (from the .ts source under
// tsx, and from a worker bundle under plain node) and compare their tick read with the inline producer's.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startReadPlane } from "../src/lib/read-plane.js";
import { startWorker } from "../src/lib/child-entry-argv.js";
import { loadPlan } from "../src/lib/plan.js";
import { makeTempDir } from "../src/lib/tmp.js";
import {
  buildOpenPrViewsAsync, createTickReadProducer, startTickReadWorker, tickReadWorkerBoot, tickReadWorkerStartFacts,
  tickReadWorkerUrl, type TickReadOptions,
} from "../src/lib/tick-read-worker.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/lib/tick-read-worker.ts";

/** Every module the file at `path` loads at runtime: static `import`/`export … from` and bare imports, never `import type`. */
function staticImports(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|\n)[ \t]*(import|export)\s+(type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g)) {
    if (match[2]) continue;
    out.push(match[3]!);
  }
  return out;
}

/** The repo-relative src files reachable from `entry` through runtime imports. */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(REPO_ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = relative(REPO_ROOT, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of staticImports(file)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      const candidates = [target, target.replace(/\.js$/, ".ts"), target.replace(/\.mjs$/, ".mts")];
      const found = candidates.find((c) => existsSync(c) && !c.endsWith("/"));
      assert.ok(found, `${rel} imports ${spec}, which resolves to no file`);
      queue.push(found);
    }
  }
  return seen;
}

test("W1-T9722: the read-plane worker entry never imports run-task", () => {
  const entry = relative(REPO_ROOT, fileURLToPath(tickReadWorkerUrl()));
  assert.equal(entry, ENTRY, "the read-plane worker entry is this module's own URL");
  const graph = importGraph(entry);
  assert.ok(graph.has("src/lib/read-plane.worker.ts"), "positive control: the walk reaches the worker glue");
  assert.ok(graph.has("src/lib/status.ts"), "positive control: the walk reaches the producer's deep imports");
  assert.equal(graph.has("src/run-task.ts"), false, "the narrow entry never loads the CLI");
  const runTask = importGraph("src/run-task.ts");
  assert.ok(runTask.size > graph.size, `the narrow entry loads fewer modules (${graph.size}) than run-task.ts (${runTask.size})`);
  // The daemon's own wiring starting its worker from this entry is test/the-tick-reads-run-off-the-event-loop.test.ts's
  // W1-T4075 daemon test: the worker's first ledger row names the entry it was started from.
});

const T0 = "2026-10-01T00:00:00Z";
const pull = (number: number, merged = false) => ({
  number, html_url: `https://github.com/o/r/pull/${number}`, state: merged ? "closed" : "open",
  merged_at: merged ? T0 : null, closed_at: merged ? T0 : null, title: `fix(read): implement ${number}`,
  body: merged ? "" : "Remudero-Task: A", head: { ref: `run-A-${number}`, sha: `sha${number}` },
  base: { ref: "main" }, created_at: T0, updated_at: T0, draft: false, labels: [],
});
/** Scripted `gh api` answers, first match wins; every other read answers `[]`. */
const ROUTES: GhShimRoute[] = [
  { when: "state=open", stdout: JSON.stringify([pull(1), pull(2)]) },
  { when: "state=closed", stdout: JSON.stringify([pull(3, true)]) },
  { when: "/check-runs", stdout: JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "advisory", status: "completed", conclusion: "failure" }] }) },
  { when: "/status", stdout: JSON.stringify({ state: "success", statuses: [{ context: "ci-gate", state: "success" }] }) },
  { when: "/files", stdout: JSON.stringify([{ filename: "src/a.ts" }]) },
  { when: "/actions/runs", stdout: JSON.stringify({ workflow_runs: [] }) },
  { when: "/compare/", stdout: JSON.stringify({ ahead_by: 2, behind_by: 0, files: [] }) },
  { when: "", stdout: "[]" },
];

/** One isolated tree: a plan, an empty ledger, a config root. Each producer gets its own, so no cache crosses. */
function tree(): { options: TickReadOptions; planPath: string; root: string } {
  const root = makeTempDir("tick-read-worker");
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, [
    "- {id: A, title: a, repo: r, type: implement, files: [src/a.ts], depends_on: [], status: queued}",
    "- {id: B, title: b, repo: r, type: implement, files: [src/b.ts], depends_on: [], status: queued}",
  ].join("\n") + "\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const options = { owner: "o", repo: "r", config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root } as unknown as TickReadOptions;
  return { options, planPath, root };
}

/** The facts with each tree's own root replaced and the wall-clock board age dropped, so two reads compare. */
const portable = (facts: unknown, root: string): unknown =>
  JSON.parse(JSON.stringify(facts).split(root).join("<root>"), (key, value) => (key === "ageHours" ? undefined : value));

async function withShim<T>(run: () => Promise<T>): Promise<T> {
  const gh = ghShim(ROUTES, { kind: "tick-read-worker" });
  const saved = { PATH: process.env.PATH, RMD_BUNDLED_WORKERS: process.env.RMD_BUNDLED_WORKERS };
  process.env.PATH = `${gh.dir}:${saved.PATH}`;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(gh.dir, { recursive: true, force: true });
  }
}

/** One tick read from a real worker started by `start`, beside the inline producer's on a twin tree. */
async function workerAgainstInline(start: (options: TickReadOptions) => ReturnType<typeof startTickReadWorker>) {
  const worker = tree();
  const inline = tree();
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const plane = startReadPlane({
    workerUrl: tickReadWorkerUrl(), workerInput: worker.options, spawn: () => start(worker.options),
    inline: () => { throw new Error("the inline fallback ran"); },
    log: (step, extra) => rows.push({ step, extra }),
  });
  try {
    const generation = await plane.read({ plan: loadPlan(worker.planPath) });
    const expected = await createTickReadProducer(inline.options)({ plan: loadPlan(inline.planPath) });
    return { generation, expected, rows, worker, inline };
  } finally {
    await plane.stop();
    rmSync(worker.root, { recursive: true, force: true });
    rmSync(inline.root, { recursive: true, force: true });
  }
}

test("W1-T9722: the narrow worker returns the same tick read as the inline producer", async () => {
  await withShim(async () => {
    process.env.RMD_BUNDLED_WORKERS = "0"; // the .ts source under tsx: this tree carries no worker bundle
    const { generation, expected, rows, worker, inline } = await workerAgainstInline((options) => startTickReadWorker(options));
    assert.equal(generation.source, "worker", "the read came from the worker thread, not the inline fallback");
    assert.ok(expected.openPrViews.length > 0, "positive control: the scripted reads produce open-PR views");
    assert.deepEqual(portable(generation.facts, worker.root), portable(expected, inline.root));
    const started = rows.find((row) => row.step === "read_plane.worker_started");
    assert.ok(started, `the worker reports its start: ${JSON.stringify(rows)}`);
    assert.equal(started.extra?.entry, ENTRY);
    assert.equal(started.extra?.bundled, false);
    assert.ok(Number(started.extra?.loaded_modules) > 0, "the boot counted the modules the isolate loaded");
    assert.ok(Number(started.extra?.heap_used_bytes) > 0);
  });
});

test("W1-T9722: a bundled read-plane worker runs under plain node and returns the same tick read", async (t) => {
  const build = createRequire(import.meta.url)("../scripts/build-child-entries.mjs") as {
    WORKER_ENTRIES: readonly string[]; workerBundleName(module: string): string;
    buildChildEntries(opts: { root: string; entries: never[]; workers: string[]; outDir: string }): Promise<unknown>;
  };
  assert.ok(build.WORKER_ENTRIES.includes(ENTRY), "the narrow entry is a declared worker entry");
  // Inside the tree, at dist/child-entries' depth (gitignored): the bundle resolves its packages from the tree's
  // node_modules and each module's source URL relative to itself, as a real build's bundle does.
  mkdirSync(join(REPO_ROOT, "dist"), { recursive: true });
  const distDir = join(REPO_ROOT, "dist"); // already gitignored (`dist/`), so this fixture is never tree dirt
  const out = mkdtempSync(join(distDir, "w9722-bundle-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await build.buildChildEntries({ root: REPO_ROOT, entries: [], workers: [ENTRY], outDir: out });
  const bundle = join(out, build.workerBundleName(ENTRY));
  assert.ok(existsSync(bundle), "the build emitted the read-plane worker bundle");
  await withShim(async () => {
    delete process.env.RMD_BUNDLED_WORKERS;
    // The real startWorker, told this bundle is current. The execArgv is given, as serve's bundle test gives it:
    // this runner preloads a TypeScript setup file, which startWorker rightly refuses to drop from a bundle's.
    const { generation, expected, rows, worker, inline } = await workerAgainstInline((options) => startTickReadWorker(options, {
      start: (url, workerOptions, opts) => startWorker(url, { ...workerOptions, execArgv: ["--import", "tsx"] }, {
        ...opts, storeRoot: false, hash: () => "test", check: () => ({ current: true, reason: "test-bundle", bundle }),
      }),
    }));
    assert.equal(generation.source, "worker");
    assert.deepEqual(portable(generation.facts, worker.root), portable(expected, inline.root));
    const started = rows.find((row) => row.step === "read_plane.worker_started");
    assert.equal(started?.extra?.bundled, true, "the worker isolate ran the bundle");
    assert.ok(Number(started?.extra?.loaded_modules) > 0);
  });
});

test("W1-T9722: the boot registers tsx only for a TypeScript entry", () => {
  const ts = tickReadWorkerBoot(pathToFileURL(join(REPO_ROOT, ENTRY)).href);
  assert.match(ts, /tsx/);
  assert.match(ts, /registerHooks/);
  const bundled = tickReadWorkerBoot("file:///tree/dist/child-entries/worker-lib-tick-read-worker.mjs");
  assert.equal(/tsx/.test(bundled), false, "a bundle loads under plain node");
  assert.match(bundled, /await import\(workerData\.entry\)/);
});

test("W1-T9722: the start row leaves an uncounted module total absent, never zero", () => {
  const key = "__rmdTickReadLoadedModules";
  const saved = (globalThis as Record<string, unknown>)[key];
  delete (globalThis as Record<string, unknown>)[key];
  try {
    const facts = tickReadWorkerStartFacts();
    assert.equal("loaded_modules" in facts, false);
    assert.equal("entry" in facts, false, "no workerData on the main thread, so no entry");
    assert.equal(facts.bundled, false);
    assert.ok(Number(facts.heap_used_bytes) > 0);
    assert.equal(tickReadWorkerStartFacts({ entry: pathToFileURL(join(REPO_ROOT, "src", "run-task.ts")).href }).entry, "src/run-task.ts",
      "the row names the entry the worker was started from, tree-relative");
    assert.equal(tickReadWorkerStartFacts({ entry: "data:text/javascript,0" }).entry, "data:text/javascript,0");
  } finally {
    if (saved !== undefined) (globalThis as Record<string, unknown>)[key] = saved;
  }
});

test("W1-T9722: the moved open-PR views stay fail-soft when the main plan cannot be read", async () => {
  const dir = makeTempDir("tick-read-worker-unreadable-plan");
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const mainPlanPath = join(dir, "tasks.yaml");
    writeFileSync(mainPlanPath, "[]\n");
    let asked = 0;
    const views = await buildOpenPrViewsAsync("o", "r", ledgerPath, {
      fetchAsync: async () => [], requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [], mainPlanPath,
      readMainPlan: () => { asked++; throw new Error("the main plan is unreadable"); },
    });
    assert.equal(asked, 1, "the plan read was attempted");
    assert.deepEqual(views, [], "an unreadable plan only disables trailer repair; the read itself completes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
