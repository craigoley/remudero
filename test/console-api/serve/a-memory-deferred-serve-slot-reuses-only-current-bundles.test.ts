// test/console-api/serve/a-memory-deferred-serve-slot-reuses-only-current-bundles.test.ts — W1-T10058.
//
// A standby whose swap is deferred for memory is prepared again on every retry, and each preparation recompiled the same
// bundles. The slot now reuses its build only when the slot's OWN build module, run in a child, finds every declared child
// entry AND every declared worker bundle current. These tests drive tiny trees holding a copy of the real build script and
// the real esbuild (linked from this checkout into the tree's own node_modules); only `npm` is answered without the network.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSlotChildEntries, CHILD_ENTRY_BUILD_SCRIPT, createSlotPreparer, runCommand, type RunCommand } from "#src/lib/serve-slots.js";
import type { ServeSupervisor } from "#src/lib/serve-supervisor.js";
import { runServeSupervisor } from "#src/lib/serve-supervisor-main.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const require = createRequire(import.meta.url);
/** This checkout's root, from the build script's own location, so the file's text does not depend on its folder. */
const REPO = dirname(dirname(require.resolve(`#scripts/${basename(CHILD_ENTRY_BUILD_SCRIPT)}`)));
interface BuildModule {
  CHILD_ENTRIES: readonly { name: string; source: string }[];
  WORKER_ENTRIES: readonly string[];
  OUT_DIR: string;
  RECIPE_VERSION: number;
  workerBundleName(module: string): string;
}
// Required, as src/lib/child-entry-argv.ts requires it, so this process holds one instance of the script.
const build = require(join(REPO, CHILD_ENTRY_BUILD_SCRIPT)) as BuildModule;
const OUT = (dir: string) => join(dir, build.OUT_DIR);

/** Writes the tiny tree's tracked files: the real build script, every declared child and worker source, package files. */
function writeTree(dir: string): void {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(join(REPO, CHILD_ENTRY_BUILD_SCRIPT), join(dir, CHILD_ENTRY_BUILD_SCRIPT));
  writeFileSync(join(dir, "package.json"), '{ "name": "slot", "type": "module" }\n');
  writeFileSync(join(dir, "package-lock.json"), '{ "lockfileVersion": 3, "n": 1 }\n');
  writeFileSync(join(dir, ".gitignore"), "dist/\nnode_modules\n");
  for (const source of [...build.CHILD_ENTRIES.map((e) => e.source), ...build.WORKER_ENTRIES]) {
    mkdirSync(dirname(join(dir, source)), { recursive: true });
    writeFileSync(join(dir, source), `export const at: string = ${JSON.stringify(source)};\n`);
  }
}

/** The tree's own node_modules holding only a link to this checkout's esbuild: the install marker lands in the tree, never here. */
function linkEsbuild(dir: string): void {
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(join(REPO, "node_modules", "esbuild"), join(dir, "node_modules", "esbuild"));
}

/** A plain (non-git) tiny tree with its dependencies linked in, ready for a real build. */
function tinyTree(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-reuse-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(dir);
  linkEsbuild(dir);
  return dir;
}

/** The real runCommand, counting the slot builds it starts; `npm` links this checkout's esbuild instead of installing. */
function countingRun(): { run: RunCommand; builds: () => number; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunCommand = async (command, args, cwd) => {
    calls.push([command, ...args]);
    if (command !== "npm") return runCommand(command, args, cwd);
    linkEsbuild(cwd);
    return "";
  };
  const builds = () => calls.filter((c) => c[0] === process.execPath && c[1] === CHILD_ENTRY_BUILD_SCRIPT && c.length === 2).length;
  return { run, builds, calls };
}

const manifestOf = (dir: string) => JSON.parse(readFileSync(join(OUT(dir), "manifest.json"), "utf8")) as { entries: { bundle: string }[]; workers: { bundle: string }[] };

test("W1-T10058: repeated preparation reuses a complete current build", async (t) => {
  // 1. The standby retry: the supervisor prepares the same inactive slot at the same sha again.
  const origin = gitRepo({ kind: "slot-reuse-origin" });
  t.after(() => origin.cleanup());
  writeTree(origin.dir);
  origin.git("add", "-A");
  origin.git("commit", "--quiet", "-m", "v1");
  const serving = gitRepo({ kind: "slot-reuse-serving", cloneFrom: origin.dir });
  t.after(() => serving.cleanup());
  const gensRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-reuse-gens-`));
  t.after(() => rmSync(gensRoot, { recursive: true, force: true }));
  const counter = countingRun();
  const rows: Array<Record<string, unknown>> = [];
  const prepare = createSlotPreparer({ repoDir: serving.dir, gensDir: join(gensRoot, "gens"), run: counter.run, log: (step, extra) => void (step === "serve.slot_child_entries" && rows.push(extra ?? {})) });

  const first = await prepare(serving.dir);
  assert.equal(counter.builds(), 1, "the first preparation builds");
  assert.equal(rows[0]?.outcome, "built");
  assert.equal(rows[0]?.reused, false);
  const manifest = manifestOf(first.dir);
  assert.equal(manifest.entries.length, build.CHILD_ENTRIES.length, "every declared child entry was built");
  assert.equal(manifest.workers.length, build.WORKER_ENTRIES.length, "every declared worker was built");
  const before = readFileSync(join(OUT(first.dir), "manifest.json"), "utf8");

  const second = await prepare(serving.dir);
  assert.equal(second.dir, first.dir);
  assert.equal(second.sha, first.sha);
  assert.equal(counter.builds(), 1, "the retry at the same sha skips the second build");
  assert.equal(rows[1]?.outcome, "built", "the outcome contract is preserved: a reused build reads built");
  assert.equal(rows[1]?.reused, true, "the ledger row says the build was reused");
  assert.equal(readFileSync(join(OUT(first.dir), "manifest.json"), "utf8"), before, "the reused manifest was not rewritten");
  assert.ok(counter.calls.some((c) => c[0] === process.execPath && c[1] !== CHILD_ENTRY_BUILD_SCRIPT), "qualification ran in a child process");

  // 2. The cold consumer: the supervisor's start reuses the cold checkout's current build too.
  const cold = tinyTree(t);
  const coldCounter = countingRun();
  const started: Array<Record<string, unknown>> = [];
  const fake: ServeSupervisor = { start: async () => {}, requestHandoff: async () => {}, shutdown: async () => {}, activeSha: () => undefined };
  const start = () => runServeSupervisor(["--", "serve"], {
    env: { RMD_SERVE_GENS_DIR: join(gensRoot, "cold-gens") },
    cwd: cold,
    run: coldCounter.run,
    headSha: () => "abc123",
    log: (step, extra) => void (step === "serve.supervisor_start" && started.push(extra ?? {})),
    create: () => fake,
    onSignal: () => {},
  });
  await start();
  await start();
  assert.equal(coldCounter.builds(), 1, "the second cold start reuses the first one's build");
  assert.deepEqual(started.map((row) => { const c = row.coldChildEntries as Record<string, unknown>; return [c.outcome, c.reused]; }), [["built", false], ["built", true]]);
});

test("W1-T10058: corrupt or missing workers cannot authorize reuse", async (t) => {
  const dir = tinyTree(t);
  const counter = countingRun();
  assert.equal((await buildSlotChildEntries(dir, counter.run)).outcome, "built");
  assert.equal((await buildSlotChildEntries(dir, counter.run)).reused, true, "control: an intact build is reused");
  assert.equal(counter.builds(), 1);
  const workers = manifestOf(dir).workers;
  assert.equal(workers.length, build.WORKER_ENTRIES.length);

  // A corrupt worker: same size, different bytes. The child-only CLI still certifies the tree.
  const corrupt = join(OUT(dir), workers[0]!.bundle);
  const bytes = readFileSync(corrupt);
  bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x20 ? 0x21 : 0x20;
  writeFileSync(corrupt, bytes);
  assert.match(await runCommand(process.execPath, [CHILD_ENTRY_BUILD_SCRIPT, "--check"], dir), /run-task: current/, "--check exits zero over a corrupt worker");
  const afterCorrupt = await buildSlotChildEntries(dir, counter.run);
  assert.deepEqual([afterCorrupt.outcome, afterCorrupt.reused], ["built", false]);
  assert.match(String(afterCorrupt.stale), /bundle-digest-mismatch/);
  assert.equal(counter.builds(), 2, "a corrupt worker forces a rebuild");
  assert.notDeepEqual(readFileSync(corrupt), bytes, "the rebuild replaced the corrupt worker");

  // A missing worker, with every child entry still valid.
  rmSync(join(OUT(dir), workers.at(-1)!.bundle));
  const afterMissing = await buildSlotChildEntries(dir, counter.run);
  assert.deepEqual([afterMissing.outcome, afterMissing.reused], ["built", false]);
  assert.match(String(afterMissing.stale), /bundle-missing/);
  assert.equal(counter.builds(), 3, "a missing worker forces a rebuild");

  // A manifest that lists no workers at all (an empty inventory) is not a certificate either.
  const path = join(OUT(dir), "manifest.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), workers: [] }));
  const afterEmpty = await buildSlotChildEntries(dir, counter.run);
  assert.deepEqual([afterEmpty.reused, counter.builds()], [false, 4]);
  assert.match(String(afterEmpty.stale), /worker-not-built/);
  assert.equal(manifestOf(dir).workers.length, build.WORKER_ENTRIES.length, "the rebuild restored every worker");
});

test("W1-T10058: changed or unqualified inputs rebuild instead of claiming reuse", async (t) => {
  const dir = tinyTree(t);
  const counter = countingRun();
  await buildSlotChildEntries(dir, counter.run);
  const cases: Array<[string, () => void, RegExp]> = [
    ["source", () => writeFileSync(join(dir, build.WORKER_ENTRIES[0]!), "export const at = 2;\n"), /source-changed/],
    ["lockfile", () => writeFileSync(join(dir, "package-lock.json"), '{ "lockfileVersion": 3, "n": 2 }\n'), /source-changed/],
    ["malformed manifest", () => writeFileSync(join(OUT(dir), "manifest.json"), "{ not json"), /no-manifest/],
    ["incomplete manifest", () => writeFileSync(join(OUT(dir), "manifest.json"), JSON.stringify({ schema: 2, recipe: build.RECIPE_VERSION })), /manifest-invalid/],
    ["missing manifest", () => rmSync(join(OUT(dir), "manifest.json")), /no-manifest/],
    ["missing child entry", () => rmSync(join(OUT(dir), `${build.CHILD_ENTRIES[1]!.name}.mjs`)), /bundle-missing/],
  ];
  for (const [label, mutate, why] of cases) {
    mutate();
    const verdict = await buildSlotChildEntries(dir, counter.run);
    assert.deepEqual([verdict.outcome, verdict.reused], ["built", false], label);
    assert.match(String(verdict.stale), why, label);
  }
  assert.equal(counter.builds(), 1 + cases.length, "every case rebuilt");
  assert.equal((await buildSlotChildEntries(dir, counter.run)).reused, true, "control: the rebuilt tree is reused");

  // An unavailable check: the module lacks the validators (an older script), or the check child itself fails.
  const old = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-old-`));
  t.after(() => rmSync(old, { recursive: true, force: true }));
  mkdirSync(join(old, "scripts"));
  writeFileSync(join(old, CHILD_ENTRY_BUILD_SCRIPT), 'import { mkdirSync } from "node:fs"; mkdirSync("dist", { recursive: true });\n');
  const oldCounter = countingRun();
  for (const expected of [1, 2]) {
    const verdict = await buildSlotChildEntries(old, oldCounter.run);
    assert.deepEqual([verdict.outcome, verdict.reused, oldCounter.builds()], ["built", false, expected]);
    assert.match(String(verdict.stale), /check-unsupported/);
  }
  const failing: RunCommand = async (command, args, cwd) => {
    if (args[0] !== CHILD_ENTRY_BUILD_SCRIPT) throw new Error("check child killed\nby a signal");
    return runCommand(command, args, cwd);
  };
  const checkFailed = await buildSlotChildEntries(dir, failing);
  assert.deepEqual([checkFailed.outcome, checkFailed.reused], ["built", false]);
  assert.equal(checkFailed.stale, "check-failed: check child killed");
  // Output that is not the positive, counted verdict never certifies: a truthy non-true, an uncounted true, or no JSON.
  for (const [output, why] of [['{"current":"yes"}', /^check-output-malformed$/], ['{"current":true,"children":3,"workers":0}', /^check-output-malformed$/], ["not json", /^check-output-malformed: /]] as const) {
    const verdict = await buildSlotChildEntries(dir, async (command, args, cwd) => (args[0] !== CHILD_ENTRY_BUILD_SCRIPT ? `${output}\n` : runCommand(command, args, cwd)));
    assert.deepEqual([verdict.outcome, verdict.reused], ["built", false], output);
    assert.match(String(verdict.stale), why, output);
  }
});

test("W1-T10058: default validation stays off-loop and preserves failed build fallback", async (t) => {
  const dir = tinyTree(t);
  assert.equal((await buildSlotChildEntries(dir)).reused, false);
  // The default runCommand validates in a child: the loop keeps turning while the qualification runs.
  let ticks = 0;
  const timer = setInterval(() => void (ticks += 1), 1);
  const reused = await buildSlotChildEntries(dir);
  clearInterval(timer);
  assert.deepEqual([reused.outcome, reused.reused, reused.stale], ["built", true, undefined]);
  assert.ok(ticks > 0, "the event loop ran during the default validation");

  // A failed build after a failed qualification keeps its failed outcome, its reason, and removes the manifest.
  writeFileSync(join(dir, build.CHILD_ENTRIES[0]!.source), "export const = ;\n");
  const failed = await buildSlotChildEntries(dir);
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.reused, undefined, "a failed build claims nothing about reuse");
  assert.match(String(failed.reason), /CHILD-ENTRY BUILD FAILED/);
  assert.throws(() => readFileSync(join(OUT(dir), "manifest.json")), /ENOENT/, "no manifest vouches for a failed build");
  const again = await buildSlotChildEntries(dir);
  assert.equal(again.outcome, "failed", "a failed build is never reused");

  // A tree without the script is still absent, and runs nothing.
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-bare-`));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const counter = countingRun();
  assert.deepEqual(Object.keys(await buildSlotChildEntries(bare, counter.run)).sort(), ["ms", "outcome"]);
  assert.equal(counter.calls.length, 0);
});
