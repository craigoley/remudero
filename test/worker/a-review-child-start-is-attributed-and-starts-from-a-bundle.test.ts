// @census-reads: bin/rmd scripts/build-child-entries.mjs — copied into executable fixture trees.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { spawnRunChild } from "#src/lib/run-child.js";
import { materializeMainEntryFromStore } from "#src/lib/child-entry-store.js";
import { RUN_CHILD_SCHEMA, writeStatus } from "#src/lib/run-child-contract.js";
import { buildFreshTreeReviewRunner, buildReviewerCodeFreshnessGate, spawnRmdReviewForFreshTree } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const build = createRequire(import.meta.url)("#scripts/build-child-entries.mjs");
const sha = "a".repeat(40);
const sourceHash = "b".repeat(64);
type Row = Record<string, unknown>;

test("test/worker/a-review-child-start-is-attributed-and-starts-from-a-bundle.test.ts", async () => {
  for (const terminalFirst of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "rmd-review-launch-segments-"));
    const stateRoot = join(root, "state");
    const engineRoot = join(stateRoot, "engines", sourceHash);
    mkdirSync(engineRoot, { recursive: true });
    writeFileSync(join(engineRoot, "engine.json"), JSON.stringify({ sha, sourceHash, builtAt: 1 }));
    const capability = join(engineRoot, "entry.mjs");
    writeFileSync(capability, "console.log('detached-work-v1:review');");
    const rows: Row[] = [];
    const entryKind = terminalFirst ? "tsx" as const : "bundle" as const;
    let now = 100;
    let released = 0;
    const child = Object.assign(new EventEmitter(), { pid: 4242, unref() {} }) as ChildProcess;
    let dir = "";
    let settled: Promise<unknown> | undefined;
    const result = { taskId: "PR7", runId: "review", merged: false, verdict: "no_pr" as const, costUsd: 0 };
    const status = (state: "running" | "done") => writeStatus(dir, {
      schema: RUN_CHILD_SCHEMA, runId: basename(dir), engineSha: sha, entryKind,
      identity: { pid: 4242, startTicks: "proc:1", containerGeneration: { containerId: "fixture", initStart: "1" } },
      state, phase: "review", heartbeatAt: now, ...(state === "done" ? { result } : {}),
    });
    try {
      const handle = await spawnRunChild({ taskId: "PR7", lane: "review", stateRoot, repoDir: root, root,
        work: { kind: "review", prNumber: 7, headSha: sha, reviewKey: "review-7" },
        plan: async () => { now += 5; return { plan: { tasks: [] } }; }, options: {},
        log: (step, extra) => { rows.push({ step, ...extra }); },
      }, {
        clock: () => now, mainSha: async () => { now += 11; return sha; },
        engine: { isCurrent: () => { now += 2; return true; }, git: async () => "" },
        launch: () => { now += 7; return { argv: [capability], kind: entryKind, reason: "fixture-entry", cwd: engineRoot, engineRoot }; },
        reserve: async () => { now += 29; return { id: "held", workerClass: "review", estimateMib: 1,
          estimateSource: { kind: "default-unmeasured" }, bindRoot() {}, releaseOccupancy() { released++; } }; },
        workerAdmissionHold: () => undefined,
        spawn: (_cmd, args) => { dir = String(args.at(-1)); return child; },
        watch: false, pollMs: 2,
        probe: { process: () => ({ state: "alive", start: "proc:1" }), generation: () => ({ containerId: "fixture", initStart: "1" }) },
      });
      assert.ok(handle.started);
      settled = handle.settled;
      assert.equal(rows.some(row => row.step === "run_child.launch_segments"), false, "no heartbeat has been observed");
      now += 43;
      status(terminalFirst ? "done" : "running");
      for (let i = 0; i < 50 && !rows.some(row => row.step === "run_child.launch_segments"); i++) await delay(2);
      const segments = rows.filter(row => row.step === "run_child.launch_segments");
      assert.equal(segments.length, 1);
      assert.deepEqual(segments[0], { step: "run_child.launch_segments", task_id: "PR7", run_id: handle.runId,
        lane: "review", engine_ms: 13, entry_ms: 7, entry_kind: entryKind, entry_reason: "fixture-entry",
        plan_ms: 5, admission_wait_ms: 29, setup_ms: 0, spawn_to_heartbeat_ms: 43 });
      now += 100;
      status("done");
      assert.deepEqual(await handle.settled, result);
      assert.equal(rows.filter(row => row.step === "run_child.launch_segments").length, 1);
      assert.equal(released, 1);
    } finally {
      if (dir) status("done");
      child.emit("exit", 0, null);
      await settled;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function reviewerFixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-bundle-store-"));
  const tree = join(root, `reviewer-${sha.slice(0, 12)}`);
  mkdirSync(tree);
  writeFileSync(join(tree, "package.json"), '{"type":"module"}');
  for (const source of [...build.CHILD_ENTRIES.map((entry: { source: string }) => entry.source), ...build.WORKER_ENTRIES]) {
    mkdirSync(dirname(join(tree, source)), { recursive: true });
    writeFileSync(join(tree, source), source === "src/run-task.ts" ? [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(new URL('../observed.json', import.meta.url), JSON.stringify({",
      "  bundled: globalThis.__rmd_bundled === true, entry: process.env.RMD_MAIN_ENTRY, args: process.argv.slice(2) }));",
    ].join("\n") : "export const fixture = true;\n");
  }
  mkdirSync(join(tree, "bin"));
  mkdirSync(join(tree, "scripts"));
  copyFileSync(join(REPO_ROOT, "bin/rmd"), join(tree, "bin/rmd"));
  copyFileSync(join(REPO_ROOT, "scripts/build-child-entries.mjs"), join(tree, "scripts/build-child-entries.mjs"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"));
  return { root, tree, store: join(root, "store") };
}

test("W1-T11152 criterion 2: a fresh-tree review runs the stored bundle and ledgers the actual wrapper choice", async () => {
  const f = reviewerFixture();
  try {
    const hash = build.sourceHash(f.tree);
    await build.buildChildEntries({ root: f.tree, outDir: join(f.store, hash), layoutDir: build.OUT_DIR });
    assert.equal(existsSync(join(f.tree, "dist")), false);
    const rows: Row[] = [];
    const env = { ...process.env, NODE_V8_COVERAGE: "" };
    const runner = buildFreshTreeReviewRunner("/repo", {
      git: () => "", addWorktree: () => {}, inspectExistingWorktree: () => "reusable", prepareWorktree: () => true,
      withWorktreeLease: async (_tree, action) => action(), worktreeRoot: f.root,
      spawnReview: (tree, args, failure, _env, entry) => spawnRmdReviewForFreshTree(tree, args, failure, env, entry, { storeRoot: f.store }),
    });
    const gate = buildReviewerCodeFreshnessGate(
      () => ({ status: "stale", codeSha: "old", originMainSha: sha, changedPaths: ["src/lib/review.ts"] }),
      (step, extra) => { rows.push({ step, ...extra }); }, async () => assert.fail("must use the fresh tree"), runner,
    );
    for (let i = 0; i < 2; i++) {
      assert.equal(await gate.call("7", [], {} as never), 0);
      const actual = JSON.parse(readFileSync(join(f.tree, "observed.json"), "utf8"));
      assert.equal(actual.bundled, true);
      assert.equal(actual.entry, "bundle:source-hash-match");
      assert.deepEqual(actual.args, ["review", "7", "--judge-at-own-start"]);
      assert.equal(rows.at(-1)?.step, "review.ran_from_fresh_tree");
      assert.equal(rows.at(-1)?.entry_kind, "bundle");
      assert.equal(rows.at(-1)?.entry_reason, `source-hash-match; ${i === 0 ? "store-hit" : "tree-current"}`);
    }
    assert.equal(existsSync(join(f.tree, build.OUT_DIR, build.MAIN_ATTEMPT_NAME)), false, "reviews do not poison daemon boot attempts");
    writeFileSync(join(f.tree, build.OUT_DIR, build.MAIN_OFF_NAME), "");
    assert.equal(await gate.call("7", [], {} as never), 0);
    assert.equal(JSON.parse(readFileSync(join(f.tree, "observed.json"), "utf8")).bundled, false);
    assert.equal(rows.at(-1)?.entry_kind, "tsx");
    assert.equal(rows.at(-1)?.entry_reason, "switched-off; switched-off");
    rmSync(join(f.tree, build.OUT_DIR), { recursive: true });
    mkdirSync(join(f.tree, build.OUT_DIR), { recursive: true });
    writeFileSync(join(f.tree, build.OUT_DIR, build.MAIN_OFF_NAME), "");
    assert.equal(await gate.call("7", [], {} as never), 0);
    assert.equal(rows.at(-1)?.entry_kind, "tsx");
    assert.equal(rows.at(-1)?.entry_reason, "switched-off; switched-off");
    assert.equal(existsSync(join(f.tree, build.OUT_DIR, "manifest.json")), false, "a store copy cannot erase the off switch before the first launch");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("W1-T11152 criterion 2: a carried source hash is reused only while its source signature still matches", async () => {
  const f = reviewerFixture();
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const originalRead = fs.readFileSync;
  try {
    const hash = build.sourceHash(f.tree);
    await build.buildChildEntries({ root: f.tree, outDir: join(f.store, hash), layoutDir: build.OUT_DIR });
    const sourceReads: string[] = [];
    fs.readFileSync = ((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      if (String(path).startsWith(join(f.tree, "src") + "/")) sourceReads.push(String(path));
      return Reflect.apply(originalRead, fs, [path, ...args]);
    }) as typeof readFileSync;
    syncBuiltinESMExports();
    const prepared = materializeMainEntryFromStore(f.tree, f.store);
    assert.deepEqual(prepared.lookup, { outcome: "hit", hash });
    assert.equal(prepared.source?.hash, hash);
    assert.ok(sourceReads.includes(join(f.tree, "src/run-task.ts")), "positive control: the first hash read the source corpus");
    sourceReads.length = 0;
    assert.equal((await build.mainEntry(f.tree, "review", { source: prepared.source })).kind, "bundle");
    assert.deepEqual(sourceReads, [], "the wrapper's judgement reuses the carried hash without reading source contents again");
    writeFileSync(join(f.tree, "src/run-task.ts"), "throw new Error('changed after materialization');\n");
    assert.deepEqual(await build.mainEntry(f.tree, "review", { source: prepared.source }), { kind: "tsx", reason: "source-signature-changed" });
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T11152 criterion 2: a missing, unreadable or corrupt store preserves tsx and reports why", async () => {
  const failures = { empty: /store-empty/, "no-match": /no-stored-build/, unreadable: /store-error: ENOTDIR/, corrupt: /stored-bundle-/ };
  for (const [failure, reason] of Object.entries(failures)) {
    const f = reviewerFixture();
    try {
      if (failure === "unreadable") writeFileSync(f.store, "not a directory");
      if (failure === "no-match") mkdirSync(join(f.store, "c".repeat(64)), { recursive: true });
      if (failure === "corrupt") {
        const hash = build.sourceHash(f.tree);
        await build.buildChildEntries({ root: f.tree, outDir: join(f.store, hash), layoutDir: build.OUT_DIR });
        writeFileSync(join(f.store, hash, "run-task.mjs"), "throw new Error('corrupt payload');");
      }
      let entry: { kind: string; reason: string } | undefined;
      assert.equal(await spawnRmdReviewForFreshTree(f.tree, ["7"], undefined,
        { ...process.env, NODE_V8_COVERAGE: "" }, value => { entry = value; }, { storeRoot: f.store }), 0);
      const actual = JSON.parse(readFileSync(join(f.tree, "observed.json"), "utf8"));
      assert.equal(actual.bundled, false);
      assert.equal(actual.entry, "tsx:no-manifest");
      assert.equal(entry?.kind, "tsx");
      assert.match(String(entry?.reason), reason);
      assert.equal(existsSync(join(f.tree, "dist")), false, "a miss must not build in the reviewer tree");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
