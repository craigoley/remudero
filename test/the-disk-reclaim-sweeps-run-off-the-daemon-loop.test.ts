/**
 * After #9710 took the object reaper's git calls off the daemon loop, `logDiskReclaimRung`'s other
 * three sweeps still ran synchronously on it: the temp-dir sweep, the clone survey (a recursive size
 * walk of each review clone's ~463 MiB node_modules, plus a git and an `lsof +D` spawn per clone) and
 * the worker-home sweep (a whole-ledger read per candidate). Each now has an awaited twin. These
 * tests pin that the rung defaults to the twins, that a timer keeps firing while one is pending,
 * and that each twin decides EXACTLY as its sync sweep on the same real fixture.
 */
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Namespace imports: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as cloneLib from "../src/lib/clone-reaper.js";
import * as tmpLib from "../src/lib/tmp.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as homeLib from "../src/lib/worker-home.js";
import * as runTaskMod from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const scratch = (label: string) => realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`)));
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 6, 12);
const longAgo = new Date(NOW - 3 * DAY_MS);
const recently = new Date(NOW - 60_000);

/** Counts interval ticks while `pending` settles — a loop held by sync work counts zero. */
async function ticksWhile<T>(pending: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 20);
  try {
    return { value: await pending(), ticks };
  } finally {
    clearInterval(timer);
  }
}

const later = <T>(ms: number, value: () => Promise<T>): Promise<T> => new Promise((r) => setTimeout(r, ms)).then(value);
const refuse = async (): Promise<never> => {
  throw new Error("EACCES: injected");
};

// ── the rung ────────────────────────────────────────────────────────────────────────────────

test("the disk-reclaim rung defaults every sweep to its awaited twin", () => {
  assert.deepEqual(
    { ...runTaskMod.DISK_RECLAIM_DEFAULT_SWEEPS },
    {
      sweepTempDirs: tmpLib.sweepStaleTempDirsAsync,
      reapClonesSurvey: runTaskMod.logCloneReapSurveyAsync,
      sweepWorkerHomes: homeLib.sweepStaleWorkerHomesAsync,
    },
  );
});

test("the disk-reclaim rung keeps a timer firing while its sweeps are pending, and reports what they found", async () => {
  const { value, ticks } = await ticksWhile(() =>
    runTaskMod.logDiskReclaimRung({ root: scratch("rung-tick-root") } as never, () => {}, {
      sweepTempDirs: () => later(200, async () => ({ removed: ["rmd-a"], kept: [], oldestKeptAgeMs: null })),
      reapClonesSurvey: () => later(200, async () => ({ candidates: [], reaped: ["/x"], bytesReclaimed: 7, dryRun: false })),
      sweepWorkerHomes: () => later(200, async () => ({ removed: ["worker-home-1"], kept: [] })),
      workerHomeRoot: () => "/nowhere",
      reapObjects: (() => ({ pruned: 0, looseBefore: 9000 })) as never,
    }),
  );
  assert.ok(ticks >= 15, `the loop must keep servicing timers while the sweeps run (ticked ${ticks})`);
  assert.equal(value.tempDirsRemoved, 1);
  assert.equal(value.clonesReaped, 1);
  assert.equal(value.cloneBytesReclaimed, 7);
  assert.equal(value.workerHomesRemoved, 1);
});

// ── temp dirs ───────────────────────────────────────────────────────────────────────────────

function tempRootFixture(): string {
  const root = scratch("sweep-tmp");
  for (const name of ["rmd-old", "remudero-legacy-old", "rmd-fresh", "unrelated-old"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "rmd-old-file"), "a file, never a candidate\n");
  writeFileSync(join(root, "rmd-old", "inner.txt"), "x\n");
  for (const name of ["rmd-old", "remudero-legacy-old", "unrelated-old", "rmd-old-file"]) utimesSync(join(root, name), longAgo, longAgo);
  utimesSync(join(root, "rmd-fresh"), recently, recently);
  return root;
}

test("the awaited temp sweep decides exactly as the sync sweep on the same real tree", async () => {
  const syncRoot = tempRootFixture();
  const awaitedRoot = tempRootFixture();
  const sync = tmpLib.sweepStaleTempDirs({ root: syncRoot, now: () => NOW });
  const awaited = await tmpLib.sweepStaleTempDirsAsync({ root: awaitedRoot, now: () => NOW });
  assert.deepEqual(awaited, sync);
  assert.deepEqual([...sync.removed].sort(), ["remudero-legacy-old", "rmd-old"], "the fixture reaches the removal arm");
  assert.deepEqual(fs.readdirSync(awaitedRoot).sort(), fs.readdirSync(syncRoot).sort());
});

test("the awaited temp sweep keeps a timer firing while a removal is pending", async () => {
  const root = tempRootFixture();
  const { value, ticks } = await ticksWhile(() =>
    tmpLib.sweepStaleTempDirsAsync({
      root,
      now: () => NOW,
      fsAsync: { readdir: fsp.readdir, stat: fsp.stat, rm: ((p: string, o: object) => later(150, () => fsp.rm(p, o))) as never },
    }),
  );
  assert.equal(value.removed.length, 2);
  assert.ok(ticks >= 10, `the loop must keep servicing timers while the sweep runs (ticked ${ticks})`);
});

test("the awaited temp sweep keeps every failure arm the sync sweep keeps", async () => {
  assert.deepEqual(await tmpLib.sweepStaleTempDirsAsync({ root: join(scratch("sweep-tmp-gone"), "absent") }), {
    removed: [],
    kept: [],
    oldestKeptAgeMs: null,
  });
  const root = tempRootFixture();
  const statRefused = await tmpLib.sweepStaleTempDirsAsync({
    root,
    now: () => NOW,
    fsAsync: { readdir: fsp.readdir, stat: refuse as never, rm: fsp.rm },
  });
  assert.deepEqual(statRefused, { removed: [], kept: [], oldestKeptAgeMs: null }, "a vanished entry is skipped");
  const rmRefused = await tmpLib.sweepStaleTempDirsAsync({
    root,
    now: () => NOW,
    fsAsync: { readdir: fsp.readdir, stat: fsp.stat, rm: refuse as never },
  });
  assert.deepEqual(rmRefused.removed, []);
  assert.deepEqual([...rmRefused.kept].sort(), ["remudero-legacy-old", "rmd-fresh", "rmd-old"], "a failed removal is kept");
  assert.equal(rmRefused.oldestKeptAgeMs, 3 * DAY_MS);
});

// ── worker homes ────────────────────────────────────────────────────────────────────────────

/** `<base>/worker-home-*` candidates beside `<base>/state/{inflight,ledger.ndjson}`. */
function workerHomeFixture(): { root: string; stateRoot: string } {
  const base = scratch("sweep-homes");
  const inflight = join(base, "state", "inflight");
  mkdirSync(inflight, { recursive: true });
  writeFileSync(join(inflight, "W1-T1.lock"), JSON.stringify({ pid: 1, run_id: "live-1" }));
  writeFileSync(join(inflight, "notes.txt"), "not a lock\n");
  writeFileSync(
    join(base, "state", "ledger.ndjson"),
    `${JSON.stringify({ step: "verdict", run_id: "done-1" })}\n{torn\n\n${JSON.stringify({ step: "run.start", run_id: "old-1" })}\n`,
  );
  for (const name of ["worker-home-live-1", "worker-home-done-1", "worker-home-old-1", "worker-home-fresh-1", "unrelated"]) {
    mkdirSync(join(base, name));
  }
  writeFileSync(join(base, "worker-home-file"), "a file\n");
  for (const name of ["worker-home-live-1", "worker-home-done-1", "worker-home-old-1"]) utimesSync(join(base, name), longAgo, longAgo);
  utimesSync(join(base, "worker-home-fresh-1"), recently, recently);
  return { root: join(base, "worker-home"), stateRoot: base };
}

test("the awaited worker-home sweep decides and logs exactly as the sync sweep on the same real tree", async () => {
  const a = workerHomeFixture();
  const b = workerHomeFixture();
  const syncRows: Array<[string, Record<string, unknown>]> = [];
  const awaitedRows: Array<[string, Record<string, unknown>]> = [];
  const sync = homeLib.sweepStaleWorkerHomes(a.root, { stateRoot: a.stateRoot, now: () => NOW, log: (s, f) => syncRows.push([s, f]) });
  const awaited = await homeLib.sweepStaleWorkerHomesAsync(b.root, {
    stateRoot: b.stateRoot,
    now: () => NOW,
    log: (s, f) => awaitedRows.push([s, f]),
  });
  assert.deepEqual(awaited, sync);
  assert.deepEqual(awaitedRows, syncRows);
  assert.deepEqual([...sync.removed].sort(), ["worker-home-done-1", "worker-home-old-1"], "both removal arms are reached");
  assert.deepEqual([...sync.kept].sort(), ["worker-home-file", "worker-home-fresh-1", "worker-home-live-1"]);
});

test("the awaited worker-home sweep keeps a timer firing while a removal is pending", async () => {
  const f = workerHomeFixture();
  const { value, ticks } = await ticksWhile(() =>
    homeLib.sweepStaleWorkerHomesAsync(f.root, {
      stateRoot: f.stateRoot,
      now: () => NOW,
      fsAsync: { rm: ((p: string, o: object) => later(150, () => fsp.rm(p, o))) as never },
    }),
  );
  assert.equal(value.removed.length, 2);
  assert.ok(ticks >= 10, `the loop must keep servicing timers while the sweep runs (ticked ${ticks})`);
});

test("the awaited worker-home sweep keeps every failure arm the sync sweep keeps", async () => {
  assert.deepEqual(await homeLib.sweepStaleWorkerHomesAsync(join(scratch("sweep-homes-gone"), "absent", "worker-home")), {
    removed: [],
    kept: [],
  });
  const f = workerHomeFixture();
  const statRefused = await homeLib.sweepStaleWorkerHomesAsync(f.root, { stateRoot: f.stateRoot, now: () => NOW, fsAsync: { stat: refuse as never } });
  assert.deepEqual(statRefused, { removed: [], kept: [] }, "a vanished entry is skipped");
  const rmRefused = await homeLib.sweepStaleWorkerHomesAsync(f.root, { stateRoot: f.stateRoot, now: () => NOW, fsAsync: { rm: refuse as never } });
  assert.deepEqual(rmRefused.removed, [], "a failed removal on either arm is kept");
  assert.equal(rmRefused.kept.length, 5);
  // An unreadable lock proves nothing, and an unreadable ledger has nothing to find: both fall to age.
  const readRefused = await homeLib.sweepStaleWorkerHomesAsync(f.root, {
    stateRoot: f.stateRoot,
    now: () => NOW,
    fsAsync: { readFile: refuse as never },
  });
  assert.deepEqual([...readRefused.removed].sort(), ["worker-home-done-1", "worker-home-live-1", "worker-home-old-1"]);
  // An absent inflight dir proves nothing either: the live run's home falls to age, as in the sync sweep.
  const g = workerHomeFixture();
  const h = workerHomeFixture();
  const noLocks = { now: () => NOW, inflightDir: join(scratch("sweep-homes-no-inflight"), "absent") };
  const syncNoLocks = homeLib.sweepStaleWorkerHomes(g.root, { stateRoot: g.stateRoot, ...noLocks });
  const awaitedNoLocks = await homeLib.sweepStaleWorkerHomesAsync(h.root, { stateRoot: h.stateRoot, ...noLocks });
  assert.deepEqual(awaitedNoLocks, syncNoLocks);
  assert.ok(awaitedNoLocks.removed.includes("worker-home-live-1"));
});

// ── review clones ───────────────────────────────────────────────────────────────────────────

const FLEET_ORIGIN = "https://github.com/craigoley/remudero.git";

/** A scratch root holding every disposition the clone survey can reach on a real tree. */
function cloneSurveyFixture(): string {
  const root = scratch("sweep-clones");
  const place = (origin: string, dest: string) => {
    const store = gitRepo({ kind: "sweep-clone-src" });
    store.addRemote("origin", origin);
    renameSync(store.dir, dest);
  };
  place(FLEET_ORIGIN, join(root, "review-old"));
  symlinkSync(join(root, "plain"), join(root, "review-old", "escape"));
  mkdirSync(join(root, "review-nested"));
  place(FLEET_ORIGIN, join(root, "review-nested", "repo"));
  place(FLEET_ORIGIN, join(root, "review-fresh"));
  place("https://example.invalid/other.git", join(root, "foreign"));
  mkdirSync(join(root, "plain"));
  mkdirSync(join(root, "linked"));
  writeFileSync(join(root, "linked", ".git"), "gitdir: /nowhere\n");
  writeFileSync(join(root, "afile"), "a file, never a candidate\n");
  symlinkSync(join(root, "plain"), join(root, "link"));
  for (const name of ["review-old", "review-nested", "foreign", "plain", "linked"]) utimesSync(join(root, name), longAgo, longAgo);
  utimesSync(join(root, "review-fresh"), recently, recently);
  return root;
}

const byPath = (cs: readonly cloneLib.CloneCandidate[], root: string) =>
  [...cs].map((c) => ({ ...c, path: c.path.slice(root.length) })).sort((x, y) => x.path.localeCompare(y.path));

test("the awaited clone survey decides exactly as the sync survey on the same real tree", async () => {
  const root = cloneSurveyFixture();
  const sync = cloneLib.reapStaleClones([root], { dryRun: true, now: () => NOW });
  const awaited = await cloneLib.reapStaleClonesAsync([root], { dryRun: true, now: () => NOW });
  assert.deepEqual(awaited, sync, "same dispositions, bytes and ages, byte for byte");
  assert.deepEqual(
    byPath(sync.candidates, root).map((c) => `${c.path}:${c.disposition}`),
    ["/foreign:not-a-fleet-clone", "/link:symlink", "/linked:not-a-fleet-clone", "/plain:not-a-fleet-clone", "/review-fresh:too-recent", "/review-nested:would-reap", "/review-old:would-reap"],
  );
  assert.ok(sync.candidates.every((c) => c.disposition !== "would-reap" || c.bytes > 0), "the size walk reads real bytes");

  const armedRoot = cloneSurveyFixture();
  const syncArmed = cloneLib.reapStaleClones([root], { now: () => NOW });
  const awaitedArmed = await cloneLib.reapStaleClonesAsync([armedRoot], { now: () => NOW });
  assert.deepEqual(
    byPath(awaitedArmed.candidates, armedRoot).map((c) => `${c.path}:${c.disposition}`),
    byPath(syncArmed.candidates, root).map((c) => `${c.path}:${c.disposition}`),
  );
  assert.equal(awaitedArmed.reaped.length, 2);
  assert.deepEqual(fs.readdirSync(armedRoot).sort(), fs.readdirSync(root).sort(), "the same entries survive both reaps");
});

test("the awaited clone survey keeps a timer firing while its probes are pending", async () => {
  const root = cloneSurveyFixture();
  const { value, ticks } = await ticksWhile(() =>
    cloneLib.reapStaleClonesAsync([root], {
      dryRun: true,
      now: () => NOW,
      openFileCountAsync: (dir) => later(100, () => cloneLib.defaultOpenFileCountAsync(dir)),
    }),
  );
  assert.equal(value.candidates.filter((c) => c.disposition === "would-reap").length, 2);
  assert.ok(ticks >= 10, `the loop must keep servicing timers while the survey runs (ticked ${ticks})`);
});

test("the awaited clone survey names a probe killed at its bound, and keeps every other arm", async () => {
  const root = cloneSurveyFixture();
  const dispositions = async (deps: cloneLib.CloneReapDeps) =>
    byPath((await cloneLib.reapStaleClonesAsync([root], { now: () => NOW, dryRun: true, ...deps })).candidates, root)
      .filter((c) => c.path.startsWith("/review-"))
      .map((c) => c.disposition);
  assert.deepEqual(await dispositions({ originOfAsync: async () => cloneLib.PROBE_TIMED_OUT }), [
    "probe-timed-out",
    "probe-timed-out",
    "probe-timed-out",
  ]);
  assert.deepEqual(await dispositions({ openFileCountAsync: async () => ({ timedOutAfterMs: 5 }) }), [
    "probe-timed-out",
    "probe-timed-out",
    "probe-timed-out",
  ]);
  assert.deepEqual(await dispositions({ openFileCountAsync: async () => ({ count: 2 }) }), ["in-use", "in-use", "in-use"]);
  // An injected SYNC probe still answers the awaited survey.
  assert.deepEqual(await dispositions({ originOf: () => FLEET_ORIGIN, openFileCount: () => 0 }), ["too-recent", "would-reap", "would-reap"]);

  const outside = await cloneLib.reapStaleClonesAsync([root], { fsAsync: { ...fsp, readdir: (async () => [".."]) as never } });
  assert.deepEqual(outside.candidates.map((c) => c.disposition), ["outside-root"]);
  const vanished = await cloneLib.reapStaleClonesAsync([root], { fsAsync: { ...fsp, lstat: refuse as never } });
  assert.deepEqual(vanished.candidates, [], "an entry that vanished between readdir and lstat is skipped");
  const rmRefused = await cloneLib.reapStaleClonesAsync([root], { now: () => NOW, fsAsync: { ...fsp, rm: refuse as never } });
  assert.deepEqual(rmRefused.reaped, []);
  assert.equal(rmRefused.candidates.filter((c) => c.disposition === "remove-failed").length, 2);
  assert.deepEqual((await cloneLib.reapStaleClonesAsync([join(root, "absent")])).candidates, []);
});

test("the awaited size walk counts what the sync walk counts and skips what it skips", async () => {
  const root = cloneSurveyFixture();
  const dir = join(root, "review-old");
  assert.equal(await cloneLib.dirSizeBytesAsync(dir), cloneLib.dirSizeBytes(dir));
  assert.equal(await cloneLib.dirSizeBytesAsync(join(root, "absent")), 0);
  const lstatRefused = await cloneLib.dirSizeBytesAsync(dir, { ...fsp, lstat: refuse as never });
  assert.equal(lstatRefused, 0, "an unstattable entry contributes nothing");
});

test("the awaited clone survey writes the same daemon.clone_reap line as the sync survey", async () => {
  const root = cloneSurveyFixture();
  const policy = () => ({ enabled: false, maxAgeHours: 24 });
  const syncRows: Array<[string, Record<string, unknown>]> = [];
  const awaitedRows: Array<[string, Record<string, unknown>]> = [];
  const cfg = { root: scratch("sweep-clones-cfg") } as never;
  runTaskMod.logCloneReapSurvey(cfg, (s, f) => syncRows.push([s, f]), { roots: () => [root], policy, ratifications: new Map() });
  await runTaskMod.logCloneReapSurveyAsync(cfg, (s, f) => awaitedRows.push([s, f]), { roots: () => [root], policy, ratifications: new Map() });
  assert.deepEqual(awaitedRows, syncRows);
  assert.ok(syncRows.some(([s]) => s === "daemon.clone_reap"));
  const failed = await runTaskMod.logCloneReapSurveyAsync(cfg, () => {}, {
    policy: () => {
      throw new Error("policy.yaml unreadable");
    },
  });
  assert.equal(failed, null, "a survey that throws is best-effort null, as the sync survey answers");
});
