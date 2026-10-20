// @census-reads: src/ bin/rmd scripts/build-child-entries.mjs — the worker-entry inventory walks src/ for modules that
// start a worker from their own URL; the launcher test copies bin/rmd and the bundle script into its fixture tree.
// bundlemain (operator ruling 2026-10-19, extending ADR 0006): the daemon's own main starts from the run-task bundle
// with its linked source map, and falls back to tsx on any doubt, naming why.
//
// bin/rmd ran every daemon through `tsx src/run-task.ts`: a tsx CLI parent process, tsx's transform of ~980 modules
// and a source map per module once a stack touched it. These tests drive scripts/build-child-entries.mjs `mainEntry`
// against fixture trees built by the real recipe, run the real bin/rmd launcher copied into such a tree, and drive
// src/lib/main-entry.ts (the boot row and the first-tick settle).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { materializeFromStore } from "#src/lib/child-entry-store.js";
import { MAIN_ENTRY_SELECTED_STEP, MAIN_ENTRY_SETTLED_STEP, readMainEntry, startMainEntryWatch } from "#src/lib/main-entry.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");

type Choice = { kind: "bundle" | "tsx"; reason: string; bundle?: string };
interface BuildModule {
  OUT_DIR: string;
  CHILD_ENTRIES: ReadonlyArray<{ name: string; source: string }>;
  WORKER_ENTRIES: readonly string[];
  MAIN_ATTEMPT_NAME: string;
  MAIN_OFF_NAME: string;
  workerBundleName(module: string): string;
  mainEntry(root: string, verb: string, opts?: { build?: (opts: object) => Promise<unknown>; now?: () => string }): Promise<Choice>;
  settleMainAttempt(root: string, outDir?: string, now?: () => string): boolean;
  readMainAttempt(root: string): { sourceHash: string; settled?: boolean; verb?: string } | null;
  buildChildEntries(opts: { root: string; outDir?: string; layoutDir?: string }): Promise<unknown>;
  sourceHash(root: string): string;
}
/** Required, as src/lib/main-entry.ts and child-entry-argv.ts require it: one instance of the script per process. */
const build = createRequire(import.meta.url)(SCRIPT) as BuildModule;

/** The printed line a fixture main writes: whether it runs bundled, what the launcher told it, and a formatted stack. */
const FIXTURE_MAIN = [
  "const facts = { bundled: (globalThis as { __rmd_bundled?: boolean }).__rmd_bundled === true, entry: process.env.RMD_MAIN_ENTRY,",
  "  maps: process.sourceMapsEnabled, argv: process.argv.slice(2), stack: String(new Error(\"probe\").stack) };",
  "console.log(JSON.stringify(facts));",
].join("\n");

/** A tree holding every declared child and worker entry (trivial modules), so the real recipe builds all of them. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-bundlemain-tree-"));
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  for (const source of [...build.CHILD_ENTRIES.map((e) => e.source), ...build.WORKER_ENTRIES]) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    writeFileSync(join(root, source), source === "src/run-task.ts" ? `${FIXTURE_MAIN}\n` : `export const at = ${JSON.stringify(source)};\n`);
  }
  return root;
}

const out = (root: string, file: string): string => join(root, build.OUT_DIR, file);

test("bundlemain: a current bundle with its linked map starts the daemon from the bundle", async () => {
  const root = makeTree();
  try {
    const first = await build.mainEntry(root, "daemon", { now: () => "2026-10-20T00:00:00.000Z" });
    assert.equal(first.kind, "bundle", JSON.stringify(first));
    assert.equal(first.reason, "built-at-boot", "a tree with no build is built once, then started from it");
    assert.equal(first.bundle, out(root, "run-task.mjs"));
    assert.ok(existsSync(`${first.bundle}.map`), "the recipe writes a linked map beside the bundle");
    assert.match(readFileSync(first.bundle!, "utf8"), /\/\/# sourceMappingURL=run-task\.mjs\.map\s*$/);
    const map = JSON.parse(readFileSync(`${first.bundle}.map`, "utf8")) as { sources: string[]; sourcesContent?: unknown };
    assert.ok(map.sources.some((s) => s.endsWith("src/run-task.ts")), "the map names the .ts source");
    assert.equal(map.sourcesContent, undefined, "a stack needs only the mappings");
    for (const module of build.WORKER_ENTRIES) assert.ok(existsSync(out(root, build.workerBundleName(module))), `${module} is bundled`);
    assert.deepEqual(build.readMainAttempt(root), { sourceHash: build.readMainAttempt(root)!.sourceHash, verb: "daemon", settled: false, at: "2026-10-20T00:00:00.000Z" });
    assert.equal(build.settleMainAttempt(root, undefined, () => "2026-10-20T00:01:00.000Z"), true);
    const second = await build.mainEntry(root, "daemon", { build: () => Promise.reject(new Error("must not rebuild a current tree")) });
    assert.deepEqual(second, { kind: "bundle", reason: "source-hash-match", bundle: out(root, "run-task.mjs") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundlemain: any doubt starts the daemon on tsx and says why", async () => {
  const root = makeTree();
  try {
    assert.deepEqual(await build.mainEntry(root, "serve"), { kind: "tsx", reason: "verb-not-bundled" });
    const failed = await build.mainEntry(root, "daemon", { build: () => Promise.reject(new Error("esbuild exploded")) });
    assert.deepEqual(failed, { kind: "tsx", reason: "build-failed: esbuild exploded" });
    const unbuilt = await build.mainEntry(root, "daemon", { build: async () => undefined });
    assert.deepEqual(unbuilt, { kind: "tsx", reason: "stale-after-build: no-manifest" });
    assert.equal((await build.mainEntry(root, "daemon")).kind, "bundle");
    build.settleMainAttempt(root);
    const worker = out(root, build.workerBundleName(build.WORKER_ENTRIES[0]!));
    const kept = readFileSync(worker);
    unlinkSync(worker);
    assert.deepEqual(await build.mainEntry(root, "daemon"), { kind: "tsx", reason: `worker-not-bundled: ${build.WORKER_ENTRIES[0]}: bundle-missing` },
      "a daemon whose worker cannot load never starts bundled");
    writeFileSync(worker, kept);
    unlinkSync(out(root, "run-task.mjs.map"));
    assert.deepEqual(await build.mainEntry(root, "daemon", { build: async () => undefined }), { kind: "tsx", reason: "map-missing" },
      "source maps stay on, so a bundle whose map a build cannot restore is no bundle");
    const rebuilt = await build.mainEntry(root, "daemon");
    assert.deepEqual([rebuilt.kind, rebuilt.reason], ["bundle", "built-at-boot"], "a bundle without its map is rebuilt with one");
    assert.ok(existsSync(out(root, "run-task.mjs.map")));
    build.settleMainAttempt(root);
    writeFileSync(out(root, build.MAIN_OFF_NAME), "");
    assert.deepEqual(await build.mainEntry(root, "daemon"), { kind: "tsx", reason: "switched-off" });
    const gone = join(root, "no-such-tree");
    assert.match((await build.mainEntry(gone, "daemon")).reason, /^resolver-error: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundlemain: a bundled boot that never reached its first tick demotes the next boot of that source to tsx", async () => {
  const root = makeTree();
  try {
    assert.equal((await build.mainEntry(root, "daemon")).kind, "bundle");
    const demoted = await build.mainEntry(root, "daemon");
    assert.deepEqual(demoted, { kind: "tsx", reason: "demoted: a bundled daemon boot of this source never reached its first tick" });
    assert.equal(build.settleMainAttempt(root), true, "a later first tick of this source settles it");
    assert.equal(build.settleMainAttempt(root), false, "settled once");
    assert.equal((await build.mainEntry(root, "daemon")).kind, "bundle");
    writeFileSync(join(root, "src", "run-task.ts"), `${FIXTURE_MAIN}\n// changed\n`);
    const fresh = await build.mainEntry(root, "daemon");
    assert.deepEqual([fresh.kind, fresh.reason], ["bundle", "built-at-boot"], "a new source gets its own attempt");
    assert.equal(build.readMainAttempt(root)!.settled, false);
    writeFileSync(out(root, build.MAIN_ATTEMPT_NAME), "{ not json");
    assert.equal(build.readMainAttempt(root)!.sourceHash, "unreadable");
    assert.equal(build.settleMainAttempt(root), false, "an unreadable marker is never overwritten as settled");
    rmSync(out(root, build.MAIN_ATTEMPT_NAME));
    assert.equal(build.readMainAttempt(root), null);
    assert.equal(build.settleMainAttempt(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A tree that also carries the real launcher and bundle script, with this repo's node_modules (tsx, esbuild). */
function makeLaunchableTree(): string {
  const root = makeTree();
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "bin", "rmd"), join(root, "bin", "rmd"));
  copyFileSync(SCRIPT, join(root, "scripts", "build-child-entries.mjs"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  return root;
}

function launch(root: string, verb: string): { bundled: boolean; entry?: string; maps: boolean; argv: string[]; stack: string } {
  const env = { ...process.env };
  delete env.RMD_MAIN_ENTRY;
  // W1-T2732: blank the coverage session var: enrolled, the child's coverage names fixture files gone by report time.
  env.NODE_V8_COVERAGE = undefined;
  const run = spawnSync("bash", [join(root, "bin", "rmd"), verb, "--flag"], { cwd: root, encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
}

test("bundlemain: bin/rmd execs the daemon from its bundle with source maps on, and tsx on any doubt", async () => {
  const root = makeLaunchableTree();
  try {
    const bundled = launch(root, "daemon");
    assert.equal(bundled.bundled, true, "the daemon verb runs the bundle");
    assert.equal(bundled.entry, "bundle:built-at-boot", "and is told which entry and why");
    assert.equal(bundled.maps, true);
    assert.deepEqual(bundled.argv, ["daemon", "--flag"]);
    assert.match(bundled.stack, /src[\\/]run-task\.ts:2:/, "a bundled frame is named by its .ts source and line through the linked map");
    assert.doesNotMatch(bundled.stack, /run-task\.mjs:/);
    const demoted = launch(root, "daemon");
    assert.equal(demoted.bundled, false, "an unsettled bundled boot sends the next boot of the same source to tsx");
    assert.match(String(demoted.entry), /^tsx:demoted: /);
    build.settleMainAttempt(root);
    assert.equal(launch(root, "daemon").entry, "bundle:source-hash-match");
    const other = launch(root, "status");
    assert.deepEqual([other.bundled, other.entry], [false, undefined], "every other verb runs on tsx exactly as before");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundlemain: the boot row names the entry, and only a bundled main settles at its first tick", () => {
  assert.deepEqual(readMainEntry("bundle:source-hash-match", false), { kind: "bundle", reason: "source-hash-match" });
  assert.deepEqual(readMainEntry("tsx:demoted: x", true), { kind: "tsx", reason: "demoted: x" });
  assert.deepEqual(readMainEntry("bundle:", false), { kind: "bundle", reason: "unnamed" });
  assert.deepEqual(readMainEntry("weird", true), { kind: "bundle", reason: "launcher-unnamed" });
  assert.deepEqual(readMainEntry(undefined, false), { kind: "tsx", reason: "launcher-unnamed" });
  const rows: Array<[string, Record<string, unknown>]> = [];
  const env: NodeJS.ProcessEnv = { RMD_MAIN_ENTRY: "bundle:source-hash-match" };
  const settled: string[] = [];
  const onStep = startMainEntryWatch({ log: (step, extra) => rows.push([step, extra]), root: "/tree", env, bundled: () => true,
    execArgv: ["--enable-source-maps", "--import", "/tree/node_modules/tsx/dist/loader.mjs"], sourceMapsEnabled: () => true,
    settle: (root) => { settled.push(root); return true; } });
  assert.deepEqual(rows, [[MAIN_ENTRY_SELECTED_STEP, { entry_kind: "bundle", reason: "source-hash-match", source_maps_enabled: true, tsx_loader: true,
    children_tsx_loader: true }]]);
  assert.equal(env.RMD_MAIN_ENTRY, undefined, "no child inherits the choice");
  onStep("daemon.boot");
  assert.deepEqual(settled, []);
  onStep("daemon.tick_phases");
  onStep("daemon.tick_phases");
  assert.deepEqual(settled, ["/tree"], "settled once, at the first tick");
  assert.deepEqual(rows[1], [MAIN_ENTRY_SETTLED_STEP, { settled: true }]);
  // A bundled main without the loader hands it to its children through process.execArgv, never loading it itself.
  const execArgv = ["--enable-source-maps"];
  const handed: Array<Record<string, unknown>> = [];
  startMainEntryWatch({ log: (_step, extra) => handed.push(extra), root: "/tree", env: { RMD_MAIN_ENTRY: "bundle:built-at-boot" }, bundled: () => true,
    execArgv, sourceMapsEnabled: () => true, exists: (path) => path === "/tree/node_modules/tsx/dist/loader.mjs" });
  assert.deepEqual(execArgv, ["--enable-source-maps", "--import", "file:///tree/node_modules/tsx/dist/loader.mjs"]);
  assert.deepEqual([handed[0]!.tsx_loader, handed[0]!.children_tsx_loader], [false, true]);
  const bare = ["--enable-source-maps"];
  const missing: Array<Record<string, unknown>> = [];
  startMainEntryWatch({ log: (_step, extra) => missing.push(extra), root: "/tree", env: {}, bundled: () => true, execArgv: bare, exists: () => false });
  assert.deepEqual(bare, ["--enable-source-maps"], "no loader in the tree: nothing is handed on");
  assert.equal(missing[0]!.children_tsx_loader, "loader-missing");
  const tsxRows: string[] = [];
  const tsxStep = startMainEntryWatch({ log: (step) => tsxRows.push(step), root: "/tree", env: { RMD_MAIN_ENTRY: "tsx:map-missing" },
    settle: () => { throw new Error("a tsx main settles nothing"); } });
  tsxStep("daemon.tick_phases");
  assert.deepEqual(tsxRows, [MAIN_ENTRY_SELECTED_STEP]);
  const failed: Array<[string, Record<string, unknown>]> = [];
  const failing = startMainEntryWatch({ log: (step, extra) => failed.push([step, extra]), root: "/tree", env: { RMD_MAIN_ENTRY: "bundle:x" },
    settle: () => { throw new Error("disk full"); } });
  failing("daemon.tick_phases");
  assert.deepEqual(failed[1], [MAIN_ENTRY_SETTLED_STEP, { settled: false, error: "disk full" }], "a settle that fails is named, never thrown");
});

test("bundlemain: the real defaults read this process and the tree's own marker", () => {
  const root = makeTree();
  const rows: Array<[string, Record<string, unknown>]> = [];
  const saved = process.env.RMD_MAIN_ENTRY;
  process.env.RMD_MAIN_ENTRY = "bundle:source-hash-match";
  try {
    const onStep = startMainEntryWatch({ log: (step, extra) => rows.push([step, extra]), root });
    assert.equal(process.env.RMD_MAIN_ENTRY, undefined);
    assert.equal(rows[0]![1].source_maps_enabled, process.sourceMapsEnabled);
    assert.equal(rows[0]![1].tsx_loader, process.execArgv.some((flag) => /tsx/.test(flag)));
    assert.equal(rows[0]![1].children_tsx_loader, rows[0]![1].tsx_loader, "a tsx process hands nothing on");
    onStep("daemon.tick_phases");
    assert.deepEqual(rows[1], [MAIN_ENTRY_SETTLED_STEP, { settled: false }], "no attempt marker in this tree: nothing to settle");
    const unnamed = startMainEntryWatch({ log: (step, extra) => rows.push([step, extra]), root });
    void unnamed;
    assert.equal(rows[2]![1].reason, "launcher-unnamed");
    assert.equal(rows[2]![1].entry_kind, "tsx", "a test process runs no bundle");
  } finally {
    if (saved === undefined) delete process.env.RMD_MAIN_ENTRY;
    else process.env.RMD_MAIN_ENTRY = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundlemain: every module that starts a worker from its own URL through the bundle helpers is a declared worker entry", () => {
  // A bundled main starts such a worker from that module's worker bundle (bundledWorkerUrl), and refuses one with none.
  const listed = execFileSync("git", ["grep", "-l", "-E", "(startWorker|bundledWorkerUrl)\\(import\\.meta\\.url", "--", "src"],
    { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter((file) => file !== "" && file !== "src/lib/child-entry-argv.ts");
  assert.ok(listed.includes("src/lib/read-model-worker.ts"), "positive control: the walk sees a known worker module");
  assert.deepEqual(listed.filter((module) => !build.WORKER_ENTRIES.includes(module)), [], "every such module is in WORKER_ENTRIES");
  // A module that hands `new Worker` its own URL directly must be a worker bundle too, or give that worker tsx itself.
  const ownUrl = execFileSync("git", ["grep", "-l", "-F", "new URL(import.meta.url)", "--", "src"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n").filter((file) => file !== "" && readFileSync(join(REPO_ROOT, file), "utf8").includes("new Worker("));
  const givesTsx = (file: string): boolean => /tsx\/esm\/api|execArgv: \["--import", "tsx"\]/.test(readFileSync(join(REPO_ROOT, file), "utf8"));
  assert.ok(ownUrl.includes("src/lib/ledger-union.ts"), "positive control: the walk sees a module that starts its own worker under tsx");
  assert.deepEqual(ownUrl.filter((file) => !build.WORKER_ENTRIES.includes(file) && !givesTsx(file)), [],
    "no module starts a worker from its own .ts URL that a bundled main could not load");
});

test("bundlemain: a build materialized from the shared store keeps its linked maps", async () => {
  const root = makeTree();
  const store = mkdtempSync(join(tmpdir(), "rmd-bundlemain-store-"));
  try {
    const hash = build.sourceHash(root);
    await build.buildChildEntries({ root, outDir: join(store, hash), layoutDir: build.OUT_DIR });
    assert.ok(existsSync(join(store, hash, "run-task.mjs.map")), "the stored build carries its maps");
    assert.deepEqual(materializeFromStore(root, store), { outcome: "hit", hash });
    assert.ok(existsSync(out(root, "run-task.mjs.map")), "the materialized copy keeps the main bundle's map");
    for (const module of build.WORKER_ENTRIES) assert.ok(existsSync(out(root, `${build.workerBundleName(module)}.map`)), `${module}'s map came too`);
    const choice = await build.mainEntry(root, "daemon", { build: () => Promise.reject(new Error("a materialized current build needs no rebuild")) });
    assert.deepEqual(choice, { kind: "bundle", reason: "source-hash-match", bundle: out(root, "run-task.mjs") });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test("bundlemain: the bundle script prints the launcher's one-line answer for --main-entry", () => {
  const root = makeTree();
  try {
    // The repo's own script, so a coverage run credits its CLI arm; it reads the fixture only as data.
    const answer = (verb: string): string[] => execFileSync(process.execPath, [SCRIPT, "--root", root, "--main-entry", verb], { encoding: "utf8" })
      .replace(/\n$/, "").split("\t");
    assert.deepEqual(answer("daemon"), ["bundle", "built-at-boot", out(root, "run-task.mjs")]);
    assert.deepEqual(answer("daemon").slice(0, 1), ["tsx"], "the unsettled attempt demotes the next boot");
    assert.deepEqual(answer("serve"), ["tsx", "verb-not-bundled", ""]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
