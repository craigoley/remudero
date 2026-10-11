import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type LaneRestartHooks } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { runTask, type RunResult } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";

const minute = 60_000;
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  // two advances of the daemon's own code: enough change pressure to latch at once, with no quiet window or staleness wait (a lockfile advance releases the coalescing window)
  changes: ["b", "c"].map((c) => ({ sha: c.repeat(40), subject: "fix: refresh", files: ["src/lib/daemon.ts", "package-lock.json"] })) };
const result = (id: string, verdict: RunResult["verdict"] = "merged"): RunResult =>
  ({ taskId: id, runId: id, merged: verdict === "merged", verdict, costUsd: 0 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function history(durationMs: number): string[] {
  const end = Date.now();
  return [
    JSON.stringify({ step: "run.start", run_id: "observed", ts: new Date(end - durationMs).toISOString() }),
    JSON.stringify({ step: "verdict", run_id: "observed", ts: new Date(end).toISOString(), verdict: "merged" }),
  ];
}

/** Three lanes; `meanMs` of 0 means no run history. The restart latches at `latchMinute`. */
function phase(meanMs: number, extraDeps: Partial<DaemonDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t7806-phase-"));
  const path = join(dir, "tasks.yaml");
  const ids = "ABCDEFGH".split("");
  writeFileSync(path, ids.map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const releases = new Map(ids.map((id) => [id, deferred<RunResult>()]));
  const hooks = new Map<string, LaneRestartHooks | undefined>();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const started: string[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const start = Date.now();
  let nowMs = start;
  let isStale = false;
  let cleaning = false;
  const merged = new Set<string>();
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    readLedgerLines: () => meanMs > 0 ? history(meanMs) : [],
    refreshMerged: () => (id) => merged.has(id),
    checkFreshness: () => isStale ? stale : { stale: false },
    checkStop: () => cleaning ? "cleanup" : undefined,
    log: (step, extra) => rows.push({ step, extra }),
    runOne: (id, restart) => { started.push(id); hooks.set(id, restart); return releases.get(id)!.promise; },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    ...extraDeps,
  } as DaemonDeps, { laneCount: 3, max: 10 });
  const tick = async (ageMinutes: number, staleNow = false) => {
    nowMs = start + ageMinutes * minute;
    isStale ||= staleNow;
    await flush();
    sleeps.shift()?.resolve();
    await flush();
    await flush();
  };
  return {
    run, started, rows, hooks,
    tick,
    at: (ageMinutes: number) => { nowMs = start + ageMinutes * minute; },
    settle: async (id: string, ageMinutes: number, verdict: RunResult["verdict"] = "merged") => {
      nowMs = start + ageMinutes * minute;
      if (verdict === "merged") merged.add(id);
      releases.get(id)!.resolve(result(id, verdict));
      await flush();
    },
    /** The restart is marked stale at minute 1 and decided by the tick at `latchMinute`. */
    latch: async (latchMinute: number) => {
      await flush();
      await tick(1, true);
      await tick(latchMinute);
    },
    cleanup: async () => {
      cleaning = true;
      for (const [id, release] of releases) release.resolve(result(id));
      for (const sleep of sleeps) sleep.resolve();
      await run;
    },
  };
}

const refilled = (rows: ReturnType<typeof phase>["rows"], finished: string) =>
  rows.find(({ step, extra }) => step === "dispatch.lane_refilled" && extra?.finished_task === finished)?.extra;
const staleHeld = (rows: ReturnType<typeof phase>["rows"]) =>
  rows.filter(({ step, extra }) => step === "dispatch.lane_refill_held" && String(extra?.reason).startsWith("stale code"));

async function yieldRefilledRun(restart: LaneRestartHooks): Promise<RunResult> {
  const root = mkdtempSync(join(tmpdir(), "rmd-t7806-boundary-"));
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.addRemote("origin", origin.dir);
  seed.git("push", "origin", "main");
  const repo = gitRepo({ cloneFrom: origin.dir });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@remudero.invalid");
  mkdirSync(join(root, "repos"));
  renameSync(repo.dir, join(root, "repos", "remudero"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: D\n  title: refill fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test\n  status: queued\n  files: [src/change.ts]\n");
  let calls = 0;
  let boundaries = 0;
  let localReads = 0;
  const worker = (text: string): WorkerResult => ({ sessionId: "fixture", costUsd: 0, numTurns: 1, text,
    blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "test", effort: "test", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false });
  const outcome = await withLiveWritesAllowed(() => runTask("D", {
    config: { claudeBin: "/bin/true", root, installRoot: process.cwd(), workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "refill-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    laneRestart: { restartLatched: restart.restartLatched, boundaryReached: () => { boundaries++; restart.boundaryReached(); } },
    externalWaitFreshness: async () => { localReads++; return undefined; },
    spawn: async (args) => {
      if (++calls === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      assert.equal(boundaries, 0, "the first worker runs before any safe boundary");
      mkdirSync(join(args.cwd, "src"), { recursive: true });
      writeFileSync(join(args.cwd, "src/change.ts"), "export const value = 42;\n");
      return worker("REPORT\nCOMMIT_MESSAGE: fix(test): retain refill work\n");
    },
    preopenGate: async () => { assert.fail("the refilled run yields before the pre-open gate"); },
  }));
  assert.equal(calls, 2, "only recon and the first implement worker run");
  assert.equal(boundaries, 1);
  assert.equal(localReads, 0, "daemon lanes use the latch even when their own freshness reader would disagree");
  assert.equal(outcome.verdict, "handed_off");
  assert.equal(outcome.prUrl, undefined);
  const rows = readFileSync(join(root, "state/ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const handoff = rows.find((row) => row.step === "run.freshness_handoff");
  assert.equal(handoff?.waiting_on, "worker");
  assert.equal(handoff?.new_sha, stale.newSha);
  assert.equal(handoff?.head_sha, origin.git("rev-parse", `refs/heads/${String(handoff?.branch)}`));
  assert.equal(origin.git("show", `${String(handoff?.branch)}:src/change.ts`), "export const value = 42;");
  return outcome;
}

test("W1-T7806: a freed lane refills while a young lane has no yield boundary since the latch", async () => {
  const h = phase(16 * minute);
  try {
    await h.latch(5);
    assert.equal(h.rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra?.action === "restart"), true,
      "the restart latched at minute 5, long before lane A reaches the 16 minute mean");
    await h.settle("B", 6);
    assert.deepEqual(h.started, ["A", "B", "C", "D"], "lane B refilled although A is younger than the mean");
    await h.settle("C", 8);
    assert.deepEqual(h.started, ["A", "B", "C", "D", "E"]);
    assert.equal(refilled(h.rows, "B")?.restart_pending, true);
    assert.deepEqual(refilled(h.rows, "B")?.waiting_on, ["A", "C"]);
    assert.deepEqual(refilled(h.rows, "C")?.waiting_on, ["A"]);
    assert.equal(staleHeld(h.rows).length, 0);
  } finally { await h.cleanup(); }
});

test("W1-T7806: refill stays open under a latch with no run history", async () => {
  const h = phase(0);
  try {
    await h.latch(5);
    assert.equal(h.rows.find(({ step }) => step === "dispatch.refill_bound")?.extra?.source, "no_history_fallback");
    await h.settle("B", 6);
    await h.settle("C", 8);
    assert.deepEqual(h.started, ["A", "B", "C", "D", "E"], "no history means no age cohort, so the live holdout keeps refill open");
    assert.deepEqual(refilled(h.rows, "C")?.waiting_on, ["A"]);
    assert.equal(staleHeld(h.rows).length, 0);
  } finally { await h.cleanup(); }
});

test("W1-T7806: a refill admitted under the latch yields at its first boundary", async () => {
  const h = phase(16 * minute);
  try {
    await h.latch(5);
    await h.settle("B", 6);
    const refill = h.hooks.get("D");
    assert.ok(refill, "the daemon lends every run its restart hooks");
    assert.equal(refill.restartLatched()?.newSha, stale.newSha, "the refilled run reads the latched restart at its first boundary");
    const handedOff = await yieldRefilledRun(refill);
    await h.settle("D", 7, handedOff.verdict);
    assert.deepEqual(h.started, ["A", "B", "C", "D", "E"], "D's handoff frees a lane that still refills while A holds the restart");
    assert.deepEqual(refilled(h.rows, "D")?.waiting_on, ["A", "C"], "the refill D holds nothing open");
    await h.settle("C", 8);
    assert.deepEqual(refilled(h.rows, "C")?.waiting_on, ["A"]);
    await h.tick(9);
    const waiting = h.rows.filter(({ step }) => step === "daemon.freshness_restart_waiting").flatMap(({ extra }) => extra?.lanes as Array<Record<string, unknown>>);
    assert.ok(waiting.some((lane) => lane.admitted_under_latch === true), "the wait names the lanes admitted under the latch");
    for (const lane of waiting) {
      const inFlightAtLatch = ["A", "B", "C"].includes(String(lane.task));
      assert.equal(lane.holdout, inFlightAtLatch, `${String(lane.task)} is a holdout only if it was in flight at the latch`);
      assert.equal(lane.admitted_under_latch, !inFlightAtLatch);
    }
    await h.settle("A", 9);
    const before = h.started.length;
    await h.settle("E", 10);
    await h.settle("F", 11);
    assert.equal(h.started.length, before, "the refills do not renew the hold once the original lane has settled");
  } finally { await h.cleanup(); }
});

test("W1-T7806: a restart wakes parked lanes while a young holdout cannot yield", async () => {
  const h = phase(16 * minute);
  try {
    await h.tick(0);
    await h.settle("B", 10);
    await h.settle("C", 17);
    await h.settle("A", 18);
    assert.deepEqual(h.started, ["A", "B", "C", "D", "E"]);
    assert.equal(h.rows.filter(({ step }) => step === "dispatch.lane_parked").length, 1);
    await h.tick(19, true);
    await h.tick(20);
    assert.deepEqual(h.started, ["A", "B", "C", "D", "E", "F"]);
    assert.deepEqual(refilled(h.rows, "A")?.waiting_on, ["D", "E"]);
    assert.equal(refilled(h.rows, "A")?.restart_pending, true);
  } finally { await h.cleanup(); }
});

test("W1-T7806: an awaited refill read closes when its last holdout reaches a boundary", async () => {
  const read = deferred<void>();
  let blockRead = false;
  let reads = 0;
  const h = phase(16 * minute, { refreshMergedAsync: async () => {
    if (blockRead) { reads++; await read.promise; }
    return () => false;
  } });
  try {
    await h.latch(5);
    await h.settle("B", 6);
    blockRead = true;
    await h.settle("C", 8);
    assert.equal(reads, 1, "the freed lane has a refill read in flight");
    h.hooks.get("A")!.boundaryReached();
    read.resolve();
    await flush();
    assert.deepEqual(h.started, ["A", "B", "C", "D"]);
    assert.match(String(staleHeld(h.rows)[0]?.extra?.reason), /^stale code \(decided while the refill read was in flight\)$/);
  } finally { read.resolve(); await h.cleanup(); }
});

test("W1-T7806: refill closes as stale code once every holdout can yield", async () => {
  const h = phase(16 * minute);
  try {
    await h.latch(5);
    await h.settle("B", 6);
    assert.deepEqual(h.started, ["A", "B", "C", "D"]);
    h.hooks.get("A")!.boundaryReached();
    await h.settle("C", 8);
    assert.deepEqual(h.started, ["A", "B", "C", "D"], "A reached a boundary and C settled: no holdout remains, so nothing starts");
    assert.equal(staleHeld(h.rows).length, 1);
    await h.settle("A", 9, "handed_off");
    await h.settle("D", 10);
    assert.deepEqual(h.started, ["A", "B", "C", "D"]);
    assert.equal((await h.run).stopReason, "stale");
  } finally { await h.cleanup(); }
});
