/**
 * The object reaper's open-handle probe (`lsof +D <repo>/.git`, src/lib/clone-reaper.ts) ran through
 * `execFileSync` with no timeout, twice per armed reap, on the daemon loop — after #9710 took the
 * four git calls off it. `lsof +D` stats every file under the tree, and the store it guards held
 * 141,536 loose objects on 2026-10-06. These tests pin the awaited, bounded replacement: the loop
 * keeps running while lsof is pending, an lsof past its bound is killed and the decision row names
 * it, and the awaited probe answers exactly as the sync one on a real held and idle directory.
 */
import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Namespace imports: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as cloneLib from "../src/lib/clone-reaper.js";
import * as reaperLib from "../src/lib/object-reaper.js";
import * as runTaskMod from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const scratch = (label: string) => realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`)));

/** Runs `fn` with an executable named `name` first on PATH whose script is `body`. */
async function withBinScript<T>(name: string, body: string, fn: () => Promise<T>): Promise<T> {
  const binDir = scratch("probe-fake-bin");
  writeFileSync(join(binDir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(binDir, name), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = savedPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

/** Counts interval ticks while `pending` settles — a loop held by a sync spawn counts zero. */
async function ticksWhile<T>(pending: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 20);
  try {
    return { value: await pending(), ticks };
  } finally {
    clearInterval(timer);
  }
}

const noSweeps = {
  sweepTempDirs: () => ({ removed: [] }) as never,
  reapClonesSurvey: () => ({ reaped: [], bytesReclaimed: 0 }) as never,
  sweepWorkerHomes: () => ({ removed: [] }) as never,
  workerHomeRoot: () => "/nowhere",
};

test("the awaited open-handle probe keeps a timer firing while lsof is pending", async () => {
  const dir = scratch("probe-tick");
  const { value, ticks } = await withBinScript("lsof", "sleep 0.6\nexit 1", () =>
    ticksWhile(() => cloneLib.defaultOpenFileCountAsync(dir)),
  );
  assert.deepEqual(value, { count: 0 }, "lsof's no-match exit with no output reads as nothing held, as the sync probe reads it");
  assert.ok(ticks >= 10, `the loop must keep servicing timers while lsof runs (ticked ${ticks})`);
});

test("an open-handle probe past its bound is killed and the decision row names handle_probe timed_out", async () => {
  const store = gitRepo({ kind: "probe-bound" });
  const rows: Array<[string, Record<string, unknown>]> = [];
  let wired: unknown;
  const started = Date.now();
  await withBinScript("lsof", "exec sleep 30", () =>
    runTaskMod.logDiskReclaimRung({ root: scratch("probe-bound-root") } as never, (s, f) => rows.push([s, f]), {
      ...noSweeps,
      objectPolicy: () => ({ enabled: true }),
      ratifications: new Map(),
      objectRepoDir: () => store.dir,
      objectInflightDir: () => scratch("probe-bound-inflight"),
      // The REAL awaited reap; the rung's OWN default probe runs, only under a short bound.
      reapObjects: (dir, inflight, d) => {
        wired = d.openFileCountAsync;
        return reaperLib.reapGitObjectsAsync(dir, inflight, {
          ...d,
          ...(d.openFileCountAsync ? { openFileCountAsync: (p: string) => cloneLib.defaultOpenFileCountAsync(p, 300) } : {}),
          listWorktrees: () => [],
          looseObjectCount: () => reaperLib.LOOSE_OBJECT_FLOOR + 1,
          listProcesses: () => [],
        });
      },
    }),
  );
  assertWallClockBound(Date.now() - started, 15_000, "the hung lsof is killed at its bound, not waited out");
  assert.equal(wired, cloneLib.defaultOpenFileCountAsync, "the rung wires the awaited lsof probe by default");
  const declined = rows.find(([s]) => s === "run.disk_reclaim.objects_declined")?.[1];
  assert.ok(declined, `a probe killed at its bound refuses (rows: ${JSON.stringify(rows.map(([s]) => s))})`);
  assert.equal(declined.handle_probe, "timed_out", "the timeout is a named outcome, never a count");
  assert.match(String(declined.reason), /open-handle probe timed out after 300 ms/);
  assert.equal(rows.find(([s]) => s === "run.disk_reclaim.objects_decision"), undefined, "nothing is pruned");
});

test("a handle probe that times out at the second end of the quiesced window refuses, named", async () => {
  const store = gitRepo({ kind: "probe-window" });
  let calls = 0;
  const r = await reaperLib.reapGitObjectsAsync(store.dir, scratch("probe-window-inflight"), {
    listWorktrees: () => [],
    listProcesses: () => [],
    looseObjectCount: () => reaperLib.LOOSE_OBJECT_FLOOR + 1,
    openFileCountAsync: async () => (++calls === 1 ? { count: 0 } : { timedOutAfterMs: 5 }),
    runPrune: () => {
      throw new Error("must never be reached: the window closed before the prune");
    },
  });
  assert.equal(calls, 2, "the handle probe is sampled at both ends of the window");
  assert.equal(r.handleProbe, "timed_out");
  assert.match(String(r.refusedBecause), /^quiesced window closed before the prune: open-handle probe timed out after 5 ms/);
  assert.equal(r.pruned, 0);
});

test("the awaited open-handle probe answers its bound directly when lsof hangs", async () => {
  const dir = scratch("probe-direct");
  const started = Date.now();
  const probe = await withBinScript("lsof", "exec sleep 30", () => cloneLib.defaultOpenFileCountAsync(dir, 200));
  assertWallClockBound(Date.now() - started, 15_000, "the hung lsof is killed at its bound");
  assert.deepEqual(probe, { timedOutAfterMs: 200 });
});

test("the awaited and sync open-handle probes answer identically on a held and an idle directory", async () => {
  const dir = scratch("probe-parity");
  const file = join(dir, "held.txt");
  writeFileSync(file, "held\n");
  const idleSync = cloneLib.defaultOpenFileCount(dir);
  const idleAwaited = await cloneLib.defaultOpenFileCountAsync(dir);
  const fd = openSync(file, "r");
  let heldSync: number;
  let heldAwaited: unknown;
  try {
    heldSync = cloneLib.defaultOpenFileCount(dir);
    heldAwaited = await cloneLib.defaultOpenFileCountAsync(dir);
  } finally {
    closeSync(fd);
  }
  assert.equal(idleSync, 0, "nothing holds the idle directory");
  assert.deepEqual(idleAwaited, { count: idleSync });
  assert.ok(heldSync > 0, `this process holds a file open under the directory (sync read ${heldSync})`);
  assert.deepEqual(heldAwaited, { count: heldSync });
});

test("an lsof that cannot run reads as held on both probes, fail closed", async () => {
  const dir = scratch("probe-missing");
  const emptyBin = scratch("probe-empty-bin");
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin;
  let sync: number;
  let awaited: unknown;
  try {
    sync = cloneLib.defaultOpenFileCount(dir);
    awaited = await cloneLib.defaultOpenFileCountAsync(dir);
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(sync, 1);
  assert.deepEqual(awaited, { count: 1 });
});

test("the awaited origin read answers the url, null for a non-repo, and its bound when git hangs", async () => {
  const store = gitRepo({ kind: "probe-origin" });
  store.addRemote("origin", "https://github.com/craigoley/remudero.git");
  assert.equal(await cloneLib.defaultOriginOfAsync(store.dir), cloneLib.defaultOriginOf(store.dir));
  assert.equal(await cloneLib.defaultOriginOfAsync(store.dir), "https://github.com/craigoley/remudero.git");
  const plain = scratch("probe-origin-plain");
  assert.equal(await cloneLib.defaultOriginOfAsync(plain), null);
  const timedOut = await withBinScript("git", "exec sleep 30", () => cloneLib.defaultOriginOfAsync(store.dir, 200));
  assert.equal(timedOut, cloneLib.PROBE_TIMED_OUT, "a slow origin read is named, never read as a foreign repo");
});
