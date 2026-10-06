/**
 * MEASURED 2026-10-06 (Azure daemon.loop_lag since boot at 0d90c2a98): the object reaper's armed
 * prune ran through `execFileSync` inside the daemon process for 161 s, producing 235 s of loop lag,
 * the largest single stall on the daemon. These tests pin the awaited replacement: the loop keeps
 * running while the prune is pending, a prune past its bound is killed and the decision row names
 * the timeout, and the awaited reap answers exactly as the sync one does on a real store.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
// Namespace imports: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as reaperLib from "../src/lib/object-reaper.js";
import * as runTaskMod from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const { LOOSE_OBJECT_FLOOR, OBJECT_PRUNE_EXPIRY, reapGitObjects } = reaperLib;
const reapGitObjectsAsync: typeof reaperLib.reapGitObjectsAsync = (...a) => reaperLib.reapGitObjectsAsync(...a);
const logDiskReclaimRung = (...a: Parameters<typeof runTaskMod.logDiskReclaimRung>) => runTaskMod.logDiskReclaimRung(...a);

const scratch = (label: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));

/** Runs `fn` with a `git` on PATH whose script is `body` (it may `exec` the real git). */
async function withGitScript<T>(body: (realGit: string) => string, fn: () => Promise<T>): Promise<T> {
  const binDir = scratch("reaper-fake-bin");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(binDir, "git"), `#!/bin/sh\n${body(realGit)}\n`);
  chmodSync(join(binDir, "git"), 0o755);
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

/** A real store with a local identity, holding `aged` unreachable loose blobs two days old and
 *  `fresh` ones written now — the first set is past the prune expiry, the second is not. `kept` is
 *  every loose file the prune must leave: the fresh blobs plus the seed commit's reachable objects. */
function storeWithLooseBlobs(aged: number, fresh: number): { dir: string; kept: number } {
  const store = gitRepo({ kind: "reaper-parity" });
  store.git("config", "user.name", "remudero-test-reaper");
  store.git("config", "user.email", "reaper@remudero.invalid");
  const reachable = looseFiles(store.dir);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  for (let i = 0; i < aged + fresh; i++) {
    const body = Buffer.from(`unreachable blob ${i}\n`);
    const raw = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
    const sha = createHash("sha1").update(raw).digest("hex");
    const dir = join(store.dir, ".git", "objects", sha.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, sha.slice(2));
    writeFileSync(file, deflateSync(raw));
    if (i < aged) utimesSync(file, twoDaysAgo, twoDaysAgo);
  }
  return { dir: store.dir, kept: reachable + fresh };
}

function looseFiles(dir: string): number {
  const objects = join(dir, ".git", "objects");
  return readdirSync(objects)
    .filter((d) => /^[0-9a-f]{2}$/.test(d))
    .reduce((n, d) => n + readdirSync(join(objects, d)).length, 0);
}

const quiet = { openFileCount: () => 0, listProcesses: () => [] };

test("the awaited object prune keeps a timer firing while its git prune is pending", async () => {
  const store = gitRepo({ kind: "reaper-tick" });
  const inflight = scratch("reaper-tick-inflight");
  const { value, ticks } = await withGitScript(
    (realGit) => `sleep 0.6\nexec ${realGit} "$@"`,
    () => ticksWhile(() => reapGitObjectsAsync(store.dir, inflight, {
      ...quiet,
      listWorktrees: () => [],
      looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
    })),
  );
  assert.equal(value.refusedBecause, undefined, "the quiet store is pruned, not refused");
  assert.equal(value.carriedBy, "quiet");
  assert.equal(value.pruneTimedOutAfterMs, undefined, "a prune inside its bound is not a timeout");
  assert.ok(ticks >= 10, `the loop must keep servicing timers while the prune runs (ticked ${ticks})`);
});

test("a prune past its bound is killed and the decision row names the timeout", async () => {
  const store = gitRepo({ kind: "reaper-bound" });
  const rows: Array<[string, Record<string, unknown>]> = [];
  const started = Date.now();
  await withGitScript(
    () => "exec sleep 30",
    () => logDiskReclaimRung({ root: scratch("reaper-bound-root") } as never, (s, f) => rows.push([s, f]), {
      sweepTempDirs: () => ({ removed: [] }) as never,
      reapClonesSurvey: () => ({ reaped: [], bytesReclaimed: 0 }) as never,
      sweepWorkerHomes: () => ({ removed: [] }) as never,
      workerHomeRoot: () => "/nowhere",
      objectPolicy: () => ({ enabled: true }),
      ratifications: new Map(),
      objectRepoDir: () => store.dir,
      objectInflightDir: () => scratch("reaper-bound-inflight"),
      objectOpenFileCount: () => 0,
      // The REAL awaited reap and its REAL bounded prune; only the probes and the bound are pinned.
      reapObjects: (dir, inflight, d) => reapGitObjectsAsync(dir, inflight, {
        ...d,
        listWorktrees: () => [],
        looseObjectCount: () => LOOSE_OBJECT_FLOOR + 1,
        listProcesses: () => [],
        pruneTimeoutMs: 300,
      }),
    }),
  );
  assert.ok(Date.now() - started < 15_000, "the hung prune is killed at its bound, not waited out");
  const decision = rows.find(([s]) => s === "run.disk_reclaim.objects_decision")?.[1];
  assert.ok(decision, `the armed pass writes its decision row (rows: ${JSON.stringify(rows.map(([s]) => s))})`);
  assert.equal(decision.prune_outcome, "timed_out", "a killed prune is named, never read as a completed one");
  assert.equal(decision.prune_timed_out_after_ms, 300);
  assert.equal(decision.carried_by, "quiet");
});

test("the awaited and sync reaps answer identically on a real store with loose objects past the expiry", async () => {
  const aged = LOOSE_OBJECT_FLOOR + 40;
  const fresh = 25;
  const { dir: syncStore, kept } = storeWithLooseBlobs(aged, fresh);
  const { dir: awaitedStore } = storeWithLooseBlobs(aged, fresh);
  const inflight = scratch("reaper-parity-inflight");
  assert.equal(looseFiles(syncStore), aged + kept, "the fixture holds every blob it wrote");

  // Survey first (it removes nothing), then the armed pass, each through the REAL default git probes.
  const syncSurvey = reapGitObjects(syncStore, inflight, { ...quiet, dryRun: true });
  const awaitedSurvey = await reapGitObjectsAsync(awaitedStore, inflight, { ...quiet, dryRun: true });
  assert.deepEqual(awaitedSurvey, syncSurvey);
  assert.equal(syncSurvey.wouldPrune, aged, `only the blobs older than ${OBJECT_PRUNE_EXPIRY} are eligible`);

  const syncArmed = reapGitObjects(syncStore, inflight, quiet);
  const awaitedArmed = await reapGitObjectsAsync(awaitedStore, inflight, quiet);
  assert.deepEqual(awaitedArmed, syncArmed);
  assert.equal(syncArmed.pruned, aged, "the sync reap pruned every aged blob");
  assert.equal(syncArmed.carriedBy, "quiet");
  assert.equal(looseFiles(awaitedStore), kept, "the awaited prune kept the blobs inside the expiry");
  assert.equal(looseFiles(syncStore), kept);
});
