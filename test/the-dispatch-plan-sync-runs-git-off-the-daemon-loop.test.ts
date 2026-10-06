import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Namespace import: this file must LOAD on a base without the awaited symbols, so each proof
// fails there on its own assertion rather than on a missing export.
import * as runTaskLib from "../src/run-task.js";
import type { SyncedPlan } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const { GitFetchError, createPlanSyncCoalescer, readOriginShardsAtRef, syncPlanFromOrigin, syncPlanOrRefuse } = runTaskLib;
const syncPlanFromOriginAsync: typeof runTaskLib.syncPlanFromOriginAsync = (...a) => runTaskLib.syncPlanFromOriginAsync(...a);
const syncPlanOrRefuseAsync: typeof runTaskLib.syncPlanOrRefuseAsync = (...a) => runTaskLib.syncPlanOrRefuseAsync(...a);
const readOriginShardsAtRefAsync: typeof runTaskLib.readOriginShardsAtRefAsync = (...a) => runTaskLib.readOriginShardsAtRefAsync(...a);
const planSyncGitRunnerAsync: typeof runTaskLib.planSyncGitRunnerAsync = (...a) => runTaskLib.planSyncGitRunnerAsync(...a);
const quarantiningPlanSyncAsync: typeof runTaskLib.quarantiningPlanSyncAsync = (...a) => runTaskLib.quarantiningPlanSyncAsync(...a);

// MEASURED 2026-10-06 (daemon.loop_lag since boot at 0d90c2a98): the dispatch plan sync read its
// shards through `defaultShardGitRunner`'s execFileSync — 3.4 s of sync git holding every daemon
// timer, on every dispatching tick, beside a sync `git fetch` and `git show`. These pin the awaited
// replacement: the loop keeps running, a bound kills a hung git and the refusal names it, and the
// awaited sync reads a real origin exactly as the sync one does.

function task(id: string, wide = false): string {
  return `- id: ${id}\n  title: "${id}${wide ? " — wide ✓" : " plain"}"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n`;
}

/** A clone whose origin/main holds one monolith task and three shards (the first multi-byte). */
function planOrigin(): { work: GitRepo; cleanup(): void } {
  const origin = gitRepo({ bare: true, kind: "plansync-origin" });
  const work = gitRepo({ kind: "plansync-work" });
  work.git("config", "user.name", "remudero-test-work");
  work.git("config", "user.email", "work@remudero.invalid");
  mkdirSync(join(work.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), task("W9-T100"));
  for (const [i, id] of ["W9-T101", "W9-T102", "W9-T103"].entries()) {
    writeFileSync(join(work.dir, "plan", "tasks.d", `${id}-shard.yaml`), task(id, i === 0));
  }
  work.git("add", "-A");
  work.git("commit", "--quiet", "-m", "seed plan");
  work.addRemote("origin", origin.dir);
  work.git("push", "--quiet", "origin", "main");
  return { work, cleanup: () => (origin.cleanup(), work.cleanup()) };
}

/** A shell script standing in for `git`: `body` runs, then (when `exec`) the real git with the args. */
function fakeGit(body: string, exec = false): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plansync-fake-bin-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "git");
  writeFileSync(bin, `#!/bin/sh\n${body}\n${exec ? `exec ${realGit} "$@"\n` : ""}`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

/** Counts interval ticks while `pending` settles — a loop held by a sync spawn counts almost none. */
async function ticksWhile<T>(pending: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 20);
  try {
    const value = await pending();
    return { value, ticks };
  } finally {
    clearInterval(timer);
  }
}

function recorder() {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  return { rows, said, log: (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra }), say: (m: string) => void said.push(m) };
}

const ids = (synced: SyncedPlan | { error: string }) => ("plan" in synced ? synced.plan.tasks.map((t) => t.id) : synced);

test("the awaited dispatch plan sync keeps a timer firing while its git is pending", async () => {
  const f = planOrigin();
  // runTask's PRODUCTION entry, with a git on PATH that takes 300 ms per call (fetch, show, ls-tree, cat-file).
  const slow = fakeGit("sleep 0.3", true);
  const savedPath = process.env.PATH;
  const r = recorder();
  try {
    process.env.PATH = `${slow.dir}:${savedPath}`;
    const { value, ticks } = await ticksWhile(() =>
      syncPlanOrRefuseAsync(join(f.work.dir, "plan", "tasks.yaml"), { allowStale: false, log: r.log, say: r.say }));
    process.env.PATH = savedPath;
    assert.deepEqual(ids(value), ["W9-T100", "W9-T101", "W9-T102", "W9-T103"], "the monolith and every shard are dispatched");
    assert.ok(ticks >= 30, `the loop must keep servicing timers during the plan sync's git calls (ticked ${ticks})`);
  } finally {
    process.env.PATH = savedPath;
    rmSync(slow.dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("a plan-sync git call killed at its bound refuses the dispatch and the refusal names the timeout", async () => {
  const f = planOrigin();
  const pidDir = mkdtempSync(join(tmpdir(), "rmd-plansync-pid-"));
  const pidFile = join(pidDir, "pid");
  const hung = fakeGit(`echo $$ > ${pidFile}\nexec sleep 30`);
  // Answers fetch, show and cat-file, but its shard LISTING hangs: a timed-out ls-tree must never read as "no shards".
  const hungListing = fakeGit(`case "$3" in ls-tree) exec sleep 30;; esac`, true);
  try {
    const r = recorder();
    const run = planSyncGitRunnerAsync(f.work.dir, { timeoutMs: 150, graceMs: 50, gitBin: hung.bin });
    const refused = await syncPlanFromOriginAsync(f.work.dir, "plan/tasks.yaml", { runGit: run }).then(
      () => assert.fail("a sync whose fetch never answered must refuse"),
      (e: unknown) => e,
    );
    assert.ok(refused instanceof GitFetchError, `a timeout refuses as GitFetchError, got ${String(refused)}`);
    assert.match((refused as Error).message, /git fetch origin failed in .*: PlanSyncGitTimeoutError: git fetch timed out after 150ms and was killed/);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the hung git was killed, not abandoned");

    const listingRun = planSyncGitRunnerAsync(f.work.dir, { timeoutMs: 1_000, graceMs: 50, gitBin: hungListing.bin });
    await assert.rejects(
      readOriginShardsAtRefAsync(f.work.dir, "plan", listingRun),
      (e: unknown) => e instanceof GitFetchError && /git ls-tree origin\/main:plan\/tasks\.d\/ failed in .*: git ls-tree timed out after 1000ms and was killed/.test(e.message),
    );
    const outcome = await syncPlanOrRefuseAsync(join(f.work.dir, "plan", "tasks.yaml"), {
      allowStale: false,
      log: r.log,
      say: r.say,
      planSnapshot: () => syncPlanFromOriginAsync(f.work.dir, "plan/tasks.yaml", { runGit: listingRun }),
    });
    assert.match("error" in outcome ? outcome.error : "", /git ls-tree timed out after 1000ms and was killed/, "the dispatch refuses rather than dropping every shard task");
    assert.equal(r.rows[0]?.step, "git_fetch_failed");
    assert.match(String(r.rows[0]?.extra?.reason), /timed out after 1000ms/);
  } finally {
    rmSync(hung.dir, { recursive: true, force: true });
    rmSync(hungListing.dir, { recursive: true, force: true });
    rmSync(pidDir, { recursive: true, force: true });
    f.cleanup();
  }
});

test("the awaited and sync dispatch plan syncs read a real origin identically", async () => {
  const f = planOrigin();
  try {
    const sync = syncPlanFromOrigin(f.work.dir, "plan/tasks.yaml");
    const awaited = await syncPlanFromOriginAsync(f.work.dir, "plan/tasks.yaml");
    assert.equal(awaited.plan.tasks.length, 4, "the fixture must hold four tasks, or the comparison is vacuous");
    assert.deepEqual(awaited, sync);
    assert.ok(awaited.plan.byId.get("W9-T101")!.title.includes("—"), "multi-byte text survives the awaited batch read");
    assert.deepEqual(await readOriginShardsAtRefAsync(f.work.dir, "plan"), readOriginShardsAtRef(f.work.dir, "plan"));
    assert.deepEqual(await readOriginShardsAtRefAsync(f.work.dir, "no-such-plan"), [], "no tasks.d/ at the ref is the no-shards case");

    let quarantined: unknown;
    const viaDaemon = await quarantiningPlanSyncAsync((q) => (quarantined = q))(f.work.dir, "plan/tasks.yaml", {});
    assert.deepEqual(viaDaemon, sync);
    assert.deepEqual(quarantined, [], "the daemon's sync reports its quarantine, here empty");

    // A failed blob or batch read refuses naming the read, exactly as the sync reads word it.
    const real = planSyncGitRunnerAsync(f.work.dir);
    const refusing = (verb: string): runTaskLib.GitRunnerAsync => async (args, stdin) => {
      if (args[0] === verb) throw new Error(`${verb} refused`);
      return real(args, stdin);
    };
    await assert.rejects(syncPlanFromOriginAsync(f.work.dir, "plan/tasks.yaml", { runGit: refusing("show") }), (e: unknown) =>
      e instanceof GitFetchError && /^git show origin\/main:plan\/tasks\.yaml failed in .*: Error: show refused$/.test(e.message));
    await assert.rejects(readOriginShardsAtRefAsync(f.work.dir, "plan", refusing("cat-file")), (e: unknown) =>
      e instanceof GitFetchError && /^git cat-file --batch over origin\/main:plan\/tasks\.d\/ failed in .*: Error: cat-file refused$/.test(e.message));

    // A broken origin: both refuse strict with git's own words, and both proceed stale under --allow-stale.
    f.work.git("remote", "set-url", "origin", join(f.work.dir, "no-such-origin"));
    const r = recorder();
    const rAsync = recorder();
    const planPath = join(f.work.dir, "plan", "tasks.yaml");
    const strictSync = syncPlanOrRefuse(planPath, { allowStale: false, log: r.log, say: r.say });
    const strictAsync = await syncPlanOrRefuseAsync(planPath, { allowStale: false, log: rAsync.log, say: rAsync.say });
    assert.ok("error" in strictSync && "error" in strictAsync);
    assert.match(strictAsync.error, /^git fetch origin failed in /);
    assert.deepEqual(rAsync.rows.map((row) => row.step), r.rows.map((row) => row.step));
    const staleSync = syncPlanOrRefuse(planPath, { allowStale: true, log: r.log, say: r.say });
    const staleAsync = await syncPlanOrRefuseAsync(planPath, { allowStale: true, log: rAsync.log, say: rAsync.say });
    assert.deepEqual(staleAsync, staleSync);
    assert.equal("plan" in staleAsync && staleAsync.staleDispatch, true);
    assert.deepEqual(rAsync.said, r.said);
  } finally {
    f.cleanup();
  }
});

test("every lane of one tick shares one awaited dispatch plan sync", async () => {
  let calls = 0;
  const plan: SyncedPlan = { plan: { tasks: [], byId: new Map() } as unknown as SyncedPlan["plan"], staleDispatch: false };
  const coalescer = createPlanSyncCoalescer("/repo/plan/tasks.yaml", async () => {
    calls += 1;
    return plan;
  });
  const lanes = [coalescer.sync({}), coalescer.sync({}), coalescer.sync({})];
  assert.equal(calls, 1, "the three lanes of one tick start one sync");
  assert.deepEqual(await Promise.all(lanes), [plan, plan, plan]);
  await coalescer.sync({});
  assert.equal(calls, 2, "the next tick syncs again");
});
